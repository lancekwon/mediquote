// 2026-11-05 장비 분류 정리 (사용자 결정: 소모품은 분류 하나, 분류는 장비 관리 한 곳에서만)
//
//   node scripts/category_cleanup_20261105.mjs          → 검토용 CSV만 만듦 (DB 안 바꿈)
//   node scripts/category_cleanup_20261105.mjs --apply  → 사용자 승인 후 실제 적용
//
// 이미 적용한 것 (Supabase MCP, 같은 날): 스탠류/소모품→소모품, 분류 추가(수술기구·응급의료기·비품목·미분류),
// cat_id 불일치 86개 정리, 비품목 12개·바루다 장비 9개 이동.
// 이 스크립트 = 나머지: 기타의료기기 재배치 + 잘못 들어간 품목 + 분류표 밖 분류 10개 + 수술기구/소모품 해체.
//
// 적용 시: equipment(cat_id·cat_name·category 같이), cat_items(옮긴 분류에 품목명 추가, 예전 분류에 그 품목 장비가
// 안 남으면 예전 분류 목록에서 뺌), 수술기구/소모품 분류 삭제(장비·품목 다 옮긴 뒤).
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://nbgubiywavozgigiwkpr.supabase.co/rest/v1/';
const KEY = process.env.SUPABASE_KEY || 'sb_publishable_L4FVvZBPaNF9BQtoadoPRw_3HeNlPRL';
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const sb = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${p}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};
const fetchAll = async (p) => {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const rows = await sb(`${p}&limit=1000&offset=${off}`);
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
};

// ── 규칙: [지금 분류들, 품목명들, 옮길 분류, 이유] ──
const PT = '물리치료/재활장비', LAB = '검사/측정장비', MON = '환자모니터링장비', EMR = '응급의료기', SURG = '수술장비',
  INST = '수술기구', BED = '병상/침대류', FURN = '수술실/병원가구', IMG = '영상진단장비', THER = '치료장비', CONS = '소모품',
  HEAT = '온열/냉각기기', STER = '멸균/소독장비', ENDO = '내시경장비';
