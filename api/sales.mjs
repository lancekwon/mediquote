// 영업사원 앱 전용 서버 (POST /api/sales { action, ... }, Authorization: Bearer <로그인 토큰>)
// 로그인한 영업사원에게 허용된 것만 돌려줌: 담당 병원, 판매 금액, 본인 견적서·메모.
// 매입가(unit_price, purchase_price)·이익·매입처는 여기서 아예 조회하지 않음.
import crypto from 'node:crypto';
import { SUPABASE_URL, SUPABASE_KEY, getLoginEmail } from './_auth.mjs';
import { ensureDocShares } from './_docshare.mjs';
import { invoiceWriteDate } from '../lib/statement_doc.mjs';

const enc = encodeURIComponent;
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
const todayKST = (offsetDays = 0) => new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const dayGap = (a, b) => Math.abs(new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000;
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_()（）\[\],./·]/g, '');
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

const NOT_EQUIPMENT_RE = /할인|discount|배송|운송|운임|택배|용달|퀵|설치비|선입금|계약금|잔금|중도금/i; // api/portal.mjs와 같은 기준
const CONSUMABLE_CAT = '소모품';
const DEFAULT_REORDER_DAYS = 90; // 한 번만 산 소모품은 주기를 알 수 없어 3개월로 봄
const REORDER_NOTICE_DAYS = 7;   // 예상일 일주일 전부터 알림
const QUOTE_BASE_URL = process.env.QUOTE_BASE_URL || 'https://my.dwmedi.kr';
const MAX_SHARE_HTML = 3 * 1024 * 1024;

const HOSPITAL_FIELDS = 'id,name,address,phone,contact_name,contact_phone';
const DRAFT_FIELDS = 'id,hospital_id,hospital_name,items,total_amount,created_at';
const PO_FIELDS = 'id,hospital_id,ordered_at,created_at,status,delivery_date,tracking_delivered,purchase_order_items(item_name,model_name,quantity,sale_price,delivered,equipment_id)';
const SERVICE_FIELDS = 'id,hospital_id,equipment_name,model_name,issue,status,requested_at,created_at,engineer';
const SERVICE_OPEN = `or=(status.is.null,status.neq.${enc('완료')})`;
const NOTE_FIELDS = 'id,rep_id,hospital_id,draft_id,body,next_contact_date,contacted_at,created_at,sales_reps(name)';
// 출고지시서·매출정산서 (sql/50). 품목의 매입가(purchase_price)·거래처(manufacturer_id)는 절대 넣지 말 것
const ORDER_FIELDS = 'id,order_no,draft_id,hospital_id,hospital_name,delivery_date,delivery_place,memo,sale_total,status,reject_reason,approved_by,approved_at,created_at';
const ORDER_ITEM_FIELDS = 'id,sort,item_name,model_name,quantity,sale_price,is_discount,po_id';
const SETTLE_FIELDS = 'id,order_id,hospital_id,buyer_name,buyer_address,buyer_reg_no,buyer_ceo,buyer_email,issue_date,supply_amount,tax_amount,total_amount,items,memo,status,reject_reason,handled_at,created_at';
const DISCOUNT_EQUIP_CODE = 'E714'; // 범용 "할인" 장비
const STATEMENT_FIELDS = 'id,statement_date,issue_date,issued_at,hospital_name,hospital_address,supplier,items,subtotal,discount_total,total';

