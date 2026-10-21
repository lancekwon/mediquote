// mediquote AI 챗 (Phase 1 — 견적 작성)
// Vercel Serverless Function (Node runtime)
//
// ⚠ 데이터 안전 원칙:
//   - 기존 테이블(equipment, hospitals, manufacturers, quotes, purchase_orders 등)은 READ ONLY
//   - 쓰기는 신규 테이블(chat_sessions, chat_messages, quotes_ai_draft)에만

const SUPABASE_URL = process.env.SUPABASE_URL
  || 'https://nbgubiywavozgigiwkpr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'sb_publishable_L4FVvZBPaNF9BQtoadoPRw_3HeNlPRL';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${res.status} ${path}: ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const TOOLS = [
  {
    name: 'search_equipment',
    description: '장비(equipment) 검색. 품목명/모델명/제조사로 LIKE 검색.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색어' },
        limit: { type: 'number', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_hospitals',
    description: '병원(hospitals) 검색. 병원명으로.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_manufacturers',
    description: '제조사·거래처(manufacturers) 검색.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_recent_quotes',
    description: '기존 quotes 테이블의 최근 견적 조회 (READ ONLY, 참고용).',
    input_schema: {
      type: 'object',
      properties: {
        hospital_id: { type: 'string', description: 'hospital UUID (선택)' },
        limit: { type: 'number', default: 5 },
      },
    },
  },
  {
    name: 'save_quote_draft',
    description:
      'AI 견적 draft 저장 → quotes_ai_draft 테이블. 기존 quotes 는 안 건드립니다. items는 [{equipment_id?, name, qty, unit_price, total?}] 형식.',
    input_schema: {
      type: 'object',
      properties: {
        hospital_id: { type: 'string' },
        hospital_name: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              equipment_id: { type: 'string' },
              name: { type: 'string' },
              qty: { type: 'number' },
              unit_price: { type: 'number' },
              total: { type: 'number' },
            },
            required: ['name', 'qty', 'unit_price'],
          },
        },
        memo: { type: 'string' },
      },
      required: ['items'],
    },
  },
];