const ETC = ['기타의료기기'];
const RULES = [
  [ETC, ['Auto Tens', '전침기자극기', '초음파치료기', 'Gymnic Ball', 'Tread Mill', '공기압치료기', 'Cryo', 'Dumbbells Set', 'Ergometer Bycle', 'FES',
    'Paraffine Bath', 'Parallel Bars', 'Redcord Narrow Sling 레드코드 네로우슬링', 'Redcord Rehab Pro 레드코드', 'Sling', 'Spain blance', 'Spine MT',
    'Stall Bar', 'T/F Rolls 운동용롤', 'TDP', 'TDP 신등', 'Zerovity Therapy Sling 3way', 'Zerovity Therapy Sling SET', 'Classic Ladder Barrel',
    'Classic Wood Reformer', 'Corner Stair', '골절촉진치료기', '근육타진기', '바이오피드백', '연하장애전기자극치료기', '저주파치료기',
    '천정레일형 보행훈련기', '천정레일형보행훈련기', '초음파자극기', '카이로프랙틱', '메조프래쉬', 'Smartro Wave'], PT, '물리치료·재활 기기'],
  [ETC, ['Ion Cooler'], HEAT, 'Multi Ion Cool과 같은 냉각기'],
  [ETC, ['Audiometer', 'Blood Cell Counter', 'Cell Counter', 'Centrifuge', 'EMG', 'Spirometer', 'Uroflowmeters', 'UDS Alpha', 'VNG', '동맥경화진단기',
    '면역분석기', '적외선체열진단기', '시력표', '브레인바디 BKM', '족저압 분석기', 'Exbody System', 'Microscope 모세혈관현미경', 'Thermometer',
    '휠체어체중계', '옴니핏'], LAB, '검사·측정·진단 기기'],
  [ETC, ['Biological Indicator Incubator', 'Scrub Station'], STER, '멸균·소독 관련'],
  [ETC, ['Fetal Monitor', '홀터모니터 운동부하', 'EKG Accessory'], MON, '환자 감시·심전도'],
  [ETC, ['Infusion Pump', 'Syringe Pump', 'LED Therapy', 'Photo Therapy Unit', 'Skin Scrubber', 'LDM', '올리지오', '피부 냉동치료기', '질타이트닝',
    'Apolex Tite 아포렉스타이트', '고압산소치료기', '질세정기'], THER, '치료·시술 기기 (레이저·피부·주입펌프 등)'],
  [ETC, ['Ambu Bag', 'Laryngoscope', 'O2 Flowmeter', 'O2 Gage', 'O2 Tank', '산소발생기'], EMR, '응급·산소'],
  [ETC, ['Anesthesia Machine', 'Operating Microscope', 'Operating Table Acc, Operating Table Op.', 'Orthopedic Table', 'Wilson Frame', 'Head Light',
    'Side Lamp', 'Side Lamp halogen', 'JS-013, Halogen', 'Auto Tourniquet', 'Tourniquet', 'Cast Cutter', 'Portable Suction', 'M310 복등 실링 설치'], SURG, '수술실 장비'],
  [ETC, ['CO2 주입기', 'Visual System'], ENDO, '내시경 관련'],
  [ETC, ['Allis Tissue Forcep', 'Biopsy Punch Forcep', 'Cervical Biopsy Punch', 'Placenta Forcep', 'Uterine Biopsy Punch', 'Vaginal Speculum',
    'Anoscope', 'Instruments', 'Compartmented Tray'], INST, '스테인리스 수술기구'],
  [ETC, ['사각베개', '입원실베개', '도넛베개', '정형다리받침', '이불 (면40수)', '환자복', '핫팩커버', 'Glucometer Strip', 'Urine Strip', '일회용질경',
    'Disposable Hemoclip', '질세정기 실리콘팁', 'Exercise Mat', 'MR Kit', 'MR-Kit'], CONS, '소모품·침구·일회용'],
  [ETC, ['Dependent Bed', '전동식 의료용 병원침대', '황토베드', 'Bobath Table', 'Fixed Table 바퀴형', 'Dental Chair', 'ENT-Chair', '전동체어',
    'GYN Exam Table Option', '진찰대열선', 'Wheel Chair'], BED, '침대·진료대·진료의자·휠체어 (이송용은 Stretcher Car와 같이)'],
  [ETC, ['Mobile Utility', 'Work Table 보조테이블', '작업테이블', '모니터카트', '세탁물운반카', 'Foot Step', '발판'], FURN, '카트·테이블·발판'],
  [ETC, ['납파티션', '납 Glove', '납안경', '방사선저감장치', 'CR', 'Wedge'], IMG, '방사선 방호·영상 관련'],

  [['수술기구/소모품'], ['co2 gas', 'Disposable Biopsy Forceps', 'E.O. Gas', '고글', '거즈'], CONS, '소모품 (수술기구/소모품 분류 해체)'],
  [['수술기구/소모품'], ['Mosquito Forceps'], INST, '스테인리스 수술기구 (수술기구/소모품 분류 해체)'],
  [['수술기구/소모품'], ['갑상선 보호대', '진료용 방어 앞치마 0.25(DARK+BLUE)'], IMG, '방사선 방호 (X-Ray Apron과 같이)'],

  [[IMG], ['Chiropractic', 'Traction', 'Traction 감압견인기'], PT, '영상진단장비에 잘못 들어감 — 물리치료'],
  [[IMG], ['Disposable Injection Needle', 'Disposable Polypectomy Snare'], CONS, '영상진단장비에 잘못 들어감 — 일회용'],
  [[IMG], ['Dressing Car'], FURN, '영상진단장비에 잘못 들어감 — 카트'],
  [[IMG], ['Dressing Forceps', 'Dressing Jar'], INST, '영상진단장비에 잘못 들어감 — 수술기구'],
  [[IMG], ['Fractional Laser'], THER, '영상진단장비에 잘못 들어감 — 레이저'],
  [[IMG], ['Lipo Suction', 'Smoke Suction', 'Suction Unit'], SURG, '영상진단장비에 잘못 들어감 — 석션'],
  [[IMG], ['MFT - Manual Function Test'], LAB, '영상진단장비에 잘못 들어감 — 검사'],

  [[THER], ['도수치료 전용 테이블', '전동테이블'], BED, '테이블은 병상/침대류 (전동테이블 35개와 같이)'],
  [[THER], ['마그네틱 E.S.W.T', '적외선치료기', 'Infrared Lamp', '냉각치료기'], PT, '물리치료 기기 (같은 품목이 물리치료에 있음)'],
  [[PT], ['Hot Pack Unit 핫팩통'], HEAT, 'Hot-Pack Unit과 같이'],
  [[PT], ['도수치료 테이블'], BED, '테이블은 병상/침대류'],
  [[BED], ['IV POLE'], FURN, 'IV Pole 4개와 같이'],
  [[MON], ['SPIRO METER'], LAB, '폐기능 검사'],
  [[HEAT], ['Hot-Pack Cover'], CONS, '커버는 소모품'],
  [[FURN], ['Sheet Cover'], CONS, '시트 커버는 소모품'],
  [[FURN], ['이동형 방어칸막이'], IMG, '방사선 방호 (방호판 칸막이와 같이)'],

  [['수술실장비'], ['*'], SURG, '분류표에 없는 "수술실장비" → 수술장비'],
  [['수액/약품'], ['링겔대'], FURN, '분류표에 없는 분류 — 링겔대는 IV Pole'],
  [['진료가구'], ['부인과 검진대'], BED, '분류표에 없는 분류 — 진료대'],
  [['보조기구'], ['수동휠체어'], BED, '분류표에 없는 분류 — 휠체어 (Wheel Chair와 같이)'],
  [['미분류'], ['링겔대 외'], FURN, '링겔대 = IV Pole'],
];
// 장비 하나씩 따로 정한 것 (같은 품목명이라도 실제 기기가 다름)
const BY_CODE = {
  E407: [PT, '초음파 "치료기" (청우 CWM-302)'], E355: [PT, '초음파 "치료기" (오릭스)'], E326: [PT, '초음파 "치료기" (디엠씨 LECTRON)'],
  E334: [IMG, '진단용 초음파 (GE LOGIQ P9) — 초음파진단기와 같이'],
  E434: [PT, '휴먼스캔 AT-1100 — 치료용으로 보고 옮김', '확인 필요'],
  E699: [PT, '호흡근 훈련기 (스마트브리드에어 프로)'], E700: [LAB, '폐기능검사기'],
  E701: [CONS, '정도관리 시린지'], E688: [CONS, '용액주입캐뉼라'], E689: [CONS, '쿨다운 젤'], E695: [CONS, '네블라이저 마스크'],
  E290: [CONS, '냉온찜질 팩 — 팩 자체는 소모품'], E621: [CONS, '핫팩 — 팩 자체는 소모품'],
};
// 옮기지 않고 표시만 (사용자 확인용)
const FLAGS = {
  E076: '테스트 데이터로 보임 (거즈 / 모델명테스트 / 제조사테스트) — 삭제 추천',
  E075: '테스트 데이터로 보임 (테스트 소모품 품명) — 삭제 추천',
  E860: '무엇인지 모름 (N322 회색, 에이치씨케이) — 분류 알려주세요',
  E719: '무엇인지 모름 (EL-2000, DSE) — 기타의료기기 유지', E824: '무엇인지 모름 (KS-MCB-01, 고산메디코) — 기타의료기기 유지',
  E742: '무엇인지 모름 (PS-100, 젠텍) — 기타의료기기 유지', E787: '품목명이 "(기타의료기기)" (ST-501, 나노메딕스썸텍) — 기타의료기기 유지',
  E295: '무엇인지 모름 (Gate Way HD) — 기타의료기기 유지', E179: '무엇인지 모름 (Insight) — 기타의료기기 유지',
  E852: '품목명이 "일반의료기기" (진솔의료기) — 기타의료기기 유지',
};

