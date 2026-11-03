// purchase_order_items 자동 생성 유틸 — Clobe TI items[] 받아서 equipment 매칭·등록까지
//
// 사용 예:
//   import { createPoItems } from './scripts/create_po_items.mjs';
//   const po = await ins('purchase_orders', { ..., total_amount, sale_amount });
//   await createPoItems(po.id, clobeTI.items, {
//     manufacturerId: po.manufacturer_id,
//     manufacturerName: po.manufacturer_name,
//     saleSupplyValue: 10000000,   // 매출 공급가 (null이면 sale_price 미설정)
//   });

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
  } = options;

  if (!poId) throw new Error('poId 필수');
  if (!Array.isArray(clobeItems) || clobeItems.length === 0) {
    return { poiIds: [], created: { equip: 0, items: 0 } };
  }

  // 매출 안분 기준 (총 공급가)
  const totalSupplyValue = clobeItems.reduce((s, it) => s + (Number(it.supplyValue) || 0), 0);

  // 신규 등록을 위해 E코드 다음 번호 미리 조회 (loop 중 추가될 수 있으니 각 신규마다 재조회)
  const poiIds = [];
  let createdEquip = 0;

  for (const it of clobeItems) {
    const itemName = String(it.name || '').trim();
    const modelName = String(it.standards || '').trim();
    const qty = Number(it.quantity) || 1;
    const itemSupply = Number(it.supplyValue) || 0;
    const itemTax = Number(it.taxAmount) || 0;
    const itemTotal = itemSupply + itemTax; // VAT 포함
    const unitPrice = qty > 0 ? Math.round(itemTotal / qty) : 0;

    // 매출가 안분
    let salePrice = null;
    if (saleSupplyValue != null && totalSupplyValue > 0 && qty > 0) {
      const itemSaleSupply = Math.round(saleSupplyValue * (itemSupply / totalSupplyValue));
      const itemSaleTotal = Math.round(itemSaleSupply * 1.1); // VAT 포함
      salePrice = Math.round(itemSaleTotal / qty);
    }

    // equipment 매칭 (item_name + model_name 완전 일치)
    let equipId = null;
    if (itemName) {
      const existing = await q(
        'equipment?select=id&item_name=eq.' + encodeURIComponent(itemName) +
        (modelName ? '&model_name=eq.' + encodeURIComponent(modelName) : '&model_name=is.null') +
        '&limit=1'
      );
      if (Array.isArray(existing) && existing.length) {
        equipId = existing[0].id;
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
