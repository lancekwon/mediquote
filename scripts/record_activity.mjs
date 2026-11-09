import './sb_env.mjs';
// 단일 거래 저장 유틸 — 모든 kind를 하나의 함수로 처리.
// Clobe 소스 ID로 중복 자동 차단 · PO/payable/receivable 자동 매칭 · balance 재계산 플래그
//
// 사용:
//   import { recordActivity, recordActivityBatch } from './scripts/record_activity.mjs';
//   await recordActivity({ kind:'ti_purchase', happenedAt:'2026-11-03', amount:2860000, ... });
//   const { results, needRebalance } = await recordActivityBatch([...]);
//   if (needRebalance) await rebuildBalanceAfter();

import { createPoItems, clobeItemPurchase, resolvePoEquipment } from './create_po_items.mjs';

const K = process.env.SB_KEY || 'sb_publishable_L4FVvZBPaNF9BQtoadoPRw_3HeNlPRL';
const B = (process.env.SB_URL || 'https://nbgubiywavozgigiwkpr.supabase.co') + '/rest/v1/';
const H = {
  apikey: K,
  Authorization: 'Bearer ' + K,
  'Content-Type': 'application/json; charset=utf-8',
  Prefer: 'return=representation',
};
const q = p => fetch(B + encodeURI(p), { headers: { apikey: K, Authorization: 'Bearer ' + K } }).then(r => r.json());
const ins = async (t, r) => {
  const x = await fetch(B + t, { method: 'POST', headers: H, body: JSON.stringify(r) });
  if (!x.ok) throw new Error(`${t} ${x.status}: ${await x.text()}`);
  const j = await x.json();
  return Array.isArray(j) ? j[0] : j;
};

function subtractDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * 단일 거래 저장 — kind에 따라 적절한 테이블로 분배.
 *
 * @param {object} opts
 * @param {string} opts.kind - ti_purchase | ti_sale | cash_in | cash_out | po_create | payable_pay | receivable_collect
 * @param {string} opts.happenedAt - YYYY-MM-DD
 * @param {number} opts.amount - VAT 포함. 수금+/지급-. 통장은 부호 그대로, TI는 양수만 (kind로 부호 결정).
 * @param {object} [opts.party] - { kind:'hospital'|'manufacturer', id, name }
 * @param {string} [opts.memo]
 * @param {string} [opts.owner]
 * @param {number} [opts.clobeTxId] - 통장 중복 차단
 * @param {string} [opts.clobeTiId] - TI 중복 차단
 * @param {string} [opts.accountId] - 통장 UUID
 * @param {string} [opts.entryType]
 * @param {string} [opts.counterparty] - 통장 counterparty 원문
 * @param {string} [opts.poId] - TI → PO 매칭
 * @param {string[]} [opts.salePoIds] - ti_sale: 이 매출 계산서에 들어간 발주들 → 그 발주의 계산서 미연결 품목 전부에 sale_ti_id (SQL 45 — 병원별 이익 월 = 계산서 발행월)
 * @param {string[]} [opts.saleItemIds] - ti_sale: 발주 일부 품목만 들어간 경우 품목 id로 직접 (예: 케이씨엘 전납 계산서 = 에제르 전납용 품목만)
 * @param {string} [opts.poNo] - PO 생성 시 번호 지정 (안 주면 자동 증번)
 * @param {string} [opts.hospitalId]
 * @param {string} [opts.manufacturerId]
 * @param {string} [opts.vendorName]
 * @param {array} [opts.items] - PO 생성 시 품목 [{name,standards,quantity,supplyValue,taxAmount}]
 * @param {number} [opts.saleAmount] - PO 매출합계 VAT 포함
 * @param {number} [opts.saleSupplyValue] - PO 매출 공급가 (품목 안분용)
 * @param {object} [opts.equipmentIds] - PO 품목별 장비 { index: 기존 장비 id | 'new' } — 비슷한 기존 장비가 있는 품목은 필수 (findEquipmentCandidates로 미리보기)
 * @param {boolean} [opts.autoMatch=true] - 자동 매칭 활성화
 * @param {'collect'|'refund'} [opts.cashInKind] - cash_in + 거래처: collect=우리가 끊은 매출 계산서 수금(수수료·광고료), refund=매입 환급·오송금 반환. 안 주면 entryType으로 판단(매출/수금 → collect, 환급/환불/반환 → refund), 그래도 모르면 저장하지 않고 에러
 * @param {string} [opts.cashLogId] - payable/receivable 연계 시
 *
 * @returns {Promise<{id,source_table,created,skipped?,poMatched?,needRebalance?}>}
 */