const equipment = await fetchAll('equipment?select=id,equip_code,cat_id,cat_name,item_name,model_name,manufacturer&order=equip_code');
const categories = await sb('categories?select=cat_id,name');
const catIdByName = new Map(categories.map((c) => [c.name, c.cat_id]));

const plan = [];
for (const e of equipment) {
  let to = null, why = '', check = '';
  if (BY_CODE[e.equip_code]) [to, why, check = ''] = BY_CODE[e.equip_code];
  else {
    const r = RULES.find(([from, items]) => from.includes(e.cat_name) && (items.includes('*') || items.includes(e.item_name)));
    if (r) [, , to, why] = r;
  }
  const flag = FLAGS[e.equip_code] || '';
  if (to && to !== e.cat_name) plan.push({ e, to, why, check });
  else if (flag) plan.push({ e, to: null, why: flag, check: '확인 필요' });
}
for (const p of plan) if (p.to && !catIdByName.has(p.to)) throw new Error(`분류표에 없는 분류: ${p.to}`);

const moves = plan.filter((p) => p.to);
const summary = new Map();
moves.forEach((p) => { const k = `${p.e.cat_name} → ${p.to}`; summary.set(k, (summary.get(k) || 0) + 1); });

if (!process.argv.includes('--apply')) {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [['장비코드', '지금 분류', '바꿀 분류', '품목', '모델', '제조사', '이유', '확인'].map(q).join(',')];
  [...plan].sort((a, b) => String(a.to || 'ㅎ').localeCompare(String(b.to || 'ㅎ')) || a.e.cat_name.localeCompare(b.e.cat_name) || a.e.equip_code.localeCompare(b.e.equip_code))
    .forEach((p) => lines.push([p.e.equip_code, p.e.cat_name, p.to || '(그대로)', p.e.item_name, p.e.model_name, p.e.manufacturer, p.why, p.check].map(q).join(',')));
  const out = path.join('exports', '장비분류_정리안_2026-11-05.csv');
  fs.mkdirSync('exports', { recursive: true });
  fs.writeFileSync(out, '﻿' + lines.join('\r\n'), 'utf8'); // 엑셀 한글 깨짐 방지 BOM
  console.log(`CSV: ${out}  (옮김 ${moves.length}개, 확인만 ${plan.length - moves.length}개)`);
  [...summary.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`${String(n).padStart(4)}  ${k}`));
  const after = new Map();
  equipment.forEach((e) => { const p = moves.find((m) => m.e.id === e.id); const c = p ? p.to : e.cat_name; after.set(c, (after.get(c) || 0) + 1); });
  console.log('\n정리 후 분류별 장비 수:');
  [...after.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`${String(n).padStart(4)}  ${k}`));
  process.exit(0);
}

