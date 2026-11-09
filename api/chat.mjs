// mediquote AI 챗 (Phase 1 — 견적 작성)
// Vercel Serverless Function (Node runtime)

import { matchEquipment } from '../scripts/equipment_match.mjs';
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

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const dayGap = (a, b) => Math.abs((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
const won = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';

// 이름 비교용 검색어 — 법인 표기·괄호·공백을 뺀 핵심 이름 + 괄호 안 이름 + 영문 이름.
// "오릭스(ORYX)" → ["오릭스", "ORYX"]. 정확한 이름만 찾다가 기존 거래처를 못 보고 중복 등록한 적이 있어서 (2026-11-04)
const CORP_RE = /주식회사|유한회사|\(주\)|㈜|（주）|\(유\)/g;
function nameTerms(name, { hospital = false } = {}) {
  const raw = String(name || '');
  const terms = new Set();
  let core = raw.replace(CORP_RE, '').replace(/[(（][^)）]*[)）]/g, '').replace(/\s+/g, '');
  if (hospital) core = core.replace(/(요양병원|한의원|치과의원|의원|병원|클리닉)$/, '');
  if (core.length >= 2) terms.add(core);
  for (const m of raw.matchAll(/[(（]([^)）]+)[)）]/g)) {
    const t = m[1].replace(CORP_RE, '').trim();
    if (t.length >= 2) terms.add(t);
  }
  for (const m of raw.matchAll(/[A-Za-z][A-Za-z0-9&.\-]{2,}/g)) terms.add(m[0]);
  return [...terms];
}
async function searchByName(table, cols, term, select, limit = 10) {
  const found = new Map();
  for (const col of cols) {
    const rows = await sb(`${table}?${col}=ilike.${encodeURIComponent('%' + term + '%')}&select=${select}&limit=${limit}`);
    rows.forEach((r) => found.set(r.id, r));
  }
  return [...found.values()];
}
async function similarNames(table, cols, name, select, opts) {
  const found = new Map();
  for (const term of nameTerms(name, opts)) {
    (await searchByName(table, cols, term, select)).forEach((r) => found.set(r.id, r));
  }
  return [...found.values()].slice(0, 15);
}
const regNo = (s) => String(s || '').replace(/\D/g, '');

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
    description: '병원(hospitals) 검색. 병원명 일부로 검색 — 법인 표기·괄호·"의원/병원"을 뺀 핵심 단어(예: "에제르", "샘유")로 찾을 것.',
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
    description: '제조사·거래처(manufacturers) 검색. 이름과 별칭(aliases)을 같이 찾음. 핵심 단어로 검색하고, 영문 이름이 있으면 영문으로도 따로 검색할 것.',
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
      'AI 견적 draft 저장 → quotes_ai_draft 테이블. 기존 quotes 는 안 건드립니다. items는 [{equipment_id?, name, qty, unit_price, total?}] 형식. **할인 요청 받으면 품목으로 추가하지 말고 global_discount 필드로 전달.**',
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
        global_discount: {
          type: 'object',
          description: '전체 할인. 사용자가 "할인 100만원", "5% 할인" 같이 요청하면 품목으로 추가하지 말고 여기에 전달.',
          properties: {
            type: { type: 'string', enum: ['rate', 'amount'], description: 'rate=퍼센트, amount=원화 금액' },
            value: { type: 'number', description: 'rate면 % 숫자, amount면 원화 금액 (양수)' },
          },
          required: ['type', 'value'],
        },
        memo: { type: 'string' },
      },
      required: ['items'],
    },
  },
  {
    name: 'create_purchase_order',
    description:
      '발주(PO) 1건 생성 (병원 1 + 거래처 1). **미리보기를 보여주고 사용자가 승인한 뒤에만 호출.** 서버가 status "진행중", 매입가 비움, 매출합계 계산을 처리함. ' +
      '같은 병원·거래처·장비로 발주일 60일 안에 만든 발주가 있으면 만들지 않고 possible_duplicates를 돌려줌 → 사용자에게 보여주고, 그래도 새로 만들라고 하면 allow_duplicate: true로 다시 호출.',
    input_schema: {
      type: 'object',
      properties: {
        manufacturer_id: { type: 'string', description: '거래처 UUID (search_manufacturers 결과의 id)' },
        hospital_id: { type: 'string', description: '병원 UUID (search_hospitals 결과의 id)' },
        owner: { type: 'string', description: '판매 담당 — 이 발주를 판 우리 회사 영업사원의 전체 이름. 시스템 프롬프트의 판매 담당 목록에 있는 이름 그대로. 병원·거래처 사람 이름이 아님. 모르면 호출 전에 사용자에게 물어볼 것.' },
        ordered_at: { type: 'string', description: '발주일 YYYY-MM-DD — 카톡에서 주문이 확정된 메시지의 날짜. 알 수 없으면 생략(오늘로 저장).' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              equipment_id: { type: 'string', description: 'equipment UUID — search_equipment 또는 register_equipment 결과의 id. 필수.' },
              item_name: { type: 'string' },
              model_name: { type: 'string' },
              quantity: { type: 'number', default: 1 },
              sale_price: { type: 'number', description: '매출 단가 (VAT 포함). 대화나 사용자가 말한 값만. 모르면 생략.' },
            },
            required: ['equipment_id', 'item_name', 'quantity'],
          },
        },
        delivery_date: { type: 'string', description: '납품예정일 (YYYY-MM-DD, 선택)' },
        notes: { type: 'string', description: 'PO 메모. 카톡에 거래처 매입가가 나오면 "카톡 매입가 1,980,000원"처럼 여기에만 적기.' },
        allow_duplicate: { type: 'boolean', description: 'possible_duplicates를 사용자에게 보여줬고 그래도 새로 만들라고 했을 때만 true.' },
      },
      required: ['manufacturer_id', 'hospital_id', 'owner', 'items'],
    },
  },
  {
    name: 'register_equipment',
    description:
      '장비 신규 등록 (E코드 자동). search_equipment로 못 찾은 품목만. **발주 미리보기에서 "신규 장비 등록"으로 보여주고 승인받은 뒤 호출.** ' +
      '같은 제품(모델명 일치 등)이 이미 있으면 새로 만들지 않고 기존 장비를 돌려줌. 비슷한 장비가 있으면 만들지 않고 similar를 돌려줌 → 사용자에게 같은 제품인지 묻고, 같으면 그 id를 쓰고 다르면 confirm_new: true로 다시 호출.',
    input_schema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: '품목명 (예: 소형고압증기멸균기)' },
        model_name: { type: 'string', description: '모델명 (없으면 생략)' },
        manufacturer_id: { type: 'string', description: '이 장비를 사는 거래처 UUID' },
        confirm_new: { type: 'boolean', description: 'similar를 사용자에게 보여줬고 다른 제품이라고 확인했을 때만 true' },
      },
      required: ['item_name', 'manufacturer_id'],
    },
  },
  {
    name: 'register_hospital',
    description:
      '신규 병원 등록. **사용자 승인 받고 호출.** hospital_code 자동 부여 (H???). 비슷한 이름의 병원이 있으면 만들지 않고 similar를 돌려줌 → 같은 곳인지 사용자에게 묻고, 다른 곳이라고 하면 confirm_new: true로 다시 호출.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: { type: 'string' },
        contact_name: { type: 'string' },
        contact_phone: { type: 'string' },
        business_reg_no: { type: 'string', description: '사업자번호 (10자리 숫자, 하이픈 제외)' },
        confirm_new: { type: 'boolean', description: 'similar를 사용자에게 보여줬고 다른 곳이라고 확인했을 때만 true' },
      },
      required: ['name'],
    },
  },
  {
    name: 'register_manufacturer',
    description:
      '신규 거래처 등록. **사용자 승인 받고 호출.** vendor_code 자동 부여 (V???). 이름·별칭이 비슷한 거래처나 같은 사업자번호가 있으면 만들지 않고 similar를 돌려줌 → 같은 곳인지 사용자에게 묻고, 다른 곳이라고 하면 confirm_new: true로 다시 호출.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        category: { type: 'string', description: '거래처 / 일반업체 / 운영비 중 하나' },
        business_reg_no: { type: 'string' },
        aliases: { type: 'string', description: '다른 이름들 쉼표로 (영문명, 대표자명 등)' },
        notes: { type: 'string' },
        confirm_new: { type: 'boolean', description: 'similar를 사용자에게 보여줬고 다른 곳이라고 확인했을 때만 true' },
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
          + `&select=id,equip_code,cat_name,item_name,model_name,manufacturer,vendor,price`;
      } else {
        url = `equipment?or=(item_name.ilike.${q},model_name.ilike.${q},manufacturer.ilike.${q},equip_code.ilike.${q})`
          + `&select=id,equip_code,cat_name,item_name,model_name,manufacturer,vendor,price`
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
      const rows = (await searchByName('manufacturers', ['name', 'aliases'], input.query,
        'id,name,aliases,vendor_code,business_reg_no,category', input.limit || 10)).slice(0, input.limit || 10);
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
          global_discount: input.global_discount || null,
        }),
      });
      return { draft_id: row.id, subtotal, vat, total_amount: total, global_discount: input.global_discount || null };
    }
    case 'create_purchase_order': {
      // 앱 규칙: total_amount = 품목 매입합계(매입가는 계산서 올 때 확정이라 지금은 0), sale_amount = 품목 매출합계.
      // 예전 버전은 매출합계를 total_amount에 넣어서 할 일 탭·매칭 화면이 매출을 매입으로 읽었음.
      const items = Array.isArray(input.items) ? input.items : [];
      if (!items.length) return { error: '품목이 없습니다.' };
      if (!isUuid(input.hospital_id) || !isUuid(input.manufacturer_id)) return { error: 'hospital_id / manufacturer_id는 검색 결과의 UUID여야 합니다.' };
      const [ownerRep] = await sb(`sales_reps?name=eq.${esc(String(input.owner || ''))}&select=name`);
      if (!ownerRep) return { error: '판매 담당(owner)은 판매 담당 목록에 있는 이름이어야 합니다. 사용자에게 물어보고 다시 호출하세요.' };
      const noEq = items.filter((it) => !isUuid(it.equipment_id));
      if (noEq.length) {
        return { error: `장비에 연결 안 된 품목: ${noEq.map((it) => it.item_name).join(', ')} — search_equipment로 찾거나, 사용자 승인 후 register_equipment로 등록한 다음 다시 호출하세요.` };
      }
      const orderedAt = /^\d{4}-\d{2}-\d{2}$/.test(input.ordered_at || '') ? input.ordered_at : todayKST();

      const [mfr] = await sb(`manufacturers?id=eq.${input.manufacturer_id}&select=id,name`);
      const [hosp] = await sb(`hospitals?id=eq.${input.hospital_id}&select=id,name`);
      if (!mfr) return { error: '해당 manufacturer_id의 거래처가 없습니다.' };
      if (!hosp) return { error: '해당 hospital_id의 병원이 없습니다.' };
      const eqIds = [...new Set(items.map((it) => it.equipment_id))];
      const eqs = await sb(`equipment?id=in.(${eqIds.join(',')})&select=id,item_name,model_name`);
      if (eqs.length !== eqIds.length) return { error: '없는 equipment_id가 있습니다. search_equipment 결과의 id를 쓰세요.' };
      const eqById = new Map(eqs.map((e) => [e.id, e]));

      // 같은 카톡을 두 번 붙여넣거나, "업데이트"(세금계산서)로 이미 만든 발주를 또 만드는 걸 막음
      if (!input.allow_duplicate) {
        const open = await sb(
          `purchase_orders?select=po_no,status,ordered_at,created_at,owner,purchase_order_items(equipment_id,item_name,model_name,quantity,sale_price)` +
          `&hospital_id=eq.${hosp.id}&manufacturer_id=eq.${mfr.id}&status=neq.${encodeURIComponent('취소')}&order=po_no.desc&limit=50`
        );
        const dups = open.filter((p) => {
          const d = String(p.ordered_at || p.created_at || '').slice(0, 10);
          return d && dayGap(d, orderedAt) <= 60 && (p.purchase_order_items || []).some((it) => eqIds.includes(it.equipment_id));
        });
        if (dups.length) {
          return {
            created: false,
            possible_duplicates: dups.map((p) => ({
              po_no: p.po_no, status: p.status, owner: p.owner,
              ordered_at: String(p.ordered_at || p.created_at || '').slice(0, 10),
              items: (p.purchase_order_items || []).map((it) => `${it.item_name} ${it.model_name || ''} x${it.quantity} 매출가 ${it.sale_price ? won(it.sale_price) : '미정'}`.replace(/\s+/g, ' ')),
            })),
            message: '같은 병원·거래처·장비 발주가 이미 있어 만들지 않았습니다. 사용자에게 보여주고, 그래도 새로 만들라고 하면 allow_duplicate: true로 다시 호출하세요.',
          };
        }
      }

      const rows = items.map((it) => {
        const eq = eqById.get(it.equipment_id);
        const sp = Math.round(Number(it.sale_price) || 0);
        return {
          equipment_id: it.equipment_id,
          item_name: it.item_name || eq.item_name,
          model_name: it.model_name ?? eq.model_name ?? '',
          manufacturer: mfr.name,
          quantity: Math.max(1, Math.round(Number(it.quantity) || 1)),
          unit_price: null,   // 매입가는 매입 세금계산서가 오면 "업데이트"에서 확정
          amount: null,
          sale_price: sp > 0 ? sp : null,
          ordered: false,
          delivered: false,
        };
      });
      const priced = rows.filter((r) => r.sale_price);
      const saleAmount = priced.length ? priced.reduce((s, r) => s + r.sale_price * r.quantity, 0) : null;

      // 발주번호 — 앱의 dbGeneratePoNo와 같은 규칙 (올해 원본(revision=0) 중 최대 번호 + 1, 리비전 -R 접미사 무시)
      const year = todayKST().slice(0, 4);
      const lastList = await sb(`purchase_orders?select=po_no&po_no=like.PO-${year}-*&revision=eq.0&order=po_no.desc&limit=1`);
      const lastN = parseInt(lastList[0]?.po_no.match(/PO-\d+-(\d+)/)?.[1] || '0', 10);
      const poNo = `PO-${year}-${String(lastN + 1).padStart(3, '0')}`;

      const [po] = await sb('purchase_orders', {
        method: 'POST',
        body: JSON.stringify({
          po_no: poNo,
          hospital_id: hosp.id,
          hospital_name: hosp.name,
          manufacturer_id: mfr.id,
          manufacturer_name: mfr.name,
          vendor_name: mfr.name,
          contract_id: null,
          source: 'ai_chat',
          status: '진행중',
          is_active: true,
          revision: 0,
          ordered_at: orderedAt,
          total_amount: 0,
          sale_amount: saleAmount,
          delivery_date: input.delivery_date || null,
          notes: input.notes || null,
          owner: input.owner,
          updated_at: new Date().toISOString(),
        }),
      });
      try {
        await sb('purchase_order_items', {
          method: 'POST',
          body: JSON.stringify(rows.map((r) => ({ ...r, po_id: po.id }))),
        });
      } catch (e) {
        // 품목 저장이 실패하면 빈 발주가 남지 않게 지움
        await sb(`purchase_orders?id=eq.${po.id}`, { method: 'DELETE' }).catch(() => {});
        throw e;
      }
      return {
        created: true,
        po_no: poNo,
        po_id: po.id,
        hospital: hosp.name,
        manufacturer: mfr.name,
        ordered_at: orderedAt,
        owner: input.owner,
        item_count: rows.length,
        sale_amount: saleAmount,
        sale_price_missing: rows.filter((r) => !r.sale_price).map((r) => r.item_name),
      };
    }
    case 'register_equipment': {
      if (!isUuid(input.manufacturer_id)) return { error: 'manufacturer_id는 거래처 UUID여야 합니다.' };
      const itemName = String(input.item_name || '').trim();
      const modelName = String(input.model_name || '').trim();
      if (!itemName) return { error: 'item_name이 필요합니다.' };
      // 중복 장비 방지 — Clobe 업데이트(createPoItems)와 같은 기준 (scripts/equipment_match.mjs)
      // Supabase는 한 번에 최대 1,000줄 → 끝까지 나눠 읽기
      const fetchAll = async (path) => {
        const out = [];
        for (let offset = 0; ; offset += 1000) {
          const rows = await sb(`${path}&limit=1000&offset=${offset}`);
          out.push(...rows);
          if (rows.length < 1000) return out;
        }
      };
      const [all, aliases] = await Promise.all([
        fetchAll('equipment?select=id,equip_code,item_name,model_name,image_url&order=equip_code'),
        fetchAll('purchase_order_items?select=equipment_id,item_name,model_name&equipment_id=not.is.null&order=created_at.desc'),
      ]);
      const { strong, candidates } = matchEquipment(itemName, modelName, all, aliases);
      if (strong) return { created: false, existing: true, equipment_id: strong.id, equip_code: strong.equip_code, item_name: strong.item_name, model_name: strong.model_name };
      if (candidates.length && !input.confirm_new) {
        return {
          created: false,
          similar: candidates.map((c) => ({ equipment_id: c.id, equip_code: c.equip_code, item_name: c.item_name, model_name: c.model_name })),
          message: '비슷한 기존 장비가 있어 새로 만들지 않았습니다. 같은 제품인지 사용자에게 묻고, 같으면 그 equipment_id를 쓰고, 다른 제품이면 confirm_new: true로 다시 호출하세요.',
        };
      }
      const [mfr] = await sb(`manufacturers?id=eq.${input.manufacturer_id}&select=id,name`);
      if (!mfr) return { error: '해당 manufacturer_id의 거래처가 없습니다.' };
      const lastE = await sb('equipment?select=equip_code&equip_code=like.E*&order=equip_code.desc&limit=1');
      const n = parseInt((lastE[0]?.equip_code || 'E000').replace(/\D/g, ''), 10) || 0;
      const code = 'E' + String(n + 1).padStart(3, '0');
      const [row] = await sb('equipment', {
        method: 'POST',
        body: JSON.stringify({
          equip_code: code,
          item_name: itemName,
          model_name: modelName || null,
          category: '미분류',
          cat_id: '미분류',
          cat_name: '미분류',
          manufacturer: mfr.name,
          vendor: mfr.name,
          vendor_id: mfr.id,
          memo: '',
        }),
      });
      return { created: true, equipment_id: row.id, equip_code: code };
    }
    case 'register_hospital': {
      if (!input.confirm_new) {
        const similar = await similarNames('hospitals', ['name'], input.name, 'id,name,hospital_code,business_reg_no', { hospital: true });
        const brn = regNo(input.business_reg_no);
        if (brn.length === 10) (await sb(`hospitals?business_reg_no=eq.${brn}&select=id,name,hospital_code,business_reg_no`)).forEach((r) => { if (!similar.some((s) => s.id === r.id)) similar.push(r); });
        if (similar.length) return { created: false, similar, message: '비슷한 병원이 이미 있습니다. 같은 곳인지 사용자에게 묻고, 다른 곳이면 confirm_new: true로 다시 호출하세요.' };
      }
      const lastList = await sb(`hospitals?select=hospital_code&hospital_code=like.H*&order=hospital_code.desc&limit=1`);
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
      if (!input.confirm_new) {
        const similar = await similarNames('manufacturers', ['name', 'aliases'], input.name, 'id,name,aliases,vendor_code,business_reg_no');
        const brn = regNo(input.business_reg_no);
        if (brn.length === 10) (await sb(`manufacturers?business_reg_no=eq.${brn}&select=id,name,aliases,vendor_code,business_reg_no`)).forEach((r) => { if (!similar.some((s) => s.id === r.id)) similar.push(r); });
        if (similar.length) return { created: false, similar, message: '이름·별칭이 비슷하거나 사업자번호가 같은 거래처가 이미 있습니다. 같은 곳인지 사용자에게 묻고, 다른 곳이면 confirm_new: true로 다시 호출하세요.' };
      }
      const lastList = await sb(`manufacturers?select=vendor_code&order=vendor_code.desc&limit=1`);
      const lastN = lastList.length ? parseInt(lastList[0].vendor_code.slice(1), 10) : 0;
      const code = 'V' + String(lastN + 1).padStart(3, '0');
      const payload = { vendor_code: code, name: input.name, category: input.category || '일반업체' };
      ['business_reg_no', 'aliases', 'notes'].forEach(k => { if (input[k]) payload[k] = input[k]; });
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
1. 기존 데이터(장비·병원·제조사·발주·세금계산서·수금)는 **수정·삭제 절대 금지** (예외: update_hospital_info로 빈 칸 보강). 새로 만드는 건 도구로만, 사용자 승인 후에만.
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

**발주(PO) 만들기 — 카톡 대화를 그대로 붙여넣는 경우가 많음**
사용자는 주문을 카톡으로 주고받고 발주는 따로 입력하지 않습니다. 대신 그 대화를 복사해서 붙여넣습니다.
- PC 카톡 복사: "[이름] [오후 3:12] 메시지", 날짜 줄 "--------------- 2026년 11월 4일 화요일 ---------------"
- 모바일 내보내기: "2026년 11월 4일 오후 3:12, 이름 : 메시지"
대화가 견적·문의뿐이고 주문 확정이 없으면 발주를 만들지 말고 그렇다고 말하세요.

1. 대화에서 뽑을 것
   - 병원(납품처), 거래처(우리가 물건을 사는 곳), 품목·모델·수량
   - 매출가: 병원에 받는 단가(VAT 포함). 대화나 사용자가 말한 값만 — 추정 금지.
   - 발주일(ordered_at): 주문이 확정된 메시지의 날짜. 알 수 없으면 생략(오늘로 저장).
   - 판매 담당(owner): 이 발주를 판 우리 회사 영업사원. 아래 "판매 담당 목록"의 이름 그대로 쓰기. 지금 대화 중인 사람이 영업사원이고 다른 말이 없으면 그 사람. 병원 원장·직원이나 거래처 사람 이름이 아님. 확실하지 않으면 미리보기에서 묻기.
   - 거래처 매입가가 대화에 나오면 notes에 "카톡 매입가 1,980,000원"처럼만 적기.
2. DB 매칭
   - 병원·거래처는 핵심 단어로 검색 (법인 표기·괄호·"의원/병원" 빼고). 영문 이름이 있으면 영문으로도 따로 검색. 후보가 여럿이면 사용자에게 고르게.
   - 품목은 search_equipment로 모델명 → 품목명 순서로 검색. 못 찾으면 미리보기에 "신규 장비 등록"으로 표시. 모든 품목은 장비(equipment_id)에 연결돼야 함.
   - 매칭된 병원의 주소/담당자/전화가 비어 있고 사용자가 알려줬으면 update_hospital_info로 보강 (사용자 확인 후).
3. 미리보기 — 어떤 쓰기 도구든 부르기 전에 반드시 보여주고 승인받기. 병원+거래처 조합마다 발주 1건:
   📦 발주 1 — 서울아산샘유외과 / 에이치씨케이
   · N322 회색 × 1 — 매출가 1,700,000원
   · 발주일 2026-11-03 · 판매 담당 성현기
   · 신규 등록: 장비 "N322 회색" (있을 때만)
   매출가를 모르는 품목은 "매출가 미정"으로 적고 "알면 알려주세요, 없으면 비워두고 만들어요"라고 한 번만 묻기.
   마지막 줄: "이대로 만들까요?"
4. 사용자가 승인하면 필요한 register_* → create_purchase_order 순서로 호출.
   - create_purchase_order가 possible_duplicates를 돌려주면 그 발주를 보여주고 물어보기. 그래도 새로 만들라고 하면 allow_duplicate: true로 다시 호출.
   - register_hospital / register_manufacturer가 similar를 돌려주면 같은 곳인지 묻기. 같은 곳이면 그 id를 쓰고, 다른 곳이면 confirm_new: true로 다시 호출.
5. 완료 후: 만든 발주번호를 알려주고, 매출가가 빈 품목이 있으면 "병원별 이익 탭의 💰 매출가 없음에서 채우면 돼요"라고 안내.

**PO 하드 룰 (사용자 명시 요청):**
- status는 항상 "진행중" (서버가 처리)
- 매입가(unit_price)는 비움 — 매입 세금계산서가 오면 "업데이트"에서 확정
- 매출가(sale_price)는 대화나 사용자가 명시한 값 그대로. 모르면 비움.

**신규 등록 (병원·거래처·장비)은 미리보기에 적어서 승인받은 것만.** 알려준 정보(주소/담당자/전화/사업자번호)는 다 담아서 등록.

**매우 중요 — 저장 정책:**
- 사용자가 견적 요청하면 **매번 \`save_quote_draft\` 호출**해서 저장하세요.
- "중복이니까 저장 안 할게요" 같은 판단 하지 마세요. draft는 그냥 쌓이는 거고 사용자가 관리합니다.
- 과거 draft 참조하지 말고, 이번 요청만 보고 즉시 저장.
- draft 저장 성공하면 draft_id를 사용자에게 표시 (챗 UI가 "📄 견적서 보기" 버튼을 자동 생성).

**매우 중요 — 할인 처리:**
- 사용자가 "할인 100만원", "5% 할인", "DC 50만원" 같이 할인 요청하면:
  **❌ 품목 리스트에 "할인" 품목을 추가하지 마세요.** (이게 과거 버그였음)
  **✅ save_quote_draft 의 \`global_discount\` 필드에 전달하세요.**
- 예: "자기장치료기 TESLA-3000 할인 100만원 잡아줘"
  → items: [{name:"자기장치료기 TESLA-3000", qty:1, unit_price:4200000}]
  → global_discount: {type:"amount", value:1000000}
  → memo: "최윤철 과장님 할인 적용" (사람 이름이나 할인 사유가 있으면 memo에)
- 예: "5% 할인"
  → global_discount: {type:"rate", value:5}
- rate(%)인지 amount(원)인지 사용자 요청에서 판단. "할인 100만원" = amount, "할인 5%" = rate.

**플로우 예시:**
사용자: "서울아산샘유외과에 BS330 신장체중계 2대 견적 뽑아줘"
→ search_hospitals("서울아산샘유외과") → id 확인
→ search_equipment("BS330") → price 확인
→ save_quote_draft({hospital_id, items:[{equipment_id, name, qty:2, unit_price}]})
→ "✅ draft 저장 완료: 총 X원 (VAT 포함 Y원)"

견적 요청이 애매하면 (예: 품목·수량만 주고 병원 안 밝힘) 되묻지 말고
가장 자연스러운 가정을 하면서 search 결과를 보여주세요.`;

// 로컬 테스트용 (쓰기 막은 fetch로 도구 동작 확인). 핸들러는 default export
export { runTool, nameTerms };

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

    // 4. Claude agent loop — 카톡 → 발주는 병원·거래처·장비 검색과 등록이 여러 번 필요해서 16턴까지
    let draftId = null;
    let finalText = '';
    let finished = false;
    const reps = await sb('sales_reps?select=name,email&order=name');
    const me = reps.find((r) => r.email === String(owner).toLowerCase());
    const system = `${SYSTEM}\n\n오늘 날짜(한국 시간): ${todayKST()}\n판매 담당 목록: ${reps.map((r) => r.name).join(', ')}\n지금 대화 중인 사람: ${me ? `${me.name} (영업사원)` : '관리자'}`;
    for (let turn = 0; turn < 16; turn++) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 16000, // 긴 카톡 대화를 정리하다 4096에서 잘리지 않게
          system,
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
        finished = true;
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

    if (!finished) finalText = '처리 단계가 너무 길어 중간에 멈췄어요. 지금까지 한 내용을 확인하고 "이어서 해줘"라고 보내주세요.';
    else if (!finalText) finalText = '응답이 비어 있어요. 다시 보내주세요.';

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
