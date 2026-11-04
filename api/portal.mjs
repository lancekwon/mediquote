// 병원 포털 API (hospital.html 전용)
// Vercel Serverless Function (Node runtime)
//
// 링크 토큰 + 접속코드(PIN)를 확인한 뒤 "그 병원 데이터만" 돌려줌.
// - 금액(단가·합계·세금계산서 금액)은 응답에 아예 넣지 않음 (병원 화면에 금액 비공개 — 사용자 결정 2026-11-04)
// - 우리 매입처(거래처) 이름도 넣지 않음. 장비 제조사는 장비 마스터의 manufacturer가 vendor와 다를 때만
// - 포털 페이지에는 DB 키가 없음. 예전 hospital.html은 브라우저가 DB를 직접 읽어서 다른 병원 데이터도 볼 수 있었음
//
// POST /api/portal  { action, token, pin, ... }   token = 전체 토큰(UUID) 또는 짧은 링크 /h/<앞 8자리>, pin = 사업자등록번호
//   check   { token }                         → 링크가 유효한지 + 로그인 방식(bizno/pin)
//   load    { token, pin }                    → 병원 화면 데이터 전체
//   service { token, pin, equipment_name, model_name, issue, notes }      → A/S·점검 신청 (service_requests)
//   order   { token, pin, items:[{name, model, quantity}], note, contact } → 재주문 요청 (order_requests, 관리자 "발주 요청")

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nbgubiywavozgigiwkpr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_L4FVvZBPaNF9BQtoadoPRw_3HeNlPRL';