// ── --apply ──
const cats = new Map(categories.map((c) => [c.name, c.cat_id]));
for (const p of moves) {
  const cid = cats.get(p.to);
  await sb(`equipment?id=eq.${p.e.id}`, { method: 'PATCH', body: JSON.stringify({ cat_id: cid, cat_name: p.to, category: p.to, updated_at: new Date().toISOString() }) });
}
// cat_items 맞추기
const items = await sb('cat_items?select=id,cat_id,name&limit=5000');
const eqNow = await fetchAll('equipment?select=cat_id,item_name&order=id');
const has = (cid, name) => eqNow.some((e) => e.cat_id === cid && e.item_name === name);
let added = 0, removed = 0;
for (const p of moves) {
  const cid = cats.get(p.to), oldCid = p.e.cat_id, name = p.e.item_name;
  if (!name || p.to === '비품목') continue;
  if (!items.some((i) => i.cat_id === cid && i.name === name)) {
    const [row] = await sb('cat_items', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ cat_id: cid, name, sort_order: 99 }) });
    items.push(row); added++;
  }
  for (const it of items.filter((i) => i.cat_id === oldCid && i.name === name && !i._gone)) {
    if (!has(oldCid, name)) { await sb(`cat_items?id=eq.${it.id}`, { method: 'DELETE' }); it._gone = true; removed++; }
  }
}
// 수술기구/소모품 분류: 장비가 하나도 안 남았으면 남은 품목 목록과 함께 삭제
const left = eqNow.filter((e) => e.cat_id === '수술기구소모품').length;
if (left === 0) {
  await sb('cat_items?cat_id=eq.수술기구소모품', { method: 'DELETE' });
  await sb('categories?cat_id=eq.수술기구소모품', { method: 'DELETE' });
}
console.log(`적용: 장비 ${moves.length}개 이동, 품목 목록 +${added} / -${removed}, 수술기구/소모품 분류 ${left === 0 ? '삭제' : `남김(장비 ${left}개 남음)`}`);
