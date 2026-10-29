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
  {
    name: 'create_purchase_order',
    description:
      '실제 발주(PO) 생성 — purchase_orders 테이블에 INSERT. **반드시 사용자 승인 받고 호출.** status는 항상 "진행중" (사용자가 수동으로 "납품완료" 체크). 매입가(unit_price)는 비움 (추후 매입세금계산서 들어오면 입력).',
    input_schema: {
      type: 'object',
      properties: {
        manufacturer_id: { type: 'string', description: '거래처 UUID (search_manufacturers 결과의 id)' },
        hospital_id: { type: 'string', description: '병원 UUID (search_hospitals 결과의 id)' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              equipment_id: { type: 'string', description: 'equipment UUID (search_equipment 결과의 id)' },
              item_name: { type: 'string' },
              model_name: { type: 'string' },
              quantity: { type: 'number', default: 1 },
              sale_price: { type: 'number', description: '매출가 (단가, VAT 포함)' },
            },
            required: ['item_name', 'quantity'],
          },
        },
        delivery_date: { type: 'string', description: '납품예정일 (YYYY-MM-DD, 선택)' },
        notes: { type: 'string', description: 'PO 메모' },
        owner: { type: 'string', enum: ['최', '권', '성'], description: '발주 담당자 (요청자의 성씨). 메시지에 "최윤철", "권OO", "성OO" 같은 이름 있으면 성씨만 추출. 명확하지 않으면 생략.' },
      },
      required: ['manufacturer_id', 'hospital_id', 'items'],
    },
  },
  {
    name: 'register_hospital',
    description:
      '신규 병원 등록. **사용자 승인 받고 호출.** hospital_code 자동 부여 (H???).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: { type: 'string' },
        contact_name: { type: 'string' },
        contact_phone: { type: 'string' },
        business_reg_no: { type: 'string', description: '사업자번호 (10자리 숫자, 하이픈 제외)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'register_manufacturer',
    description:
      '신규 거래처 등록. **사용자 승인 받고 호출.** vendor_code 자동 부여 (V???).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        category: { type: 'string', description: '거래처 / 일반업체 / 운영비 중 하나' },
        business_reg_no: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_hospital_info',
    description: '기존 병원 정보 보강 (주소/담당자/전화/사업자번호). 사용자가 알려준 값만 세팅.',
    input_schema: {
      type: 'object',
      properties: {
        hospital_id: { type: 'string' },
        address: { type: 'string' },
        contact_name: { type: 'string' },
        contact_phone: { type: 'string' },
        business_reg_no: { type: 'string' },
      },
      required: ['hospital_id'],
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
    case 'create_purchase_order': {
      // 다음 PO 번호
      const year = new Date().getFullYear();
      const lastList = await sb(`purchase_orders?select=po_no&po_no=like.PO-${year}-%&order=po_no.desc&limit=1`);
      const lastN = lastList.length ? parseInt(lastList[0].po_no.replace(`PO-${year}-`, ''), 10) : 0;
      const poNo = `PO-${year}-${String(lastN + 1).padStart(3, '0')}`;

      // 거래처/병원 name 조회
      const [mfr] = await sb(`manufacturers?id=eq.${input.manufacturer_id}&select=name,vendor_code`);
      const [hosp] = await sb(`hospitals?id=eq.${input.hospital_id}&select=name,hospital_code`);

      const total = (input.items || []).reduce((s, i) => s + ((i.sale_price || 0) * (i.quantity || 1)), 0);
      const today = new Date().toISOString().slice(0, 10);

      const [po] = await sb('purchase_orders', {
        method: 'POST',
        body: JSON.stringify({
          po_no: poNo,
          manufacturer_id: input.manufacturer_id,
          manufacturer_name: mfr?.name || null,
          hospital_id: input.hospital_id,
          hospital_name: hosp?.name || null,
          total_amount: total,
          status: '진행중',
          created_at: today,
          delivery_date: input.delivery_date || null,
          notes: input.notes || null,
          owner: input.owner || null,
        }),
      });
      for (const it of input.items) {
        await sb('purchase_order_items', {
          method: 'POST',
          body: JSON.stringify({
            po_id: po.id,
            equipment_id: it.equipment_id || null,
            item_name: it.item_name,
            model_name: it.model_name || '',
            quantity: it.quantity || 1,
            sale_price: it.sale_price || null,
            unit_price: null,
          }),
        });
      }
      return {
        po_no: poNo,
        po_id: po.id,
        manufacturer: mfr?.name,
        hospital: hosp?.name,
        total_amount: total,
        item_count: input.items.length,
      };
    }
    case 'register_hospital': {
      const lastList = await sb(`hospitals?select=hospital_code&hospital_code=like.H%&order=hospital_code.desc&limit=1`);
      const lastN = lastList.length ? parseInt((lastList[0].hospital_code || 'H000').slice(1), 10) : 0;
      const code = 'H' + String(lastN + 1).padStart(3, '0');
      const payload = { hospital_code: code, name: input.name };
      ['address', 'contact_name', 'contact_phone', 'business_reg_no'].forEach(k => {
        if (input[k]) payload[k] = input[k];
      });
      const [row] = await sb('hospitals', { method: 'POST', body: JSON.stringify(payload) });
      return { hospital_code: code, hospital_id: row.id, name: row.name };
    }
    case 'register_manufacturer': {
      const lastList = await sb(`manufacturers?select=vendor_code&order=vendor_code.desc&limit=1`);
      const lastN = lastList.length ? parseInt(lastList[0].vendor_code.slice(1), 10) : 0;
      const code = 'V' + String(lastN + 1).padStart(3, '0');
      const payload = { vendor_code: code, name: input.name, category: input.category || '일반업체' };
      ['business_reg_no', 'notes'].forEach(k => { if (input[k]) payload[k] = input[k]; });
      const [row] = await sb('manufacturers', { method: 'POST', body: JSON.stringify(payload) });
      return { vendor_code: code, manufacturer_id: row.id, name: row.name };
    }
    case 'update_hospital_info': {
      const payload = {};
      ['address', 'contact_name', 'contact_phone', 'business_reg_no'].forEach(k => {
        if (input[k]) payload[k] = input[k];
      });
      if (Object.keys(payload).length === 0) return { success: false, error: 'nothing to update' };
      await sb(`hospitals?id=eq.${input.hospital_id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      return { success: true, hospital_id: input.hospital_id, updated: payload };
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

**발주(PO) 생성 플로우 (카톡 대화 등 자연어로 발주 요청 받으면):**

1. 메시지에서 **병원·거래처·품목·수량·매출가·담당자정보** 추출
2. search_hospitals / search_manufacturers / search_equipment 로 각각 DB 매칭
3. 매칭 안 되는 거는 **반드시 사용자에게 묻기**:
   - 신규 병원? → "병원 신규 등록할까요? [주소/담당자/전화 알려주세요]"
   - 신규 거래처? → "거래처 신규 등록할까요? [사업자번호 아시면]"
4. 매칭 된 병원인데 주소/담당자/전화 비어있고 사용자가 알려줬으면 update_hospital_info 로 보강 (사용자 확인 후)
5. 모든 정보 확인되면 **"PO 생성해도 될까요? 사용자 승인"** 받기
6. 승인되면 create_purchase_order 호출

**PO 하드 룰 (사용자 명시 요청):**
- **status는 항상 "진행중"** (서버 기본값, 변경 금지 — 사용자가 수동으로 "납품완료" 체크)
- **매입가(unit_price)는 비움** (매입세금계산서 들어오면 수동 입력)
- **매출가(sale_price)는 사용자가 명시한 값 그대로** (추정 금지)
- 매출가 모르면 사용자에게 "매출가 얼마에요?" 묻기

**발주 담당자(owner) 추론:**
- PO_OWNERS = `['최', '권', '성']` 3명만 가능.
- 카톡 대화나 메시지에서 **발주 요청자의 성씨**를 추출:
  - "최윤철", "최OO" → `owner: '최'`
  - "권OO" → `owner: '권'`
  - "성현기", "성OO" → `owner: '성'`
- 메시지에서 명확하지 않으면 owner 생략 (null)
- 요청자와 다른 사람 (예: "연승은 발주완료") 이름은 무시 — 발주 요청자가 담당자

**신규 등록 (hospital/manufacturer) 전 반드시:**
- 사용자에게 "신규 등록할까요?" 확인
- 알려준 정보 (주소/담당자/전화/사업자번호) 다 담아서 등록

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
