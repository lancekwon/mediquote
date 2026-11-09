// 영업사원 앱 전용 서버 (POST /api/sales { action, ... }, Authorization: Bearer <로그인 토큰>)
// 로그인한 영업사원에게 허용된 것만 돌려줌: 담당 병원, 판매 금액, 본인 견적서·메모.
// 매입가(unit_price, purchase_price)·이익·매입처는 여기서 아예 조회하지 않음.
import crypto from 'node:crypto';
import { SUPABASE_URL, SUPABASE_KEY, getLoginEmail } from './_auth.mjs';

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
  const [drafts, notes, services, pos, consumables] = await Promise.all([
    sb(`quotes_ai_draft?owner=eq.${enc(rep.email)}&status=eq.draft&select=${DRAFT_FIELDS}&order=created_at.desc&limit=3`),
    sb(`sales_notes?rep_id=eq.${rep.id}&contacted_at=is.null&next_contact_date=lte.${today}&select=id,body,next_contact_date,hospital_id,draft_id,hospitals(name,phone,contact_phone),quotes_ai_draft(hospital_name)&order=next_contact_date`),
    ids ? sb(`service_requests?hospital_id=in.(${ids})&${SERVICE_OPEN}&select=${SERVICE_FIELDS}&order=created_at.desc&limit=20`) : [],
    ids ? sb(`purchase_orders?hospital_id=in.(${ids})&status=neq.${enc('취소')}&select=${PO_FIELDS}`) : [],
    ids ? consumableMap() : new Map(),
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
  };
}

async function hospitalDetail(rep, id) {
  const hospital = await assignedHospital(rep, id);
  const nameFilter = `hospital_name.eq."${String(hospital.name).replace(/"/g, '\\"')}"`;
  const [pos, deliveries, drafts, notes, services, consumables] = await Promise.all([
    sb(`purchase_orders?hospital_id=eq.${id}&status=neq.${enc('취소')}&select=${PO_FIELDS}`),
    sb(`deliveries?hospital_id=eq.${id}&select=delivered_date,delivery_items(item_name,model_name,quantity,total_amount)`),
    sb(`quotes_ai_draft?owner=eq.${enc(rep.email)}&status=eq.draft&or=(hospital_id.eq.${id},${enc(nameFilter)})&select=${DRAFT_FIELDS}&order=created_at.desc&limit=10`),
    sb(`sales_notes?hospital_id=eq.${id}&select=${NOTE_FIELDS}&order=created_at.desc&limit=50`),
    sb(`service_requests?hospital_id=eq.${id}&${SERVICE_OPEN}&select=${SERVICE_FIELDS}&order=created_at.desc`),
    consumableMap(),
  ]);
  return {
    hospital,
    history: buildHistory(pos, deliveries),
    drafts,
    notes: notes.map(noteView),
    services,
    reorders: findReorders(pos, consumables, () => hospital.name),
  };
}

async function draftDetail(rep, id) {
  const draft = await ownDraft(rep, id, 'id,hospital_id,hospital_name,items,total_amount,created_at,global_discount');
  const equipIds = (draft.items || []).map((i) => i.equipment_id).filter(isUuid);
  const [equips, notes] = await Promise.all([
    equipIds.length ? sb(`equipment?id=in.(${equipIds.join(',')})&select=id,cat_id,cat_name,item_name,model_name,manufacturer,price,image_url,description,specs,cert,as_period,model_notes`) : [],
    sb(`sales_notes?draft_id=eq.${id}&select=${NOTE_FIELDS}&order=created_at.desc&limit=50`),
  ]);
  return { draft, equips, notes: notes.map(noteView) };
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

async function shareQuote(rep, body) {
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
      default: throw new HttpError(400, 'unknown action');
    }
    res.status(200).json(result);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error('[sales]', e);
    res.status(e.status || 500).json({ error: e instanceof HttpError ? e.message : '처리하지 못했습니다. 잠시 뒤 다시 해 주세요.' });
  }
}