// 매출 세금계산서 목록 — 우리 메모의 "[병원] 납품:" 머리와 " — " 뒤 설명은 빼고 보여줌 (api/portal.mjs와 같은 기준)
const invoiceText = (m) => String(m || '').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/^납품\s*:\s*/, '').split(/\s+—\s+/)[0].trim();
// 취소된 원본과 그 취소(마이너스) 계산서는 짝지어 뺌 — 재발행 건만 남음
function invoiceList(rows) {
  const list = rows.map((t) => ({ ...t, amt: Number(t.amount) || 0 }));
  const gone = new Set();
  for (const neg of list.filter((t) => t.amt < 0)) {
    const cands = list.filter((t) => t.amt === -neg.amt && !gone.has(t.id));
    if (!cands.length) continue;
    const orig = cands.find((t) => /^\s*(\[[^\]]*\]\s*)?원본/.test(t.memo || ''))
      || [...cands].sort((a, b) => String(a.issue_date).localeCompare(String(b.issue_date)))[0];
    gone.add(neg.id); gone.add(orig.id);
  }
  return {
    hidden: gone.size,
    // 날짜 = 계산서 작성일자 (승인번호 앞 8자리). 수정 재발행이면 클로브 발급일과 다름 (아이비: 작성 11/17, 발급 11/20)
    invoices: list.filter((t) => !gone.has(t.id))
      .map((t) => ({ id: t.id, date: invoiceWriteDate(t), amount: t.amt, has_pdf: !!t.pdf_path, summary: invoiceText(t.memo) || (t.amt < 0 ? '수정 세금계산서' : '세금계산서') }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date))),
  };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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
  if (!res.ok) throw new Error(`Supabase ${res.status} ${path}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function fetchAll(path) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await sb(`${path}&limit=1000&offset=${offset}`);
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

async function assignedHospital(rep, id) {
  if (!isUuid(id)) throw new HttpError(400, '병원 정보가 잘못됐습니다.');
  const [hospital] = await sb(`hospitals?id=eq.${id}&assigned_rep_id=eq.${rep.id}&select=${HOSPITAL_FIELDS}`);
  if (!hospital) throw new HttpError(404, '담당 병원이 아닙니다.');
  return hospital;
}

async function ownDraft(rep, id, select = DRAFT_FIELDS) {
  if (!isUuid(id)) throw new HttpError(400, '견적서 정보가 잘못됐습니다.');
  const [draft] = await sb(`quotes_ai_draft?id=eq.${id}&owner=eq.${enc(rep.email)}&status=eq.draft&select=${select}`);
  if (!draft) throw new HttpError(404, '내 견적서가 아닙니다.');
  return draft;
}

const consumableMap = async () => new Map(
  (await fetchAll(`equipment?or=(cat_name.eq.${enc(CONSUMABLE_CAT)},category.eq.${enc(CONSUMABLE_CAT)})&select=id,item_name,model_name&order=id`))
    .map((e) => [e.id, e]),
);

// 소모품 재주문 — 산 날짜 간격의 평균이 주기. 예상일 일주일 전부터, 더 급한 순으로
function findReorders(pos, consumables, hospitalName) {
  const today = todayKST();
  const groups = new Map();
  for (const p of pos) {
    const date = String(p.ordered_at || p.created_at || '').slice(0, 10);
    if (!date) continue;
    for (const it of p.purchase_order_items || []) {
      const eq = consumables.get(it.equipment_id);
      if (!eq || (it.quantity != null && Number(it.quantity) <= 0)) continue;
      const key = `${p.hospital_id}|${it.equipment_id}`;
      if (!groups.has(key)) groups.set(key, { hospital_id: p.hospital_id, name: eq.item_name, model: eq.model_name || '', dates: new Set() });
      groups.get(key).dates.add(date);
    }
  }
  const out = [];
  for (const g of groups.values()) {
    const dates = [...g.dates].sort();
    const last = dates[dates.length - 1];
    const measured = dates.length >= 2;
    const cycle = measured ? Math.max(7, Math.round(dayGap(dates[0], last) / (dates.length - 1))) : DEFAULT_REORDER_DAYS;
    const since = dayGap(last, today);
    const dueIn = cycle - since;
    if (dueIn > REORDER_NOTICE_DAYS) continue;
    out.push({ hospital_id: g.hospital_id, hospital_name: hospitalName(g.hospital_id), name: g.name, model: g.model, last_date: last, days_since: since, cycle_days: measured ? cycle : null, due_in: dueIn });
  }
  return out.sort((a, b) => a.due_in - b.due_in);
}

// 납품·주문 내역 (판매 금액). 납품 기록과 90일 안에 있는 같은 품목의 주문은 같은 건이라 한 번만 (portal과 같은 기준)
function buildHistory(pos, deliveries) {
  const rows = [];
  const label = (it) => `${it.item_name || ''} ${it.model_name || ''}`;
  for (const d of deliveries) {
    for (const it of d.delivery_items || []) {
      if ((!it.item_name && !it.model_name) || NOT_EQUIPMENT_RE.test(label(it))) continue;
      rows.push({
        key: norm(it.model_name || it.item_name), date: String(d.delivered_date || '').slice(0, 10),
        name: it.item_name || it.model_name, model: it.item_name ? (it.model_name || '') : '',
        qty: Number(it.quantity) || 1, amount: it.total_amount ?? null, delivered: true, eta: null,
      });
    }
  }
  const deliveredRows = rows.slice();
  for (const p of pos) {
    const date = String(p.ordered_at || p.created_at || '').slice(0, 10);
    const poDone = !!p.tracking_delivered || p.status === '납품완료';
    for (const it of p.purchase_order_items || []) {
      if (NOT_EQUIPMENT_RE.test(label(it))) continue;
      if (it.quantity != null && Number(it.quantity) <= 0) continue;
      const key = norm(it.model_name || it.item_name);
      if (deliveredRows.some((d) => d.key === key && d.date && date && dayGap(d.date, date) <= 90)) continue;
      const qty = Number(it.quantity) || 1;
      rows.push({
        key, date, name: it.item_name || it.model_name, model: it.item_name ? (it.model_name || '') : '',
        qty, amount: it.sale_price != null ? Number(it.sale_price) * qty : null,
        delivered: poDone || !!it.delivered, eta: p.delivery_date || null,
      });
    }
  }
  return rows.sort((a, b) => String(b.date).localeCompare(String(a.date))).map(({ key, ...r }) => r);
}

const noteView = ({ sales_reps: author, ...n }) => ({ ...n, author: author?.name || '' });

async function home(rep) {
  const today = todayKST();
  const hospitals = await sb(`hospitals?assigned_rep_id=eq.${rep.id}&select=${HOSPITAL_FIELDS}&order=name`);
  const ids = hospitals.map((h) => h.id).join(',');
  const hospitalName = (id) => hospitals.find((h) => h.id === id)?.name || '';
  const [drafts, notes, services, pos, consumables, orders] = await Promise.all([
    sb(`quotes_ai_draft?owner=eq.${enc(rep.email)}&status=eq.draft&select=${DRAFT_FIELDS}&order=created_at.desc&limit=3`),
    sb(`sales_notes?rep_id=eq.${rep.id}&contacted_at=is.null&next_contact_date=lte.${today}&select=id,body,next_contact_date,hospital_id,draft_id,hospitals(name,phone,contact_phone),quotes_ai_draft(hospital_name)&order=next_contact_date`),
    ids ? sb(`service_requests?hospital_id=in.(${ids})&${SERVICE_OPEN}&select=${SERVICE_FIELDS}&order=created_at.desc&limit=20`) : [],
    ids ? sb(`purchase_orders?hospital_id=in.(${ids})&status=neq.${enc('취소')}&select=${PO_FIELDS}`) : [],
    ids ? consumableMap() : new Map(),
    myOrders(rep, 30),
  ]);
  const followups = notes.map((n) => ({
    id: n.id, body: n.body, next_contact_date: n.next_contact_date, hospital_id: n.hospital_id, draft_id: n.draft_id,
    name: n.hospitals?.name || n.quotes_ai_draft?.hospital_name || '이름 없는 견적',
    phone: n.hospitals?.contact_phone || n.hospitals?.phone || null,
  }));
  const week = todayKST(7);
  const upcoming = pos
    .filter((p) => p.delivery_date && p.delivery_date >= today && p.delivery_date <= week && !p.tracking_delivered && p.status !== '납품완료')
    .sort((a, b) => a.delivery_date.localeCompare(b.delivery_date))
    .map((p) => {
      const items = (p.purchase_order_items || []).filter((i) => !NOT_EQUIPMENT_RE.test(`${i.item_name || ''} ${i.model_name || ''}`));
      return {
        id: p.id, hospital_id: p.hospital_id, hospital_name: hospitalName(p.hospital_id), delivery_date: p.delivery_date,
        summary: items.length ? `${items[0].model_name || items[0].item_name}${items.length > 1 ? ` 외 ${items.length - 1}건` : ''}` : '품목 없음',
      };
    });
  return {
    rep: { id: rep.id, name: rep.name },
    hospitals,
    drafts,
    followups,
    services: services.map((s) => ({ ...s, hospital_name: hospitalName(s.hospital_id) })),
    reorders: findReorders(pos, consumables, hospitalName).slice(0, 5),
    upcoming,
    // 진행 중인 출고지시서 (계산서 발행·취소된 건 빼고)
    orders: orders.filter((o) => o.stage !== 'invoiced' && o.stage !== 'cancelled').slice(0, 5),
  };
}

async function hospitalDetail(rep, id) {
  const hospital = await assignedHospital(rep, id);
  const nameFilter = `hospital_name.eq."${String(hospital.name).replace(/"/g, '\\"')}"`;
  const [pos, deliveries, drafts, notes, services, consumables, invoices, statements] = await Promise.all([
    sb(`purchase_orders?hospital_id=eq.${id}&status=neq.${enc('취소')}&select=${PO_FIELDS}`),
    sb(`deliveries?hospital_id=eq.${id}&select=delivered_date,delivery_items(item_name,model_name,quantity,total_amount)`),
    sb(`quotes_ai_draft?owner=eq.${enc(rep.email)}&status=eq.draft&or=(hospital_id.eq.${id},${enc(nameFilter)})&select=${DRAFT_FIELDS}&order=created_at.desc&limit=10`),
    sb(`sales_notes?hospital_id=eq.${id}&select=${NOTE_FIELDS}&order=created_at.desc&limit=50`),
    sb(`service_requests?hospital_id=eq.${id}&${SERVICE_OPEN}&select=${SERVICE_FIELDS}&order=created_at.desc`),
    consumableMap(),
    sb(`tax_invoices?kind=eq.sale&hospital_id=eq.${id}&select=id,issue_date,clobe_ti_id,amount,memo,pdf_path&order=issue_date.desc&limit=300`),
    // 병원 포털과 같게 공개(shared)된 것만 — 관리자가 숨긴 건 옛 버전·잘못 뽑은 것
    sb(`hospital_statements?hospital_id=eq.${id}&shared=is.true&select=${STATEMENT_FIELDS}&order=statement_date.desc,issued_at.desc`),
  ]);
  const inv = invoiceList(invoices);
  return {
    hospital,
    history: buildHistory(pos, deliveries),
    drafts,
    notes: notes.map(noteView),
    services,
    reorders: findReorders(pos, consumables, () => hospital.name),
    invoices: inv.invoices,
    invoices_hidden: inv.hidden,
    statements, // 관리자가 발행한 거래명세서 사본 (발행 당시 품목·매출 단가 그대로)
  };
}

