// purchase_order_items 자동 생성 유틸 — Clobe TI items[] 받아서 equipment 매칭·등록까지
//
// 사용 예:
//   import { createPoItems, findEquipmentCandidates } from './scripts/create_po_items.mjs';
//   // 1) 미리보기 단계: 품목마다 기존 장비 연결 결과를 사용자에게 보여줌
//   const report = await findEquipmentCandidates(clobeTI.items);   // [{ index, name, model, equipment, candidates }]
//   //    candidates가 있는 품목은 사용자가 고른 걸 equipmentIds[index]에 넣음 (기존 장비 id 또는 'new')
//   // 2) 저장 단계 — PO 만들기 전에 resolvePoEquipment로 미결 후보가 없는지 먼저 확인할 것 (recordActivity po_create는 알아서 함)
//   const po = await ins('purchase_orders', { ..., total_amount, sale_amount });
//   await createPoItems(po.id, clobeTI.items, {
//     manufacturerId: po.manufacturer_id,
//     manufacturerName: po.manufacturer_name,
//     saleSupplyValue: 10000000,   // 매출 공급가 (null이면 sale_price 미설정)
//     equipmentIds: { 0: '<기존 장비 id>', 2: 'new' },   // 후보가 있던 품목만
//   });
//
// 장비 중복 방지 (2026-11-04): 이름이 글자까지 같아야만 기존 장비로 보던 탓에 사진 없는 중복 장비가 생겼음.
// 이제 scripts/equipment_match.mjs 기준으로 확실하면 자동 연결, 비슷한 장비가 있으면 사용자가 고르기 전엔 등록하지 않고 에러.

import { matchEquipment } from './equipment_match.mjs';

const K = process.env.SB_KEY || 'sb_publishable_L4FVvZBPaNF9BQtoadoPRw_3HeNlPRL';
const B = (process.env.SB_URL || 'https://nbgubiywavozgigiwkpr.supabase.co') + '/rest/v1/';
const H = {
  apikey: K,
  Authorization: 'Bearer ' + K,
  'Content-Type': 'application/json; charset=utf-8',
  Prefer: 'return=representation',
};
// 호출부에서 값을 encodeURIComponent로 한 번 인코딩해서 넘김 — 여기서 encodeURI를 또 하면 한글이 이중 인코딩돼
// 기존 장비를 못 찾고 매번 신규 등록됨 (2026-11-04 발견). 품목명에 '&'가 있을 수 있어 encodeURI 하나로 대체도 불가.
const q = p => fetch(B + p, { headers: { apikey: K, Authorization: 'Bearer ' + K } }).then(r => r.json());
const ins = async (t, r) => {
  const x = await fetch(B + t, { method: 'POST', headers: H, body: JSON.stringify(r) });
  if (!x.ok) throw new Error(`${t} ${x.status}: ${await x.text()}`);
  const j = await x.json();
  return Array.isArray(j) ? j[0] : j;
};

/**
 * Clobe TI 품목 1개의 수량·매입단가(VAT 포함). createPoItems와 PO 매입합계 계산이 같은 값을 쓰도록 공용.
 * @param {{quantity?:number, supplyValue?:number, taxAmount?:number}} it
 * @returns {{qty:number, unitPrice:number}}
 */
export function clobeItemPurchase(it) {
  const qty = Number(it.quantity) || 1;
  const itemTotal = (Number(it.supplyValue) || 0) + (Number(it.taxAmount) || 0);
  return { qty, unitPrice: qty > 0 ? Math.round(itemTotal / qty) : 0 };
}

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
const loadEquipment = async () => {
  const rows = await q('equipment?select=id,equip_code,item_name,model_name,image_url&limit=5000');
  if (!Array.isArray(rows)) throw new Error('장비 목록 조회 실패: ' + JSON.stringify(rows));
  return rows;
};

/**
 * 품목마다 기존 장비 연결 결과 (미리보기용, 아무것도 쓰지 않음).
 * equipment: 자동으로 붙을 기존 장비 (없으면 null) / candidates: 비슷한 기존 장비 (사용자가 골라야 함)
 */
export async function findEquipmentCandidates(clobeItems, equipment = null) {
  const list = equipment || await loadEquipment();
  return (clobeItems || []).map((it, index) => {
    const name = String(it.name || '').trim(), model = String(it.standards || '').trim();
    const { strong, candidates } = matchEquipment(name, model, list);
    return { index, name, model, equipment: strong, candidates: strong ? [] : candidates };
  });
}

/**
 * 저장 전 확인: 품목마다 쓸 장비 id 결정. 비슷한 기존 장비가 있는데 equipmentIds로 정하지 않은 품목이 있으면 에러 (아무것도 안 씀).
 * @returns {Promise<Array<string|'new'>>} index별 기존 장비 id 또는 'new'(새로 등록)
 */