async function runTool(name, input, { sessionId, owner }) {
  const esc = (s) => encodeURIComponent(s);
  switch (name) {
    case 'search_equipment': {
      const q = esc(`%${input.query}%`);
      // equip_code 로도 바로 조회 (E045 식 입력)
      const codeMatch = /^E\d{3,}$/i.test(input.query.trim());
      let url;
      if (codeMatch) {
        url = `equipment?equip_code=eq.${encodeURIComponent(input.query.trim().toUpperCase())}`
          + `&select=id,equip_code,cat_name,item_name,model_name,manufacturer,price`;
      } else {
        url = `equipment?or=(item_name.ilike.${q},model_name.ilike.${q},manufacturer.ilike.${q},equip_code.ilike.${q})`
          + `&select=id,equip_code,cat_name,item_name,model_name,manufacturer,price`
          + `&limit=${input.limit || 20}`;
      }
      const rows = await sb(url);
      return { count: rows.length, rows };
    }
    case 'search_hospitals': {
      const q = esc(`%${input.query}%`);
      const rows = await sb(
        `hospitals?name=ilike.${q}&select=id,name,hospital_code,business_reg_no&limit=${input.limit || 10}`
      );
      return { count: rows.length, rows };
    }
    case 'search_manufacturers': {
      const q = esc(`%${input.query}%`);
      const rows = await sb(
        `manufacturers?name=ilike.${q}&select=id,name,vendor_code,business_reg_no,category&limit=${input.limit || 10}`
      );
      return { count: rows.length, rows };
    }
    case 'get_recent_quotes': {
      let path = `quotes?select=*&order=created_at.desc&limit=${input.limit || 5}`;
      if (input.hospital_id) path += `&hospital_id=eq.${input.hospital_id}`;
      const rows = await sb(path);
      return { count: rows.length, rows };
    }
    case 'save_quote_draft': {
      // mediquote 정책: equipment.price = VAT 포함 최종가.
      // total = sum(unit_price × qty) = VAT 포함 최종금액.
      // 공급가(supply) = total ÷ 1.1, VAT = 나머지.
      const items = input.items.map((i) => ({
        ...i,
        total: i.total ?? i.qty * i.unit_price,
      }));
      const total = items.reduce((s, i) => s + (i.total || 0), 0);
      const subtotal = Math.round(total / 1.1); // 공급가 역산
      const vat = total - subtotal;
      const [row] = await sb('quotes_ai_draft', {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId,
          owner,
          hospital_id: input.hospital_id || null,
          hospital_name: input.hospital_name || null,
          items,
          subtotal,
          vat,
          total_amount: total,
          memo: input.memo || null,
        }),
      });
      return { draft_id: row.id, subtotal, vat, total_amount: total };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

const SYSTEM = `당신은 **mediquote(DWmedi)** 의료장비 영업 어시스턴트입니다.
사용자는 영업 딜러이고, 담당 병원·의원에 의료장비 견적서를 작성해야 합니다.

**하드 규칙:**
1. 기존 데이터(장비·병원·제조사·발주·세금계산서·수금)는 **읽기만**. 수정/삭제 절대 금지.
2. 견적은 반드시 \`save_quote_draft\` 로 **draft 상태**로만 저장. 기존 quotes 테이블은 안 건드립니다.
3. 가격은 \`search_equipment\` 의 price 를 기준. 가격이 0 or 없으면 사용자에게 물어보세요.
4. 병원이 DB에 없을 수 있으니 \`search_hospitals\` 로 먼저 확인 → 없으면 \`hospital_name\` 만 넣어 draft.
5. 답변은 **한국어**, 숫자는 콤마(예: 1,500,000원), 간결하게.

**매우 중요 — 부가세(VAT) 정책:**
- mediquote의 **모든 장비 price는 이미 VAT 포함 최종 소비자가**입니다.
- "VAT 별도", "부가세 10% 추가" 같은 설명 하지 마세요. 혼란만 줍니다.
- 가격 안내: "케어러쉬 7,700,000원" ← 이게 VAT 포함 최종가. 끝.
- 견적서 total_amount = sum(unit_price × qty) = VAT 포함 최종금액.
- 서버가 자동으로 공급가(÷1.1)·VAT(나머지)·총액 계산해 저장합니다.
- Claude는 그냥 unit_price에 search_equipment 결과의 price 그대로 넣으면 됩니다.

**매우 중요 — 저장 정책:**
- 사용자가 견적 요청하면 **매번 \`save_quote_draft\` 호출**해서 저장하세요.
- "중복이니까 저장 안 할게요" 같은 판단 하지 마세요. draft는 그냥 쌓이는 거고 사용자가 관리합니다.
- 과거 draft 참조하지 말고, 이번 요청만 보고 즉시 저장.
- draft 저장 성공하면 draft_id를 사용자에게 표시 (챗 UI가 "📄 견적서 보기" 버튼을 자동 생성).

**플로우 예시:**
사용자: "서울아산샘유외과에 BS330 신장체중계 2대 견적 뽑아줘"
→ search_hospitals("서울아산샘유외과") → id 확인
→ search_equipment("BS330") → price 확인
→ save_quote_draft({hospital_id, items:[{equipment_id, name, qty:2, unit_price}]})
→ "✅ draft 저장 완료: 총 X원 (VAT 포함 Y원)"

사용자가 애매하게 요청하면 (예: 품목·수량만 주고 병원 안 밝힘) 되묻지 말고
가장 자연스러운 가정을 하면서 search 결과를 보여주세요.`;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.status(200).json({ ok: true, model: MODEL });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  if (!ANTHROPIC_KEY) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { sessionId: sessionIdIn, owner, message } = body || {};
    if (!owner || !message) {
      res.status(400).json({ error: 'owner, message required' });
      return;
    }

    // 1. 세션 확보
    let sessionId = sessionIdIn;
    if (!sessionId) {
      const [sess] = await sb('chat_sessions', {
        method: 'POST',
        body: JSON.stringify({ owner, title: message.slice(0, 60) }),
      });
      sessionId = sess.id;
    }

    // 2. 과거 메시지 → Claude 메시지 포맷으로 복원
    const past = await sb(
      `chat_messages?session_id=eq.${sessionId}&order=created_at.asc&select=role,content,tool_calls,tool_result`
    );
    const messages = [];
    for (const m of past) {
      if (m.role === 'user') {
        messages.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
          }
        }
        if (content.length) messages.push({ role: 'assistant', content });
      } else if (m.role === 'tool' && m.tool_result) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.tool_result.tool_use_id,
              content: JSON.stringify(m.tool_result.content),
            },
          ],
        });
      }
    }

    // 3. 새 user 메시지 (DB 저장 + in-memory 추가)
    messages.push({ role: 'user', content: message });
    await sb('chat_messages', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, role: 'user', content: message }),
    });

    // 4. Claude agent loop (max 10 turns)
    let draftId = null;
    let finalText = '';
    for (let turn = 0; turn < 10; turn++) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          system: SYSTEM,
          tools: TOOLS,
          messages,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Anthropic ${resp.status}: ${errText}`);
      }
      const data = await resp.json();
      const assistantContent = data.content || [];

      const toolCalls = assistantContent
        .filter((c) => c.type === 'tool_use')
        .map((c) => ({ type: c.type, id: c.id, name: c.name, input: c.input }));
      const text = assistantContent
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');

      await sb('chat_messages', {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId,
          role: 'assistant',
          content: text || null,
          tool_calls: toolCalls.length ? toolCalls : null,
          input_tokens: data.usage?.input_tokens,
          output_tokens: data.usage?.output_tokens,
        }),
      });
      messages.push({ role: 'assistant', content: assistantContent });

      if (data.stop_reason !== 'tool_use') {
        finalText = text;
        break;
      }

      // tool 실행
      for (const tc of toolCalls) {
        let result;
        try {
          result = await runTool(tc.name, tc.input, { sessionId, owner });
          if (tc.name === 'save_quote_draft' && result?.draft_id) draftId = result.draft_id;
        } catch (e) {
          result = { error: e.message };
        }
        await sb('chat_messages', {
          method: 'POST',
          body: JSON.stringify({
            session_id: sessionId,
            role: 'tool',
            tool_result: { tool_use_id: tc.id, content: result },
          }),
        });
        messages.push({
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: tc.id, content: JSON.stringify(result) },
          ],
        });
      }
    }

    // 5. 세션 last_message_at 갱신
    await sb(`chat_sessions?id=eq.${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_message_at: new Date().toISOString() }),
    });

    res.status(200).json({ sessionId, reply: finalText, draftId });
  } catch (e) {
    console.error('[chat.mjs]', e);
    res.status(500).json({ error: e.message });
  }
}