// 세금계산서 한 장 = 관리자가 올린 홈택스 PDF 그대로 (2026-11-20 사용자: 원장님이 받는 것과 똑같이).
// PDF는 비공개 보관함(tax-invoices)에 있고, 담당 병원 계산서일 때만 10분짜리 서명 링크를 줌
const TAX_PDF_BUCKET = 'tax-invoices';
async function signTaxPdf(path) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${TAX_PDF_BUCKET}/${String(path).split('/').map(enc).join('/')}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 600 }),
  });
  if (!r.ok) throw new Error(`storage sign ${r.status}: ${await r.text()}`);
  const { signedURL } = await r.json();
  return `${SUPABASE_URL}/storage/v1${signedURL}`;
}

async function invoiceDetail(rep, id) {
  if (!isUuid(id)) throw new HttpError(400, '계산서 정보가 잘못됐습니다.');
  const [t] = await sb(`tax_invoices?id=eq.${id}&kind=eq.sale&select=id,issue_date,clobe_ti_id,amount,memo,hospital_id,pdf_path`);
  if (!t?.hospital_id) throw new HttpError(404, '계산서를 찾을 수 없습니다.');
  const hospital = await assignedHospital(rep, t.hospital_id);
  const amount = Number(t.amount) || 0;
  return {
    invoice: { id: t.id, date: invoiceWriteDate(t), amount, summary: invoiceText(t.memo) || (amount < 0 ? '수정 세금계산서' : '세금계산서') },
    hospital_name: hospital.name,
    pdf_url: t.pdf_path ? await signTaxPdf(t.pdf_path) : null,
  };
}