const COMPANY = { name: '대원메디칼', phone: '02-2202-0615' };
// 발주 담당(owner) → 화면에 보여줄 담당 영업. 나중에 병원별로 달라질 수 있음
const OWNER_NAMES = { 최: '최윤철', 권: '권우혁', 성: '성현기' };
// 장비가 아닌 줄 (할인·운송·선입금 등)은 보유 장비·재주문에서 뺌
const NOT_EQUIPMENT_RE = /할인|discount|배송|운송|운임|택배|용달|퀵|설치비|선입금|계약금|잔금|중도금/i;
// 재주문 목록에서 위로 올릴 소모품처럼 보이는 이름
// (핫팩 "기계"는 장비라서 핫팩 뒤에 기/유닛/unit이 붙으면 제외)
const CONSUMABLE_RE = /소모품|젤|gel|패드|pad|시트|sheet|롤|거즈|장갑|커버|필터|filter|전극|핫팩(?!\s*(기|유닛|가온))|베개|메트|매트|타올|수건|시린지|syringe|tray|jar|컵|cup|팁|tip|바늘|needle/i;

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
  if (!res.ok) throw new Error(`DB ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_()（）\[\],./·]/g, '');
const dayGap = (a, b) => Math.abs((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
const enc = encodeURIComponent;
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
// 예전 엑셀 임포트 품목명 "OperatingTableAcc" → "Operating Table Acc" (영문 붙여쓰기만)
const prettyName = (s) => /^[A-Za-z][A-Za-z0-9]*$/.test(String(s || '')) ? String(s).replace(/([a-z])([A-Z])/g, '$1 $2') : String(s || '');

// 링크 코드: 예전 전체 토큰(UUID 36자) 또는 짧은 링크 /h/<토큰 앞 8자리>
async function findHospital(token) {
  const sel = 'select=id,name,address,contact_name,phone,hospital_code,access_pin,business_reg_no';
  let rows = [];
  if (isUuid(token)) rows = await sb(`hospitals?token=eq.${token}&${sel}`);
  else if (/^[0-9a-f]{8}$/i.test(String(token || ''))) rows = await sb(`hospitals?token=like.${String(token).toLowerCase()}*&${sel}`);
  return rows.length === 1 ? rows[0] : null; // 앞 8자리가 겹치면(거의 없음) 열지 않음
}

// 접속 코드 = 병원 사업자등록번호 10자리 (사용자 결정 2026-11-04). 사업자번호가 없는 병원만 예전 PIN
const bizNo = (h) => { const d = String(h?.business_reg_no || '').replace(/\D/g, ''); return d.length === 10 ? d : null; };
const loginKind = (h) => (bizNo(h) ? 'bizno' : (String(h?.access_pin || '').trim() ? 'pin' : null));

// 링크+접속코드 확인. 틀리면 null (응답 지연으로 무작위 대입을 느리게)
async function auth(token, pin) {
  const h = await findHospital(token);
  const kind = loginKind(h);
  const input = String(pin || '').trim();
  const ok = kind === 'bizno' ? input.replace(/\D/g, '') === bizNo(h)
    : kind === 'pin' ? input === String(h.access_pin).trim()
    : false;
  if (!ok) { await new Promise((r) => setTimeout(r, 600)); return null; }
  return h;
}

async function loadBundle(h) {
  const [deliveries, pos, invoices, services, orders] = await Promise.all([
    sb(`deliveries?hospital_id=eq.${h.id}&select=id,delivered_date,doc_no,delivery_items(item_name,model_name,spec,quantity)&order=delivered_date.desc`),
    sb(`purchase_orders?hospital_id=eq.${h.id}&status=neq.${enc('취소')}` +
      `&select=id,po_no,ordered_at,created_at,status,tracking_delivered,tracking_delivered_at,owner,purchase_order_items(item_name,model_name,quantity,equipment_id,delivered,delivered_at)` +
      `&order=po_no.desc`),
    sb(`tax_invoices?kind=eq.sale&hospital_id=eq.${h.id}&select=issue_date,memo&order=issue_date.desc`),
    sb(`service_requests?hospital_id=eq.${h.id}&select=id,equipment_name,model_name,issue,status,requested_at,engineer,created_at&order=created_at.desc`),
    sb(`order_requests?site=eq.${enc(h.name)}&requester=eq.${enc('병원 포털')}&select=id,model_name,quantity,status,created_at&order=created_at.desc&limit=100`),
  ]);

  // 장비 마스터 — 발주 품목은 equipment_id로, 납품 품목은 모델명으로 연결 (사진·분류)
  const eqIds = [...new Set(pos.flatMap((p) => p.purchase_order_items.map((i) => i.equipment_id)).filter(isUuid))];
  const models = [...new Set(deliveries.flatMap((d) => d.delivery_items.map((i) => String(i.model_name || '').trim())).filter((m) => m.length >= 2))];
  const eqSelect = 'id,item_name,model_name,manufacturer,vendor,cat_name,category,image_url';
  const eqRows = [
    ...(eqIds.length ? await sb(`equipment?id=in.(${eqIds.join(',')})&select=${eqSelect}`) : []),
    ...(models.length ? await sb(`equipment?model_name=in.(${models.map((m) => `"${m.replace(/"/g, '')}"`).map(enc).join(',')})&select=${eqSelect}`) : []),
  ];
  const eqById = new Map(eqRows.map((e) => [e.id, e]));
  const eqByModel = new Map(eqRows.filter((e) => e.model_name).map((e) => [norm(e.model_name), e]));
  const eqView = (e) => e && {
    category: e.cat_name || e.category || null,
    // 제조사가 매입처와 같게 저장된 장비(스크립트로 등록된 것)는 매입처일 수 있어서 안 보여줌
    maker: e.manufacturer && e.manufacturer !== e.vendor ? e.manufacturer : null,
    image: e.image_url || null,
  };

  // 품목 이벤트 (주문/납품) → 같은 장비끼리 묶기
  const events = [];
  for (const d of deliveries) {
    for (const it of d.delivery_items) {
      const label = `${it.item_name || ''} ${it.model_name || ''}`;
      if (!it.item_name && !it.model_name) continue;
      if (NOT_EQUIPMENT_RE.test(label)) continue;
      const eq = eqByModel.get(norm(it.model_name));
      events.push({ type: '납품', date: d.delivered_date, ref: d.doc_no || null, name: it.item_name || it.model_name, model: it.model_name || '', qty: Number(it.quantity) || 1, eq });
    }
  }
  for (const p of pos) {
    const date = String(p.ordered_at || p.created_at || '').slice(0, 10);
    const poDelivered = !!p.tracking_delivered || p.status === '납품완료';
    for (const it of p.purchase_order_items) {
      const label = `${it.item_name || ''} ${it.model_name || ''}`;
      if (NOT_EQUIPMENT_RE.test(label)) continue;
      const eq = eqById.get(it.equipment_id) || eqByModel.get(norm(it.model_name));
      events.push({
        type: '주문', date, ref: p.po_no, name: it.item_name || it.model_name, model: it.model_name || '', qty: Number(it.quantity) || 1, eq,
        delivered: poDelivered || !!it.delivered,
        deliveredAt: String(it.delivered_at || p.tracking_delivered_at || '').slice(0, 10) || null,
        owner: p.owner || null,
      });
    }
  }
  const groups = new Map();
  for (const ev of events) {
    const key = ev.eq?.id || `${norm(ev.name)}|${norm(ev.model)}`;
    if (!groups.has(key)) groups.set(key, { key, name: ev.name, model: ev.model, eq: ev.eq, events: [] });
    const g = groups.get(key);
    if (!g.eq && ev.eq) g.eq = ev.eq;
    g.events.push(ev);
  }

  const openSvc = services.filter((s) => s.status !== '완료');
  const equipment = [...groups.values()].map((g) => {
    const dels = g.events.filter((e) => e.type === '납품');
    // 납품 기록과 90일 안에 있는 주문은 같은 건 → 수량은 납품 쪽만 셈 (이력에는 둘 다)
    const orders = g.events.filter((e) => e.type === '주문');
    const ownOrders = orders.filter((o) => !dels.some((d) => d.date && o.date && dayGap(d.date, o.date) <= 90));
    const qty = dels.reduce((s, e) => s + e.qty, 0) + ownOrders.reduce((s, e) => s + e.qty, 0);
    const dates = g.events.map((e) => e.date).filter(Boolean).sort();
    const pending = ownOrders.filter((o) => !o.delivered);
    const nameKey = norm(g.name), modelKey = norm(g.model);
    const svc = services.filter((s) => (nameKey && norm(s.equipment_name) === nameKey) || (modelKey && norm(s.model_name) === modelKey));
    const timeline = [
      ...g.events.map((e) => ({
        date: e.date,
        title: e.type === '납품' ? '납품' : (e.delivered ? '주문 · 납품 완료' : '주문 접수'),
        detail: `${e.qty}${e.qty > 1 ? '개' : '대'}${e.type === '납품' && e.ref ? ` · ${e.ref}` : ''}`,
      })),
      ...svc.map((s) => ({ date: String(s.requested_at || s.created_at || '').slice(0, 10), title: `점검·수리 ${s.status || '접수'}`, detail: s.issue || '' })),
    ].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return {
      key: g.key,
      name: prettyName(g.name),
      model: g.model,
      ...(eqView(g.eq) || { category: null, maker: null, image: null }),
      qty,
      firstDate: dates[0] || null,
      lastDate: dates[dates.length - 1] || null,
      purchases: dels.length + ownOrders.length,
      // 납품 기록도, 납품 체크도 없이 주문만 있으면 "주문 접수" (발주를 나중에 입력하는 경우가 많아 단정하지 않음)
      state: dels.length === 0 && pending.length === ownOrders.length && ownOrders.length > 0 ? 'ordered' : 'delivered',
      openService: svc.some((s) => openSvc.includes(s)),
      timeline,
    };
  }).sort((a, b) => String(b.lastDate).localeCompare(String(a.lastDate)) || a.name.localeCompare(b.name));

  // 재주문 후보 — 전에 받은 품목 전부. 소모품처럼 보이는 것 → 여러 번 산 것 → 최근 순
  const reorder = equipment
    .map((e) => ({ key: e.key, name: e.name, model: e.model, category: e.category, image: e.image, lastDate: e.lastDate, purchases: e.purchases, consumable: CONSUMABLE_RE.test(`${e.name} ${e.model} ${e.category || ''}`) }))
    .sort((a, b) => (b.consumable - a.consumable) || (b.purchases - a.purchases) || String(b.lastDate).localeCompare(String(a.lastDate)));

  // 문서함 — 금액 없이 날짜·품목만
  const summary = (items) => {
    const names = items.map((i) => `${prettyName(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}`);
    return names.length > 4 ? `${names.slice(0, 4).join(', ')} 외 ${names.length - 4}건` : names.join(', ');
  };
  const orderByDate = new Map();
  for (const ev of events.filter((e) => e.type === '주문')) {
    if (!orderByDate.has(ev.date)) orderByDate.set(ev.date, []);
    orderByDate.get(ev.date).push(ev);
  }
  const documents = {
    orders: [...orderByDate.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, items]) => ({ date, summary: summary(items), count: items.length })),
    deliveries: deliveries.map((d) => {
      const items = d.delivery_items.filter((i) => !NOT_EQUIPMENT_RE.test(`${i.item_name || ''} ${i.model_name || ''}`)).map((i) => ({ name: i.item_name || i.model_name, qty: Number(i.quantity) || 1 }));
      return { date: d.delivered_date, docNo: d.doc_no || null, summary: summary(items), count: items.length };
    }),
    invoices: invoices.map((t) => ({ date: t.issue_date, summary: String(t.memo || '').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/^납품\s*:\s*/, '') || '세금계산서 발행' })),
  };

  const latestOwner = pos.find((p) => p.owner)?.owner || null;
  return {
    hospital: { name: h.name, address: h.address || null, contact: h.contact_name || null, code: h.hospital_code || null },
    rep: latestOwner && OWNER_NAMES[latestOwner] ? { name: OWNER_NAMES[latestOwner] } : null,
    company: COMPANY,
    today: todayKST(),
    equipment,
    reorder,
    documents,
    services: services.map((s) => ({
      id: s.id, equipment: s.equipment_name || '', model: s.model_name || '', issue: s.issue || '', status: s.status || '접수',
      date: String(s.requested_at || s.created_at || '').slice(0, 10), engineer: s.engineer || null,
    })),
    myOrders: orders.map((o) => ({ id: o.id, item: o.model_name || '', quantity: o.quantity, status: o.status, date: String(o.created_at || '').slice(0, 10) })),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { action, token, pin } = body;

    if (action === 'check') {
      const h = await findHospital(token);
      const kind = loginKind(h);
      res.status(200).json({ ok: !!kind, login: kind }); // login: 'bizno' | 'pin' — 입력 안내 문구용 (번호 자체는 안 보냄)
      return;
    }

    const h = await auth(token, pin);
    if (!h) { res.status(401).json({ error: '접속 코드가 올바르지 않습니다.' }); return; }

    if (action === 'load') {
      res.status(200).json(await loadBundle(h));
      return;
    }

    if (action === 'service') {
      const issue = clip(body.issue, 2000);
      const equipmentName = clip(body.equipment_name, 200);
      if (!issue) { res.status(400).json({ error: '증상을 적어 주세요.' }); return; }
      await sb('service_requests', {
        method: 'POST',
        body: JSON.stringify({
          hospital_id: h.id,
          hospital_name: h.name,
          equipment_name: equipmentName || null,
          model_name: clip(body.model_name, 200) || null,
          issue,
          notes: ['[병원 포털 신청]', clip(body.contact, 100) && `연락처: ${clip(body.contact, 100)}`, clip(body.notes, 1000)].filter(Boolean).join(' '),
          requested_at: todayKST(),
          status: '접수',
        }),
      });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'order') {
      const items = (Array.isArray(body.items) ? body.items : [])
        .map((i) => ({ label: clip(`${i.name || ''} ${i.model || ''}`, 200), quantity: Math.max(1, Math.min(9999, Math.round(Number(i.quantity) || 0))) }))
        .filter((i) => i.label && i.quantity > 0)
        .slice(0, 50);
      if (!items.length) { res.status(400).json({ error: '주문할 품목을 담아 주세요.' }); return; }
      const note = clip(body.note, 1000);
      const contact = clip(body.contact, 100);
      // order_requests 실제 테이블엔 contact 칸이 없음(SQL 20 파일과 다름) → 내용에 같이 적음
      const content = ['병원 포털 재주문', note, contact && `연락처: ${contact}`].filter(Boolean).join(' · ');
      await sb('order_requests', {
        method: 'POST',
        body: JSON.stringify(items.map((i) => ({
          requester: '병원 포털',
          site: h.name,
          content,
          model_name: i.label,
          quantity: i.quantity,
          status: '대기',
        }))),
      });
      res.status(200).json({ ok: true, count: items.length });
      return;
    }

    res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('[portal]', e);
    res.status(500).json({ error: '잠시 후 다시 시도해 주세요.' });
  }
}

// 로컬 테스트용
export { loadBundle, findHospital };
