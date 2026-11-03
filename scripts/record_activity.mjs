// 단일 거래 저장 유틸 — 모든 kind를 하나의 함수로 처리.
// Clobe 소스 ID로 중복 자동 차단 · PO/payable/receivable 자동 매칭 · balance 재계산 플래그
//
// 사용:
//   import { recordActivity, recordActivityBatch } from './scripts/record_activity.mjs';
//   await recordActivity({ kind:'ti_purchase', happenedAt:'2026-11-03', amount:2860000, ... });
//   const { results, needRebalance } = await recordActivityBatch([...]);
//   if (needRebalance) await rebuildBalanceAfter();

import { createPoItems } from './create_po_items.mjs';

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
 * @param {string} [opts.poNo] - PO 생성 시 번호 지정 (안 주면 자동 증번)
 * @param {string} [opts.hospitalId]
 * @param {string} [opts.manufacturerId]
 * @param {string} [opts.vendorName]
 * @param {array} [opts.items] - PO 생성 시 품목 [{name,standards,quantity,supplyValue,taxAmount}]
 * @param {number} [opts.saleAmount] - PO 매출합계 VAT 포함
 * @param {number} [opts.saleSupplyValue] - PO 매출 공급가 (품목 안분용)
 * @param {boolean} [opts.autoMatch=true] - 자동 매칭 활성화
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

  // PO 자동 매칭 (금액 ±1원 + manufacturer_id + 미매칭)
  let poId = o.poId || null;
  if (!poId && o.autoMatch !== false && o.manufacturerId && o.amount) {
    const since = subtractDays(o.happenedAt, 30);
    const target = Math.abs(o.amount);
    const cands = await q(
      `purchase_orders?select=id,total_amount&manufacturer_id=eq.${o.manufacturerId}` +
      `&status=neq.취소&total_amount=gte.${target - 1}&total_amount=lte.${target + 1}` +
      `&created_at=gte.${since}T00:00:00&limit=5`
    );
    for (const c of (cands || [])) {
      const used = await q(`tax_invoices?select=id&po_id=eq.${c.id}&limit=1`);
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
    no_po: !o.poId,
    confirmed: true,
    clobe_ti_id: o.clobeTiId || null,
  };
  const inserted = await ins('tax_invoices', row);
  return { id: inserted.id, source_table: 'tax_invoices', created: true };
}

// ============================================================
// 통장 (cash_in / cash_out) + payable/receivable 자동 연계
// ============================================================
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
  const inserted = await ins('cash_balance_log', row);

  // 자동 매칭 — payable/receivable 함께 생성 (거래처 매칭된 경우만)
  if (o.autoMatch !== false && o.party?.id) {
    if (kind === 'cash_out' && o.party.kind === 'manufacturer') {
      await ins('payable_transactions', {
        manufacturer_id: o.party.id,
        tx_date: o.happenedAt,
        tx_type: 'payment',
        amount: Math.abs(o.amount),
        memo: o.memo || null,
        po_id: o.poId || null,
        cash_log_id: inserted.id,
        confirmed: true,
      }).catch(e => console.warn('payable auto-create', e.message));
    } else if (kind === 'cash_in' && o.party.kind === 'hospital') {
      await ins('receivable_transactions', {
        hospital_id: o.party.id,
        tx_date: o.happenedAt,
        tx_type: 'collect',
        amount: Math.abs(o.amount),
        memo: o.memo || null,
        cash_log_id: inserted.id,
      }).catch(e => console.warn('receivable auto-create', e.message));
    } else if (kind === 'cash_in' && o.party.kind === 'manufacturer') {
      // 환급 — payable에 음수 payment
      await ins('payable_transactions', {
        manufacturer_id: o.party.id,
        tx_date: o.happenedAt,
        tx_type: 'payment',
        amount: -Math.abs(o.amount),
        memo: o.memo || null,
        po_id: o.poId || null,
        cash_log_id: inserted.id,
        confirmed: true,
      }).catch(e => console.warn('refund payable auto-create', e.message));
    }
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

  const row = {
    po_no: poNo,
    status: '진행중',
    ordered_at: o.orderedAt || new Date().toISOString().slice(0, 10),
    hospital_id: o.hospitalId || null,
    hospital_name: o.party?.kind === 'hospital' ? o.party.name : null,
    manufacturer_id: o.manufacturerId || null,
    manufacturer_name: (o.party?.kind === 'manufacturer' ? o.party.name : null) || o.vendorName || null,
    total_amount: Math.abs(o.amount || 0),
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
  const row = {
    hospital_id: o.hospitalId || o.party?.id,
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
