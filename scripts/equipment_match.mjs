// 장비 중복 등록 방지 — 세금계산서·카톡 품목명이 장비 목록 이름과 글자까지 같지 않아도 같은 제품을 찾는다.
// 2026-11-04: Clobe 업데이트가 "H480S, 소형고압증기멸균기"를 기존 E569 "Steam Sterilizer / 48L-H480S"와 다른 장비로
// 새로 만들어 사진 없는 중복(E836·E844·E847·E848·E861)이 생겼음. 예전 기준은 품목명+모델명 "완전 일치"뿐이었음.
//
// 쓰는 곳: scripts/create_po_items.mjs (Clobe 업데이트), api/chat.mjs register_equipment (카톡 → 발주)
//
//   strong  = 같은 제품이 확실 → 자동으로 기존 장비 사용
//   candidates = 비슷한 기존 장비 → 새로 만들지 말고 사람(사용자)에게 고르게 함

export const normName = (s) => String(s || '').toLowerCase().replace(/[\s\-_()（）\[\]<>,./·:'"]/g, '');

// 모델 코드처럼 보이는 조각 (글자와 숫자가 섞인 3자 이상): "H480S" "MK-10" "IR-3000" "TAE-2002"
function codeTokens(...texts) {
  const out = new Set();
  for (const t of texts) {
    for (const raw of String(t || '').split(/[\s,()（）/·\[\]<>]+/)) {
      const n = normName(raw);
      if (n.length >= 3 && /[a-z]/.test(n) && /\d/.test(n)) out.add(n);
    }
  }
  return [...out];
}

/**
 * @param {string} name  품목명 (세금계산서 품목명 / 카톡에서 뽑은 이름)
 * @param {string} model 모델·규격 (없으면 '')
 * @param {Array<{id, equip_code, item_name, model_name, image_url?}>} equipment 장비 목록 전체
 * @param {Array<{equipment_id, item_name, model_name}>} [aliases] 예전 발주 품목 (이름 → 연결된 장비). 사람이 한 번 고른 연결을 기억하는 용도
 *   예) 계산서 품목 "윌트리적외선조사기(벽걸이)"를 E713 "적외선치료기 / VITA Wall"로 합친 뒤엔 같은 이름이 오면 E713으로 자동 연결
 * @returns {{ strong: object|null, candidates: object[] }}
 */
export function matchEquipment(name, model, equipment, aliases = []) {
  const n = normName(name), m = normName(model);
  const strong = [];
  // 예전 발주에서 같은 품목명(+같은 모델)을 이미 어떤 장비로 연결했으면 그 장비
  if (n && aliases.length) {
    const byId = new Map(equipment.map((e) => [e.id, e]));
    const hit = aliases.find((a) => a.equipment_id && normName(a.item_name) === n && normName(a.model_name) === m && byId.has(a.equipment_id));
    if (hit) return { strong: byId.get(hit.equipment_id), candidates: [] };
  }
  const scored = new Map();
  const add = (e, s) => scored.set(e.id, { e, s: Math.max(s, scored.get(e.id)?.s || 0) });
  const codes = codeTokens(name, model);

  const contains = (a, b) => a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
  for (const e of equipment) {
    const en = normName(e.item_name), em = normName(e.model_name);
    // 확실: 모델명이 같음 / 품목명이 장비 모델명과 같음(계산서에 모델을 품목명으로 적은 경우) / 품목명·모델 둘 다 같음
    if ((m && em && m === em) || (n && em && n === em) || (n && en && n === en && m === em)) { strong.push(e); continue; }
    // 비슷함: 모델 코드 조각이 장비 이름·모델에 들어 있음 > 품목명은 같고 모델만 다름 > 이름이 서로 포함
    const hay = en + '|' + em;
    if (codes.some((c) => hay.includes(c))) add(e, 3);
    else if (n && en && n === en) add(e, 2);
    else if (contains(n, em) || contains(n, en)) add(e, 1);
  }
  // 같은 제품이 이미 여러 개면 사진 있는 것 → 코드 빠른 것
  const pick = (a, b) => (!!b.image_url - !!a.image_url) || String(a.equip_code).localeCompare(String(b.equip_code));
  strong.sort(pick);
  const candidates = [...scored.values()].sort((a, b) => (b.s - a.s) || pick(a.e, b.e)).slice(0, 5).map((x) => x.e);
  return { strong: strong[0] || null, candidates };
}