async function draftDetail(rep, id) {
  const draft = await ownDraft(rep, id, 'id,hospital_id,hospital_name,items,total_amount,created_at,global_discount');
  const equipIds = (draft.items || []).map((i) => i.equipment_id).filter(isUuid);
  const [equips, notes, orders] = await Promise.all([
    equipIds.length ? sb(`equipment?id=in.(${equipIds.join(',')})&select=id,cat_id,cat_name,item_name,model_name,manufacturer,price,image_url,description,specs,cert,as_period,model_notes`) : [],
    sb(`sales_notes?draft_id=eq.${id}&select=${NOTE_FIELDS}&order=created_at.desc&limit=50`),
    sb(`shipping_orders?draft_id=eq.${id}&rep_id=eq.${rep.id}&select=id,order_no,status,created_at&order=created_at.desc&limit=1`),
  ]);
  return { draft, equips, notes: notes.map(noteView), order: orders[0] || null };
}

// ============================================================
// 출고지시서 (영업사원 → 관리자 승인 → 거래처별 발주)
// ============================================================
const poDone = (p) => !!p.tracking_delivered || p.status === '납품완료' || !!p.delivered;

// 견적서 → 출고지시서 품목 줄. 매출 단가는 견적 그대로(부가세 포함), 견적 전체 할인은 "할인" 줄 하나로 따로 (사용자 2026-11-20)
async function draftLines(draft) {
  const raw = Array.isArray(draft.items) ? draft.items : [];
  const ids = [...new Set(raw.map((i) => i.equipment_id).filter(isUuid))];
  const equips = ids.length ? await sb(`equipment?id=in.(${ids.join(',')})&select=id,item_name,model_name`) : [];
  const lines = [];
  for (const i of raw) {
    const e = equips.find((x) => x.id === i.equipment_id);
    const name = clip(e?.item_name || i.name, 200);
    if (!name) continue;
    const qty = Math.max(1, Math.round(Number(i.qty) || 1));
    const unit = Number.isFinite(Number(i.unit_price)) && i.unit_price != null ? Math.round(Number(i.unit_price)) : Math.round((Number(i.total) || 0) / qty);
    lines.push({ equipment_id: e?.id || null, item_name: name, model_name: e ? (e.model_name || null) : null, quantity: qty, sale_price: unit, is_discount: false });
  }
  const gross = lines.reduce((s, l) => s + l.quantity * l.sale_price, 0);
  const d = draft.global_discount || null;
  const discount = d?.type === 'rate' ? Math.round(gross * (Number(d.value) || 0) / 100)
    : d?.type === 'amount' ? Math.min(Math.round(Number(d.value) || 0), gross) : 0;
  if (discount > 0) {
    const [eq] = await sb(`equipment?equip_code=eq.${DISCOUNT_EQUIP_CODE}&select=id`);
    lines.push({ equipment_id: eq?.id || null, item_name: '할인', model_name: null, quantity: 1, sale_price: -discount, is_discount: true });
  }
  return { lines, total: gross - discount };
}

// 영업사원 앱에 보여줄 진행 단계 — 발주 납품 여부와 정산서 상태로 계산
async function withStage(orders) {
  if (!orders.length) return [];
  const poIds = [...new Set(orders.flatMap((o) => (o.shipping_order_items || []).map((i) => i.po_id)).filter(Boolean))];
  const [pos, settles] = await Promise.all([
    poIds.length ? sb(`purchase_orders?id=in.(${poIds.join(',')})&select=id,status,tracking_delivered,delivered`) : [],
    sb(`sales_settlements?order_id=in.(${orders.map((o) => o.id).join(',')})&status=in.(${enc('요청')},${enc('발행완료')})&select=id,order_id,status,total_amount,issue_date`),
  ]);
  return orders.map((o) => {
    const ids = [...new Set((o.shipping_order_items || []).map((i) => i.po_id).filter(Boolean))];
    const live = ids.map((id) => pos.find((p) => p.id === id)).filter((p) => p && p.status !== '취소');
    const delivered = live.filter(poDone).length;
    const settlement = settles.find((s) => s.order_id === o.id) || null;
    const stage = o.status === '요청' ? 'requested' : o.status === '반려' ? 'rejected' : o.status === '취소' ? 'cancelled'
      : settlement?.status === '발행완료' ? 'invoiced' : settlement ? 'settle_requested'
      : live.length && delivered === live.length ? 'delivered' : 'ordered';
    return { ...o, stage, po_count: live.length, delivered_count: delivered, settlement };
  });
}