export async function recordActivity(opts) {
  const { kind } = opts;
  if (!kind) throw new Error('kind required');
  switch (kind) {
    case 'ti_purchase': return recordTiPurchase(opts);
    case 'ti_sale':     return recordTiSale(opts);
    case 'cash_in':
    case 'cash_out':    return recordCash(kind, opts);
    case 'po_create':   return recordPoCreate(opts);
    case 'payable_pay': return recordPayablePay(opts);
    case 'receivable_collect': return recordReceivableCollect(opts);
    default: throw new Error('unknown kind: ' + kind);
  }
}

// ============================================================
// 매입 세금계산서
// ============================================================
async function recordTiPurchase(o) {
  // Clobe 중복
  if (o.clobeTiId) {
    const exist = await q(`tax_invoices?select=id&clobe_ti_id=eq.${encodeURIComponent(o.clobeTiId)}&limit=1`);
    if (Array.isArray(exist) && exist.length) {
      return { id: exist[0].id, source_table: 'tax_invoices', created: false, skipped: 'duplicate_clobe_ti_id' };
    }
  }

  // PO 자동 매칭 (금액 ±1원 + manufacturer_id + 미매칭).
  // 환입/수정(음수) 세금계산서는 같은 금액의 다른 PO에 잘못 붙을 수 있어 자동 매칭하지 않음 → 매칭 큐에서 처리.
  let poId = o.poId || null;
  if (!poId && o.autoMatch !== false && o.manufacturerId && o.amount > 0) {
    const since = subtractDays(o.happenedAt, 30);
    const target = o.amount;
    const cands = await q(
      `purchase_orders?select=id,total_amount&manufacturer_id=eq.${o.manufacturerId}` +
      `&status=neq.취소&total_amount=gte.${target - 1}&total_amount=lte.${target + 1}` +
      `&created_at=gte.${since}T00:00:00&limit=5`
    );
    for (const c of (cands || [])) {
      // "이미 매입 확정된 PO" = 플러스 매입 TI가 연결됨 (v_activity_feed confirmed와 같은 기준)
      const used = await q(`tax_invoices?select=id&po_id=eq.${c.id}&kind=eq.purchase&amount=gt.0&limit=1`);
      if (!used.length) { poId = c.id; break; }
    }
  }

  const row = {
    kind: 'purchase',
    issue_date: o.happenedAt,
    party_name: o.party?.name || o.vendorName || null,
    amount: o.amount,  // 음수 수정세금계산서 그대로
    memo: o.memo || null,
    manufacturer_id: o.manufacturerId || (o.party?.kind === 'manufacturer' ? o.party.id : null),
    hospital_id: o.hospitalId || null,
    po_id: poId,
    no_po: !poId && o.autoMatch === false,
    confirmed: true,
    clobe_ti_id: o.clobeTiId || null,
  };
  const inserted = await ins('tax_invoices', row);
  return { id: inserted.id, source_table: 'tax_invoices', created: true, poMatched: !!poId };
}

// ============================================================
// 매출 세금계산서
// ============================================================
async function recordTiSale(o) {
  if (o.clobeTiId) {
    const exist = await q(`tax_invoices?select=id&clobe_ti_id=eq.${encodeURIComponent(o.clobeTiId)}&limit=1`);
    if (exist.length) {
      return { id: exist[0].id, source_table: 'tax_invoices', created: false, skipped: 'duplicate_clobe_ti_id' };
    }
  }
  const row = {
    kind: 'sale',
    issue_date: o.happenedAt,
    party_name: o.party?.name || o.vendorName || null,
    amount: o.amount,
    memo: o.memo || null,
    manufacturer_id: o.manufacturerId || (o.party?.kind === 'manufacturer' ? o.party.id : null),
    hospital_id: o.hospitalId || (o.party?.kind === 'hospital' ? o.party.id : null),
    po_id: o.poId || null,
    no_po: !o.poId && !o.salePoIds?.length && !o.saleItemIds?.length,
    confirmed: true,
    clobe_ti_id: o.clobeTiId || null,
  };
  const inserted = await ins('tax_invoices', row);
  const linkedItems = await linkSaleTiItems(inserted.id, o);
  return { id: inserted.id, source_table: 'tax_invoices', created: true, linkedItems };
}

/**
 * 매출 계산서 → 발주 품목 연결 (purchase_order_items.sale_ti_id). 이미 다른 계산서에 연결된 품목은 건드리지 않음.
 * 병원별 이익에서 그 품목의 월 = 이 계산서 발행월 (📅 이동한 달이 있으면 그게 먼저). 이미 저장된 계산서에도 쓸 수 있음.
 * @returns {Promise<number>} 연결된 품목 수
 */