export async function resolvePoEquipment(clobeItems, { equipmentIds = {}, equipment = null } = {}) {
  const report = await findEquipmentCandidates(clobeItems, equipment);
  const undecided = [];
  const ids = report.map((r) => {
    const pick = equipmentIds[r.index];
    if (isUuid(pick) || pick === 'new') return pick;
    if (r.equipment) return r.equipment.id;
    if (r.candidates.length) { undecided.push(r); return null; }
    return 'new';
  });
  if (undecided.length) {
    const lines = undecided.map((r) => `  [${r.index}] ${r.name}${r.model ? ' / ' + r.model : ''} → 후보 ` +
      r.candidates.map((c) => `${c.equip_code} ${c.item_name}${c.model_name ? '/' + c.model_name : ''}`).join(' | '));
    const err = new Error(`비슷한 기존 장비가 있어 새로 등록하지 않음 — equipmentIds로 정해 주세요 (기존 id 또는 'new'):\n${lines.join('\n')}`);
    err.undecided = undecided;
    throw err;
  }
  return ids;
}

/**
 * Clobe TI items[]를 받아 purchase_order_items를 생성.
 * equipment에 매칭되면 재사용, 없으면 신규 등록 (E코드 증번).
 *
 * @param {string} poId — 대상 purchase_orders.id
 * @param {Array} clobeItems — Clobe TI의 items 배열 [{name, standards, quantity, unitPrice, supplyValue, taxAmount}, ...]
 * @param {object} options
 * @param {string} options.manufacturerId — 신규 equipment 등록 시 vendor_id
 * @param {string} options.manufacturerName — 신규 equipment 등록 시 vendor 이름
 * @param {number|null} options.saleSupplyValue — 매출 공급가 (안분용). null이면 sale_price 미설정.
 * @param {string} options.category — equipment 신규 등록 시 category (기본 '미분류')
 * @returns {Promise<{poiIds: string[], created: {equip: number, items: number}}>}
 */
export async function createPoItems(poId, clobeItems, options = {}) {
  const {
    manufacturerId = null,
    manufacturerName = null,
    saleSupplyValue = null,
    category = '미분류',
    equipmentIds = {},
  } = options;

  if (!poId) throw new Error('poId 필수');
  if (!Array.isArray(clobeItems) || clobeItems.length === 0) {
    return { poiIds: [], created: { equip: 0, items: 0 } };
  }

  // 품목 넣기 전에 장비 연결부터 전부 결정 — 비슷한 기존 장비가 있는데 안 정했으면 여기서 에러 (품목은 하나도 안 들어감)
  const resolved = await resolvePoEquipment(clobeItems, { equipmentIds });
  const madeInThisCall = new Map(); // 같은 PO 안에서 같은 새 품목이 두 줄이면 장비는 하나만

  // 매출 안분 기준 (총 공급가)
  const totalSupplyValue = clobeItems.reduce((s, it) => s + (Number(it.supplyValue) || 0), 0);

  // 신규 등록을 위해 E코드 다음 번호 미리 조회 (loop 중 추가될 수 있으니 각 신규마다 재조회)
  const poiIds = [];
  let createdEquip = 0;

  for (const [i, it] of clobeItems.entries()) {
    const itemName = String(it.name || '').trim();
    const modelName = String(it.standards || '').trim();
    const { qty, unitPrice } = clobeItemPurchase(it); // VAT 포함
    const itemSupply = Number(it.supplyValue) || 0;

    // 매출가 안분
    let salePrice = null;
    if (saleSupplyValue != null && totalSupplyValue > 0 && qty > 0) {
      const itemSaleSupply = Math.round(saleSupplyValue * (itemSupply / totalSupplyValue));
      const itemSaleTotal = Math.round(itemSaleSupply * 1.1); // VAT 포함
      salePrice = Math.round(itemSaleTotal / qty);
    }

    // equipment: resolvePoEquipment가 정한 기존 장비 id, 또는 'new'면 새로 등록
    let equipId = null;
    const newKey = `${itemName}|${modelName}`.toLowerCase();
    if (itemName) {
      if (resolved[i] !== 'new') {
        equipId = resolved[i];
      } else if (madeInThisCall.has(newKey)) {
        equipId = madeInThisCall.get(newKey);
      } else {
        // 신규 equipment 등록
        const lastE = await q('equipment?select=equip_code&equip_code=like.E*&order=equip_code.desc&limit=1');
        const n = parseInt((lastE[0]?.equip_code || 'E000').replace(/\D/g, ''), 10) || 0;
        const newCode = 'E' + String(n + 1).padStart(3, '0');
        const eq = await ins('equipment', {
          equip_code: newCode,
          item_name: itemName,
          model_name: modelName || null,
          category,
          cat_id: category,
          cat_name: category,
          manufacturer: manufacturerName || null,
          vendor: manufacturerName || null,
          vendor_id: manufacturerId || null,
          purchase_price: unitPrice,
          price: salePrice,
          memo: '',
        });
        equipId = eq?.id || null;
        if (equipId) madeInThisCall.set(newKey, equipId);
        createdEquip++;
      }
    }

    // purchase_order_items insert
    const poi = await ins('purchase_order_items', {
      po_id: poId,
      equipment_id: equipId,
      item_name: itemName,
      model_name: modelName || null,
      quantity: qty,
      unit_price: unitPrice,
      sale_price: salePrice,
    });
    if (poi?.id) poiIds.push(poi.id);
  }

  return { poiIds, created: { equip: createdEquip, items: poiIds.length } };
}