async function ownOrder(rep, id) {
  if (!isUuid(id)) throw new HttpError(400, '출고지시서 정보가 잘못됐습니다.');
  const [order] = await sb(`shipping_orders?id=eq.${id}&rep_id=eq.${rep.id}&select=${ORDER_FIELDS},shipping_order_items(${ORDER_ITEM_FIELDS})`);
  if (!order) throw new HttpError(404, '내 출고지시서가 아닙니다.');
  order.shipping_order_items.sort((a, b) => a.sort - b.sort);
  return (await withStage([order]))[0];
}

async function myOrders(rep, limit = 100) {
  const rows = await sb(`shipping_orders?rep_id=eq.${rep.id}&select=${ORDER_FIELDS},shipping_order_items(${ORDER_ITEM_FIELDS})&order=created_at.desc&limit=${limit}`);
  return withStage(rows);
}

async function orderForm(rep, draftId) {
  const draft = await ownDraft(rep, draftId, 'id,hospital_id,hospital_name,items,total_amount,global_discount,created_at');
  const [hospitals, open] = await Promise.all([
    sb(`hospitals?assigned_rep_id=eq.${rep.id}&select=id,name,address&order=name`),
    sb(`shipping_orders?draft_id=eq.${draftId}&status=in.(${enc('요청')},${enc('승인')})&select=id,order_no,status`),
  ]);
  const { lines, total } = await draftLines(draft);
  const byName = hospitals.find((h) => salesNormName(h.name) === salesNormName(draft.hospital_name));
  const preset = hospitals.find((h) => h.id === draft.hospital_id) || byName || null;
  return { draft: { id: draft.id, hospital_name: draft.hospital_name }, hospitals, hospital_id: preset?.id || null, lines, total, open: open[0] || null };
}
const salesNormName = (s) => norm(s).replace(/의원|병원|한의원|클리닉/g, '');

async function nextOrderNo() {
  const prefix = `출고-${todayKST().slice(0, 4)}-`;
  const [last] = await sb(`shipping_orders?order_no=like.${enc(prefix)}*&select=order_no&order=order_no.desc&limit=1`);
  const n = last ? parseInt(last.order_no.slice(prefix.length), 10) || 0 : 0;
  return `${prefix}${String(n + 1).padStart(3, '0')}`;
}