export async function linkSaleTiItems(tiId, { salePoIds = [], saleItemIds = [] } = {}) {
  let n = 0;
  const patch = async filter => {
    const r = await fetch(`${B}purchase_order_items?${filter}&sale_ti_id=is.null`, { method: 'PATCH', headers: H, body: JSON.stringify({ sale_ti_id: tiId }) });
    if (!r.ok) throw new Error(`매출 계산서 품목 연결 실패 ${r.status}: ${await r.text()}`);
    n += (await r.json()).length;
  };
  if (salePoIds.length) await patch(`po_id=in.(${salePoIds.join(',')})`);
  if (saleItemIds.length) await patch(`id=in.(${saleItemIds.join(',')})`);
  return n;
}

// ============================================================
// 통장 (cash_in / cash_out) + payable/receivable 자동 연계
// ============================================================
function manufacturerCashInKind(o) {
  if (o.cashInKind === 'collect' || o.cashInKind === 'refund') return o.cashInKind;
  if (o.cashInKind != null) throw new Error(`cashInKind는 collect 또는 refund만 가능: ${o.cashInKind}`);
  if (/매출|수금/.test(o.entryType || '')) return 'collect';
  if (/환급|환불|반환/.test(o.entryType || '')) return 'refund';
  throw new Error(`${o.party.name} ${o.happenedAt} 입금 ${o.amount}원: 매출 수금인지 환급인지 모름 — cashInKind를 'collect' 또는 'refund'로 지정`);
}

async function recordCash(kind, o) {
  if (!o.accountId) throw new Error('accountId required for ' + kind);
  if (o.clobeTxId) {
    const exist = await q(`cash_balance_log?select=id&clobe_tx_id=eq.${o.clobeTxId}&limit=1`);
    if (exist.length) {
      return { id: exist[0].id, source_table: 'cash_balance_log', created: false, skipped: 'duplicate_clobe_tx_id' };
    }
  }
  const delta = kind === 'cash_in' ? Math.abs(o.amount) : -Math.abs(o.amount);
  const row = {
    log_date: o.happenedAt,
    delta,
    memo: o.memo || null,
    counterparty: o.counterparty || o.party?.name || null,
    entry_type: o.entryType || null,
    account_id: o.accountId,
    clobe_tx_id: o.clobeTxId || null,
    // balance_after는 끝에 rebuildBalanceAfter에서 재계산
  };
  // 거래처 입금은 통장에 넣기 전에 수금/환급부터 정함 — 못 정하면 통장도 안 들어가게 여기서 멈춤
  const linksParty = o.autoMatch !== false && !!o.party?.id;
  const mfrInKind = linksParty && kind === 'cash_in' && o.party.kind === 'manufacturer' ? manufacturerCashInKind(o) : null;

  const inserted = await ins('cash_balance_log', row);

  // 통장과 원장은 같이 들어가야 함 — 원장 저장이 실패하면 통장 행도 되돌림 (통장만 남으면 받을 돈/줄 돈이 틀어짐)
  const link = async (table, ledgerRow) => {
    try {
      await ins(table, { ...ledgerRow, cash_log_id: inserted.id });
    } catch (e) {
      const undo = await fetch(`${B}cash_balance_log?id=eq.${inserted.id}`, { method: 'DELETE', headers: H });
      const undone = undo.ok && (await undo.json()).length === 1;
      throw new Error(`${table} 저장 실패 — 통장 행 ${undone ? '되돌림' : `되돌리기 실패, 직접 확인 필요 (id=${inserted.id})`}: ${e.message}`);
    }
  };

  if (linksParty) {
    const base = { tx_date: o.happenedAt, memo: o.memo || null };
    const payable = amount => link('payable_transactions', { ...base, manufacturer_id: o.party.id, tx_type: 'payment', amount, po_id: o.poId || null, confirmed: true });
    const collect = idField => link('receivable_transactions', { ...base, [idField]: o.party.id, tx_type: 'collect', amount: Math.abs(o.amount) });
    if (kind === 'cash_out' && o.party.kind === 'manufacturer') await payable(Math.abs(o.amount));
    else if (kind === 'cash_in' && o.party.kind === 'hospital') await collect('hospital_id');
    else if (mfrInKind === 'collect') await collect('manufacturer_id');
    else if (mfrInKind === 'refund') await payable(-Math.abs(o.amount));
  }

  return { id: inserted.id, source_table: 'cash_balance_log', created: true, needRebalance: true };
}

// ============================================================
// PO 생성 (품목 자동 insert 포함)
// ============================================================
async function recordPoCreate(o) {
  if (!o.hospitalId && !o.manufacturerId) throw new Error('hospital_id or manufacturer_id required');

  // po_no 자동 증번
  let poNo = o.poNo;
  if (!poNo) {
    const year = new Date().getFullYear();
    const last = await q(`purchase_orders?select=po_no&po_no=like.PO-${year}-*&order=po_no.desc&limit=1`);
    const n = parseInt((last[0]?.po_no || `PO-${year}-000`).split('-').pop(), 10) || 0;
    poNo = `PO-${year}-${String(n + 1).padStart(3, '0')}`;
  }

  // total_amount는 품목 매입합계 기준으로 통일 (매입/매출 혼재 방지)
  // o.items는 Clobe TI 품목 형식 → createPoItems가 넣을 단가와 같은 계산(clobeItemPurchase)으로 합산
  // 품목이 없으면 o.amount로 fallback
  const purchaseSum = Array.isArray(o.items) && o.items.length
    ? o.items.reduce((s, it) => { const { qty, unitPrice } = clobeItemPurchase(it); return s + qty * unitPrice; }, 0)
    : Math.abs(o.amount || 0);
  // 장비 연결을 PO 만들기 전에 확정 — 비슷한 기존 장비가 있는데 o.equipmentIds로 안 정했으면 여기서 멈춤 (빈 PO가 안 남게)
  const equipmentIds = Array.isArray(o.items) && o.items.length
    ? Object.fromEntries((await resolvePoEquipment(o.items, { equipmentIds: o.equipmentIds || {} })).map((id, i) => [i, id]))
    : {};
  const row = {
    po_no: poNo,
    status: '진행중',
    ordered_at: o.orderedAt || new Date().toISOString().slice(0, 10),
    hospital_id: o.hospitalId || null,
    hospital_name: o.party?.kind === 'hospital' ? o.party.name : null,
    manufacturer_id: o.manufacturerId || null,
    manufacturer_name: (o.party?.kind === 'manufacturer' ? o.party.name : null) || o.vendorName || null,
    total_amount: purchaseSum,
    sale_amount: o.saleAmount != null ? o.saleAmount : null,
    owner: o.owner || null,
    is_active: true,
    source: o.source || 'clobe_sync',
  };
  const po = await ins('purchase_orders', row);

  // 품목 (옵션)
  let itemsCreated = 0;
  if (Array.isArray(o.items) && o.items.length) {
    const r = await createPoItems(po.id, o.items, {
      manufacturerId: po.manufacturer_id,
      manufacturerName: po.manufacturer_name,
      saleSupplyValue: o.saleSupplyValue != null ? o.saleSupplyValue : (o.saleAmount ? Math.round(o.saleAmount / 1.1) : null),
      equipmentIds,
    });
    itemsCreated = r.created.items;
  }

  return { id: po.id, po_no: poNo, source_table: 'purchase_orders', created: true, itemsCreated };
}

// ============================================================
// payable_transactions 단독 저장
// ============================================================
async function recordPayablePay(o) {
  const row = {
    manufacturer_id: o.manufacturerId || o.party?.id,
    tx_date: o.happenedAt,
    tx_type: 'payment',
    amount: Math.abs(o.amount),
    memo: o.memo || null,
    po_id: o.poId || null,
    cash_log_id: o.cashLogId || null,
    confirmed: true,
  };
  const inserted = await ins('payable_transactions', row);
  return { id: inserted.id, source_table: 'payable_transactions', created: true };
}

// ============================================================
// receivable_transactions 단독 저장
// ============================================================
async function recordReceivableCollect(o) {
  const isMfr = !!o.manufacturerId || o.party?.kind === 'manufacturer';
  const row = {
    hospital_id: isMfr ? null : (o.hospitalId || o.party?.id),
    manufacturer_id: isMfr ? (o.manufacturerId || o.party.id) : null,
    tx_date: o.happenedAt,
    tx_type: 'collect',
    amount: Math.abs(o.amount),
    memo: o.memo || null,
    cash_log_id: o.cashLogId || null,
  };
  const inserted = await ins('receivable_transactions', row);
  return { id: inserted.id, source_table: 'receivable_transactions', created: true };
}

// ============================================================
// 배치
// ============================================================
export async function recordActivityBatch(items, { onProgress, stopOnError = false } = {}) {
  const results = [];
  let needRebalance = false;
  let created = 0, skipped = 0, failed = 0;
  for (let i = 0; i < items.length; i++) {
    try {
      const r = await recordActivity(items[i]);
      results.push({ ok: true, ...r, input: items[i] });
      if (r.created) created++;
      else if (r.skipped) skipped++;
      if (r.needRebalance) needRebalance = true;
    } catch (e) {
      failed++;
      results.push({ ok: false, error: e.message, input: items[i] });
      if (stopOnError) break;
    }
    if (onProgress) onProgress(i + 1, items.length);
  }
  return { results, needRebalance, summary: { created, skipped, failed, total: items.length } };
}