async function createOrder(rep, body) {
  const draft = await ownDraft(rep, body.draft_id, 'id,hospital_id,hospital_name,items,total_amount,global_discount');
  if (!body.hospital_id) throw new HttpError(400, '병원을 골라 주세요. 목록에 없으면 관리자에게 병원 등록·담당 지정을 부탁하세요.');
  const hospital = await assignedHospital(rep, body.hospital_id); // 등록 먼저 (사용자 2026-11-20): 담당 병원만
  const open = await sb(`shipping_orders?draft_id=eq.${draft.id}&status=in.(${enc('요청')},${enc('승인')})&select=id`);
  if (open.length) throw new HttpError(409, '이 견적서로 낸 출고지시서가 이미 있습니다.');
  const { lines, total } = await draftLines(draft);
  if (!lines.some((l) => !l.is_discount)) throw new HttpError(400, '견적서에 품목이 없습니다.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.delivery_date || '') ? body.delivery_date : null;
  let order = null;
  for (let tries = 0; !order; tries++) {
    try {
      [order] = await sb('shipping_orders', {
        method: 'POST',
        body: JSON.stringify({
          order_no: await nextOrderNo(), rep_id: rep.id, rep_name: rep.name, draft_id: draft.id,
          hospital_id: hospital.id, hospital_name: hospital.name, delivery_date: date,
          delivery_place: clip(body.delivery_place, 300) || hospital.address || null, memo: clip(body.memo, 2000) || null,
          sale_total: total,
        }),
      });
    } catch (e) {
      if (tries < 3 && /409|23505/.test(e.message) && /order_no/.test(e.message)) continue; // 번호가 겹치면 다시
      if (/23505/.test(e.message)) throw new HttpError(409, '이 견적서로 낸 출고지시서가 이미 있습니다.');
      throw e;
    }
  }
  try {
    await sb('shipping_order_items', { method: 'POST', body: JSON.stringify(lines.map((l, i) => ({ ...l, order_id: order.id, sort: i }))) });
  } catch (e) {
    await sb(`shipping_orders?id=eq.${order.id}`, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
  return { order: await ownOrder(rep, order.id) };
}

async function cancelOrder(rep, id) {
  const order = await ownOrder(rep, id);
  if (order.status !== '요청') throw new HttpError(409, '관리자가 이미 처리한 출고지시서는 취소할 수 없습니다. 관리자에게 말씀해 주세요.');
  await sb(`shipping_orders?id=eq.${id}&rep_id=eq.${rep.id}&status=eq.${enc('요청')}`, { method: 'PATCH', body: JSON.stringify({ status: '취소', updated_at: new Date().toISOString() }) });
  return { order: await ownOrder(rep, id) };
}

// ============================================================
// 매출정산서 = 세금계산서 발행 요청 (납품완료 후에만 — 사용자 2026-11-20)
// ============================================================
const isRegNo = (s) => /^\d{10}$/.test(s);
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

// 품목 한 줄: 금액(부가세 포함)에서 공급가액·세액·공급가 단가 계산
function settleLine(l) {
  const qty = Math.max(1, Math.round(Number(l.qty) || 1));
  const amount = Math.round(Number(l.amount) || 0);
  const supply = Math.round(amount / 1.1);
  return { name: clip(l.name, 100), spec: clip(l.spec, 60), qty, unit_price: Math.round(supply / qty), supply, tax: amount - supply, amount };
}

async function settlementForm(rep, orderId) {
  const order = await ownOrder(rep, orderId);
  if (order.stage !== 'delivered') throw new HttpError(409, order.settlement ? '이미 계산서 발행을 요청했습니다.' : '납품이 다 끝나야 요청할 수 있습니다.');
  const [h] = await sb(`hospitals?id=eq.${order.hospital_id}&assigned_rep_id=eq.${rep.id}&select=id,name,address,business_reg_no,ceo_name,contact_name,tax_email,contact_email`);
  if (!h) throw new HttpError(404, '담당 병원이 아닙니다.');
  const items = order.shipping_order_items.map((i) => settleLine({
    name: i.is_discount ? '할인' : i.item_name, spec: i.model_name || '', qty: i.quantity, amount: i.quantity * i.sale_price,
  }));
  // 발행일 기본값 = 이 발주로 뽑은 거래명세서 날짜 (사용자 2026-11-20: 계산서 날짜와 명세서 날짜를 같은 날로)
  const poIds = [...new Set(order.shipping_order_items.map((i) => i.po_id).filter(Boolean))];
  const [stmt] = poIds.length
    ? await sb(`hospital_statements?hospital_id=eq.${order.hospital_id}&shared=is.true&po_ids=ov.{${poIds.join(',')}}&select=issue_date,statement_date&order=issued_at.desc&limit=1`)
    : [];
  return {
    order: { id: order.id, order_no: order.order_no, hospital_name: order.hospital_name, sale_total: order.sale_total },
    form: {
      buyer_name: h.name || '', buyer_address: h.address || '', buyer_reg_no: (h.business_reg_no || '').replace(/\D/g, ''),
      buyer_ceo: h.ceo_name || '', buyer_email: h.tax_email || h.contact_email || '', issue_date: stmt ? (stmt.issue_date || stmt.statement_date) : todayKST(), items,
      issue_date_from: stmt ? 'statement' : null,
    },
  };
}

async function createSettlement(rep, body) {
  const order = await ownOrder(rep, body.order_id);
  if (order.stage !== 'delivered') throw new HttpError(409, order.settlement ? '이미 계산서 발행을 요청했습니다.' : '납품이 다 끝나야 요청할 수 있습니다.');
  const f = {
    buyer_name: clip(body.buyer_name, 200), buyer_address: clip(body.buyer_address, 300),
    buyer_reg_no: String(body.buyer_reg_no || '').replace(/\D/g, ''), buyer_ceo: clip(body.buyer_ceo, 100),
    buyer_email: clip(body.buyer_email, 200).toLowerCase(), issue_date: String(body.issue_date || ''),
  };
  const missing = [
    !f.buyer_name && '병원 이름', !f.buyer_address && '주소', !isRegNo(f.buyer_reg_no) && '사업자번호 10자리',
    !f.buyer_ceo && '대표자(원장)', !isEmail(f.buyer_email) && '이메일', !/^\d{4}-\d{2}-\d{2}$/.test(f.issue_date) && '발행일',
  ].filter(Boolean);
  if (missing.length) throw new HttpError(400, `${missing.join(', ')}을(를) 확인해 주세요.`);
  const items = (Array.isArray(body.items) ? body.items : []).map(settleLine).filter((l) => l.amount !== 0);
  if (!items.length || items.some((l) => !l.name)) throw new HttpError(400, '품목 이름과 금액을 확인해 주세요.');
  const total = items.reduce((s, l) => s + l.amount, 0);
  if (total <= 0) throw new HttpError(400, '발행금액이 0원보다 커야 합니다.');

  const [h] = await sb(`hospitals?id=eq.${order.hospital_id}&assigned_rep_id=eq.${rep.id}&select=id,address,business_reg_no,ceo_name,tax_email`);
  if (!h) throw new HttpError(404, '담당 병원이 아닙니다.');
  if (!h.business_reg_no) {
    const [other] = await sb(`hospitals?business_reg_no=eq.${f.buyer_reg_no}&id=neq.${h.id}&select=name`);
    if (other) throw new HttpError(409, `사업자번호 ${f.buyer_reg_no}는 다른 병원(${other.name})에 등록돼 있습니다. 번호를 확인하거나 관리자에게 말씀해 주세요.`);
  }
  const [row] = await sb('sales_settlements', {
    method: 'POST',
    body: JSON.stringify({
      order_id: order.id, rep_id: rep.id, rep_name: rep.name, hospital_id: order.hospital_id, ...f,
      supply_amount: items.reduce((s, l) => s + l.supply, 0), tax_amount: items.reduce((s, l) => s + l.tax, 0), total_amount: total,
      items: items.map(({ amount, ...l }) => l), memo: clip(body.memo, 2000) || null,
    }),
  }).catch((e) => { if (/23505/.test(e.message)) throw new HttpError(409, '이미 계산서 발행을 요청했습니다.'); throw e; });
  // 병원 정보 채워 두기 (다음 정산서에 자동) — 사업자번호·주소는 비어 있을 때만
  const patch = { ceo_name: f.buyer_ceo, tax_email: f.buyer_email };
  if (!h.business_reg_no) patch.business_reg_no = f.buyer_reg_no;
  if (!h.address) patch.address = f.buyer_address;
  await sb(`hospitals?id=eq.${h.id}&assigned_rep_id=eq.${rep.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    .catch((e) => console.error('[sales] 정산서 병원 정보 저장 실패', e));
  return { settlement: row.id, order: await ownOrder(rep, order.id) };
}

async function settlementDetail(rep, id) {
  if (!isUuid(id)) throw new HttpError(400, '정산서 정보가 잘못됐습니다.');
  const [s] = await sb(`sales_settlements?id=eq.${id}&rep_id=eq.${rep.id}&select=${SETTLE_FIELDS}`);
  if (!s) throw new HttpError(404, '내 정산서가 아닙니다.');
  return { settlement: s };
}

async function cancelSettlement(rep, id) {
  if (!isUuid(id)) throw new HttpError(400, '정산서 정보가 잘못됐습니다.');
  const rows = await sb(`sales_settlements?id=eq.${id}&rep_id=eq.${rep.id}&status=eq.${enc('요청')}`, { method: 'PATCH', body: JSON.stringify({ status: '취소', updated_at: new Date().toISOString() }) });
  if (!rows.length) throw new HttpError(409, '이미 처리된 요청은 취소할 수 없습니다. 관리자에게 말씀해 주세요.');
  return { ok: true };
}

async function templates() {
  const rows = await sb('quotes?quote_no=like.TMPL-*&select=quote_no,categories&order=quote_no');
  return rows.flatMap((r) => {
    const rest = r.quote_no.slice(5);
    const cut = rest.lastIndexOf('-');
    if (cut === -1 || !(r.categories || []).length) return [];
    // 견적에 필요한 칸만 (메모·비고는 내보내지 않음)
    const categories = r.categories.map((c) => ({
      id: c.id, name: c.name,
      items: (c.items || []).map((i) => ({
        id: i.id, name: i.name, quantity: i.quantity, excluded: !!i.excluded, itemDiscount: i.itemDiscount || 0, selectedModelId: i.selectedModelId,
        models: (i.models || []).map((m) => ({ id: m.id, name: m.name, manufacturer: m.manufacturer, price: m.price ?? null })),
      })),
    }));
    return [{ quoteNo: r.quote_no, dept: rest.slice(0, cut), tier: rest.slice(cut + 1), categories }];
  });
}

async function addNote(rep, body) {
  const text = clip(body.body, 2000);
  if (!text) throw new HttpError(400, '메모 내용을 적어 주세요.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.next_contact_date || '') ? body.next_contact_date : null;
  if (body.hospital_id) await assignedHospital(rep, body.hospital_id);
  else await ownDraft(rep, body.draft_id, 'id');
  await sb('sales_notes', {
    method: 'POST',
    body: JSON.stringify({ rep_id: rep.id, hospital_id: body.hospital_id || null, draft_id: body.hospital_id ? null : body.draft_id, body: text, next_contact_date: date }),
  });
  return { ok: true };
}

async function doneNote(rep, id) {
  if (!isUuid(id)) throw new HttpError(400, '메모 정보가 잘못됐습니다.');
  const rows = await sb(`sales_notes?id=eq.${id}&rep_id=eq.${rep.id}`, { method: 'PATCH', body: JSON.stringify({ contacted_at: new Date().toISOString() }) });
  if (!rows.length) throw new HttpError(404, '내 메모가 아닙니다.');
  return { ok: true };
}

async function saveContact(rep, body) {
  await assignedHospital(rep, body.id);
  const patch = {
    contact_name: clip(body.contact_name, 100) || null,
    contact_phone: clip(body.contact_phone, 40) || null,
    phone: clip(body.phone, 40) || null,
    address: clip(body.address, 300) || null,
  };
  const [hospital] = await sb(`hospitals?id=eq.${body.id}&assigned_rep_id=eq.${rep.id}&select=${HOSPITAL_FIELDS}`, { method: 'PATCH', body: JSON.stringify(patch) });
  return { hospital };
}

// 카톡으로 보낼 링크 (/q/<token>)
//   견적서: 보낼 때마다 화면 사본(html)을 저장한 새 링크
//   세금계산서·거래명세서 (2026-11-20 사용자: "my. 문서함과 같은 주소"): 서류마다 고정 링크 하나 (api/_docshare.mjs)
//     — 몇 번을 보내도 같은 주소, 병원 포털 문서함 단추도 같은 주소. 화면은 열 때마다 DB에서 그림 (api/quote.mjs)
async function shareQuote(rep, body) {
  const kind = body.kind === 'tax_invoice' || body.kind === 'statement' ? body.kind : 'quote';
  if (kind === 'tax_invoice') {
    if (!isUuid(body.invoice_id)) throw new HttpError(400, '계산서 정보가 잘못됐습니다.');
    const [t] = await sb(`tax_invoices?id=eq.${body.invoice_id}&kind=eq.sale&select=id,hospital_id,pdf_path`);
    if (!t?.hospital_id || !t.pdf_path) throw new HttpError(404, '계산서 PDF를 찾을 수 없습니다.');
    const h = await assignedHospital(rep, t.hospital_id);
    const links = await ensureDocShares([{ kind, id: t.id, title: `${h.name} 세금계산서`, rep_id: rep.id }]);
    return { url: links.get(`${kind}:${t.id}`) };
  }
  if (kind === 'statement') {
    if (!isUuid(body.statement_id)) throw new HttpError(400, '명세서 정보가 잘못됐습니다.');
    const [st] = await sb(`hospital_statements?id=eq.${body.statement_id}&shared=is.true&select=id,hospital_id`);
    if (!st) throw new HttpError(404, '명세서를 찾을 수 없습니다.');
    const h = await assignedHospital(rep, st.hospital_id);
    const links = await ensureDocShares([{ kind, id: st.id, title: `${h.name} 거래명세서`, rep_id: rep.id }]);
    return { url: links.get(`${kind}:${st.id}`) };
  }
  const html = String(body.html || '');
  if (!html.startsWith('<!DOCTYPE html>')) throw new HttpError(400, '견적서 내용이 잘못됐습니다.');
  if (html.length > MAX_SHARE_HTML) throw new HttpError(413, '견적서가 너무 큽니다.');
  if (body.draft_id) await ownDraft(rep, body.draft_id, 'id');
  const token = crypto.randomBytes(12).toString('base64url');
  await sb('quote_shares', {
    method: 'POST',
    body: JSON.stringify({ token, rep_id: rep.id, draft_id: body.draft_id || null, title: clip(body.title, 200) || null, html }),
  });
  return { url: `${QUOTE_BASE_URL}/q/${token}` };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const email = await getLoginEmail(req);
    if (!email) throw new HttpError(401, '다시 로그인해 주세요.');
    const [row] = await sb(`sales_reps?email=eq.${enc(email)}&select=id,name,email`);
    if (!row) throw new HttpError(403, 'not_registered');
    const rep = row;
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    let result;
    switch (body.action) {
      case 'home': result = await home(rep); break;
      case 'hospital': result = await hospitalDetail(rep, body.id); break;
      case 'draft': result = await draftDetail(rep, body.id); break;
      case 'drafts': result = { drafts: await sb(`quotes_ai_draft?owner=eq.${enc(rep.email)}&status=eq.draft&select=${DRAFT_FIELDS}&order=created_at.desc&limit=100`) }; break;
      case 'equipment': result = { equipment: await fetchAll('equipment?select=id,cat_name,item_name,model_name,manufacturer,price,image_url&order=item_name,id') }; break;
      case 'templates': result = { templates: await templates() }; break;
      case 'add_note': result = await addNote(rep, body); break;
      case 'done_note': result = await doneNote(rep, body.id); break;
      case 'save_contact': result = await saveContact(rep, body); break;
      case 'share_quote': result = await shareQuote(rep, body); break;
      case 'invoice': result = await invoiceDetail(rep, body.id); break;
      case 'orders': result = { orders: await myOrders(rep) }; break;
      case 'order': result = { order: await ownOrder(rep, body.id) }; break;
      case 'order_form': result = await orderForm(rep, body.draft_id); break;
      case 'create_order': result = await createOrder(rep, body); break;
      case 'cancel_order': result = await cancelOrder(rep, body.id); break;
      case 'settlement_form': result = await settlementForm(rep, body.order_id); break;
      case 'create_settlement': result = await createSettlement(rep, body); break;
      case 'settlement': result = await settlementDetail(rep, body.id); break;
      case 'cancel_settlement': result = await cancelSettlement(rep, body.id); break;
      default: throw new HttpError(400, 'unknown action');
    }
    res.status(200).json(result);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error('[sales]', e);
    res.status(e.status || 500).json({ error: e instanceof HttpError ? e.message : '처리하지 못했습니다. 잠시 뒤 다시 해 주세요.' });
  }
}
