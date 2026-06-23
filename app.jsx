const { useState, useMemo, useCallback, useEffect, useRef } = React;

/* ============================================================
   SUPABASE CLIENT
   ============================================================ */
const SUPABASE_URL = 'https://nbgubiywavozgigiwkpr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_L4FVvZBPaNF9BQtoadoPRw_3HeNlPRL';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- 한글 초성 검색 유틸 ---------- */
const HANGUL_CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
function getChosung(str) {
  let out = '';
  for (const ch of (str || '')) {
    const code = ch.charCodeAt(0) - 0xAC00;
    if (code >= 0 && code <= 11171) out += HANGUL_CHO[Math.floor(code / 588)];
    else out += ch;
  }
  return out;
}
// 검색어가 한글 자음(초성)만으로 구성됐는지
function isChosungQuery(q) {
  return /^[ㄱ-ㅎ]+$/.test(q || '');
}
// 거래처명 매칭: 부분 문자열 OR (검색어가 자음이면) 초성 매칭
function vendorMatch(name, query) {
  const q = (query || '').trim();
  if (!q) return true;
  const n = (name || '');
  if (n.toLowerCase().includes(q.toLowerCase())) return true;
  if (isChosungQuery(q)) return getChosung(n).includes(q);
  return false;
}

/* ---------- Equipment DB ---------- */
// 목록 로드: image_data 제외 (Egress 절감)
const EQUIP_COLUMNS = 'id,cat_id,cat_name,category,item_name,model_name,model_id,manufacturer,vendor,vendor_id,price,model_notes,alt_text,alt_models,homepage,purchase_price,contact_name,contact_phone,image_url,description,specs,origin,cert,as_period,warranty,memo,created_at,manufacturers:vendor_id(id,vendor_code,name,contact_name,contact_phone)';
async function dbLoadEquip() {
  const { data, error } = await sb.from('equipment').select(EQUIP_COLUMNS).order('created_at', { ascending: false });
  if (error) { console.error('dbLoadEquip:', error); return []; }
  return data.map(r => ({
    id:       r.id,
    catId:    r.cat_id    || 'imaging',
    catName:  r.cat_name  || r.category || '기타',
    itemName: r.item_name || '',
    model: {
      id:           r.model_id     || r.id,
      name:         r.model_name   || '',
      manufacturer: r.manufacturer || '',
      price:        r.price ?? null,
      notes:        r.model_notes  || '',
    },
    vendorId:  r.vendor_id || null,
    vendorCode: r.manufacturers?.vendor_code || '',
    vendor:    r.manufacturers?.name || r.vendor || '',
    altText:  r.alt_text   || '',
    altModels: Array.isArray(r.alt_models) ? r.alt_models : [],
    homepage: r.homepage   || '',
    purchasePrice: r.purchase_price ?? null,
    contactName:  r.contact_name  || '',
    contactPhone: r.contact_phone || '',
    image:    r.image_url || null,
    spec: {
      desc:     r.description || '',
      specs:    Array.isArray(r.specs) ? r.specs : [],
      origin:   r.origin      || '',
      cert:     r.cert        || '',
      as:       r.as_period   || '',
      warranty: r.warranty    || '',
    },
    createdAt: r.created_at,
  }));
}
// 개별 장비 이미지 로드 — image_url 없을 때 fallback (레거시)
async function dbLoadEquipImage(id) {
  const { data, error } = await sb.from('equipment').select('image_data').eq('id', id).single();
  if (error || !data) return null;
  return data.image_data || null;
}

// 이미지 Supabase Storage 업로드 → public URL 반환
// 주의: publishable key는 RLS UPDATE를 통과 못 해서 upsert 사용 불가 → 매번 새 파일명으로 INSERT
async function uploadEquipImage(dataUrl, fileId, oldUrl) {
  let contentType = 'image/png', b64 = dataUrl;
  if (dataUrl.includes(',')) {
    const [header, data] = dataUrl.split(',');
    b64 = data;
    contentType = header.split(':')[1]?.split(';')[0] || 'image/png';
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ext = (contentType.includes('jpeg') || contentType.includes('jpg')) ? 'jpg'
    : contentType.includes('webp') ? 'webp' : 'png';
  const safeName = String(fileId).replace(/[^a-zA-Z0-9_-]/g, '_');
  // timestamp + 랜덤으로 충돌 회피 → INSERT만 발생
  const path = `${safeName}_${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}.${ext}`;
  const { error } = await sb.storage.from('equipment').upload(path, bytes, { contentType });
  if (error) throw error;
  const { data: { publicUrl } } = sb.storage.from('equipment').getPublicUrl(path);
  // 옛 파일 정리 (옵션) — DELETE 정책 있으면 작동, 실패해도 무시
  if (oldUrl && typeof oldUrl === 'string' && oldUrl.includes('/storage/v1/object/public/equipment/')) {
    try {
      const oldPath = oldUrl.split('/storage/v1/object/public/equipment/')[1];
      if (oldPath && oldPath !== path) await sb.storage.from('equipment').remove([oldPath]);
    } catch (_) { /* 정리 실패는 무시 */ }
  }
  return publicUrl;
}

async function dbSaveEquip(entry) {
  // 이미지 처리: base64 → Storage 업로드, URL은 그대로, null은 null
  let imageUrl = null;
  if (entry.image) {
    if (entry.image.startsWith('http')) {
      imageUrl = entry.image; // 이미 Storage URL
    } else if (entry.image.startsWith('data:')) {
      const fileId = (entry.model?.id || entry.id || ('eq-' + Date.now()));
      // 기존 image_url을 oldUrl로 전달 → 새 업로드 성공 시 정리
      let oldUrl = null;
      if (entry.id) {
        try {
          const { data: cur } = await sb.from('equipment').select('image_url').eq('id', entry.id).single();
          oldUrl = cur?.image_url || null;
        } catch (_) {}
      }
      imageUrl = await uploadEquipImage(entry.image, fileId, oldUrl);
    }
  }

  const row = {
    category: entry.catName,
    item_name: entry.itemName,
    model_name: entry.model.name,
    manufacturer: entry.model.manufacturer || '',
    vendor: entry.vendor || '',
    vendor_id: entry.vendorId || null,
    price: entry.model.price || null,
    specs: entry.spec?.specs || [],
    description: entry.spec?.desc || '',
    cert: entry.spec?.cert || '',
    warranty: entry.spec?.warranty || '',
    as_period: entry.spec?.as || '',
    origin: entry.spec?.origin || '',
    image_url: imageUrl,
    image_data: null, // Storage 전환 완료 — base64 저장 중단
    memo: entry.model?.notes || '',
    cat_id: entry.catId,
    cat_name: entry.catName,
    model_id: entry.model.id,
    model_notes: entry.model.notes || '',
    alt_text: entry.altText || '',
    alt_models: entry.altModels || [],
    homepage: entry.homepage || '',
    purchase_price: entry.purchasePrice || null,
    // contact_name/phone — B안: 거래처 마스터(manufacturers)로 통일, equipment에 안 씀
    raw_data: entry,
  };
  // 수정 (id가 있으면 Supabase UUID로 update)
  if (entry.id) {
    const { data, error } = await sb.from('equipment').update(row).eq('id', entry.id).select('id').single();
    if (error) throw error;
    return data.id;
  }
  // 신규
  const { data, error } = await sb.from('equipment').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}

async function dbDeleteEquip(id) {
  const { error } = await sb.from('equipment').delete().eq('id', id);
  if (error) throw error;
}

/* ---------- Equipment Price History ---------- */
// 매입가 이력 기록 + equipment.purchase_price 자동 갱신
async function dbLogPriceChange({ equipmentId, price, prevPrice, source = 'po', poId = null, poNo = null, vendor = null, note = null, autoUpdate = true }) {
  if (!equipmentId || price == null) return;
  const numPrice = Number(price);
  const numPrev = prevPrice != null ? Number(prevPrice) : null;
  if (numPrev != null && numPrev === numPrice) return; // 변동 없으면 기록 안 함
  // 1. 이력 INSERT
  await sb.from('equipment_price_history').insert({
    equipment_id: equipmentId,
    price: numPrice,
    prev_price: numPrev,
    source, po_id: poId, po_no: poNo, vendor, note,
  });
  // 2. equipment.purchase_price 자동 갱신
  if (autoUpdate) {
    await sb.from('equipment').update({ purchase_price: numPrice }).eq('id', equipmentId);
  }
}

async function dbLoadPriceHistory(equipmentId) {
  if (!equipmentId) return [];
  const { data, error } = await sb.from('equipment_price_history')
    .select('*').eq('equipment_id', equipmentId)
    .order('recorded_at', { ascending: false });
  if (error) { console.error(error); return []; }
  return data || [];
}

/* ---------- Quotes DB ---------- */
async function dbLoadQuotes() {
  const { data, error } = await sb.from('quotes').select('*').order('created_at', { ascending: false });
  if (error) { console.error('dbLoadQuotes:', error); return []; }
  return data.filter(r => !r.quote_no.startsWith('TMPL-')).map(r => ({
    id: r.id,
    quoteNo: r.quote_no,
    hospital: r.hospital,
    doctor: r.doctor,
    savedAt: new Date(r.created_at).toLocaleString('ko-KR', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).replace(/\.\s*/g,'.').replace(',',''),
    finalAmt: r.final_amt,
    dept: r.dept || '',
    quoteInfo: { hospital: r.hospital, doctor: r.doctor, dept: r.dept || '', quoteNo: r.quote_no, date: r.date, validity: r.validity },
    categories: r.categories,
    globalDiscount: r.global_discount,
    vatIncluded: r.vat_included,
    author: r.author || '',
    lead_id: r.lead_id || null,
  }));
}

async function dbSaveQuote(entry) {
  // 견적번호 race condition 대응: unique constraint 위반 시 재생성 + 재시도 (최대 3회)
  const MAX_RETRIES = 3;
  let attempt = 0;
  let quoteNo = entry.quoteNo;
  while (attempt < MAX_RETRIES) {
    const row = {
      quote_no: quoteNo,
      hospital: entry.quoteInfo.hospital,
      doctor: entry.quoteInfo.doctor,
      dept: entry.quoteInfo.dept || '',
      date: entry.quoteInfo.date,
      validity: entry.quoteInfo.validity,
      categories: entry.categories,
      global_discount: entry.globalDiscount,
      vat_included: entry.vatIncluded,
      final_amt: entry.finalAmt,
      author: entry.author || null,
      lead_id: entry.lead_id || null,
    };
    let { error } = await sb.from('quotes').insert(row);
    if (!error) return quoteNo;
    // author 컬럼 미존재 호환성
    if (error.message && error.message.includes('author')) {
      const { author: _, ...rowWithoutAuthor } = row;
      const { error: err2 } = await sb.from('quotes').insert(rowWithoutAuthor);
      if (!err2) return quoteNo;
      error = err2;
    }
    // 중복 키 에러면 번호 재생성 후 재시도
    const isDup = error && (error.code === '23505' || (error.message || '').includes('duplicate') || (error.message || '').toLowerCase().includes('unique'));
    if (isDup && attempt < MAX_RETRIES - 1) {
      console.warn(`견적번호 ${quoteNo} 중복, 재생성 중... (attempt ${attempt + 1})`);
      quoteNo = await dbGenerateQuoteNo();
      attempt++;
      continue;
    }
    throw error;
  }
  throw new Error('견적번호 생성 실패: 여러 번 시도했으나 중복이 해결되지 않았습니다.');
}

async function dbDeleteQuote(id) {
  const { error } = await sb.from('quotes').delete().eq('id', id);
  if (error) throw error;
}

/* ---------- Standard Templates DB ---------- */
async function dbLoadTemplates() {
  const { data, error } = await sb.from('quotes').select('*').like('quote_no', 'TMPL-%').order('quote_no');
  if (error) { console.error('dbLoadTemplates:', error); return {}; }
  const map = {};
  for (const r of data) {
    // quote_no: 'TMPL-정형외과-1억'  →  dept='정형외과', tier='1억'
    const withoutPrefix = r.quote_no.slice(5); // remove 'TMPL-'
    const lastDash = withoutPrefix.lastIndexOf('-');
    if (lastDash === -1) continue;
    const dept = withoutPrefix.slice(0, lastDash);
    const tier = withoutPrefix.slice(lastDash + 1);
    map[dept + '__' + tier] = { id: r.id, quoteNo: r.quote_no, dept, tier, categories: r.categories || [] };
  }
  return map;
}

async function dbUpsertTemplate(dept, tier, categories) {
  const quoteNo = 'TMPL-' + dept + '-' + tier;
  const row = {
    quote_no: quoteNo, hospital: '__TEMPLATE__', doctor: '', dept,
    date: getToday(), validity: '', categories,
    global_discount: { type: 'rate', value: 0 }, vat_included: false, final_amt: 0,
  };
  const { data: existing } = await sb.from('quotes').select('id').eq('quote_no', quoteNo);
  if (existing && existing.length > 0) {
    const { error } = await sb.from('quotes').update(row).eq('quote_no', quoteNo);
    if (error) throw error;
  } else {
    const { error } = await sb.from('quotes').insert(row);
    if (error) throw error;
  }
}

async function dbDeleteTemplate(quoteNo) {
  const { error } = await sb.from('quotes').delete().eq('quote_no', quoteNo);
  if (error) throw error;
}

async function dbGenerateQuoteNo() {
  const year = new Date().getFullYear();
  const { data, error } = await sb.from('quotes').select('quote_no').like('quote_no', `DW-${year}-%`).order('quote_no', { ascending: false }).limit(1);
  if (error || !data || data.length === 0) return `DW-${year}-001`;
  const seq = parseInt(data[0].quote_no.split('-')[2], 10);
  return `DW-${year}-${String((isNaN(seq) ? 0 : seq) + 1).padStart(3, '0')}`;
}

async function dbLoadQuoteByNo(quoteNo) {
  const { data, error } = await sb.from('quotes').select('*').eq('quote_no', quoteNo).single();
  if (error || !data) return null;
  return {
    id: data.id, quoteNo: data.quote_no,
    hospital: data.hospital, doctor: data.doctor,
    savedAt: new Date(data.created_at).toLocaleString('ko-KR'),
    finalAmt: data.final_amt, dept: data.dept || '',
    quoteInfo: { hospital: data.hospital, doctor: data.doctor, dept: data.dept || '', quoteNo: data.quote_no, date: data.date, validity: data.validity },
    categories: data.categories, globalDiscount: data.global_discount,
    vatIncluded: data.vat_included, author: data.author || '', lead_id: data.lead_id || null,
  };
}

async function dbGenerateRevisionNo(baseQuoteNo) {
  const cleanBase = baseQuoteNo.replace(/-R\d+$/, '');
  const { data, error } = await sb.from('quotes').select('quote_no').like('quote_no', `${cleanBase}-R%`).order('quote_no', { ascending: false }).limit(1);
  if (error || !data || data.length === 0) return `${cleanBase}-R2`;
  const match = data[0].quote_no.match(/-R(\d+)$/);
  const revNum = match ? parseInt(match[1], 10) : 1;
  return `${cleanBase}-R${revNum + 1}`;
}

/* ---------- Dynamic Categories DB ---------- */
async function dbLoadDynCats() {
  const { data, error } = await sb.from('categories').select('*').order('sort_order').order('created_at');
  if (error) { console.error('dbLoadDynCats:', error); return []; }
  return data.map(r => ({ dbId: r.id, id: r.cat_id, name: r.name, colorKey: r.color_key || 'blue', sortOrder: r.sort_order }));
}
async function dbSaveDynCat(cat) {
  const catId = 'cat-' + Date.now();
  const { data, error } = await sb.from('categories').insert({ cat_id: catId, name: cat.name.trim(), color_key: cat.colorKey || 'blue', sort_order: cat.sortOrder || 99 }).select('id').single();
  if (error) throw error;
  return { dbId: data.id, id: catId, name: cat.name.trim(), colorKey: cat.colorKey || 'blue', sortOrder: cat.sortOrder || 99 };
}
async function dbDeleteDynCat(dbId) {
  const { error } = await sb.from('categories').delete().eq('id', dbId);
  if (error) throw error;
}

/* ---------- Dynamic Cat Items DB ---------- */
async function dbLoadDynItems() {
  const { data, error } = await sb.from('cat_items').select('*').order('sort_order').order('created_at');
  if (error) { console.error('dbLoadDynItems:', error); return []; }
  return data.map(r => ({ id: r.id, catId: r.cat_id, name: r.name }));
}
async function dbSaveDynItem(item) {
  const { data, error } = await sb.from('cat_items').insert({ cat_id: item.catId, name: item.name.trim() }).select('id').single();
  if (error) throw error;
  return { id: data.id, catId: item.catId, name: item.name.trim() };
}
async function dbDeleteDynItem(id) {
  const { error } = await sb.from('cat_items').delete().eq('id', id);
  if (error) throw error;
}

/* ---------- Hospitals DB ---------- */
async function dbLoadHospitals() {
  const { data, error } = await sb.from('hospitals').select('*').order('created_at', { ascending: false });
  if (error) { console.error('dbLoadHospitals:', error); return []; }
  return data;
}
async function dbNextHospitalCode() {
  const { data } = await sb.from('hospitals').select('hospital_code').like('hospital_code', 'H%').order('hospital_code', { ascending: false }).limit(1);
  if (!data || data.length === 0) return 'H001';
  const m = (data[0].hospital_code || '').match(/H(\d+)/);
  const next = m ? parseInt(m[1], 10) + 1 : 1;
  return 'H' + String(next).padStart(3, '0');
}
async function dbSaveHospital(h) {
  const row = { ...h };
  if (!row.hospital_code) row.hospital_code = await dbNextHospitalCode();
  const { data, error } = await sb.from('hospitals').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}
async function dbUpdateHospital(id, h) {
  const { error } = await sb.from('hospitals').update(h).eq('id', id);
  if (error) throw error;
}
async function dbDeleteHospital(id) {
  const { error } = await sb.from('hospitals').delete().eq('id', id);
  if (error) throw error;
}

/* ---------- Contracts DB ---------- */
async function dbLoadContracts(hospitalId = null) {
  let q = sb.from('contracts').select('*').order('created_at', { ascending: false });
  if (hospitalId) q = q.eq('hospital_id', hospitalId);
  const { data, error } = await q;
  if (error) { console.error('dbLoadContracts:', error); return []; }
  return data;
}
async function dbSaveContract(c) {
  const { data, error } = await sb.from('contracts').insert(c).select('id').single();
  if (error) throw error;
  return data.id;
}
async function dbUpdateContract(id, c) {
  const { error } = await sb.from('contracts').update(c).eq('id', id);
  if (error) throw error;
}

/* ---------- Deliveries DB ---------- */
async function dbLoadDeliveries(hospitalId) {
  const { data, error } = await sb.from('deliveries')
    .select('*, delivery_items(*)')
    .eq('hospital_id', hospitalId)
    .order('delivered_date', { ascending: false });
  if (error) { console.error('dbLoadDeliveries:', error); return []; }
  return data;
}
async function dbSaveDelivery(delivery, items) {
  const { data, error } = await sb.from('deliveries').insert(delivery).select('id').single();
  if (error) throw error;
  const deliveryId = data.id;
  if (items && items.length > 0) {
    const rows = items.map(it => ({ ...it, delivery_id: deliveryId }));
    const { error: ie } = await sb.from('delivery_items').insert(rows);
    if (ie) throw ie;
  }
  return deliveryId;
}
async function dbDeleteDelivery(id) {
  const { error } = await sb.from('deliveries').delete().eq('id', id);
  if (error) throw error;
}
async function dbLoadAllInspectionItems() {
  // C-Arm, X-Ray, CT 장비 — 3년 주기 방사선 안전관리 검사 대상
  const { data, error } = await sb.from('delivery_items')
    .select('id,item_name,model_name,spec,deliveries!inner(id,hospital_id,delivered_date)')
    .or('item_name.ilike.*c-arm*,item_name.ilike.*x-ray*,item_name.ilike.*ct*')
    .limit(1000);
  if (error) { console.error('dbLoadAllInspectionItems:', error); return []; }
  return (data || []).map(d => ({
    id: d.id,
    item_name: d.item_name,
    model_name: d.model_name,
    spec: d.spec,
    hospital_id: d.deliveries?.hospital_id,
    delivered_date: d.deliveries?.delivered_date,
  }));
}

/* ---------- Service Requests DB ---------- */
async function dbLoadServiceRequests(hospitalId = null) {
  let q = sb.from('service_requests').select('*').order('created_at', { ascending: false });
  if (hospitalId) q = q.eq('hospital_id', hospitalId);
  const { data, error } = await q;
  if (error) { console.error('dbLoadServiceRequests:', error); return []; }
  return data;
}
async function dbSaveServiceRequest(sr) {
  const { data, error } = await sb.from('service_requests').insert(sr).select('id').single();
  if (error) throw error;
  return data.id;
}
async function dbUpdateServiceRequest(id, sr) {
  const { error } = await sb.from('service_requests').update(sr).eq('id', id);
  if (error) throw error;
}

/* ---------- Leads DB ---------- */
async function dbLoadLeads() {
  const { data, error } = await sb.from('leads').select('*').order('created_at', { ascending: false });
  if (error) { console.error('dbLoadLeads:', error); return []; }
  return data;
}
async function dbSaveLead(lead) {
  const { data, error } = await sb.from('leads').insert(lead).select('id').single();
  if (error) throw error;
  return data.id;
}
async function dbUpdateLead(id, lead) {
  const { error } = await sb.from('leads').update(lead).eq('id', id);
  if (error) throw error;
}
async function dbDeleteLead(id) {
  const { error } = await sb.from('leads').delete().eq('id', id);
  if (error) throw error;
}

/* ---------- Manufacturers DB ---------- */
async function dbLoadManufacturers() {
  const { data, error } = await sb.from('manufacturers').select('*').order('name');
  if (error) { console.error('dbLoadManufacturers:', error); return []; }
  return data;
}
async function dbNextVendorCode() {
  const { data } = await sb.from('manufacturers').select('vendor_code').like('vendor_code', 'V%').order('vendor_code', { ascending: false }).limit(1);
  if (!data || data.length === 0) return 'V001';
  const m = (data[0].vendor_code || '').match(/V(\d+)/);
  const next = m ? parseInt(m[1], 10) + 1 : 1;
  return 'V' + String(next).padStart(3, '0');
}
async function dbSaveManufacturer(m) {
  const row = { ...m };
  if (!row.vendor_code) row.vendor_code = await dbNextVendorCode();
  const { data, error } = await sb.from('manufacturers').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}
async function dbUpdateManufacturer(id, m) {
  const { error } = await sb.from('manufacturers').update(m).eq('id', id);
  if (error) throw error;
}
async function dbDeleteManufacturer(id) {
  const { error } = await sb.from('manufacturers').delete().eq('id', id);
  if (error) throw error;
}

/* ---------- Purchase Orders DB ---------- */
async function dbLoadPurchaseOrders(contractId = null) {
  let q = sb.from('purchase_orders').select('*, purchase_order_items(*)').order('created_at', { ascending: false });
  if (contractId) q = q.eq('contract_id', contractId);
  const { data, error } = await q;
  if (error) { console.error('dbLoadPurchaseOrders:', error); return []; }
  return data;
}
async function dbSavePurchaseOrder(po, items) {
  const { data, error } = await sb.from('purchase_orders').insert({ ...po, updated_at: new Date().toISOString() }).select('id').single();
  if (error) throw error;
  const poId = data.id;
  if (items && items.length > 0) {
    const rows = items.map(it => ({ ...it, po_id: poId }));
    const { error: ie } = await sb.from('purchase_order_items').insert(rows);
    if (ie) throw ie;
  }
  return poId;
}
async function dbUpdatePurchaseOrder(id, po) {
  const { error } = await sb.from('purchase_orders').update({ ...po, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}
async function dbDeletePurchaseOrder(id) {
  // 연동된 외상매입 트랜잭션 모두 정리 (purchase + adjustment + cancel — payment는 PO와 별개라 보존)
  await sb.from('payable_transactions').delete().eq('po_id', id).in('tx_type', ['purchase','adjustment','cancel']);
  const { error } = await sb.from('purchase_orders').delete().eq('id', id);
  if (error) throw error;
}
async function dbUpdatePoItem(id, patch) {
  const { error } = await sb.from('purchase_order_items').update(patch).eq('id', id);
  if (error) throw error;
}

/* ---------- PO Notes (발주별 메모·이슈 로그) ---------- */
async function dbLoadPoNotes(poIds = null) {
  let q = sb.from('po_notes').select('*').order('created_at', { ascending: false });
  if (poIds && poIds.length > 0) q = q.in('po_id', poIds);
  const { data, error } = await q;
  if (error) { console.error('dbLoadPoNotes:', error); return []; }
  return data || [];
}
async function dbInsertPoNote(row) {
  const { data, error } = await sb.from('po_notes').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}
async function dbUpdatePoNote(id, patch) {
  const { error } = await sb.from('po_notes').update(patch).eq('id', id);
  if (error) throw error;
}
async function dbDeletePoNote(id) {
  const { error } = await sb.from('po_notes').delete().eq('id', id);
  if (error) throw error;
}

/* ---------- PO Checklist (발주별 체크리스트) ---------- */
async function dbLoadChecklists(poIds = null) {
  let q = sb.from('po_checklist_items').select('*').order('created_at', { ascending: true });
  if (poIds && poIds.length > 0) q = q.in('po_id', poIds);
  const { data, error } = await q;
  if (error) { console.error('dbLoadChecklists:', error); return []; }
  return data || [];
}
async function dbInsertChecklist(row) {
  const { data, error } = await sb.from('po_checklist_items').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}
async function dbUpdateChecklist(id, patch) {
  const { error } = await sb.from('po_checklist_items').update(patch).eq('id', id);
  if (error) throw error;
}
async function dbDeleteChecklist(id) {
  const { error } = await sb.from('po_checklist_items').delete().eq('id', id);
  if (error) throw error;
}

async function dbGeneratePoNo() {
  const year = new Date().getFullYear();
  const prefix = `PO-${year}-`;
  // 원본만 카운트 (revision=0). 리비전 -R{n} 은 제외
  const { data } = await sb.from('purchase_orders')
    .select('po_no')
    .like('po_no', `${prefix}%`)
    .eq('revision', 0)
    .order('po_no', { ascending: false }).limit(1);
  if (data && data.length > 0) {
    // 'PO-2026-001' → 001 추출 (R 접미사 무시)
    const m = data[0].po_no.match(/PO-\d+-(\d+)/);
    const lastNum = m ? parseInt(m[1], 10) : 0;
    return `${prefix}${String(lastNum + 1).padStart(3, '0')}`;
  }
  return `${prefix}001`;
}

// 발주서 리비전 저장: 옛 PO를 비활성화하고 새 리비전 INSERT
async function dbSavePurchaseOrderRevision(originalPoId, newPoData, newItems, reason) {
  // 1. 원본/부모 정보 조회
  const { data: original, error: e0 } = await sb.from('purchase_orders')
    .select('id, po_no, parent_po_id, revision')
    .eq('id', originalPoId).single();
  if (e0) throw e0;
  // parent는 원본(revision=0). 현재가 이미 리비전이면 parent를 그대로 사용
  const parentId = original.parent_po_id || original.id;
  const { data: parent } = await sb.from('purchase_orders')
    .select('po_no, revision').eq('id', parentId).single();

  // 2. 다음 리비전 번호 계산 (parent 기준 하위 리비전 중 최댓값 + 1)
  const { data: siblings } = await sb.from('purchase_orders')
    .select('revision').eq('parent_po_id', parentId).order('revision', { ascending: false }).limit(1);
  const nextRev = ((siblings && siblings[0]?.revision) || 0) + 1;

  // 3. 새 PO 번호: 부모번호 + -R{nextRev}
  const newPoNo = `${parent.po_no}-R${nextRev}`;

  // 4. 기존 활성 리비전들 모두 비활성화 (parent 자신 + 모든 자식)
  await sb.from('purchase_orders').update({ is_active: false }).eq('id', parentId);
  await sb.from('purchase_orders').update({ is_active: false }).eq('parent_po_id', parentId);

  // 5. 새 리비전 INSERT
  const { data: inserted, error: e1 } = await sb.from('purchase_orders').insert({
    ...newPoData,
    po_no: newPoNo,
    parent_po_id: parentId,
    revision: nextRev,
    is_active: true,
    revision_reason: reason || null,
  }).select('id').single();
  if (e1) throw e1;
  const newPoId = inserted.id;

  // 6. 품목 INSERT
  if (newItems && newItems.length > 0) {
    const rows = newItems.map(it => ({ ...it, po_id: newPoId }));
    const { error: e2 } = await sb.from('purchase_order_items').insert(rows);
    if (e2) throw e2;
  }
  return { newPoId, newPoNo, revision: nextRev };
}

// 발주서 리비전 이력 조회 (parent + 모든 자식)
async function dbLoadPurchaseOrderHistory(poId) {
  const { data: target } = await sb.from('purchase_orders')
    .select('id, parent_po_id').eq('id', poId).single();
  if (!target) return [];
  const parentId = target.parent_po_id || target.id;
  const { data, error } = await sb.from('purchase_orders')
    .select('*, purchase_order_items(*)')
    .or(`id.eq.${parentId},parent_po_id.eq.${parentId}`)
    .order('revision', { ascending: false });
  if (error) { console.error(error); return []; }
  return data;
}

/* ---------- Contracts DB (all) ---------- */
// 목록 로드: categories JSON 컬럼 제외 (Egress 절감 — 15행 730KB → 3KB)
// categories가 필요한 발주계획서/병원 관리 등에서는 dbLoadContractWithCategories 단건 호출 사용
const CONTRACT_META_COLUMNS = 'id,hospital_id,hospital_name,quote_name,contract_date,delivery_target_date,amount,status,list_fixed,statement_issued,statement_issued_at,invoice_issued,invoice_issued_at,invoice_amount,collected,collected_at,collected_amount,all_paid,margin,created_at';
async function dbLoadAllContracts() {
  const { data, error } = await sb.from('contracts').select(CONTRACT_META_COLUMNS).order('created_at', { ascending: false });
  if (error) { console.error('dbLoadAllContracts:', error); return []; }
  return data;
}
// categories 포함 단건 조회 (id 또는 quote_name)
async function dbLoadContractWithCategories({ id = null, quoteName = null } = {}) {
  let q = sb.from('contracts').select('*');
  if (id) q = q.eq('id', id);
  else if (quoteName) q = q.eq('quote_name', quoteName);
  else return null;
  const { data, error } = await q.maybeSingle();
  if (error) { console.error('dbLoadContractWithCategories:', error); return null; }
  return data;
}

/* ---------- Payables (외상매입금) ---------- */
async function dbLoadPayableBalances() {
  // v_payable_balance: manufacturer_id, manufacturer_name, vendor_code, balance, total_purchase, total_payment, last_tx_date
  const { data, error } = await sb.from('v_payable_balance').select('*').order('balance', { ascending: false });
  if (error) { console.error('dbLoadPayableBalances:', error); return []; }
  return data || [];
}
async function dbLoadPayableTransactions({ manufacturerId = null, dateFrom = null, dateTo = null } = {}) {
  let q = sb.from('payable_transactions').select('*').order('tx_date', { ascending: false }).order('created_at', { ascending: false });
  if (manufacturerId) q = q.eq('manufacturer_id', manufacturerId);
  if (dateFrom) q = q.gte('tx_date', dateFrom);
  if (dateTo) q = q.lte('tx_date', dateTo);
  const { data, error } = await q;
  if (error) { console.error('dbLoadPayableTransactions:', error); return []; }
  return data || [];
}
async function dbInsertPayableTransaction(row) {
  const { data, error } = await sb.from('payable_transactions').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}
async function dbInsertPaymentBatch({ txDate, items, batchMemo, cashBalanceAfter }) {
  // items: [{ manufacturerId, amount, memo }]
  if (!items || items.length === 0) return null;
  // crypto.randomUUID() 가용 (Supabase JS 클라이언트도 사용)
  const batchId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const rows = items.filter(it => it.amount > 0).map(it => ({
    manufacturer_id: it.manufacturerId,
    tx_date: txDate,
    tx_type: 'payment',
    amount: it.amount,
    memo: it.memo || batchMemo || null,
    payment_batch_id: batchId,
  }));
  if (rows.length === 0) return null;
  const { error } = await sb.from('payable_transactions').insert(rows);
  if (error) throw error;
  const total = rows.reduce((s, r) => s + r.amount, 0);
  // cash_balance_log 1행 자동 기록 (출금)
  const cashRow = {
    log_date: txDate,
    delta: -total,
    memo: batchMemo || `${txDate} 일괄지급 (${rows.length}건)`,
    payment_batch_id: batchId,
  };
  if (cashBalanceAfter !== undefined && cashBalanceAfter !== null && cashBalanceAfter !== '') {
    cashRow.balance_after = Number(cashBalanceAfter);
  }
  const { error: ce } = await sb.from('cash_balance_log').insert(cashRow);
  if (ce) console.error('cash_balance_log insert:', ce);
  return { batchId, total, count: rows.length };
}
async function dbDeletePayableTransaction(id) {
  const { error } = await sb.from('payable_transactions').delete().eq('id', id);
  if (error) throw error;
}
async function dbDeletePaymentBatch(batchId) {
  const { error } = await sb.from('payable_transactions').delete().eq('payment_batch_id', batchId);
  if (error) throw error;
  await sb.from('cash_balance_log').delete().eq('payment_batch_id', batchId);
}
async function dbLoadCashBalanceLog({ limit = 100 } = {}) {
  const { data, error } = await sb.from('cash_balance_log').select('*').order('log_date', { ascending: false }).order('created_at', { ascending: false }).limit(limit);
  if (error) { console.error('dbLoadCashBalanceLog:', error); return []; }
  return data || [];
}
async function dbInsertCashBalance(row) {
  const { data, error } = await sb.from('cash_balance_log').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}
async function dbDeleteCashBalance(id) {
  const { error } = await sb.from('cash_balance_log').delete().eq('id', id);
  if (error) throw error;
}

/* ---------- Receivables (매출/수금 AR) ---------- */
async function dbLoadReceivableBalances() {
  // v_receivable_balance: hospital_id, hospital_name, total_invoice, contract_count,
  //   total_collected, total_adjustment, total_cancel, balance, last_tx_date
  const { data, error } = await sb.from('v_receivable_balance').select('*').order('balance', { ascending: false });
  if (error) { console.error('dbLoadReceivableBalances:', error); return []; }
  return data || [];
}
async function dbLoadReceivableTransactions({ hospitalId = null, contractId = null, dateFrom = null, dateTo = null } = {}) {
  let q = sb.from('receivable_transactions').select('*').order('tx_date', { ascending: false }).order('created_at', { ascending: false });
  if (hospitalId) q = q.eq('hospital_id', hospitalId);
  if (contractId) q = q.eq('contract_id', contractId);
  if (dateFrom) q = q.gte('tx_date', dateFrom);
  if (dateTo) q = q.lte('tx_date', dateTo);
  const { data, error } = await q;
  if (error) { console.error('dbLoadReceivableTransactions:', error); return []; }
  return data || [];
}
async function dbInsertReceivableTransaction(row) {
  const { data, error } = await sb.from('receivable_transactions').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}
async function dbDeleteReceivableTransaction(id) {
  const { error } = await sb.from('receivable_transactions').delete().eq('id', id);
  if (error) throw error;
}

/* ---------- Expected Revenue (예상 매출) ---------- */
async function dbLoadExpectedRevenue() {
  const { data, error } = await sb.from('expected_revenue').select('*')
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) { console.error('dbLoadExpectedRevenue:', error); return []; }
  return data || [];
}
async function dbLoadExpectedRevenueSummary() {
  const { data, error } = await sb.from('v_expected_revenue_summary').select('*');
  if (error) { console.error('dbLoadExpectedRevenueSummary:', error); return []; }
  return data || [];
}
async function dbInsertExpectedRevenue(row) {
  const { data, error } = await sb.from('expected_revenue').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}
async function dbInsertExpectedRevenueBatch(rows) {
  if (!rows || rows.length === 0) return [];
  const { data, error } = await sb.from('expected_revenue').insert(rows).select('id');
  if (error) throw error;
  return (data || []).map(r => r.id);
}
async function dbUpdateExpectedRevenue(id, patch) {
  const { error } = await sb.from('expected_revenue').update(patch).eq('id', id);
  if (error) throw error;
}
async function dbDeleteExpectedRevenue(id) {
  const { error } = await sb.from('expected_revenue').delete().eq('id', id);
  if (error) throw error;
}

// 발주 ↔ 외상매입 자동 연동 (차액 누적 방식 — audit trail 보존)
// 현재 PO에 대한 매입 누적 합계를 newAmount로 맞추기 위한 차액 트랜잭션을 추가한다.
// 첫 매입이면 'purchase', 그 이후 변경은 'adjustment'로 기록.
async function dbAdjustPayableForPo({ poId, manufacturerId, txDate, newAmount, memo }) {
  const { data: existing } = await sb.from('payable_transactions')
    .select('amount, tx_type').eq('po_id', poId);
  const rels = (existing || []).filter(t => ['purchase','adjustment','cancel'].includes(t.tx_type));
  const currentTotal = rels.reduce((s, t) => s + (t.amount || 0), 0);
  const diff = (newAmount || 0) - currentTotal;
  if (diff === 0) return null;
  const txType = rels.length === 0 ? 'purchase' : 'adjustment';
  const { data, error } = await sb.from('payable_transactions')
    .insert({ po_id: poId, manufacturer_id: manufacturerId, tx_date: txDate,
              tx_type: txType, amount: diff, memo })
    .select('id').single();
  if (error) throw error;
  return { id: data.id, txType, diff };
}
// 발주 취소 — B안: 거래처 잔액을 정확히 0으로 만들고, 이미 지급된 부분은 환불 예정 보정 트랜잭션으로 명시
async function dbCancelPayableForPo({ poId, manufacturerId, txDate, reason }) {
  // 1) 이 PO의 매입 합계 (purchase + adjustment + cancel 모두)
  const { data: poTx } = await sb.from('payable_transactions')
    .select('amount, tx_type').eq('po_id', poId);
  const purchaseTotal = (poTx || [])
    .filter(t => ['purchase','adjustment','cancel'].includes(t.tx_type))
    .reduce((s, t) => s + (t.amount || 0), 0);
  if (purchaseTotal === 0) return null;

  // 2) 매입 청산 — cancel -매입합계
  const memo = `발주 취소${reason ? ' — ' + reason : ''}`;
  const { error: e1 } = await sb.from('payable_transactions')
    .insert({ po_id: poId, manufacturer_id: manufacturerId, tx_date: txDate,
              tx_type: 'cancel', amount: -purchaseTotal, memo });
  if (e1) throw e1;

  // 3) 거래처 전체 잔액 조회 후 음수면 환불 예정 보정 (잔액 0으로 맞춤)
  const { data: balRow } = await sb.from('v_payable_balance')
    .select('balance').eq('manufacturer_id', manufacturerId).single();
  const newBalance = balRow?.balance || 0;
  let refundDue = 0;
  if (newBalance < 0) {
    refundDue = -newBalance;
    const refundMemo = `발주 취소 환불 예정 ${refundDue.toLocaleString()}원 (이미 지급된 금액 — 거래처에서 환수 필요)`;
    const { error: e2 } = await sb.from('payable_transactions')
      .insert({ po_id: poId, manufacturer_id: manufacturerId, tx_date: txDate,
                tx_type: 'adjustment', amount: refundDue, memo: refundMemo });
    if (e2) throw e2;
  }
  return { canceled: purchaseTotal, refundDue };
}
// (DEPRECATED) 옛 dbSyncPayableForPo / dbDeletePayableForPo — 호환용으로 유지
async function dbSyncPayableForPo(args) {
  return dbAdjustPayableForPo({ ...args, newAmount: args.amount });
}
async function dbDeletePayableForPo(poId) {
  // 이력 보존 — 그냥 cancel 한 번 더 호출하지 않고, 발주서 삭제 시점에만 호출되는 hard delete 유지
  const { error } = await sb.from('payable_transactions')
    .delete().eq('po_id', poId);
  if (error) throw error;
}
// 미정산 발주 매입을 PO 단위로 합산하여 반환
// purchase + adjustment + cancel 트랜잭션을 PO_id별로 합산 (amount 부호 그대로)
// 합계 0 이하인 PO(전부 취소된 것 등)는 제외
async function dbLoadActivePoTransactions() {
  const { data, error } = await sb.from('payable_transactions')
    .select('manufacturer_id, po_id, tx_date, amount, memo, tx_type')
    .in('tx_type', ['purchase','adjustment','cancel'])
    .not('po_id', 'is', null)
    .order('tx_date', { ascending: false });
  if (error) { console.error('dbLoadActivePoTransactions:', error); return []; }
  const byPo = new Map();
  for (const t of data || []) {
    if (!byPo.has(t.po_id)) {
      byPo.set(t.po_id, {
        po_id: t.po_id,
        manufacturer_id: t.manufacturer_id,
        tx_date: t.tx_date,         // 가장 최근 거래일
        amount: 0,
        memo: t.memo,                // 가장 최근 메모
        tx_count: 0,
      });
    }
    const agg = byPo.get(t.po_id);
    agg.amount += (t.amount || 0);
    agg.tx_count += 1;
    if (t.tx_date && t.tx_date > agg.tx_date) agg.tx_date = t.tx_date;
  }
  // 합계 양수인 PO만 (취소된 것/0인 것 제외)
  return [...byPo.values()].filter(p => p.amount > 0);
}

/* ============================================================
   GOOGLE CALENDAR 연동
   ============================================================ */
const GCAL_CLIENT_ID = '718682549167-75dp0recums2qvbvlgr78q177fpstruk.apps.googleusercontent.com';
const GCAL_SCOPES = 'https://www.googleapis.com/auth/calendar.events';
const GCAL_API = 'https://www.googleapis.com/calendar/v3';
const GCAL_CALENDAR_ID = 'c67d2b297cc0bf6e206ea456332bdafa849f264266a20ecb17432cf72ac000b0@group.calendar.google.com';

// 영업사원 ↔ 구글 계정 매핑 (localStorage에 저장)
function getGcalMappings() {
  try { return JSON.parse(localStorage.getItem('gcal_mappings') || '{}'); } catch { return {}; }
}
function setGcalMappings(m) { localStorage.setItem('gcal_mappings', JSON.stringify(m)); }

let gcalTokenClient = null;
let gcalAccessToken = localStorage.getItem('gcal_token') || null;

function initGcalTokenClient(callback) {
  if (!window.google?.accounts?.oauth2) { console.warn('Google OAuth not loaded'); return; }
  gcalTokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GCAL_CLIENT_ID,
    scope: GCAL_SCOPES,
    callback: (resp) => {
      if (resp.access_token) {
        gcalAccessToken = resp.access_token;
        localStorage.setItem('gcal_token', resp.access_token);
        if (callback) callback(resp.access_token);
      }
    },
  });
}

function gcalAuth(callback) {
  if (gcalAccessToken) {
    // 토큰 유효성 검사
    fetch('https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=' + gcalAccessToken)
      .then(r => r.ok ? callback(gcalAccessToken) : Promise.reject())
      .catch(() => {
        gcalAccessToken = null;
        localStorage.removeItem('gcal_token');
        gcalAuth(callback);
      });
    return;
  }
  if (!gcalTokenClient) initGcalTokenClient(callback);
  else gcalTokenClient.callback = (resp) => {
    if (resp.access_token) {
      gcalAccessToken = resp.access_token;
      localStorage.setItem('gcal_token', resp.access_token);
      callback(resp.access_token);
    }
  };
  if (gcalTokenClient) gcalTokenClient.requestAccessToken();
}

async function gcalCreateEvent(meeting, lead, assigneeEmail) {
  return new Promise((resolve, reject) => {
    gcalAuth(async (token) => {
      try {
        const startDate = meeting.date;
        const startTime = meeting.time || '09:00';
        const [h, m] = startTime.split(':').map(Number);
        const endH = h + 1;
        const start = `${startDate}T${startTime}:00+09:00`;
        const end = `${startDate}T${String(endH).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+09:00`;

        const event = {
          summary: `[DW] ${lead.contact_name || ''} ${meeting.type || '미팅'}${lead.dept ? ' - ' + lead.dept : ''}`,
          description: [
            lead.hospital_name ? `병원: ${lead.hospital_name}` : '',
            `유형: ${meeting.type || '미팅'}`,
            meeting.memo ? `메모: ${meeting.memo}` : '',
            `담당: ${lead.assignee || '미배정'}`,
            '---',
            'mediquote에서 자동 생성됨',
          ].filter(Boolean).join('\n'),
          start: { dateTime: start, timeZone: 'Asia/Seoul' },
          end: { dateTime: end, timeZone: 'Asia/Seoul' },
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 10 }] },
        };

        // 영업사원 이메일이 있으면 attendee로 추가
        if (assigneeEmail) {
          event.attendees = [{ email: assigneeEmail }];
        }

        const calendarId = assigneeEmail || 'primary';
        const resp = await fetch(`${GCAL_API}/calendars/${encodeURIComponent(GCAL_CALENDAR_ID)}/events?sendUpdates=all`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
        if (!resp.ok) throw new Error('Calendar API: ' + resp.status);
        const data = await resp.json();
        resolve(data.id); // google event id 반환
      } catch (e) {
        console.error('gcalCreateEvent:', e);
        reject(e);
      }
    });
  });
}

async function gcalDeleteEvent(eventId) {
  return new Promise((resolve) => {
    gcalAuth(async (token) => {
      try {
        await fetch(`${GCAL_API}/calendars/${encodeURIComponent(GCAL_CALENDAR_ID)}/events/${eventId}`, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + token },
        });
        resolve(true);
      } catch (e) {
        console.error('gcalDeleteEvent:', e);
        resolve(false);
      }
    });
  });
}

/* ============================================================
   INITIAL DATA
   ============================================================ */
const INITIAL_CATEGORIES = [
  /* 더미 데이터 제거 완료 — 실제 데이터는 Supabase에서 로드 */
  /*
  {
    id: 'imaging', name: '영상진단 장비', colorKey: 'blue',
    items: [
      { id:'xray', name:'X-Ray (DR System)', selectedModelId:'xvision-hf-525r',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'xvision-hf-525r', name:'Xvision HF 525R', manufacturer:'Gemss healthcare', price:15000000, notes:'' },
          { id:'gxr-e40-plus', name:'GXR-E40 Plus', manufacturer:'DRgem', price:null, notes:'문의' },
          { id:'dk-innovision-f1', name:'DK Innovision F1', manufacturer:'DK Medical System', price:null, notes:'문의' },
          { id:'rex-525r', name:'REX 525R', manufacturer:'Listem', price:16000000, notes:'' },
          { id:'accuray-d5', name:'Accuray D5', manufacturer:'DK Medical System', price:null, notes:'문의' },
          { id:'ai-xray-dr', name:'AI X RAY + DR', manufacturer:'Remedi', price:20000000, notes:'' },
          { id:'apex-dr', name:'Apex DR', manufacturer:'DK Medical System', price:15000000, notes:'콘덴서 포함' },
        ]},
      { id:'dr', name:'DR', selectedModelId:'lg-17x17',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'lg-17x17', name:'LG 17x17', manufacturer:'LG', price:29910000, notes:'' },
          { id:'bsd-4343', name:'BSD 4343', manufacturer:'Bon Tech', price:10500000, notes:'' },
          { id:'acquidr-mano4343t', name:'AcquiDR Mano4343T', manufacturer:'DrGem', price:11000000, notes:'' },
          { id:'rfa-17x17', name:'RFA 17x17', manufacturer:'Astel', price:10500000, notes:'' },
        ]},
      { id:'carm', name:'C-Arm', selectedModelId:'kmc-650',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'kmc-650', name:'KMC-650', manufacturer:'Gemss healthcare', price:34500000, notes:'' },
          { id:'zen-2090-turbo', name:'ZEN-2090 Turbo', manufacturer:'Genoray', price:null, notes:'미팅시 가격제안' },
          { id:'xplus-35d', name:'Xplus 35D', manufacturer:'Gemss healthcare', price:40000000, notes:'' },
          { id:'oscar-prime', name:'Oscar Prime', manufacturer:'Genoray', price:null, notes:'미팅시 가격제안' },
          { id:'spinel-3g', name:'Spinel 3G', manufacturer:'Gemss healthcare', price:70000000, notes:'' },
          { id:'carm-handswitch', name:'핸드스위치 (C-Arm 옵션)', manufacturer:'제조사별', price:110000, notes:'' },
        ]},
      { id:'carm-table', name:'C-Arm Table', selectedModelId:'x3-b',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'x3-b', name:'X3-B', manufacturer:'01M', price:2000000, notes:'' },
          { id:'kf-906', name:'KF 906', manufacturer:'펄시', price:1900000, notes:'' },
          { id:'ca-1000', name:'CA-1000', manufacturer:'네오텍', price:2000000, notes:'' },
        ]},
      { id:'ultrasound', name:'초음파진단기', selectedModelId:'versana-balance',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'versana-balance', name:'Versana Balance', manufacturer:'GE Healthcare', price:22000000, notes:'' },
          { id:'logiq-f', name:'Logiq F', manufacturer:'GE Healthcare', price:27000000, notes:'' },
          { id:'logiq-p7', name:'Logiq P7', manufacturer:'GE Healthcare', price:null, notes:'문의' },
          { id:'xc-50', name:'XC-50', manufacturer:'Alpinion', price:null, notes:'문의' },
          { id:'xc-60', name:'XC-60', manufacturer:'Alpinion', price:null, notes:'문의' },
          { id:'v5', name:'V5', manufacturer:'Samsung Medison', price:null, notes:'문의' },
          { id:'v7', name:'V7', manufacturer:'Samsung Medison', price:null, notes:'문의' },
          { id:'juniper', name:'Juniper', manufacturer:'Siemens Healthineers', price:35000000, notes:'' },
        ]},
      { id:'bmd', name:'골밀도진단기', selectedModelId:'dexino',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'dexino', name:'Dexino', manufacturer:'J-One Medical System', price:14000000, notes:'' },
          { id:'inalyzer-air', name:'Inalyzer AIR', manufacturer:'Medikors', price:16000000, notes:'' },
          { id:'dexxum-t', name:'Dexxum T', manufacturer:'Osteosys', price:null, notes:'문의' },
        ]},
      { id:'pacs', name:'PACS', selectedModelId:'pacs-techheim',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'pacs-techheim', name:'PACS', manufacturer:'TechHeim', price:2000000, notes:'' },
          { id:'pacs-fuji', name:'PACS', manufacturer:'Fuji', price:500000, notes:'' },
        ]},
    ]
  },
  {
    id: 'pt', name: '물리치료기기', colorKey: 'emerald',
    items: [
      { id:'ict', name:'ICT 간섭파', selectedModelId:'ecoplus',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'kmc-2900jt', name:'KMC-2900JT', manufacturer:'Medi Round', price:1000000, notes:'TENS 포함' },
          { id:'ecoplus', name:'Ecoplus', manufacturer:'Goodple', price:1000000, notes:'' },
          { id:'gp-mediplus', name:'GP-Mediplus', manufacturer:'Goodple', price:1000000, notes:'' },
          { id:'lectron-350ri', name:'Lectron 350RI', manufacturer:'DMC', price:1200000, notes:'' },
          { id:'biotron', name:'BioTron', manufacturer:'DMC', price:1400000, notes:'' },
          { id:'pmi-3000', name:'PMI 3000', manufacturer:'Stratek', price:1600000, notes:'' },
          { id:'ict-insung', name:'ICT', manufacturer:'Insung Medical', price:1200000, notes:'' },
        ]},
      { id:'microwave', name:'Microwave', selectedModelId:'is-3000',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'is-3000', name:'IS-3000', manufacturer:'Insung Medical', price:1500000, notes:'' },
          { id:'scan-laser', name:'Scan Laser', manufacturer:'Goodple', price:1500000, notes:'' },
        ]},
      { id:'ir', name:'적외선치료기', selectedModelId:'ir-2014',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'ir-3000', name:'IR-3000', manufacturer:'Haedong Medical', price:120000, notes:'' },
          { id:'ir-2014', name:'IR-2014', manufacturer:'열린세상', price:120000, notes:'' },
        ]},
      { id:'newmyo', name:'Newmyo', selectedModelId:'newmyo-kmg',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'newmyo-kmg', name:'뉴마이오 (의료용조합자극기)', manufacturer:'KMG', price:3600000, notes:'' },
        ]},
      { id:'cryo', name:'Cryo', selectedModelId:'cryo-master',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'btl-cryo', name:'BTL Cryotherapy', manufacturer:'BTL', price:null, notes:'문의' },
          { id:'cryo-master', name:'Cryo Master', manufacturer:'Mesh', price:4800000, notes:'' },
          { id:'cryo-well', name:'Cryo-Well', manufacturer:'DMC', price:4000000, notes:'' },
          { id:'pain-zero', name:'Pain Zero', manufacturer:'메디젠', price:4000000, notes:'' },
        ]},
      { id:'magnetic', name:'자기장치료기', selectedModelId:'tesla-3000',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'tesla-3000', name:'Tesla 3000', manufacturer:'Wever', price:3600000, notes:'' },
          { id:'anybeat-33', name:'Anybeat 33', manufacturer:'신화', price:3500000, notes:'' },
          { id:'magstorm-flat', name:'Magstorm Flat', manufacturer:'케이원메드', price:3600000, notes:'' },
        ]},
      { id:'hilt', name:'고강도레이저', selectedModelId:'lambda-yag',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'lambda-yag', name:'Lambda Yag', manufacturer:'AITIS Korea', price:20000000, notes:'' },
          { id:'hilthera-4', name:'Hilthera 4.0', manufacturer:'Rev Med', price:30000000, notes:'' },
          { id:'bonpapa', name:'Bonpapa', manufacturer:'Bonpapa', price:16000000, notes:'' },
        ]},
      { id:'hydro', name:'수치료기', selectedModelId:'aqua-healing-bed',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'aqua-healing-bed', name:'Aqua Healing Bed', manufacturer:'Hyu Medi', price:5900000, notes:'' },
          { id:'aqua-line-g4', name:'Aqua Line G4', manufacturer:'Goodple', price:5500000, notes:'' },
        ]},
      { id:'percussion', name:'근육타진기', selectedModelId:'01m7-d',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'01m7-d', name:'01M7-D', manufacturer:'01M', price:1200000, notes:'' },
          { id:'t10', name:'T10 (팁7개)', manufacturer:'Young In', price:1000000, notes:'' },
        ]},
    ]
  },
  {
    id: 'manual', name: '도수치료 장비', colorKey: 'amber',
    items: [
      { id:'eswt', name:'ESWT', selectedModelId:'zeus-wave-pr',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'dual-wave-plus', name:'Dual Wave Plus', manufacturer:'iwellness', price:13000000, notes:'' },
          { id:'zeus-wave-pr', name:'Zeus Wave (piezo+Radial)', manufacturer:'Wever Instrument', price:16000000, notes:'' },
          { id:'zeus-wave-ph', name:'Zeus Wave (piezo+Hilt)', manufacturer:'Wever Instrument', price:25000000, notes:'' },
          { id:'dual-active-f', name:'Dual Active F', manufacturer:'K1 Med', price:16000000, notes:'' },
          { id:'wolf-piezo-2', name:'Wolf Piezo Wave 2', manufacturer:'Wolf', price:50000000, notes:'' },
          { id:'storz', name:'Storz', manufacturer:'Storz Medical', price:null, notes:'문의' },
          { id:'shockwave-f1', name:'Shockwave F1', manufacturer:'WMedix', price:35000000, notes:'' },
          { id:'sineson-piezo', name:'Sineson Piezo', manufacturer:'K1Med', price:15000000, notes:'' },
          { id:'piezo-di2', name:'Piezo Di2', manufacturer:'DMC', price:12000000, notes:'' },
          { id:'gp707sw', name:'GP707SW', manufacturer:'Goodple', price:6000000, notes:'' },
        ]},
      { id:'traction', name:'견인치료기', selectedModelId:'spine-balance',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'lc-100', name:'LC-100', manufacturer:'Win-Trac', price:3600000, notes:'' },
          { id:'spine-balance', name:'Spine Balance', manufacturer:'에이원', price:8000000, notes:'' },
          { id:'sst-100-plus', name:'SST-100 Plus', manufacturer:'Stratek', price:2500000, notes:'' },
          { id:'traction-dmc', name:'Traction', manufacturer:'DMC', price:2400000, notes:'' },
        ]},
      { id:'chiro', name:'Chiropractic', selectedModelId:'raphael-707',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'raphael-707', name:'Raphael 707', manufacturer:'01M', price:12000000, notes:'' },
          { id:'cw500', name:'CW500', manufacturer:'01M', price:5000000, notes:'' },
        ]},
      { id:'manual-table', name:'도수치료 테이블', selectedModelId:'m2-a',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'m2-a', name:'M2-A', manufacturer:'01M', price:690000, notes:'' },
          { id:'m2-b', name:'M2-B', manufacturer:'01M', price:780000, notes:'' },
          { id:'e-100', name:'E-100 보급형', manufacturer:'HCK', price:700000, notes:'' },
          { id:'e-102', name:'E-102 경추형', manufacturer:'HCK', price:900000, notes:'' },
          { id:'go-2000', name:'GO 2000 범용 전동식', manufacturer:'네오텍', price:800000, notes:'' },
        ]},
      { id:'duta-mat', name:'두타매트', selectedModelId:'mks-001',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'mks-001', name:'MKS-001', manufacturer:'선경', price:300000, notes:'' },
        ]},
      { id:'hotpack', name:'Hot Pack Unit 핫팩통', selectedModelId:'dw-12',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'dw-12', name:'DW 12단', manufacturer:'DW', price:590000, notes:'' },
          { id:'dw-24', name:'DW 24단', manufacturer:'DW', price:690000, notes:'' },
        ]},
      { id:'parapin', name:'Parapin Bath', selectedModelId:'ps-100',
        quantity:1, itemDiscount:0, excluded:false, memo:'',
        models:[
          { id:'ps-100', name:'PS-100', manufacturer:'아이젠', price:70000, notes:'' },
        ]},
    ]
  }
  */
];

/* ============================================================
   PRODUCT SPECS (더미 제거 — DB spec 데이터 우선, 미등록 시 _default 사용)
   ============================================================ */
const PRODUCT_SPECS = {
  '_default': { specs:[], as:'—', warranty:'—', origin:'—', cert:[], desc:'상세 스펙 정보는 제조사에 문의하거나 카탈로그를 참고해 주세요.' },
};

/* ============================================================
   MANUFACTURER INFO (더미 제거 — 미등록 제조사는 _default 표시)
   ============================================================ */
const MANUFACTURER_INFO = {
  '_default': { founded:'—', country:'—', hq:'—', website:'—', tel:'—', category:'의료기기', desc:'상세 제조사 정보는 담당 영업사원에게 문의해 주세요.' },
};

const NEUTRAL_COLORS = {
  header:'bg-slate-50 border-b border-slate-200', accent:'bg-slate-400', headText:'text-slate-700',
  badge:'bg-slate-100 text-slate-700', text:'text-slate-500', border:'border-slate-200',
  light:'bg-slate-50', btn:'bg-slate-900 hover:bg-slate-700',
};

/* ============================================================
   HELPERS
   ============================================================ */
const getToday = () => new Date().toISOString().split('T')[0];
const getValidity = (days=30) => { const d=new Date(); d.setDate(d.getDate()+days); return d.toISOString().split('T')[0]; };
const formatWon = (n) => n!=null ? n.toLocaleString('ko-KR')+'원' : '—';
const formatWonShort = (n) => n!=null ? n.toLocaleString('ko-KR') : '—';
const pad = n => String(n).padStart(2, '0');
const getModel = (item) => item.models.find(m=>m.id===item.selectedModelId) || item.models[0];
const getGross = (item) => { const m=getModel(item); return (m&&m.price!=null) ? m.price*item.quantity : null; };
const getNet = (item) => { const g=getGross(item); return g!=null ? Math.max(0, g-(item.itemDiscount||0)) : null; };

function calcSummary(categories, globalDiscount) {
  let totalItems=0, activeItems=0, grossSum=0, discountSum=0, unknownCount=0;
  categories.forEach(cat => cat.items.forEach(item => {
    totalItems++;
    if (!item.excluded) {
      activeItems++;
      const g = getGross(item);
      if (g!=null) { grossSum += g; discountSum += (item.itemDiscount||0); }
      else unknownCount++;
    }
  }));
  const afterItemDiscount = grossSum - discountSum;
  const globalAmt = globalDiscount.type==='rate'
    ? Math.round(afterItemDiscount * (globalDiscount.value||0) / 100)
    : Math.min(globalDiscount.value||0, afterItemDiscount);
  const finalAmt = afterItemDiscount - globalAmt;
  return { totalItems, activeItems, grossSum, discountSum, afterItemDiscount, globalAmt, finalAmt, unknownCount };
}

/* ============================================================
   TOAST (전역)
   ============================================================ */
// 전역 toast 헬퍼 - 어디서든 toast('메시지', 'success'|'error'|'info') 호출 가능
// 사용 예: toast.success('저장되었습니다'), toast.error('저장 실패: ' + e.message)
const __toastListeners = [];
function __emitToast(msg, type='info') {
  __toastListeners.forEach(fn => fn({ id: Date.now() + Math.random(), msg, type }));
}
window.toast = Object.assign(
  (msg, type='info') => __emitToast(msg, type),
  {
    success: (msg) => __emitToast(msg, 'success'),
    error:   (msg) => __emitToast(msg, 'error'),
    info:    (msg) => __emitToast(msg, 'info'),
  }
);
// 처리되지 않은 alert 대체: 에러 핸들러 래퍼
window.handleError = (e, fallbackMsg='오류가 발생했습니다') => {
  console.error(e);
  __emitToast((e?.message ? fallbackMsg + ': ' + e.message : fallbackMsg), 'error');
};

function Toast({ toasts: externalToasts }) {
  const [internalToasts, setInternalToasts] = React.useState([]);

  React.useEffect(() => {
    const handler = (t) => {
      setInternalToasts(p => [...p, t]);
      setTimeout(() => setInternalToasts(p => p.filter(x => x.id !== t.id)), 3000);
    };
    __toastListeners.push(handler);
    return () => {
      const i = __toastListeners.indexOf(handler);
      if (i >= 0) __toastListeners.splice(i, 1);
    };
  }, []);

  const toasts = [...(externalToasts || []), ...internalToasts];
  if (toasts.length === 0) return null;
  const t = toasts[toasts.length - 1]; // 가장 최신 1개만 표시
  return (
    <div className="fixed top-20 left-1/2 z-50 pointer-events-none" style={{transform:'translateX(-50%)'}}>
      <div key={t.id} className={`toast-anim flex items-center gap-3 px-6 py-4 rounded-xl shadow-2xl text-white text-sm font-semibold min-w-[260px] justify-center ${t.type==='success'?'bg-emerald-600':t.type==='error'?'bg-red-600':'bg-slate-800'}`}
        style={{transform:'translateX(-50%) translateX(50%)'}}>
        <span className="text-lg leading-none">{t.type==='success'?'✓':t.type==='error'?'✕':'ℹ'}</span>
        <span>{t.msg}</span>
      </div>
    </div>
  );
}

/* ============================================================
   HEADER
   ============================================================ */
const DEPT_LIST = ['정형외과','내과','가정의학과','재활의학과','산부인과','피부과','응급의학과','영상의학과','안과','흉부외과','성형외과','비뇨기과','이비인후과','소아과','신경외과','정신건강의학과','마취통증의학과','직업의학과','신경과','외과'];

/* ============================================================
   LOGIN PAGE
   ============================================================ */
function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { data, error: authErr } = await sb.auth.signInWithPassword({ email, password });
      if (authErr) throw authErr;
      onLogin(data.user);
    } catch(err) {
      setError(err.message === 'Invalid login credentials'
        ? '이메일 또는 비밀번호가 올바르지 않습니다.'
        : (err.message || '로그인에 실패했습니다.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{minHeight:'100vh', background:'#0f172a', display:'flex', alignItems:'center', justifyContent:'center'}}>
      <div className="bg-white rounded-2xl shadow-2xl p-10 w-full animate-fs" style={{maxWidth:'400px'}}>
        {/* Logo */}
        <div className="flex items-center gap-2.5 mb-8">
          <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white font-bold text-sm">DW</div>
          <div>
            <div className="font-bold text-slate-900 text-base leading-tight">DWmedi</div>
            <div className="text-xs text-slate-400 leading-tight">의료장비 견적 시스템</div>
          </div>
        </div>

        <h2 className="text-xl font-bold text-slate-900 mb-1">로그인</h2>
        <p className="text-sm text-slate-500 mb-6">이메일과 비밀번호를 입력해 주세요</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="text-xs font-semibold text-slate-600 mb-1.5 block">이메일</label>
            <input
              type="email" value={email}
              onChange={e => setEmail(e.target.value)}
              required autoFocus
              placeholder="example@email.com"
              className="w-full border border-slate-300 rounded-lg px-3.5 py-2.5 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600 mb-1.5 block">비밀번호</label>
            <input
              type="password" value={password}
              onChange={e => setPassword(e.target.value)}
              required
              placeholder="••••••••"
              className="w-full border border-slate-300 rounded-lg px-3.5 py-2.5 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5 flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z"/></svg>
              {error}
            </div>
          )}
          <button
            type="submit" disabled={loading}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-semibold rounded-lg text-sm transition-colors mt-1"
          >
            {loading ? '로그인 중...' : '로그인'}
          </button>
        </form>
      </div>
    </div>
  );
}

// 발주 요청함 '대기' 건수 — 메뉴 뱃지용
function useOrderRequestPending() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { count: c } = await sb.from('order_requests').select('id', { count: 'exact', head: true }).eq('status', '대기');
        if (alive) setCount(c || 0);
      } catch (_) {}
    })();
    return () => { alive = false; };
  }, []);
  return count;
}

function Header({ quoteInfo, setQuoteInfo, onSave, onLoad, onLoadStandard, onManage, onHome, onHospitals, onService, onLeads, onPayables, onPoTracking, onOrderRequests, onDashboard, user, onLogout }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showCompanySettings, setShowCompanySettings] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const pendingReqs = useOrderRequestPending();
  const menuItems = [
    { label:'홈',               onClick: onDashboard, icon:'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
    { label:'영업 관리',         onClick: onLeads,    icon:'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
    { label:'발주 진행',         onClick: onPoTracking, icon:'M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0zM13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1' },
    { label:'견적 작성',         onClick: onHome,     icon:'M12 4v16m8-8H4' },
    { label:'견적 관리',         onClick: onLoad,     icon:'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12' },
    { label:'병원 관리',         onClick: onHospitals, icon:'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4' },
    { label:'장비 및 거래처 관리', onClick: onManage,   icon:'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
    { label:'매입매출 관리',   onClick: onPayables, icon:'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z' },
    { label:'발주 요청함',      onClick: onOrderRequests, badge: pendingReqs, icon:'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0l-2.5 4.5a2 2 0 01-1.7 1H8.2a2 2 0 01-1.7-1L4 13m16 0h-4.6a1 1 0 00-.9.6 2.5 2.5 0 01-5 0 1 1 0 00-.9-.6H4' },
  ];

  const textFields = [
    { key:'hospital', label:'병원명', w:'w-36' },
    { key:'doctor', label:'원장명', w:'w-28' },
    { key:'quoteNo', label:'견적번호', w:'w-32' },
    { key:'date', label:'견적일자', type:'date', w:'w-36' },
    { key:'validity', label:'유효기간', type:'date', w:'w-36' },
  ];

  return (
    <header className="bg-slate-900 text-white px-5 py-2.5 flex items-center gap-4 shrink-0 border-b border-slate-800">
      <button onClick={onHome} className="flex items-center gap-2 mr-2 shrink-0 hover:opacity-80 transition-opacity">
        <div className="w-7 h-7 rounded bg-blue-500 flex items-center justify-center text-white font-bold text-xs">DW</div>
        <span className="font-bold text-sm tracking-tight text-slate-100">DWmedi</span>
      </button>
      <div className="flex items-center gap-3 flex-1 overflow-x-auto">
        {textFields.map(f => (
          <div key={f.key} className="flex items-center gap-1.5 shrink-0">
            <label className="text-slate-400 text-xs whitespace-nowrap">{f.label}</label>
            <input
              type={f.type||'text'}
              value={quoteInfo[f.key]||''}
              onChange={e => setQuoteInfo(p=>({...p,[f.key]:e.target.value}))}
              className={`${f.w} bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500`}
            />
          </div>
        ))}
        <div className="flex items-center gap-1.5 shrink-0">
          <label className="text-slate-400 text-xs whitespace-nowrap">진료과</label>
          <select
            value={quoteInfo.dept||''}
            onChange={e => setQuoteInfo(p=>({...p, dept:e.target.value}))}
            className="w-32 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          >
            <option value="">선택</option>
            {DEPT_LIST.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      </div>

      {/* 유저 메뉴 */}
      <div className="relative shrink-0" ref={menuRef}>
        <button
          onClick={() => setMenuOpen(p => !p)}
          className="w-8 h-8 rounded-full bg-blue-600 hover:bg-blue-500 flex items-center justify-center text-white text-sm font-bold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          {user?.email?.[0]?.toUpperCase() || '?'}
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-10 w-52 bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden animate-fs z-50">
            {menuItems.map(item => (
              <button key={item.label} onClick={() => { item.onClick(); setMenuOpen(false); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors text-left">
                <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={item.icon}/>
                </svg>
                {item.label}
                {item.badge > 0 && <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold">{item.badge}</span>}
              </button>
            ))}
            <div className="border-t border-slate-100 mx-3 my-1"/>
            <button onClick={() => { setShowCompanySettings(true); setMenuOpen(false); }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors text-left">
              <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
              회사 정보
            </button>
            <div className="border-t border-slate-100 mx-3 my-1"/>
            <div className="px-4 py-2 text-xs text-slate-400 truncate">{user?.email || ''}</div>
            <button onClick={() => { onLogout(); setMenuOpen(false); }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors text-left">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
              로그아웃
            </button>
          </div>
        )}
      </div>
      {showCompanySettings && <CompanySettingsModal onClose={() => setShowCompanySettings(false)}/>}
    </header>
  );
}

/* ============================================================
   APP HEADER (공통 헤더 — 아바타 드롭다운 메뉴 포함)
   ============================================================ */
function AppHeader({ title, badge, onLogoClick, user, onLogout, nav, children }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showCompanySettings, setShowCompanySettings] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    const handler = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  const pendingReqs = useOrderRequestPending();
  const menuItems = [
    { label:'홈',               onClick: nav?.home,      icon:'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
    { label:'영업 관리',         onClick: nav?.leads,     icon:'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
    { label:'발주 진행',         onClick: nav?.poTracking, icon:'M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0zM13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1' },
    { label:'견적 작성',         onClick: nav?.editor,    icon:'M12 4v16m8-8H4' },
    { label:'견적 관리',         onClick: nav?.list,      icon:'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12' },
    { label:'병원 관리',         onClick: nav?.hospitals, icon:'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4' },
    { label:'장비 및 거래처 관리', onClick: nav?.manage,    icon:'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
    { label:'매입매출 관리',   onClick: nav?.payables,  icon:'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z' },
    { label:'발주 요청함',      onClick: nav?.orderRequests, badge: pendingReqs, icon:'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0l-2.5 4.5a2 2 0 01-1.7 1H8.2a2 2 0 01-1.7-1L4 13m16 0h-4.6a1 1 0 00-.9.6 2.5 2.5 0 01-5 0 1 1 0 00-.9-.6H4' },
  ];
  return (
    <header className="bg-slate-900 text-white px-6 py-3 flex items-center gap-4 shrink-0 border-b border-slate-800">
      <button onClick={onLogoClick} className="flex items-center gap-2 mr-2 hover:opacity-80 transition-opacity shrink-0">
        <div className="w-7 h-7 rounded bg-blue-500 flex items-center justify-center text-white font-bold text-xs">DW</div>
        <span className="font-bold text-sm tracking-tight text-slate-100">DWmedi</span>
      </button>
      {title && <>
        <span className="text-slate-400 text-xs shrink-0">·</span>
        <span className="text-slate-200 text-sm font-semibold shrink-0">{title}</span>
      </>}
      {badge && <span className="ml-1 px-2 py-0.5 bg-slate-700 text-slate-300 text-xs rounded-full shrink-0">{badge}</span>}
      <div className="ml-auto flex items-center gap-2">
        {children}
        {user && <div className="relative shrink-0" ref={menuRef}>
          <button onClick={() => setMenuOpen(p => !p)}
            className="w-8 h-8 rounded-full bg-blue-600 hover:bg-blue-500 flex items-center justify-center text-white text-sm font-bold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400">
            {user?.email?.[0]?.toUpperCase() || '?'}
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-10 w-52 bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden animate-fs z-50">
              {menuItems.map(item => (
                <button key={item.label} onClick={() => { item.onClick?.(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors text-left">
                  <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={item.icon}/>
                  </svg>
                  {item.label}
                  {item.badge > 0 && <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold">{item.badge}</span>}
                </button>
              ))}
              <div className="border-t border-slate-100 mx-3 my-1"/>
              <button onClick={() => { setShowCompanySettings(true); setMenuOpen(false); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors text-left">
                <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                회사 정보
              </button>
              <div className="border-t border-slate-100 mx-3 my-1"/>
              <div className="px-4 py-2 text-xs text-slate-400 truncate">{user?.email || ''}</div>
              <button onClick={() => { onLogout?.(); setMenuOpen(false); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors text-left">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
                로그아웃
              </button>
            </div>
          )}
        </div>}
        {showCompanySettings && <CompanySettingsModal onClose={() => setShowCompanySettings(false)}/>}
      </div>
    </header>
  );
}

/* ============================================================
   PRODUCT DETAIL MODAL
   ============================================================ */
function ProductDetailModal({ modelId, modelName, manufacturer, catName, catColorKey, onClose, onViewManufacturer, customEquips = [] }) {
  const spec = PRODUCT_SPECS[modelId] || PRODUCT_SPECS['_default'];
  const colors = NEUTRAL_COLORS;
  // DB에서 실제 장비 조회 (modelId 또는 modelName+manufacturer로 매칭)
  const dbEquip = customEquips.find(e =>
    e.model.id === modelId ||
    (e.model.name === modelName && e.model.manufacturer === manufacturer)
  );
  const equipImage = dbEquip?.image || null;
  // DB spec이 있으면 우선 사용
  const dbSpec = dbEquip?.spec;
  const desc     = dbSpec?.desc     || spec.desc;
  const specs    = (dbSpec?.specs?.length ? dbSpec.specs : spec.specs);
  const origin   = dbSpec?.origin   || spec.origin;
  const cert     = dbSpec?.cert     ? (typeof dbSpec.cert === 'string' ? dbSpec.cert.split(',').map(s=>s.trim()).filter(Boolean) : dbSpec.cert) : spec.cert;
  const asP      = dbSpec?.as       || spec.as;
  const warranty = dbSpec?.warranty || spec.warranty;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}/>
      <div className="relative bg-white rounded-xl shadow-2xl animate-fs flex flex-col" style={{width:'860px', maxHeight:'86vh'}}>

        {/* Header */}
        <div className="bg-slate-900 text-white px-6 py-4 rounded-t-xl flex items-start justify-between shrink-0">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`px-2 py-0.5 text-xs rounded font-medium ${colors.badge}`}>{catName}</span>
            </div>
            <div className="text-lg font-bold leading-tight">{modelName}</div>
            <button
              onClick={() => { onClose(); onViewManufacturer(manufacturer); }}
              className="text-sm text-slate-400 hover:text-blue-300 transition-colors mt-0.5 text-left"
            >
              {manufacturer} →
            </button>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-white hover:bg-slate-700 transition-colors mt-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">

          {/* Left — image + cert */}
          <div className="w-72 shrink-0 border-r border-slate-200 bg-slate-50 flex flex-col items-center gap-3 p-6">
            {equipImage
              ? <img src={equipImage} alt={modelName} className="w-full aspect-square object-contain rounded-xl border border-slate-200 bg-white shadow-sm" onError={e=>{e.target.style.display='none';}}/>
              : <div className="w-full aspect-square rounded-xl border-2 border-dashed border-slate-300 bg-white flex flex-col items-center justify-center gap-2 text-slate-400">
                  <svg className="w-12 h-12 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                  </svg>
                  <span className="text-xs font-medium">이미지 없음</span>
                </div>
            }
            <div className="w-full bg-white rounded-lg border border-slate-200 p-3 flex flex-col gap-1.5">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">인증 및 원산지</div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500 w-14 shrink-0">원산지</span>
                <span className="text-xs font-medium text-slate-800">{origin}</span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="text-xs text-slate-500 w-14 shrink-0">인증</span>
                <div className="flex flex-wrap gap-1">
                  {cert.map(c => <span key={c} className="px-1.5 py-0.5 bg-blue-50 text-blue-700 text-xs rounded border border-blue-200">{c}</span>)}
                </div>
              </div>
            </div>
          </div>

          {/* Right — specs */}
          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
            {/* Description */}
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">제품 소개</div>
              <p className="text-sm text-slate-700 leading-relaxed">{desc}</p>
            </div>

            {/* Specs table */}
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">주요 사양</div>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <tbody>
                    {specs.map((s, i) => (
                      <tr key={s.l+i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                        <td className="px-4 py-2.5 font-medium text-slate-600 w-36 border-r border-slate-200">{s.l}</td>
                        <td className="px-4 py-2.5 text-slate-800 font-medium">{s.v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* A/S & Warranty */}
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">보증 및 A/S</div>
              <div className="grid grid-cols-2 gap-3">
                {[['A/S 기간', asP, 'bg-emerald-50 border-emerald-200 text-emerald-800'], ['제품 보증', warranty, 'bg-blue-50 border-blue-200 text-blue-800']].map(([label, val, cls]) => (
                  <div key={label} className={`rounded-lg border p-3 ${cls}`}>
                    <div className="text-xs opacity-70 mb-0.5">{label}</div>
                    <div className="font-bold text-sm">{val}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   MANUFACTURER MODAL
   ============================================================ */
function ManufacturerModal({ manufacturer, allCategories, onClose, onViewProduct }) {
  const info = MANUFACTURER_INFO[manufacturer] || { ...MANUFACTURER_INFO['_default'] };

  // 해당 제조사의 모든 모델 수집
  const products = useMemo(() => {
    const rows = [];
    allCategories.forEach(cat => {
      cat.items.forEach(item => {
        item.models.forEach(model => {
          if (model.manufacturer === manufacturer) {
            rows.push({ cat, item, model });
          }
        });
      });
    });
    return rows;
  }, [allCategories, manufacturer]);

  const infoItems = [
    { label:'설립', value: info.founded },
    { label:'국가', value: info.country },
    { label:'본사', value: info.hq },
    { label:'주요 분야', value: info.category },
    { label:'전화', value: info.tel },
    { label:'홈페이지', value: info.website },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}/>
      <div className="relative bg-white rounded-xl shadow-2xl animate-fs flex flex-col" style={{width:'780px', maxHeight:'86vh'}}>

        {/* Header */}
        <div className="bg-slate-900 text-white px-6 py-4 rounded-t-xl flex items-center justify-between shrink-0">
          <div>
            <div className="text-xs text-slate-400 mb-0.5">제조사 정보</div>
            <div className="text-lg font-bold">{manufacturer}</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-white hover:bg-slate-700 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
          {/* Info grid */}
          <div className="grid grid-cols-3 gap-2">
            {infoItems.map(({ label, value }) => (
              <div key={label} className="bg-slate-50 rounded-lg px-4 py-3 border border-slate-200">
                <div className="text-xs text-slate-400 mb-0.5">{label}</div>
                <div className="text-xs font-semibold text-slate-800">{value}</div>
              </div>
            ))}
          </div>

          {/* Description */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
            <p className="text-sm text-slate-700 leading-relaxed">{info.desc}</p>
          </div>

          {/* Products */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="text-sm font-bold text-slate-900">취급 모델</div>
              <span className="px-2 py-0.5 bg-slate-200 text-slate-600 text-xs rounded-full font-medium">{products.length}개</span>
            </div>
            {products.length === 0 ? (
              <div className="text-sm text-slate-400 py-4 text-center">등록된 모델이 없습니다.</div>
            ) : (
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-900 text-white">
                      <th className="px-4 py-2.5 text-left font-semibold">카테고리</th>
                      <th className="px-4 py-2.5 text-left font-semibold">품목명</th>
                      <th className="px-4 py-2.5 text-left font-semibold">모델명</th>
                      <th className="px-4 py-2.5 text-right font-semibold">단가</th>
                      <th className="px-4 py-2.5 text-left font-semibold">비고</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map(({ cat, item, model }, i) => {
                      const colors = NEUTRAL_COLORS;
                      return (
                        <tr key={model.id} className={`border-t border-slate-100 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50'} hover:bg-blue-50 transition-colors`}>
                          <td className="px-4 py-2.5">
                            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${colors.badge}`}>{cat.name}</span>
                          </td>
                          <td className="px-4 py-2.5 font-medium text-slate-800">{item.name}</td>
                          <td className="px-4 py-2.5">
                            <button
                              onClick={() => { onClose(); onViewProduct(model.id, model.name, manufacturer, cat.name, cat.colorKey); }}
                              className="text-blue-600 hover:text-blue-800 hover:underline font-medium transition-colors"
                            >
                              {model.name}
                            </button>
                          </td>
                          <td className="px-4 py-2.5 text-right tnum">
                            {model.price != null
                              ? <span className="font-semibold text-slate-800">{model.price.toLocaleString('ko-KR')}원</span>
                              : <span className="px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded">문의</span>
                            }
                          </td>
                          <td className="px-4 py-2.5 text-slate-500">{model.notes || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   ADD EQUIPMENT MODAL
   ============================================================ */
function AddEquipmentModal({ categories, customEquips = [], dynCats = [], dynItems = [], onAdd, onClose, onViewProduct, onViewManufacturer }) {
  const [tab, setTab] = useState('search');          // 'search' | 'custom'
  const [query, setQuery] = useState('');
  const [selectedCat,  setSelectedCat]  = useState('all');
  const [selectedItem, setSelectedItem] = useState('all');
  const searchRef = useRef(null);
  const filterCats = dynCats.length > 0 ? dynCats : categories;

  const handleSelectCat = (catId) => {
    setSelectedCat(catId);
    setSelectedItem('all');
  };

  // custom form state
  const [form, setForm] = useState({
    catId: categories[0]?.id || '',
    itemName: '', modelName: '', manufacturer: '', price: '', notes: '',
  });
  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));

  useEffect(() => { if (tab === 'search') searchRef.current?.focus(); }, [tab]);

  // 장비 관리(Supabase)와 동일한 데이터 소스 사용
  const catalog = useMemo(() => {
    return customEquips.map(e => ({
      catId: e.catId,
      catName: e.catName,
      catColorKey: (filterCats.find(c=>c.id===e.catId)?.colorKey) || (categories.find(c=>c.id===e.catId)?.colorKey) || 'blue',
      itemName: e.itemName,
      model: e.model,
      altModels: e.altModels || [],
      equipId: e.id,
      image: e.image || null,
    }));
  }, [customEquips, filterCats, categories]);

  const itemOptions = useMemo(() => {
    if (selectedCat === 'all') return [];
    return dynItems.filter(it => it.catId === selectedCat);
  }, [dynItems, selectedCat]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return catalog.filter(r => {
      const matchCat  = selectedCat  === 'all' || r.catId    === selectedCat;
      const matchItem = selectedItem === 'all' || r.itemName === selectedItem;
      const matchQ = !q ||
        r.itemName.toLowerCase().includes(q) ||
        r.model.name.toLowerCase().includes(q) ||
        r.model.manufacturer.toLowerCase().includes(q);
      return matchCat && matchItem && matchQ;
    });
  }, [catalog, query, selectedCat, selectedItem]);

  const handleAddFromSearch = (row) => {
    onAdd({
      catId: row.catId,
      itemName: row.itemName,
      modelName: row.model.name,
      manufacturer: row.model.manufacturer,
      price: row.model.price,
      notes: row.model.notes,
      image: row.image || null,
      altModels: row.altModels || [],
    });
  };

  const handleAddAll = () => {
    filtered.forEach((row, i) => {
      setTimeout(() => onAdd({
        catId:        row.catId,
        itemName:     row.itemName,
        modelName:    row.model.name,
        manufacturer: row.model.manufacturer,
        price:        row.model.price,
        notes:        row.model.notes,
        image:        row.image || null,
        altModels:    row.altModels || [],
      }), i * 2);
    });
  };

  const handleAddCustom = () => {
    if (!form.itemName.trim() || !form.modelName.trim()) return;
    onAdd({
      catId: form.catId,
      itemName: form.itemName.trim(),
      modelName: form.modelName.trim(),
      manufacturer: form.manufacturer.trim(),
      price: parseInt(form.price.replace(/[^0-9]/g,'')) || null,
      notes: form.notes.trim(),
    });
    setForm(p => ({ ...p, itemName:'', modelName:'', manufacturer:'', price:'', notes:'' }));
  };

  const catColorMap = {};
  categories.forEach(c => { catColorMap[c.id] = c.colorKey; });

  const inputCls = "w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}/>
      <div className="relative bg-white rounded-xl shadow-2xl flex flex-col animate-fs" style={{width:'1400px', maxWidth:'98vw', height:'90vh'}}>

        {/* Header */}
        <div className="bg-slate-900 text-white px-5 py-3.5 rounded-t-xl flex items-center justify-between shrink-0">
          <div>
            <div className="font-bold text-sm">장비 추가</div>
            <div className="text-xs text-slate-400 mt-0.5">카탈로그 검색 또는 직접 입력으로 견적에 장비를 추가합니다</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-white hover:bg-slate-700 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Tabs — 직접입력 제거. 마스터에 없는 모델은 장비 및 거래처 관리 → 장비 등록에서 추가 후 사용 */}
        <div className="flex border-b border-slate-200 shrink-0">
          {[{id:'search',label:'카탈로그 검색',icon:'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0'}].map(t => (
            <button key={t.id} onClick={()=>setTab(t.id)}
              className={`flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab===t.id?'border-blue-600 text-blue-700':'border-transparent text-slate-500 hover:text-slate-700'}`}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={t.icon}/></svg>
              {t.label}
            </button>
          ))}
          <div className="ml-auto flex items-center pr-4">
            <span className="text-xs text-slate-400">총 {catalog.length}개 모델 등록됨 · 없는 모델은 장비 관리에서 먼저 등록</span>
          </div>
        </div>

        {/* ── 카탈로그 검색 탭 ── */}
        {tab === 'search' && (
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Search controls */}
            <div className="px-4 pt-3 pb-2 border-b border-slate-100 flex flex-col gap-2 shrink-0">
              <div className="relative">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0"/></svg>
                <input ref={searchRef} type="text" placeholder="품목명, 모델명, 제조사로 검색..." value={query} onChange={e=>setQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"/>
                {query && <button onClick={()=>setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/></svg>
                </button>}
              </div>
              <div className="flex flex-wrap gap-1">
                {[{id:'all',label:'전체'},...filterCats.map(c=>({id:c.id,label:c.name}))].map(f=>(
                  <button key={f.id} onClick={()=>handleSelectCat(f.id)}
                    className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors whitespace-nowrap ${selectedCat===f.id?'bg-slate-900 text-white':'text-slate-600 hover:bg-slate-100'}`}>
                    {f.label}
                  </button>
                ))}
              </div>
              {itemOptions.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1.5 border-t border-slate-100">
                  <button onClick={()=>setSelectedItem('all')}
                    className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors whitespace-nowrap ${selectedItem==='all'?'bg-blue-600 text-white':'text-slate-500 hover:bg-slate-100'}`}>
                    전체
                  </button>
                  {itemOptions.map(it=>(
                    <button key={it.id} onClick={()=>setSelectedItem(it.name)}
                      className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors whitespace-nowrap ${selectedItem===it.name?'bg-blue-600 text-white':'text-slate-500 hover:bg-slate-100'}`}>
                      {it.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Results */}
            <div className="overflow-y-auto flex-1">
              {filtered.length === 0 ? (
                <div className="py-16 text-center text-slate-400">
                  <div className="text-2xl mb-2">🔍</div>
                  <div className="font-medium text-sm">검색 결과가 없습니다</div>
                  <div className="text-xs mt-1">직접 입력 탭에서 새 장비를 추가해 보세요</div>
                </div>
              ) : (
                <>
                <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100 bg-slate-50/60 shrink-0">
                  <span className="text-xs text-slate-500">{filtered.length}개 장비</span>
                  <button onClick={handleAddAll}
                    className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 font-medium transition-colors">
                    전체 추가 ({filtered.length})
                  </button>
                </div>
                <table className="w-full">
                  <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide w-32">카테고리</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide w-36">품목명</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">모델명</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide w-36">제조사</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide w-28">단가</th>
                      <th className="w-20 px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row, idx) => {
                      const colors = NEUTRAL_COLORS;
                      return (
                        <tr key={idx} className={`border-b border-slate-100 hover:bg-slate-50 transition-colors ${row.isCustom ? 'bg-emerald-50/30' : ''}`}>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-col gap-0.5">
                              <span className={`px-1.5 py-0.5 text-xs rounded font-medium whitespace-nowrap ${colors.badge}`}>{row.catName}</span>
                              {row.isCustom && <span className="px-1.5 py-0.5 text-xs rounded font-medium whitespace-nowrap bg-emerald-100 text-emerald-700">사용자등록</span>}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-xs font-medium text-slate-800 whitespace-nowrap">{row.itemName}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => onViewProduct(row.model.id, row.model.name, row.model.manufacturer, row.catName, row.catColorKey)}
                                className="text-xs text-blue-600 hover:text-blue-800 hover:underline font-medium whitespace-nowrap transition-colors"
                              >{row.model.name}</button>
                              {/* model.notes 태그 숨김 */}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            <button onClick={() => onViewManufacturer(row.model.manufacturer)} className="text-xs text-slate-600 hover:text-blue-600 hover:underline transition-colors">{row.model.manufacturer}</button>
                          </td>
                          <td className="px-3 py-2.5 text-right tnum text-xs">
                            {row.model.price != null
                              ? <span className="font-medium text-slate-800">{row.model.price.toLocaleString('ko-KR')}원</span>
                              : <span className="px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded text-xs">문의</span>
                            }
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <button onClick={()=>handleAddFromSearch(row)}
                              className={`px-2.5 py-1 text-xs rounded font-medium transition-colors text-white ${colors.btn}`}>
                              + 추가
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── 직접 입력 탭 ── */}
        {tab === 'custom' && (
          <div className="p-5 overflow-y-auto flex-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-slate-600 mb-1">추가할 카테고리 <span className="text-red-500">*</span></label>
                <div className="flex gap-2">
                  {categories.map(cat => {
                    const colors = NEUTRAL_COLORS;
                    const active = form.catId === cat.id;
                    return (
                      <button key={cat.id} onClick={()=>setF('catId', cat.id)}
                        className={`flex-1 py-2 text-xs rounded-lg border-2 font-medium transition-colors ${active ? `${colors.btn} text-white border-transparent` : `border-slate-200 text-slate-600 hover:border-slate-300`}`}>
                        {cat.name}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">품목명 <span className="text-red-500">*</span></label>
                <input type="text" placeholder="예) X-Ray, 초음파진단기" value={form.itemName} onChange={e=>setF('itemName',e.target.value)} className={inputCls}/>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">모델명 <span className="text-red-500">*</span></label>
                <input type="text" placeholder="예) DR-5000" value={form.modelName} onChange={e=>setF('modelName',e.target.value)} className={inputCls}/>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">제조사</label>
                <input type="text" placeholder="예) GE Healthcare" value={form.manufacturer} onChange={e=>setF('manufacturer',e.target.value)} className={inputCls}/>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">단가 (원)</label>
                <input type="text" inputMode="numeric" placeholder="미입력 시 '문의' 표시" value={form.price}
                  onChange={e=>setF('price', e.target.value.replace(/[^0-9]/g,''))}
                  className={inputCls + ' tnum'}/>
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-slate-600 mb-1">비고</label>
                <input type="text" placeholder="특이사항, 옵션 등" value={form.notes} onChange={e=>setF('notes',e.target.value)} className={inputCls}/>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-slate-100 flex items-center justify-between">
              <p className="text-xs text-slate-400">* 표시 항목은 필수입니다. 추가 후 견적 화면에서 수량·할인을 조정하세요.</p>
              <button
                onClick={handleAddCustom}
                disabled={!form.itemName.trim() || !form.modelName.trim()}
                className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>
                견적에 추가
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   CONTROLS BAR
   ============================================================ */
function ControlsBar({ search, setSearch, onAddEquip }) {
  return (
    <div className="bg-white border-b border-slate-200 px-5 py-2 flex items-center gap-4 shrink-0">
      <button
        onClick={onAddEquip}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 hover:bg-slate-700 text-white transition-colors shrink-0"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>
        장비 추가
      </button>
      <div className="w-px h-5 bg-slate-200 shrink-0"/>
      <div className="relative">
        <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0" />
        </svg>
        <input
          type="text"
          placeholder="품목명, 모델명, 제조사 검색..."
          value={search}
          onChange={e=>setSearch(e.target.value)}
          className="pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-md w-56 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
        />
        {search && (
          <button onClick={()=>setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
          </button>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1 text-xs text-slate-400">
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>반영</span>
        <span className="mx-1.5">·</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-300 inline-block"></span>제외</span>
        <span className="mx-1.5">·</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-400 inline-block"></span>문의</span>
      </div>
    </div>
  );
}

/* ============================================================
   ITEM ROW
   ============================================================ */
function ItemRow({ item, catColorKey, rowNum, onUpdate, onDelete, onOpenAlt, onViewProduct, onViewManufacturer, catName, customEquips = [] }) {
  const model = getModel(item);
  const gross = getGross(item);
  const net = getNet(item);
  const hasPrice = model?.price != null;
  const colors = NEUTRAL_COLORS;
  // 이미지: 모델에 직접 저장된 것 → customEquips에서 매칭 순으로 조회
  // 우선순위: equipment 테이블 최신 이미지 → 견적서에 저장된 옛 이미지 (수정 반영용)
  const imageData = customEquips.find(e => e.itemName === item.name && e.model.name === model?.name)?.image || model?.image || null;

  const [editingPrice, setEditingPrice] = useState(false);
  const [priceInput, setPriceInput] = useState('');
  const priceRef = useRef(null);

  useEffect(() => {
    if (editingPrice && priceRef.current) {
      priceRef.current.focus();
      priceRef.current.select();
    }
  }, [editingPrice]);

  const startPriceEdit = () => {
    if (item.excluded) return;
    setPriceInput(model?.price != null ? String(model.price) : '');
    setEditingPrice(true);
  };

  const commitPriceEdit = () => {
    const parsed = parseInt(priceInput.replace(/[^0-9]/g,'')) || 0;
    const updatedModels = item.models.map(m =>
      m.id === item.selectedModelId ? { ...m, price: parsed } : m
    );
    onUpdate({ ...item, models: updatedModels, itemDiscount: Math.min(item.itemDiscount, parsed * item.quantity) });
    setEditingPrice(false);
  };

  const updateQty = (delta) => {
    const newQty = Math.max(1, Math.min(9999, item.quantity + delta));
    onUpdate({ ...item, quantity: newQty });
  };

  const updateDiscount = (val) => {
    const parsed = parseInt(val.replace(/,/g,'')) || 0;
    const maxDiscount = gross || 0;
    onUpdate({ ...item, itemDiscount: Math.min(parsed, maxDiscount) });
  };

  return (
    <tr className={`tr-row border-b border-slate-100 align-middle ${item.excluded ? 'tr-excluded bg-slate-50' : 'bg-white'}`}>
      {/* 번호 / 상태 */}
      <td className="td-toggle px-2 py-2 text-center w-10">
        <button
          onClick={() => onUpdate({...item, excluded:!item.excluded})}
          title={item.excluded?'반영하기':'제외하기'}
          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mx-auto transition-all ${
            item.excluded
              ? 'border-slate-300 bg-white hover:border-red-300'
              : 'border-emerald-500 bg-emerald-500 hover:bg-emerald-600'
          }`}
        >
          {!item.excluded && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7"/></svg>}
        </button>
      </td>
      {/* 품명 */}
      <td className="px-2 py-1 w-56">
        <div className="flex items-center gap-2">
          {imageData
            ? <img src={imageData} alt={item.name} className="w-32 h-32 object-contain rounded border border-slate-200 bg-white shrink-0" onError={e=>{e.target.style.display='none';}}/>
            : <div className="w-32 h-32 rounded border border-slate-100 bg-slate-50 flex items-center justify-center shrink-0">
                <svg className="w-10 h-10 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
              </div>
          }
          <div className="flex flex-col min-w-0">
            <span className={`text-xs shrink-0 ${item.excluded?'text-slate-300':'text-slate-400'}`}>#{rowNum}</span>
            <span className="font-semibold text-slate-800 text-xs leading-tight truncate">{item.name}</span>
          </div>
        </div>
      </td>
      {/* 모델명 */}
      <td className="px-2 py-2 w-44">
        <div className="flex items-center gap-1 flex-wrap">
          <button
            onClick={() => model && onViewProduct(model.id, model.name, model.manufacturer, catName, catColorKey)}
            className="font-medium text-xs text-blue-600 hover:text-blue-800 hover:underline leading-tight transition-colors"
          >{model?.name}</button>
          {/* model.notes 태그 숨김 */}
        </div>
      </td>
      {/* 제조사 */}
      <td className="px-2 py-2 w-36">
        <button
          onClick={() => model?.manufacturer && onViewManufacturer(model.manufacturer)}
          className="text-xs text-slate-500 hover:text-blue-600 hover:underline transition-colors whitespace-nowrap"
        >{model?.manufacturer}</button>
      </td>
      {/* 단가 — 더블클릭으로 직접 편집 */}
      <td
        className="px-2 py-2 text-right w-28 tnum"
        onDoubleClick={startPriceEdit}
        title="더블클릭하여 단가 수정"
        style={{cursor: item.excluded ? 'default' : 'text'}}
      >
        {editingPrice ? (
          <input
            ref={priceRef}
            type="text"
            inputMode="numeric"
            value={priceInput}
            onChange={e => setPriceInput(e.target.value.replace(/[^0-9]/g,''))}
            onBlur={commitPriceEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') commitPriceEdit();
              if (e.key === 'Escape') setEditingPrice(false);
            }}
            className="w-full text-right px-1 py-0.5 text-xs border-0 border-b-2 border-blue-500 focus:outline-none bg-blue-50 rounded-sm tnum"
          />
        ) : hasPrice ? (
          <span className="text-xs text-slate-700 group relative">
            {model.price.toLocaleString('ko-KR')}
            <span className="ml-1 text-slate-300 text-xs opacity-0 group-hover:opacity-100 transition-opacity">✎</span>
          </span>
        ) : (
          <span className="px-1.5 py-0.5 bg-orange-100 text-orange-700 text-xs rounded font-medium">문의</span>
        )}
      </td>
      {/* 수량 */}
      <td className="px-2 py-2 w-24">
        <div className="flex items-center gap-1 justify-center">
          <button onClick={()=>updateQty(-1)} className="w-5 h-5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 flex items-center justify-center text-xs font-bold leading-none">−</button>
          <span className="w-6 text-center text-xs font-semibold tnum text-slate-800">{item.quantity}</span>
          <button onClick={()=>updateQty(1)} className="w-5 h-5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 flex items-center justify-center text-xs font-bold leading-none">+</button>
        </div>
      </td>
      {/* 공급가액 */}
      <td className="px-2 py-2 text-right w-28 tnum">
        {gross!=null
          ? <span className="text-xs text-slate-700">{gross.toLocaleString('ko-KR')}</span>
          : <span className="text-slate-400 text-xs">—</span>
        }
      </td>
      {/* 품목할인 */}
      <td className="px-2 py-2 w-28">
        <div className="relative">
          <input
            type="text"
            inputMode="numeric"
            placeholder="0"
            value={item.itemDiscount ? item.itemDiscount.toLocaleString('ko-KR') : ''}
            onChange={e => updateDiscount(e.target.value)}
            disabled={!hasPrice || item.excluded}
            className="w-full text-right pr-5 pl-2 py-1 text-xs border border-slate-200 rounded focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 disabled:bg-slate-50 disabled:text-slate-400 tnum"
          />
          <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs">₩</span>
        </div>
      </td>
      {/* 할인 후 금액 */}
      <td className="px-2 py-2 text-right w-32 tnum">
        {net!=null
          ? <span className={`text-xs font-semibold ${item.itemDiscount>0?'text-blue-700':'text-slate-800'}`}>{net.toLocaleString('ko-KR')}</span>
          : <span className="text-slate-400 text-xs">—</span>
        }
      </td>
      {/* 대체품 */}
      <td className="px-2 py-2 w-20 text-center">
        {item.models.length > 1
          ? <button
              onClick={() => onOpenAlt(item)}
              className={`px-2 py-1 text-xs rounded border font-medium transition-colors ${colors.border} ${colors.text} hover:${colors.light} bg-white hover:bg-opacity-60`}
            >
              {item.models.length}개
            </button>
          : <span className="text-xs text-slate-300">단일</span>
        }
      </td>
      {/* 메모 */}
      <td className="px-2 py-2">
        <input
          type="text"
          value={item.memo}
          onChange={e => onUpdate({...item, memo:e.target.value})}
          placeholder="메모 입력..."
          className="w-full min-w-[80px] px-2 py-1 text-xs border border-slate-200 rounded focus:outline-none focus:border-blue-400 bg-transparent placeholder-slate-300"
        />
      </td>
      {/* 삭제 */}
      <td className="px-2 py-2 w-8 text-center">
        <button
          onClick={onDelete}
          title="항목 삭제"
          className="w-6 h-6 flex items-center justify-center rounded-full text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors mx-auto"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </td>
    </tr>
  );
}

/* ============================================================
   CATEGORY SECTION
   ============================================================ */
function CategorySection({ category, collapsed, onToggle, onUpdateItem, onDeleteItem, onOpenAlt, search, rowOffset, onViewProduct, onViewManufacturer, customEquips }) {
  const colors = NEUTRAL_COLORS;
  const activeCount = category.items.filter(i => !i.excluded).length;
  const filteredItems = search
    ? category.items.filter(i =>
        i.name.toLowerCase().includes(search.toLowerCase()) ||
        getModel(i)?.name.toLowerCase().includes(search.toLowerCase()) ||
        getModel(i)?.manufacturer.toLowerCase().includes(search.toLowerCase())
      )
    : category.items;

  if (search && filteredItems.length === 0) return null;

  return (
    <tbody>
      <tr>
        <td colSpan={11} className={`${colors.header} cursor-pointer select-none`} onClick={onToggle}>
          <div className="px-4 py-2 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className={`w-1 h-4 rounded-full ${colors.accent} inline-block shrink-0`}></span>
              <svg className={`w-3 h-3 ${colors.headText} transition-transform ${collapsed ? 'rotate-[-90deg]' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7"/></svg>
              <span className={`font-semibold text-sm ${colors.headText}`}>{category.name}</span>
              <span className="text-xs text-slate-400 font-normal">
                총 {category.items.length}개 · 반영 <span className="font-medium text-slate-600">{activeCount}</span>개
              </span>
            </div>
            <div className="flex items-center gap-2">
              {(() => {
                const catSum = category.items
                  .filter(i => !i.excluded)
                  .reduce((sum, i) => { const n = getNet(i); return sum + (n || 0); }, 0);
                return catSum > 0
                  ? <span className={`text-xs font-semibold tnum ${colors.headText}`}>{catSum.toLocaleString('ko-KR')}원</span>
                  : null;
              })()}
            </div>
          </div>
        </td>
      </tr>
      {!collapsed && filteredItems.map((item, idx) => (
        <ItemRow
          key={item.id}
          item={item}
          catColorKey={category.colorKey}
          rowNum={rowOffset + idx + 1}
          onUpdate={updated => onUpdateItem(category.id, updated)}
          onDelete={() => onDeleteItem(category.id, item.id)}
          onOpenAlt={onOpenAlt}
          onViewProduct={onViewProduct}
          onViewManufacturer={onViewManufacturer}
          catName={category.name}
          customEquips={customEquips}
        />
      ))}
    </tbody>
  );
}

/* ============================================================
   SUMMARY PANEL
   ============================================================ */
function SummaryPanel({ categories, globalDiscount, setGlobalDiscount, vatIncluded, setVatIncluded, onPdfPreview, onSave, onRevisionSave, saving, currentQuoteNo }) {
  const s = useMemo(() => calcSummary(categories, globalDiscount), [categories, globalDiscount]);
  // VAT 별도: finalAmt에 10% 가산 / VAT 포함: finalAmt를 역산하여 공급가·부가세 분리
  const supplyAmt = vatIncluded ? Math.floor(s.finalAmt / 1.1) : s.finalAmt;
  const vatAmt    = vatIncluded ? (s.finalAmt - supplyAmt) : 0;

  return (
    <aside className="w-72 bg-white border-l border-slate-200 flex flex-col shrink-0 overflow-y-auto">
      {/* Header */}
      <div className="bg-slate-900 text-white px-4 py-3">
        <div className="text-xs font-semibold tracking-widest text-slate-400 uppercase mb-0.5">견적 요약</div>
        <div className="text-xl font-bold tnum">{supplyAmt.toLocaleString('ko-KR')}<span className="text-sm font-normal text-slate-300 ml-1">원</span></div>
        <div className="text-xs text-slate-400 mt-0.5">{vatIncluded ? '공급가 (부가세 역산)' : '최종 제안 금액 (VAT 별도)'}</div>
      </div>

      <div className="p-4 flex flex-col gap-4 flex-1">
        {/* 품목 현황 */}
        <div className="bg-slate-50 rounded-lg p-3">
          <div className="text-center">
            <div className="text-lg font-bold text-emerald-600 tnum">{s.activeItems}</div>
            <div className="text-xs text-slate-500">총 견적 품목</div>
          </div>
          {s.unknownCount > 0 && (
            <div className="text-center pt-1 border-t border-slate-200 mt-1">
              <div className="text-xs text-orange-600 font-medium">가격 미확정 {s.unknownCount}개 품목 제외됨</div>
            </div>
          )}
        </div>

        {/* 금액 내역 */}
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-500">공급가액 합계</span>
            <span className="font-medium tnum text-slate-700">{s.grossSum.toLocaleString('ko-KR')}원</span>
          </div>
          {s.discountSum > 0 && (
            <div className="flex justify-between items-center text-xs">
              <span className="text-slate-500">품목별 할인 합계</span>
              <span className="font-medium tnum text-red-600">−{s.discountSum.toLocaleString('ko-KR')}원</span>
            </div>
          )}
          {s.discountSum > 0 && (
            <div className="flex justify-between items-center text-xs border-t border-slate-100 pt-1.5">
              <span className="text-slate-600 font-medium">할인 후 소계</span>
              <span className="font-semibold tnum">{s.afterItemDiscount.toLocaleString('ko-KR')}원</span>
            </div>
          )}
        </div>

        {/* 전체 할인 */}
        <div className="border border-slate-200 rounded-lg p-3">
          <div className="text-xs font-semibold text-slate-700 mb-2">전체 할인</div>
          <div className="flex gap-1.5 mb-2">
            <button
              onClick={() => setGlobalDiscount(p => ({...p, type:'rate'}))}
              className={`flex-1 py-1 text-xs rounded border font-medium transition-colors ${globalDiscount.type==='rate' ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}
            >정률 (%)</button>
            <button
              onClick={() => setGlobalDiscount(p => ({...p, type:'amount'}))}
              className={`flex-1 py-1 text-xs rounded border font-medium transition-colors ${globalDiscount.type==='amount' ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}
            >정액 (₩)</button>
          </div>
          <div className="relative">
            <input
              type="number"
              min={0}
              max={globalDiscount.type==='rate'?100:s.afterItemDiscount}
              value={globalDiscount.value||''}
              onChange={e => {
                const v = parseFloat(e.target.value)||0;
                const capped = globalDiscount.type==='rate' ? Math.min(100,v) : Math.min(v, s.afterItemDiscount);
                setGlobalDiscount(p=>({...p,value:capped}));
              }}
              placeholder="0"
              className="w-full text-right pr-8 pl-3 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 tnum"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">
              {globalDiscount.type==='rate' ? '%' : '₩'}
            </span>
          </div>
          {s.globalAmt > 0 && (
            <div className="flex justify-between items-center text-xs mt-2 pt-2 border-t border-slate-100">
              <span className="text-slate-500">
                {globalDiscount.type==='rate' ? `${globalDiscount.value}% 할인` : '정액 할인'}
              </span>
              <span className="text-red-600 font-semibold tnum">−{s.globalAmt.toLocaleString('ko-KR')}원</span>
            </div>
          )}
        </div>

        {/* 최종 금액 */}
        <div className="border-t-2 border-slate-800 pt-3">
          {vatIncluded ? (
            /* VAT 포함 역산 표시 */
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-500">VAT 포함 합계 (고정)</span>
                <span className="text-sm font-bold tnum text-blue-700">{s.finalAmt.toLocaleString('ko-KR')}원</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-500">공급가 (÷1.1, 내림)</span>
                <span className="font-semibold tnum text-slate-800">{supplyAmt.toLocaleString('ko-KR')}원</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-500">부가세 (10%)</span>
                <span className="font-semibold tnum text-slate-600">{vatAmt.toLocaleString('ko-KR')}원</span>
              </div>
            </div>
          ) : (
            /* VAT 별도 표시 */
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between items-start">
                <span className="text-sm font-bold text-slate-800">최종 제안 금액</span>
                <div className="text-lg font-bold tnum text-slate-900">{s.finalAmt.toLocaleString('ko-KR')}원</div>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-500">부가세 (10%)</span>
                <span className="font-semibold tnum text-slate-600">{Math.floor(s.finalAmt * 0.1).toLocaleString('ko-KR')}원</span>
              </div>
              <div className="flex justify-between items-center text-xs border-t border-slate-200 pt-1.5 mt-0.5">
                <span className="font-semibold text-slate-700">VAT 포함 합계</span>
                <span className="font-bold tnum text-blue-700">{Math.floor(s.finalAmt * 1.1).toLocaleString('ko-KR')}원</span>
              </div>
            </div>
          )}

          {/* VAT 토글 */}
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setVatIncluded(p=>!p)}
                className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${vatIncluded ? 'bg-blue-600' : 'bg-slate-300'}`}
              >
                <span className={`inline-block w-4 h-4 bg-white rounded-full shadow transform transition-transform mt-0.5 ${vatIncluded ? 'translate-x-4.5' : 'translate-x-0.5'}`} style={{marginLeft: vatIncluded?'19px':'2px'}}/>
              </button>
              <span className="text-xs text-slate-600">VAT {vatIncluded ? '포함 (역산)' : '별도'}</span>
            </div>
          </div>
        </div>

        {/* 카테고리별 소계 */}
        <div>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">카테고리별 소계</div>
          {categories.map(cat => {
            const colors = NEUTRAL_COLORS;
            const catSum = cat.items.filter(i=>!i.excluded).reduce((sum,i)=>sum+(getNet(i)||0),0);
            const catActive = cat.items.filter(i=>!i.excluded).length;
            return (
              <div key={cat.id} className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-slate-400"></span>
                  <span className="text-xs text-slate-600">{cat.name}</span>
                  <span className="text-xs text-slate-400">({catActive})</span>
                </div>
                <span className="text-xs font-medium tnum text-slate-700">{catSum.toLocaleString('ko-KR')}원</span>
              </div>
            );
          })}
        </div>

        {/* PDF 버튼 */}
        <div className="mt-auto pt-2 flex flex-col gap-2">
          {onRevisionSave && currentQuoteNo && (
            <button
              onClick={onRevisionSave}
              disabled={saving}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 text-white text-sm font-semibold rounded-lg hover:bg-amber-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
              {saving ? '저장 중...' : '수정 저장'}
            </button>
          )}
          {onSave && (
            <button
              onClick={onSave}
              disabled={saving}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"/></svg>
              {saving ? '저장 중...' : '견적 저장'}
            </button>
          )}
          <button
            onClick={onPdfPreview}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border-2 border-slate-800 text-slate-800 text-sm font-semibold rounded-lg hover:bg-slate-50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
            PDF 미리보기
          </button>
          <button
            onClick={onPdfPreview}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-900 text-white text-sm font-semibold rounded-lg hover:bg-slate-800 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
            최종 PDF 생성
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ============================================================
   ALT MODAL
   ============================================================ */
function AltModal({ item, catColorKey, onSelect, onClose }) {
  const colors = NEUTRAL_COLORS;
  const selectedModel = getModel(item);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}/>
      <div className="relative bg-white rounded-xl shadow-2xl w-[680px] max-h-[80vh] flex flex-col animate-fs">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div className={`text-xs font-medium mb-0.5 ${colors.text}`}>대체 모델 선택</div>
            <div className="text-base font-bold text-slate-900">{item.name}</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-4">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide pb-2 pl-2">모델명</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide pb-2">제조사</th>
                <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide pb-2">가격</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide pb-2 pl-3">비고</th>
                <th className="w-24 pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {item.models.map((model, idx) => {
                const isSelected = model.id === item.selectedModelId;
                const isBase = idx === 0;
                return (
                  <tr key={model.id} className={`border-b border-slate-100 last:border-0 ${isSelected ? 'bg-blue-50' : 'hover:bg-slate-50'} transition-colors`}>
                    <td className="py-2.5 pl-2 pr-3">
                      <div className="flex items-center gap-2">
                        {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0"></span>}
                        <span className={`text-sm font-medium ${isSelected?'text-blue-800':'text-slate-800'}`}>{model.name}</span>
                        {isBase && <span className="text-xs px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">기본</span>}
                      </div>
                    </td>
                    <td className="py-2.5 text-xs text-slate-600">{model.manufacturer}</td>
                    <td className="py-2.5 text-right tnum">
                      {model.price!=null
                        ? <span className={`text-sm font-semibold ${isSelected?'text-blue-700':'text-slate-800'}`}>{model.price.toLocaleString('ko-KR')}원</span>
                        : <span className="px-2 py-0.5 bg-orange-100 text-orange-700 text-xs rounded font-medium">문의</span>
                      }
                    </td>
                    <td className="py-2.5 pl-3 text-xs text-slate-500">{model.notes||'—'}</td>
                    <td className="py-2.5 text-right pr-2">
                      {isSelected
                        ? <span className="px-2.5 py-1 text-xs bg-blue-600 text-white rounded font-medium">선택됨</span>
                        : <button
                            onClick={() => { onSelect(item, model.id); onClose(); }}
                            className={`px-2.5 py-1 text-xs rounded font-medium border transition-colors ${colors.border} ${colors.text} hover:bg-opacity-10 bg-white`}
                          >선택</button>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* price compare bar */}
        {(() => {
          const prices = item.models.filter(m=>m.price!=null).map(m=>m.price);
          if (prices.length < 2) return null;
          const minP = Math.min(...prices), maxP = Math.max(...prices);
          const curP = selectedModel?.price;
          return (
            <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span>가격 범위</span>
                <div className="flex-1 h-1.5 bg-slate-200 rounded-full relative">
                  {curP!=null && (
                    <div
                      className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-600 rounded-full border-2 border-white shadow"
                      style={{left: `${((curP-minP)/(maxP-minP||1))*100}%`, transform:'translateX(-50%) translateY(-50%)'}}
                    />
                  )}
                  <div className="h-1.5 bg-blue-200 rounded-full" style={{width:`${((maxP-minP)/(maxP||1))*100}%`}}/>
                </div>
                <span className="tnum">{minP.toLocaleString('ko-KR')}원</span>
                <span>~</span>
                <span className="tnum">{maxP.toLocaleString('ko-KR')}원</span>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

/* ============================================================
   PDF PREVIEW MODAL
   ============================================================ */
const DW_LOGO_BASE64 = 'data:image/png;base64,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';

function PdfPreviewModal({ quoteInfo, categories, globalDiscount, vatIncluded, onClose, customEquips = [] }) {
  const [tab, setTab] = useState('summary');
  const logoBase64 = DW_LOGO_BASE64;
  const s = useMemo(() => calcSummary(categories, globalDiscount), [categories, globalDiscount]);
  const supplyAmt = vatIncluded ? Math.floor(s.finalAmt / 1.1) : s.finalAmt;
  const vatAmt    = vatIncluded ? (s.finalAmt - supplyAmt) : 0;

  const handlePrint = () => {
    const printWin = window.open('', '_blank', 'width=900,height=700');
    if (!printWin) { alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요.'); return; }

    let rowNum = 0;
    const activeItems = [];
    categories.forEach(cat => cat.items.forEach(item => {
      if (!item.excluded) {
        rowNum++;
        const m = getModel(item);
        const dbE = customEquips.find(e => e.model.id === m?.id || (e.model.name === m?.name && e.model.manufacturer === m?.manufacturer));
        const equipImg = dbE?.image || m?.image || null;
        activeItems.push({ rowNum, catName: cat.name, itemName: item.name, modelId: m?.id||'', modelName: m?.name||'', manufacturer: m?.manufacturer||'', price: m?.price, quantity: item.quantity, gross: getGross(item), discount: item.itemDiscount, net: getNet(item), image: equipImg });
      }
    }));

    const rows = activeItems.map(i => `
      <tr>
        <td style="text-align:center;width:40px">${i.rowNum}</td>
        <td><strong>${i.itemName}</strong><br/><span style="color:#64748b;font-size:10px">${i.modelName} · ${i.manufacturer}</span></td>
        <td style="text-align:center;width:50px">${i.quantity}</td>
        <td style="text-align:right;font-weight:700;width:120px">${i.net!=null?i.net.toLocaleString('ko-KR')+'원':'—'}</td>
      </tr>`).join('');

    printWin.document.write(`<!DOCTYPE html><html lang="ko"><head>
      <meta charset="UTF-8"><title>의료장비 견적서</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600;700&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; color-adjust:exact !important; }
        body { font-family:'Noto Sans KR',sans-serif; font-size:11px; color:#1e293b; }
        .cover { min-height:100vh; padding:0; display:flex; flex-direction:column; }
        .cover-header { padding:32px 64px 20px; display:flex; flex-direction:column; align-items:center; }
        .cover-header-logo-row { display:flex; align-items:center; gap:20px; width:100%; margin-bottom:16px; }
        .cover-header-line { flex:1; height:1px; background:#1e3a5f; }
        .cover-header-logo { height:40px; object-fit:contain; }
        .cover-header-title { font-size:22px; font-weight:800; color:#1e3a5f; letter-spacing:-0.5px; margin-bottom:7px; text-align:center; width:100%; }
        .cover-header-info { font-size:11px; line-height:2.2; color:#475569; text-align:right; width:100%; margin-bottom:0; }
        .cover-body { flex:1; padding:7px 64px 16px; display:flex; flex-direction:column; justify-content:center; }
        .cover-greeting { margin-bottom:20px; font-size:11.5px; line-height:2; color:#334155; }
        .cover-greeting strong { color:#1e3a5f; font-size:14px; display:block; margin-bottom:6px; }
        .cover-pentagon { position:relative; width:320px; height:330px; margin:0 auto 10px; }
        .cover-pentagon svg { position:absolute; top:0; left:0; width:100%; height:100%; }
        .cover-pnode { position:absolute; display:flex; flex-direction:column; align-items:center; text-align:center; width:100px; margin-left:-50px; margin-top:-24px; }
        .cover-pnode-num { width:38px; height:38px; border-radius:50%; background:#1e3a5f; color:#fff; font-size:14px; font-weight:800; display:flex; align-items:center; justify-content:center; margin-bottom:5px; }
        .cover-pnode-title { font-size:9px; font-weight:700; color:#1e3a5f; line-height:1.4; }
        .cover-closing { font-size:11px; color:#475569; text-align:center; margin-top:16px; margin-bottom:16px; line-height:1.8; }
        .cover-summary { background:linear-gradient(135deg,#1e3a5f 0%,#2d5a8e 100%); color:#fff; border-radius:12px; padding:16px 28px; margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; }
        .cover-summary-left { display:flex; flex-direction:column; gap:2px; }
        .cover-summary-label { font-size:11px; opacity:0.85; }
        .cover-summary-sublabel { font-size:9px; opacity:0.65; }
        .cover-summary-amt { font-size:22px; font-weight:800; letter-spacing:-0.5px; }
        .cover-bottom { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px; }
        .cover-bottom-box { background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px 16px; }
        .cover-bottom-box-title { font-size:9.5px; font-weight:700; color:#1e3a5f; margin-bottom:4px; }
        .cover-bottom-box-desc { font-size:8.5px; color:#475569; line-height:1.6; }
        .cover-note { font-size:9px; color:#1e3a5f; text-align:center; margin-top:8px; padding:6px 16px; background:#f0f4f8; border-radius:6px; border:1px solid #e2e8f0; }
        .page-break { page-break-before:always; }
        .page { padding:40px 50px; }
        .section-title { font-size:16px; font-weight:700; color:#1e3a5f; border-bottom:2px solid #1e3a5f; padding-bottom:8px; margin-bottom:16px; }
        table.data { width:100%; border-collapse:collapse; }
        table.data th { background:#1e3a5f; color:#fff; padding:7px 8px; text-align:left; font-size:10px; font-weight:600; }
        table.data td { padding:6px 8px; border-bottom:1px solid #e2e8f0; vertical-align:middle; }
        table.data tr:nth-child(even) td { background:#f8fafc; }
        .total-box { background:#1e3a5f; color:#fff; border-radius:8px; padding:20px 24px; margin-top:20px; }
        .total-box .row { display:flex; justify-content:space-between; padding:4px 0; font-size:12px; }
        .total-box .final { font-size:18px; font-weight:700; border-top:1px solid rgba(255,255,255,0.3); padding-top:12px; margin-top:8px; }
        .footer { text-align:center; color:#94a3b8; font-size:10px; margin-top:40px; padding-top:16px; border-top:1px solid #e2e8f0; }
        @media print {
          .cover { min-height:100vh; page-break-after:always; }
          .page-break { page-break-before:always; }
          @page { margin:15mm; size:A4; }
        }
      </style>
    </head><body>

    <!-- 표지 -->
    <div class="cover">
      <div class="cover-header">
        <div class="cover-header-logo-row">
          <div class="cover-header-line"></div>
          ${logoBase64 ? `<img src="${logoBase64}" alt="DW Logo" class="cover-header-logo"/>` : ''}
          <div class="cover-header-line"></div>
        </div>
        <div class="cover-header-title">의료기기 납품 견적서</div>
        <div class="cover-header-info">
          견적일자 : ${quoteInfo.date}<br/>
          견적번호 : ${quoteInfo.quoteNo}<br/>
          유효기간 : ${quoteInfo.validity}<br/>
          담당자번호 : 010-2210-9800
        </div>
      </div>
      <div class="cover-body">
        <div class="cover-greeting">
          <strong>성공적인 개원을 기원합니다. ${quoteInfo.doctor} 원장님</strong> 안녕하세요, 대원메디칼입니다.<br/>
          대원메디칼은 1989년 설립 이래, 대한민국 의료 현장과 함께 성장해 왔습니다.<br/>
          수많은 병·의원의 개원과 성장을 지켜보며, 단순히 장비를 납품하는 것이 아닌 병원의 동반자로서 함께해 왔습니다.<br/>
          원장님께서 환자 진료에만 집중하실 수 있도록, 개원 준비부터 사후관리까지 모든 과정을 원스톱으로 책임지겠습니다.
        </div>
        <div class="cover-pentagon">
          <svg viewBox="0 0 340 320" fill="none" xmlns="http://www.w3.org/2000/svg">
            <polygon points="170,28 320,137 262,292 78,292 20,137" stroke="#1e3a5f" stroke-width="1.5" fill="none" stroke-dasharray="6,4" opacity="0.3"/>
            <line x1="170" y1="28" x2="262" y2="292" stroke="#1e3a5f" stroke-width="0.8" opacity="0.12"/>
            <line x1="170" y1="28" x2="78" y2="292" stroke="#1e3a5f" stroke-width="0.8" opacity="0.12"/>
            <line x1="320" y1="137" x2="78" y2="292" stroke="#1e3a5f" stroke-width="0.8" opacity="0.12"/>
            <line x1="20" y1="137" x2="262" y2="292" stroke="#1e3a5f" stroke-width="0.8" opacity="0.12"/>
            <line x1="320" y1="137" x2="20" y2="137" stroke="#1e3a5f" stroke-width="0.8" opacity="0.12"/>
          </svg>
          <div class="cover-pnode" style="left:170px;top:28px"><div class="cover-pnode-num">1</div><div class="cover-pnode-title">46년<br/>턴키 노하우</div></div>
          <div class="cover-pnode" style="left:320px;top:137px"><div class="cover-pnode-num">2</div><div class="cover-pnode-title">개원 트렌드<br/>반영한 병원 구축</div></div>
          <div class="cover-pnode" style="left:262px;top:292px"><div class="cover-pnode-num">3</div><div class="cover-pnode-title">합리적인<br/>가격 경쟁력</div></div>
          <div class="cover-pnode" style="left:78px;top:292px"><div class="cover-pnode-num">4</div><div class="cover-pnode-title">24시간 밀착 케어<br/>긴급 A/S 전담팀</div></div>
          <div class="cover-pnode" style="left:20px;top:137px"><div class="cover-pnode-num">5</div><div class="cover-pnode-title">개원 패키지<br/>특전</div></div>
        </div>
        <div class="cover-closing">
          원장님의 비전이 현실이 되는 그날까지, 대원메디칼이 든든한 파트너가 되어드리겠습니다.
        </div>
        <div class="cover-summary">
          <div class="cover-summary-left">
            <div class="cover-summary-label">총 제안 품목 : ${s.activeItems}종 (주요 의료기기, 소모품 일체)</div>
            <div class="cover-summary-sublabel">금액 (VAT 포함 합계)</div>
          </div>
          <div class="cover-summary-amt">${vatIncluded?s.finalAmt.toLocaleString('ko-KR'):Math.floor(s.finalAmt*1.1).toLocaleString('ko-KR')}원</div>
        </div>
        <div class="cover-bottom">
          <div class="cover-bottom-box">
            <div class="cover-bottom-box-title">소모품 및 스텐류</div>
            <div class="cover-bottom-box-desc">첫 주문 DWmall 10% 할인권 증정</div>
          </div>
          <div class="cover-bottom-box">
            <div class="cover-bottom-box-title">A/S 및 금융 지원</div>
            <div class="cover-bottom-box-desc">무상 보증 : 장비별 1년~5년<br/>금융연계 : 리스/할부 최저금리 최대 60개월 적용</div>
          </div>
        </div>
        <div class="cover-note">일부 기기는 제조사의 유통정책으로 인해 미팅 후 가격안내가 가능합니다</div>
      </div>
    </div>

    <!-- 총괄표 -->
    <div class="page">
      <div class="section-title">총괄표</div>
      <table class="data">
        <thead>
          <tr>
            <th style="width:40px;text-align:center">No.</th>
            <th>품목명 · 모델</th>
            <th style="text-align:center;width:50px">수량</th>
            <th style="text-align:right;width:120px">최종금액</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="total-box">
        <div class="row"><span>공급가액 합계</span><span style="font-variant-numeric:tabular-nums">${s.grossSum.toLocaleString('ko-KR')}원</span></div>
        ${s.discountSum>0?`<div class="row"><span>품목별 할인</span><span>−${s.discountSum.toLocaleString('ko-KR')}원</span></div>`:''}
        <div class="row"><span>전체 할인 (${globalDiscount.type==='rate'?globalDiscount.value+'%':'정액'})</span><span>−${s.globalAmt.toLocaleString('ko-KR')}원</span></div>
        ${vatIncluded
          ? `<div class="row"><span>공급가 (역산)</span><span style="font-variant-numeric:tabular-nums">${Math.floor(s.finalAmt/1.1).toLocaleString('ko-KR')}원</span></div><div class="row"><span>부가세 (10%)</span><span style="font-variant-numeric:tabular-nums">${(s.finalAmt-Math.floor(s.finalAmt/1.1)).toLocaleString('ko-KR')}원</span></div><div class="row final"><span>VAT 포함 합계</span><span style="font-variant-numeric:tabular-nums">${s.finalAmt.toLocaleString('ko-KR')}원</span></div>`
          : `<div class="row final"><span>최종 제안 금액</span><span style="font-variant-numeric:tabular-nums">${s.finalAmt.toLocaleString('ko-KR')}원</span></div><div class="row" style="font-size:12px"><span>부가세 (10%)</span><span style="font-variant-numeric:tabular-nums">${Math.floor(s.finalAmt*0.1).toLocaleString('ko-KR')}원</span></div><div class="row final" style="background:rgba(255,255,255,0.15)"><span>VAT 포함 합계</span><span style="font-variant-numeric:tabular-nums">${Math.floor(s.finalAmt*1.1).toLocaleString('ko-KR')}원</span></div>`
        }
      </div>
      <div class="footer">본 견적서는 ${quoteInfo.validity}까지 유효합니다. · ${quoteInfo.hospital} 귀중</div>
    </div>

    <!-- 제품 상세 페이지들 -->
    ${(() => {
      let detailNum = 0;
      return activeItems.map(i => {
        detailNum++;
        const foundSpec = PRODUCT_SPECS[i.modelId] || PRODUCT_SPECS['_default'];
        const dbE = customEquips.find(e => e.model.id === i.modelId || (e.model.name === i.modelName && e.model.manufacturer === i.manufacturer));
        const pDesc    = dbE?.spec?.desc     || foundSpec.desc;
        const pSpecs   = (dbE?.spec?.specs?.length ? dbE.spec.specs : foundSpec.specs);
        const pOrigin  = dbE?.spec?.origin   || foundSpec.origin;
        const pCert    = dbE?.spec?.cert ? (typeof dbE.spec.cert==='string'?dbE.spec.cert.split(',').map(s=>s.trim()).filter(Boolean):dbE.spec.cert) : foundSpec.cert;
        const pAs      = dbE?.spec?.as       || foundSpec.as;
        const pWarranty= dbE?.spec?.warranty || foundSpec.warranty;
        const pImage   = dbE?.image || i.image || null;
        const certsHtml = pCert.map(c => `<span style="display:inline-block;padding:1px 6px;border:1px solid #bfdbfe;background:#eff6ff;color:#1d4ed8;border-radius:4px;font-size:9px;margin:1px">${c}</span>`).join('');
        const specsHtml = pSpecs.map((s,idx) => `<tr style="background:${idx%2===0?'#fff':'#f8fafc'}"><td style="padding:5px 8px;color:#64748b;width:120px;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;font-size:10px">${s.l}</td><td style="padding:5px 8px;color:#1e293b;border-bottom:1px solid #e2e8f0;font-size:10px;font-weight:500">${s.v}</td></tr>`).join('');
        return `
    <div class="page page-break">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #1e3a5f">
        <span style="color:#94a3b8;font-size:11px">#${detailNum}</span>
        <div>
          <div style="font-size:15px;font-weight:700;color:#1e293b">${i.itemName}</div>
          <div style="font-size:11px;color:#64748b;margin-top:1px">${i.modelName} · ${i.manufacturer}</div>
        </div>
        <div style="margin-left:auto;text-align:right">
          <div style="font-size:11px;color:#64748b">${i.price!=null?i.price.toLocaleString('ko-KR')+'원 × '+i.quantity:'문의'}</div>
          <div style="font-size:14px;font-weight:700;color:#1e3a5f">${i.net!=null?i.net.toLocaleString('ko-KR')+'원':'—'}</div>
        </div>
      </div>
      <div style="display:flex;gap:20px">
        <!-- 이미지 영역 -->
        <div style="width:180px;shrink:0;flex-shrink:0">
          ${pImage
            ? `<img src="${pImage}" alt="${i.itemName}" style="width:180px;height:180px;object-fit:contain;border-radius:10px;border:1px solid #e2e8f0;background:#fff;margin-bottom:10px;display:block"/>`
            : `<div style="width:180px;height:180px;border:2px dashed #cbd5e1;border-radius:10px;background:#f8fafc;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;font-size:10px;margin-bottom:10px"><div style="font-size:24px;opacity:0.3">📷</div><div>이미지 없음</div></div>`
          }
          <div style="font-size:10px;display:flex;flex-direction:column;gap:4px">
            <div style="display:flex;gap:4px"><span style="color:#94a3b8;width:36px">원산지</span><span style="font-weight:600;color:#1e293b">${pOrigin}</span></div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:flex-start"><span style="color:#94a3b8;width:36px">인증</span><div>${certsHtml}</div></div>
          </div>
        </div>
        <!-- 스펙 -->
        <div style="flex:1">
          <div style="margin-bottom:10px">
            <div style="font-size:9px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">제품 소개</div>
            <p style="font-size:10px;color:#475569;line-height:1.7">${pDesc}</p>
          </div>
          <div style="margin-bottom:10px">
            <div style="font-size:9px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">주요 사양</div>
            <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden">
              <tbody>${specsHtml}</tbody>
            </table>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div style="border:1px solid #a7f3d0;background:#ecfdf5;border-radius:8px;padding:10px">
              <div style="font-size:9px;color:#059669;margin-bottom:2px">A/S 기간</div>
              <div style="font-size:12px;font-weight:700;color:#065f46">${pAs}</div>
            </div>
            <div style="border:1px solid #bfdbfe;background:#eff6ff;border-radius:8px;padding:10px">
              <div style="font-size:9px;color:#2563eb;margin-bottom:2px">제품 보증</div>
              <div style="font-size:12px;font-weight:700;color:#1e40af">${pWarranty}</div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
      }).join('');
    })()}

    <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
    printWin.document.close();
  };

  const s_all = useMemo(() => calcSummary(categories, globalDiscount), [categories, globalDiscount]);
  let rowCounter = 0;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/70 backdrop-blur-sm" onClick={onClose}/>
      <div className="relative bg-white rounded-xl shadow-2xl w-[820px] max-h-[90vh] flex flex-col animate-fs">
        {/* Header */}
        <div className="bg-slate-900 text-white px-5 py-3 rounded-t-xl flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400">PDF 미리보기</div>
            <div className="text-sm font-bold">의료장비 공급 견적서</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handlePrint} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
              PDF 인쇄 / 저장
            </button>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-white hover:bg-slate-700 transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 bg-slate-50">
          {[{id:'cover',label:'표지'},{ id:'summary',label:'총괄표'},{ id:'detail',label:'상세 내역'}].map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab===t.id?'border-blue-600 text-blue-700 bg-white':'border-transparent text-slate-500 hover:text-slate-700'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Preview content */}
        <div className="flex-1 overflow-y-auto bg-slate-100 p-6">
          <div className="bg-white shadow-sm rounded-lg max-w-2xl mx-auto min-h-full">

            {tab==='cover' && (
              <div className="flex flex-col">
                {/* Header */}
                <div className="px-10 pt-7 pb-4 flex flex-col items-center rounded-t-lg">
                  <div className="flex items-center gap-4 w-full mb-3">
                    <div className="flex-1 h-px bg-[#1e3a5f]"></div>
                    {logoBase64
                      ? <img src={logoBase64} alt="DW Logo" className="h-10 object-contain"/>
                      : <div className="w-10 h-10 bg-[#1e3a5f] rounded-lg flex items-center justify-center text-white font-bold text-sm">DW</div>
                    }
                    <div className="flex-1 h-px bg-[#1e3a5f]"></div>
                  </div>
                  <div className="text-lg font-extrabold text-[#1e3a5f] tracking-tight mb-1 text-center">의료기기 납품 견적서</div>
                  <div className="text-[11px] text-slate-500 leading-loose text-right w-full">
                    <div>견적일자 : {quoteInfo.date}</div>
                    <div>견적번호 : {quoteInfo.quoteNo}</div>
                    <div>유효기간 : {quoteInfo.validity}</div>
                    <div>담당자번호 : 010-2210-9800</div>
                  </div>
                </div>
                {/* Body */}
                <div className="px-10 pt-3 pb-6">
                  {/* Greeting */}
                  <div className="text-[11.5px] text-slate-700 leading-loose mb-7">
                    <p className="mb-1"><strong className="text-[#1e3a5f] text-[14px] block mb-2">성공적인 개원을 기원합니다. {quoteInfo.doctor} 원장님</strong> 안녕하세요, 대원메디칼입니다.</p>
                    <p className="mb-1">대원메디칼은 1989년 설립 이래, 대한민국 의료 현장과 함께 성장해 왔습니다.</p>
                    <p className="mb-1">수많은 병·의원의 개원과 성장을 지켜보며, 단순히 장비를 납품하는 것이 아닌 병원의 동반자로서 함께해 왔습니다.</p>
                    <p>원장님께서 환자 진료에만 집중하실 수 있도록, 개원 준비부터 사후관리까지 모든 과정을 원스톱으로 책임지겠습니다.</p>
                  </div>
                  {/* Pentagon */}
                  <div className="relative mx-auto mb-4" style={{width:'280px',height:'264px'}}>
                    <svg viewBox="0 0 340 320" fill="none" className="absolute inset-0 w-full h-full">
                      <polygon points="170,28 320,137 262,292 78,292 20,137" stroke="#1e3a5f" strokeWidth="1.5" fill="none" strokeDasharray="6,4" opacity="0.3"/>
                      <line x1="170" y1="28" x2="262" y2="292" stroke="#1e3a5f" strokeWidth="0.8" opacity="0.12"/>
                      <line x1="170" y1="28" x2="78" y2="292" stroke="#1e3a5f" strokeWidth="0.8" opacity="0.12"/>
                      <line x1="320" y1="137" x2="78" y2="292" stroke="#1e3a5f" strokeWidth="0.8" opacity="0.12"/>
                      <line x1="20" y1="137" x2="262" y2="292" stroke="#1e3a5f" strokeWidth="0.8" opacity="0.12"/>
                      <line x1="320" y1="137" x2="20" y2="137" stroke="#1e3a5f" strokeWidth="0.8" opacity="0.12"/>
                    </svg>
                    {[
                      ['1','46년\n턴키 노하우','50%','8.7%'],
                      ['2','개원 트렌드\n반영한 병원 구축','94%','42.8%'],
                      ['3','합리적인\n가격 경쟁력','77%','91.2%'],
                      ['4','24시간 밀착 케어\n긴급 A/S 전담팀','23%','91.2%'],
                      ['5','개원 패키지\n특전','5.8%','42.8%'],
                    ].map(([n,t,l,tp])=>(
                      <div key={n} className="absolute flex flex-col items-center text-center" style={{left:l,top:tp,transform:'translate(-50%,-50%)'}}>
                        <div className="w-9 h-9 rounded-full bg-[#1e3a5f] text-white text-sm font-extrabold flex items-center justify-center mb-1.5">{n}</div>
                        <div className="text-[8.5px] font-bold text-[#1e3a5f] leading-snug whitespace-pre-line">{t}</div>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-500 text-center mt-6 mb-6 leading-relaxed">원장님의 비전이 현실이 되는 그날까지, 대원메디칼이 든든한 파트너가 되어드리겠습니다.</p>
                  {/* Summary */}
                  <div className="bg-gradient-to-br from-[#1e3a5f] to-[#2d5a8e] text-white rounded-2xl px-7 py-5 flex justify-between items-center mb-6">
                    <div>
                      <div className="text-xs opacity-90">총 제안 품목 : {s_all.activeItems}종 (주요 의료기기, 소모품 일체)</div>
                      <div className="text-[10px] opacity-60 mt-1">금액 (VAT 포함 합계)</div>
                    </div>
                    <div className="text-2xl font-extrabold tracking-tight">{vatIncluded?s_all.finalAmt.toLocaleString('ko-KR'):Math.floor(s_all.finalAmt*1.1).toLocaleString('ko-KR')}원</div>
                  </div>
                  {/* Bottom boxes */}
                  <div className="grid grid-cols-2 gap-3.5 mb-4">
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                      <div className="text-[10px] font-bold text-[#1e3a5f] mb-1.5">소모품 및 스텐류</div>
                      <div className="text-[9px] text-slate-600">첫 주문 DWmall 10% 할인권 증정</div>
                    </div>
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                      <div className="text-[10px] font-bold text-[#1e3a5f] mb-1.5">A/S 및 금융 지원</div>
                      <div className="text-[9px] text-slate-600 leading-relaxed">무상 보증 : 장비별 1년~5년<br/>금융연계 : 리스/할부 최저금리 최대 60개월 적용</div>
                    </div>
                  </div>
                  <div className="text-[9.5px] text-[#1e3a5f] text-center bg-slate-100 border border-slate-200 rounded-md py-2 px-4">일부 기기는 제조사의 유통정책으로 인해 미팅 후 가격안내가 가능합니다</div>
                </div>
              </div>
            )}

            {tab==='summary' && (
              <div className="p-6">
                <h2 className="text-base font-bold text-slate-900 border-b-2 border-slate-900 pb-2 mb-4">총괄표</h2>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-900 text-white">
                      <th className="px-2 py-2 text-center w-8">No.</th>
                      <th className="px-2 py-2 text-left">품목명 · 모델</th>
                      <th className="px-2 py-2 text-center w-12">수량</th>
                      <th className="px-2 py-2 text-right w-32">최종금액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categories.map(cat => [
                      <tr key={'cat-'+cat.id} className={`${NEUTRAL_COLORS.header}`}>
                        <td colSpan={4} className={`px-3 py-1.5 font-semibold text-xs ${NEUTRAL_COLORS.headText}`}>{cat.name}</td>
                      </tr>,
                      ...cat.items.filter(i=>!i.excluded).map(item => {
                        rowCounter++;
                        const m = getModel(item);
                        const n = getNet(item);
                        return (
                          <tr key={item.id} className="border-b border-slate-100">
                            <td className="px-2 py-2 text-center text-slate-400 text-xs">{rowCounter}</td>
                            <td className="px-2 py-2">
                              <div className="font-medium text-slate-800 text-xs">{item.name}</div>
                              <div className="text-slate-500 text-xs">{m?.name} · {m?.manufacturer}</div>
                            </td>
                            <td className="px-2 py-2 text-center text-xs">{item.quantity}</td>
                            <td className="px-2 py-2 text-right tnum font-semibold text-xs">{n!=null?n.toLocaleString('ko-KR')+'원':'—'}</td>
                          </tr>
                        );
                      })
                    ])}
                  </tbody>
                </table>
                <div className="mt-4 bg-slate-900 text-white rounded-lg p-4 text-sm">
                  {[
                    ['공급가액 합계', s_all.grossSum.toLocaleString('ko-KR')+'원'],
                    ...(s_all.discountSum>0?[['품목별 할인', '−'+s_all.discountSum.toLocaleString('ko-KR')+'원']]:[]),
                    [`전체 할인 (${globalDiscount.type==='rate'?globalDiscount.value+'%':'정액'})`, '−'+s_all.globalAmt.toLocaleString('ko-KR')+'원'],
                    ...(vatIncluded
                      ? [
                          ['공급가 (역산 ÷1.1)', Math.floor(s_all.finalAmt/1.1).toLocaleString('ko-KR')+'원'],
                          ['부가세 (10%)', (s_all.finalAmt-Math.floor(s_all.finalAmt/1.1)).toLocaleString('ko-KR')+'원'],
                        ]
                      : [
                          ['부가세 (10%)', Math.floor(s_all.finalAmt*0.1).toLocaleString('ko-KR')+'원'],
                        ]
                    ),
                  ].map(([k,v]) => (
                    <div key={k} className="flex justify-between py-1 text-slate-300 text-xs">
                      <span>{k}</span><span className="tnum">{v}</span>
                    </div>
                  ))}
                  <div className="flex justify-between pt-3 mt-2 border-t border-slate-600 font-bold text-sm">
                    <span>{vatIncluded ? '최종 제안 금액 (공급가)' : '최종 제안 금액'}</span>
                    <span className="tnum">{vatIncluded ? Math.floor(s_all.finalAmt/1.1).toLocaleString('ko-KR') : s_all.finalAmt.toLocaleString('ko-KR')}원</span>
                  </div>
                  <div className="flex justify-between pt-2 mt-1 border-t border-slate-500 font-bold text-base text-blue-300">
                    <span>VAT 포함 합계</span>
                    <span className="tnum">{vatIncluded ? s_all.finalAmt.toLocaleString('ko-KR') : Math.floor(s_all.finalAmt*1.1).toLocaleString('ko-KR')}원</span>
                  </div>
                  <div className="text-xs text-slate-400 mt-1">VAT {vatIncluded?'포함 (역산)':'별도'} · 유효기간 {quoteInfo.validity}까지</div>
                </div>
              </div>
            )}

            {tab==='detail' && (() => {
              let detailCounter = 0;
              const allActive = [];
              categories.forEach(cat => cat.items.forEach(item => {
                if (!item.excluded) allActive.push({ cat, item });
              }));
              if (allActive.length === 0) return (
                <div className="p-10 text-center text-slate-400 text-sm">반영된 품목이 없습니다.</div>
              );
              return (
                <div className="p-6 flex flex-col gap-6">
                  <h2 className="text-base font-bold text-slate-900 border-b-2 border-slate-900 pb-2">상세 내역</h2>
                  {allActive.map(({ cat, item }) => {
                    detailCounter++;
                    const m = getModel(item);
                    const spec = PRODUCT_SPECS[m?.id] || PRODUCT_SPECS['_default'];
                    const colors = NEUTRAL_COLORS;
                    const n = getNet(item);
                    const dbE2 = customEquips.find(e => e.model.id === m?.id || (e.model.name === m?.name && e.model.manufacturer === m?.manufacturer));
                    const itemImage = dbE2?.image || m?.image || null;
                    const iDesc     = dbE2?.spec?.desc     || spec.desc;
                    const iSpecs    = (dbE2?.spec?.specs?.length ? dbE2.spec.specs : spec.specs);
                    const iOrigin   = dbE2?.spec?.origin   || spec.origin;
                    const iCert     = dbE2?.spec?.cert ? (typeof dbE2.spec.cert==='string'?dbE2.spec.cert.split(',').map(s=>s.trim()).filter(Boolean):dbE2.spec.cert) : spec.cert;
                    const iAs       = dbE2?.spec?.as       || spec.as;
                    const iWarranty = dbE2?.spec?.warranty || spec.warranty;
                    return (
                      <div key={item.id} className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                        {/* Card header */}
                        <div className="bg-slate-900 text-white px-5 py-3 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-slate-400 text-xs tnum">#{detailCounter}</span>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-0.5 text-xs rounded font-medium ${colors.badge}`}>{cat.name}</span>
                                <span className="font-semibold text-sm">{item.name}</span>
                              </div>
                              <div className="text-xs text-slate-400 mt-0.5">{m?.name} · {m?.manufacturer}</div>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-xs text-slate-400 tnum">{m?.price!=null?m.price.toLocaleString('ko-KR')+'원 × '+item.quantity:'문의'}</div>
                            {item.itemDiscount>0 && <div className="text-xs text-red-400 tnum">−{item.itemDiscount.toLocaleString('ko-KR')}원</div>}
                            <div className="font-bold text-sm tnum text-white">{n!=null?n.toLocaleString('ko-KR')+'원':'—'}</div>
                          </div>
                        </div>
                        {/* Card body */}
                        <div className="flex">
                          {/* Left — image + cert */}
                          <div className="w-52 shrink-0 border-r border-slate-200 bg-slate-50 p-4 flex flex-col gap-3">
                            {itemImage
                              ? <img src={itemImage} alt={item.name} className="w-full aspect-square object-contain rounded-lg border border-slate-200 bg-white" onError={e=>{e.target.style.display='none';}}/>
                              : <div className="w-full aspect-square rounded-lg border-2 border-dashed border-slate-300 bg-white flex flex-col items-center justify-center gap-1.5 text-slate-400">
                                  <svg className="w-8 h-8 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                                  </svg>
                                  <span className="text-xs">이미지 없음</span>
                                </div>
                            }
                            <div className="flex flex-col gap-1 text-xs">
                              <div className="flex items-center gap-1.5">
                                <span className="text-slate-400 w-10 shrink-0">원산지</span>
                                <span className="font-medium text-slate-700">{iOrigin}</span>
                              </div>
                              <div className="flex items-start gap-1.5">
                                <span className="text-slate-400 w-10 shrink-0">인증</span>
                                <div className="flex flex-wrap gap-1">
                                  {iCert.map(c => <span key={c} className="px-1 py-0.5 bg-blue-50 text-blue-700 rounded border border-blue-200 text-xs">{c}</span>)}
                                </div>
                              </div>
                            </div>
                          </div>
                          {/* Right — specs */}
                          <div className="flex-1 p-4 flex flex-col gap-4">
                            <div>
                              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">제품 소개</div>
                              <p className="text-xs text-slate-700 leading-relaxed">{iDesc}</p>
                            </div>
                            <div>
                              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">주요 사양</div>
                              <div className="border border-slate-200 rounded-lg overflow-hidden">
                                <table className="w-full text-xs">
                                  <tbody>
                                    {iSpecs.map((sp, i) => (
                                      <tr key={sp.l+i} className={i%2===0?'bg-white':'bg-slate-50'}>
                                        <td className="px-3 py-2 font-medium text-slate-500 w-32 border-r border-slate-200">{sp.l}</td>
                                        <td className="px-3 py-2 text-slate-800">{sp.v}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2.5">
                                <div className="text-xs text-emerald-600 mb-0.5">A/S 기간</div>
                                <div className="font-bold text-sm text-emerald-800">{iAs}</div>
                              </div>
                              <div className="rounded-lg border border-blue-200 bg-blue-50 p-2.5">
                                <div className="text-xs text-blue-600 mb-0.5">제품 보증</div>
                                <div className="font-bold text-sm text-blue-800">{iWarranty}</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}


/* ============================================================
   EQUIPMENT MANAGE PAGE (통합: 장비목록 + 장비등록 + 카테고리관리)
   ============================================================ */

// 회사 정보 (발주서 등 PDF 출력 시 사용) - localStorage 저장
const DEFAULT_COMPANY_INFO = {
  name: '주식회사 대원메디칼',
  phone: '02-2202-0615',
  fax: '02-2202-0614',
  address: '',
  contact_name: '',
  contact_phone: '',
};
function getCompanyInfo() {
  try {
    const saved = JSON.parse(localStorage.getItem('company_info') || '{}');
    return { ...DEFAULT_COMPANY_INFO, ...saved };
  } catch { return DEFAULT_COMPANY_INFO; }
}
function setCompanyInfo(info) {
  localStorage.setItem('company_info', JSON.stringify(info));
}

function CompanySettingsModal({ onClose }) {
  const [form, setForm] = React.useState(getCompanyInfo());
  const inputCls = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
  const labelCls = "block text-xs font-semibold text-slate-600 mb-1";

  const handleSave = () => {
    setCompanyInfo(form);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="font-bold text-slate-900">🏢 회사 정보 설정</div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="p-6 space-y-3">
          <div className="text-xs text-slate-500 mb-2">발주서 등 PDF 출력 시 발주처 정보로 사용됩니다.</div>
          <div><label className={labelCls}>회사명 <span className="text-red-400">*</span></label>
            <input value={form.name} onChange={e => setForm(p=>({...p, name:e.target.value}))} className={inputCls}/></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>대표 전화</label>
              <input value={form.phone} onChange={e => setForm(p=>({...p, phone:e.target.value}))} className={inputCls} placeholder="02-0000-0000"/></div>
            <div><label className={labelCls}>팩스</label>
              <input value={form.fax} onChange={e => setForm(p=>({...p, fax:e.target.value}))} className={inputCls}/></div>
          </div>
          <div><label className={labelCls}>주소</label>
            <input value={form.address} onChange={e => setForm(p=>({...p, address:e.target.value}))} className={inputCls}/></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>담당자명</label>
              <input value={form.contact_name} onChange={e => setForm(p=>({...p, contact_name:e.target.value}))} className={inputCls}/></div>
            <div><label className={labelCls}>담당자 H.P</label>
              <input value={form.contact_phone} onChange={e => setForm(p=>({...p, contact_phone:e.target.value}))} className={inputCls} placeholder="010-0000-0000"/></div>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50">취소</button>
          <button onClick={handleSave} disabled={!form.name.trim()} className="px-5 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-500 disabled:opacity-40">저장</button>
        </div>
      </div>
    </div>
  );
}

function HospitalManageTab() {
  const [hospitals, setHospitals] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [editingId, setEditingId] = React.useState(null);
  const [expandedId, setExpandedId] = React.useState(null);
  const [form, setForm] = React.useState({ name:'', region:'', address:'', phone:'', contact_name:'', contact_phone:'', contact_email:'', notes:'' });
  const [saving, setSaving] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState(null);
  const [deleteRefs, setDeleteRefs] = React.useState(null);
  const [deleteLoading, setDeleteLoading] = React.useState(false);
  const [deletingNow, setDeletingNow] = React.useState(false);

  const reload = React.useCallback(async () => {
    setLoading(true);
    const data = await dbLoadHospitals();
    setHospitals((data || []).sort((a,b) => (a.hospital_code || 'Z').localeCompare(b.hospital_code || 'Z')));
    setLoading(false);
  }, []);
  React.useEffect(() => { reload(); }, [reload]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return hospitals;
    return hospitals.filter(h =>
      (h.hospital_code || '').toLowerCase().includes(q) ||
      (h.name || '').toLowerCase().includes(q) ||
      (h.contact_name || '').toLowerCase().includes(q) ||
      (h.contact_phone || '').includes(q)
    );
  }, [hospitals, search]);

  React.useEffect(() => {
    if (!deleteTarget) { setDeleteRefs(null); return; }
    setDeleteLoading(true);
    (async () => {
      try {
        const [leads, contracts, expRev, recvTx] = await Promise.all([
          sb.from('leads').select('id', { count:'exact', head:true }).eq('hospital_id', deleteTarget.id),
          sb.from('contracts').select('id', { count:'exact', head:true }).eq('hospital_id', deleteTarget.id),
          sb.from('expected_revenue').select('id', { count:'exact', head:true }).eq('target_hospital_id', deleteTarget.id),
          sb.from('receivable_transactions').select('id', { count:'exact', head:true }).eq('hospital_id', deleteTarget.id),
        ]);
        const r = { leads: leads.count||0, contracts: contracts.count||0, exp_rev: expRev.count||0, recv_tx: recvTx.count||0 };
        r.total = r.leads + r.contracts + r.exp_rev + r.recv_tx;
        setDeleteRefs(r);
      } finally { setDeleteLoading(false); }
    })();
  }, [deleteTarget]);

  const handleNew = () => { setEditingId('__new__'); setExpandedId('__new__'); setForm({ name:'', region:'', address:'', phone:'', contact_name:'', contact_phone:'', contact_email:'', notes:'' }); };
  const handleEdit = (h) => { setEditingId(h.id); setExpandedId(h.id); setForm({ name: h.name||'', region: h.region||'', address: h.address||'', phone: h.phone||'', contact_name: h.contact_name||'', contact_phone: h.contact_phone||'', contact_email: h.contact_email||'', notes: h.notes||'' }); };
  const handleSave = async () => {
    if (!form.name.trim()) { alert('병원명을 입력하세요.'); return; }
    setSaving(true);
    try {
      if (editingId === '__new__') {
        await dbSaveHospital(form);
      } else {
        await dbUpdateHospital(editingId, form);
      }
      await reload();
      setEditingId(null); setExpandedId(null);
    } catch (e) { alert('저장 실패: ' + (e.message||e)); }
    finally { setSaving(false); }
  };
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeletingNow(true);
    try {
      await dbDeleteHospital(deleteTarget.id);
      setHospitals(p => p.filter(x => x.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (e) {
      const msg = e?.message || String(e);
      if (msg.includes('foreign key') || msg.includes('violates') || e?.code === '23503') {
        alert(`삭제 실패 — 다른 데이터(영업 lead·계약·매출·수금)에서 이 병원을 참조하고 있어 DB가 막았습니다.\n해당 데이터를 먼저 정리하거나 다른 병원으로 옮긴 뒤 다시 시도하세요.\n\n원본 메시지: ${msg}`);
      } else { alert('삭제 중 오류: ' + msg); }
    } finally { setDeletingNow(false); }
  };

  const inputCls = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
  const labelCls = "block text-xs font-semibold text-slate-600 mb-1";

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-100 bg-slate-50">
        <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="H코드·병원명·담당자 검색"
          className="flex-1 max-w-sm bg-white border border-slate-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"/>
        <div className="ml-auto text-xs text-slate-500">{filtered.length}개 / 전체 {hospitals.length}</div>
        <button onClick={handleNew} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 font-semibold">+ 신규 병원 등록</button>
      </div>
      {loading ? (
        <div className="p-12 text-center text-slate-400 text-sm">불러오는 중...</div>
      ) : (
        <div className="divide-y divide-slate-100 max-h-[calc(100vh-280px)] overflow-y-auto">
          {editingId === '__new__' && (
            <div className="px-5 py-4 bg-blue-50">
              <div className="text-xs font-semibold text-blue-700 mb-3">+ 신규 병원 등록 — H코드는 자동 부여됩니다</div>
              <div className="grid grid-cols-3 gap-2 mb-2">
                <div><label className={labelCls}>병원명 <span className="text-red-400">*</span></label><input value={form.name} onChange={e=>setForm(p=>({...p, name:e.target.value}))} className={inputCls} autoFocus/></div>
                <div><label className={labelCls}>지역</label><input value={form.region} onChange={e=>setForm(p=>({...p, region:e.target.value}))} className={inputCls}/></div>
                <div><label className={labelCls}>전화</label><input value={form.phone} onChange={e=>setForm(p=>({...p, phone:e.target.value}))} className={inputCls}/></div>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-2">
                <div><label className={labelCls}>담당자</label><input value={form.contact_name} onChange={e=>setForm(p=>({...p, contact_name:e.target.value}))} className={inputCls}/></div>
                <div><label className={labelCls}>담당자 연락처</label><input value={form.contact_phone} onChange={e=>setForm(p=>({...p, contact_phone:e.target.value}))} className={inputCls}/></div>
                <div><label className={labelCls}>이메일</label><input value={form.contact_email} onChange={e=>setForm(p=>({...p, contact_email:e.target.value}))} className={inputCls}/></div>
              </div>
              <div className="mb-2"><label className={labelCls}>주소</label><input value={form.address} onChange={e=>setForm(p=>({...p, address:e.target.value}))} className={inputCls}/></div>
              <div className="mb-3"><label className={labelCls}>메모</label><input value={form.notes} onChange={e=>setForm(p=>({...p, notes:e.target.value}))} className={inputCls}/></div>
              <div className="flex gap-2 justify-end">
                <button onClick={()=>{setEditingId(null); setExpandedId(null);}} className="px-4 py-1.5 text-sm border border-slate-200 text-slate-600 rounded hover:bg-slate-50">취소</button>
                <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-semibold">{saving ? '저장 중...' : '저장'}</button>
              </div>
            </div>
          )}
          {filtered.map(h => {
            const isExpanded = expandedId === h.id;
            const isEditing = editingId === h.id;
            return (
              <div key={h.id}>
                <div className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 cursor-pointer" onClick={()=>setExpandedId(isExpanded ? null : h.id)}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {h.hospital_code && <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 text-xs font-mono font-semibold rounded">{h.hospital_code}</span>}
                      <span className="font-semibold text-slate-800">{h.name}</span>
                      {h.region && <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 text-xs rounded">{h.region}</span>}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {h.contact_name && `${h.contact_name} · `}
                      {h.contact_phone && `${h.contact_phone}`}
                      {!h.contact_name && !h.contact_phone && '담당자 정보 미입력'}
                    </div>
                  </div>
                  <button onClick={(e)=>{e.stopPropagation(); handleEdit(h);}} className="px-3 py-1 text-xs border border-slate-200 text-slate-600 rounded hover:bg-slate-100">수정</button>
                  <button onClick={(e)=>{e.stopPropagation(); setDeleteTarget(h);}} className="px-2 py-1 text-xs border border-slate-200 text-slate-400 rounded hover:border-red-300 hover:text-red-500">삭제</button>
                  <svg className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
                </div>
                {isExpanded && isEditing && (
                  <div className="px-5 py-4 bg-blue-50">
                    <div className="grid grid-cols-3 gap-2 mb-2">
                      <div><label className={labelCls}>병원명</label><input value={form.name} onChange={e=>setForm(p=>({...p, name:e.target.value}))} className={inputCls}/></div>
                      <div><label className={labelCls}>지역</label><input value={form.region} onChange={e=>setForm(p=>({...p, region:e.target.value}))} className={inputCls}/></div>
                      <div><label className={labelCls}>전화</label><input value={form.phone} onChange={e=>setForm(p=>({...p, phone:e.target.value}))} className={inputCls}/></div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-2">
                      <div><label className={labelCls}>담당자</label><input value={form.contact_name} onChange={e=>setForm(p=>({...p, contact_name:e.target.value}))} className={inputCls}/></div>
                      <div><label className={labelCls}>담당자 연락처</label><input value={form.contact_phone} onChange={e=>setForm(p=>({...p, contact_phone:e.target.value}))} className={inputCls}/></div>
                      <div><label className={labelCls}>이메일</label><input value={form.contact_email} onChange={e=>setForm(p=>({...p, contact_email:e.target.value}))} className={inputCls}/></div>
                    </div>
                    <div className="mb-2"><label className={labelCls}>주소</label><input value={form.address} onChange={e=>setForm(p=>({...p, address:e.target.value}))} className={inputCls}/></div>
                    <div className="mb-3"><label className={labelCls}>메모</label><input value={form.notes} onChange={e=>setForm(p=>({...p, notes:e.target.value}))} className={inputCls}/></div>
                    <div className="flex gap-2 justify-end">
                      <button onClick={()=>{setEditingId(null);}} className="px-4 py-1.5 text-sm border border-slate-200 text-slate-600 rounded hover:bg-slate-50">취소</button>
                      <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-semibold">{saving ? '저장 중...' : '저장'}</button>
                    </div>
                  </div>
                )}
                {isExpanded && !isEditing && (
                  <div className="px-5 py-3 bg-slate-50 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                    <div><span className="text-slate-500">담당자 </span><span className="font-medium text-slate-800">{h.contact_name || '-'}</span></div>
                    <div><span className="text-slate-500">연락처 </span><span className="font-medium text-slate-800">{h.contact_phone || '-'}</span></div>
                    <div><span className="text-slate-500">전화 </span><span className="font-medium text-slate-800">{h.phone || '-'}</span></div>
                    <div><span className="text-slate-500">이메일 </span><span className="font-medium text-slate-800">{h.contact_email || '-'}</span></div>
                    <div className="col-span-2"><span className="text-slate-500">주소 </span><span className="font-medium text-slate-800">{h.address || '-'}</span></div>
                    {h.notes && <div className="col-span-2"><span className="text-slate-500">메모 </span><span className="text-slate-700">{h.notes}</span></div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg>
                </div>
                <div>
                  <div className="font-bold text-slate-900">병원 삭제</div>
                  <div className="text-xs text-slate-500 mt-0.5">이 작업은 되돌릴 수 없습니다</div>
                </div>
              </div>
              <div className="bg-red-50 border border-red-100 rounded-lg px-4 py-3 mb-3">
                <div className="text-sm font-semibold text-red-700 mb-1">{deleteTarget.hospital_code ? deleteTarget.hospital_code + ' · ' : ''}{deleteTarget.name}</div>
                <div className="text-xs text-red-500">병원 마스터 정보가 영구 삭제됩니다.</div>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 mb-2 text-xs">
                <div className="font-semibold text-slate-700 mb-2">연결된 데이터 {deleteLoading ? '확인 중...' : ''}</div>
                {deleteRefs && (
                  <div className="space-y-1 text-slate-600">
                    <div className="flex justify-between"><span>영업 lead</span><span className={`font-mono font-semibold ${deleteRefs.leads > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{deleteRefs.leads}</span></div>
                    <div className="flex justify-between"><span>계약</span><span className={`font-mono font-semibold ${deleteRefs.contracts > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{deleteRefs.contracts}</span></div>
                    <div className="flex justify-between"><span>예상 매출</span><span className={`font-mono font-semibold ${deleteRefs.exp_rev > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{deleteRefs.exp_rev}</span></div>
                    <div className="flex justify-between"><span>수금 거래</span><span className={`font-mono font-semibold ${deleteRefs.recv_tx > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{deleteRefs.recv_tx}</span></div>
                  </div>
                )}
              </div>
              {deleteRefs && deleteRefs.total > 0 && (
                <div className="text-xs text-rose-600 bg-rose-50 rounded-lg px-3 py-2 mt-2">
                  ⚠️ 연결 데이터가 있어 삭제가 막힐 수 있습니다. 먼저 해당 데이터를 정리하거나 다른 병원으로 옮기세요.
                </div>
              )}
            </div>
            <div className="px-6 pb-5 flex gap-2 justify-end">
              <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50">취소</button>
              <button onClick={handleDeleteConfirm} disabled={deletingNow || deleteLoading}
                className="px-5 py-2 text-sm bg-red-500 text-white rounded-lg font-semibold hover:bg-red-600 disabled:opacity-50 transition-colors">
                {deletingNow ? '삭제 중...' : '삭제 확인'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   매입가 현황 탭 — 장비별 구매 활동 분석 (최소/평균/최근/횟수/거래처)
   소스: purchase_order_items(equipment_id) + purchase_orders(날짜·거래처) + equipment_price_history(보완)
   ============================================================ */
function EquipmentPurchasePriceTab({ equips = [] }) {
  const [poItems, setPoItems] = React.useState([]);
  const [pos, setPos] = React.useState([]);
  const [hist, setHist] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [sortKey, setSortKey] = React.useState('latestDate');
  const [sortDir, setSortDir] = React.useState('desc');
  const [detail, setDetail] = React.useState(null);

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [pi, po, ph] = await Promise.all([
          sb.from('purchase_order_items').select('equipment_id, model_name, manufacturer, unit_price, quantity, po_id, ordered_at, created_at').not('equipment_id', 'is', null).then(r => r.data || []),
          sb.from('purchase_orders').select('id, vendor_name, manufacturer_name, hospital_name, ordered_at, created_at').then(r => r.data || []),
          sb.from('equipment_price_history').select('equipment_id, price, recorded_at, vendor, po_no, po_id').then(r => r.data || []),
        ]);
        setPoItems(pi); setPos(po); setHist(ph);
      } finally { setLoading(false); }
    })();
  }, []);

  const eqMap = React.useMemo(() => new Map(equips.map(e => [e.id, e])), [equips]);

  const rows = React.useMemo(() => {
    const poMap = new Map(pos.map(p => [p.id, p]));
    const events = new Map(); const covered = new Set();
    poItems.forEach(it => {
      if (!it.equipment_id || !(Number(it.unit_price) > 0)) return;
      const po = poMap.get(it.po_id) || {};
      const date = (po.ordered_at || po.created_at || it.ordered_at || it.created_at || '').slice(0, 10);
      const vendor = po.vendor_name || po.manufacturer_name || it.manufacturer || '';
      if (!events.has(it.equipment_id)) events.set(it.equipment_id, []);
      events.get(it.equipment_id).push({ price: Number(it.unit_price), qty: Number(it.quantity) || 0, date, vendor, site: po.hospital_name || '', src: '발주' });
      if (it.po_id) covered.add(it.equipment_id + '|' + it.po_id);
    });
    hist.forEach(h => {
      if (!h.equipment_id || !(Number(h.price) > 0)) return;
      if (h.po_id && covered.has(h.equipment_id + '|' + h.po_id)) return;
      if (!events.has(h.equipment_id)) events.set(h.equipment_id, []);
      events.get(h.equipment_id).push({ price: Number(h.price), qty: 0, date: (h.recorded_at || '').slice(0, 10), vendor: h.vendor || '', site: (poMap.get(h.po_id) || {}).hospital_name || '', src: '이력' });
    });
    const out = [];
    events.forEach((evs, eqId) => {
      const e = eqMap.get(eqId);
      const prices = evs.map(x => x.price);
      const sorted = [...evs].sort((a, b) => (a.date < b.date ? 1 : -1));
      const latest = sorted[0];
      out.push({
        eqId, model: e ? (e.model && e.model.name) || e.itemName || '(모델명 없음)' : '(삭제된 장비)', mfr: e ? (e.model && e.model.manufacturer) || '' : '',
        count: evs.length, totalQty: evs.reduce((s, x) => s + x.qty, 0),
        min: Math.min(...prices), max: Math.max(...prices),
        avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
        latestPrice: latest.price, latestDate: latest.date,
        vendors: [...new Set(evs.map(x => x.vendor).filter(Boolean))],
        events: sorted,
      });
    });
    return out;
  }, [poItems, pos, hist, eqMap]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    let a = q ? rows.filter(r => (r.model + ' ' + r.mfr + ' ' + r.vendors.join(' ')).toLowerCase().includes(q)) : rows;
    a = [...a].sort((x, y) => {
      let vx, vy;
      if (sortKey === 'latestDate' || sortKey === 'model') { vx = x[sortKey] || ''; vy = y[sortKey] || ''; }
      else { vx = x[sortKey] || 0; vy = y[sortKey] || 0; }
      const c = vx < vy ? -1 : vx > vy ? 1 : 0; return sortDir === 'asc' ? c : -c;
    });
    return a;
  }, [rows, search, sortKey, sortDir]);

  const toggleSort = (k) => { if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir('desc'); } };
  const sortIcon = (k) => sortKey === k ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ' ↕';
  const fmt = n => (n || 0).toLocaleString();
  const exportCsv = () => {
    const head = ['모델', '제조사', '최근매입가', '최근일', '최소', '평균', '최대', '구매횟수', '총수량', '거래처'];
    const esc = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const lines = [head.map(esc).join(',')].concat(filtered.map(r => [r.model, r.mfr, r.latestPrice, r.latestDate, r.min, r.avg, r.max, r.count, r.totalQty, r.vendors.join(';')].map(esc).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = '장비별_매입가_' + new Date().toISOString().slice(0, 10) + '.csv'; a.click(); URL.revokeObjectURL(url);
  };

  const Th = ({ k, children, cls = '' }) => (
    <th onClick={() => toggleSort(k)} className={`px-3 py-2 cursor-pointer select-none hover:bg-slate-100 whitespace-nowrap ${sortKey === k ? 'text-blue-600' : ''} ${cls}`}>{children}{sortIcon(k)}</th>
  );

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="모델·제조사·거래처 검색"
            className="w-full pl-3 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <span className="text-xs text-slate-500">{filtered.length}개 장비 (구매 데이터 있는 것만)</span>
        <button onClick={exportCsv} className="px-3 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-500 shrink-0">엑셀 내보내기</button>
      </div>
      {loading ? (
        <div className="p-12 text-center text-slate-400 text-sm">불러오는 중...</div>
      ) : filtered.length === 0 ? (
        <div className="p-12 text-center text-slate-400 text-sm">구매(발주/매입가) 데이터가 있는 장비가 없습니다.</div>
      ) : (
        <div className="overflow-auto" style={{ maxHeight: 'calc(100vh - 320px)' }}>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
              <tr>
                <Th k="model" cls="text-left">모델 / 제조사</Th>
                <Th k="latestPrice" cls="text-right">최근 매입가</Th>
                <Th k="latestDate" cls="text-center">최근일</Th>
                <Th k="min" cls="text-right">최소</Th>
                <Th k="avg" cls="text-right">평균</Th>
                <Th k="max" cls="text-right">최대</Th>
                <Th k="count" cls="text-center">횟수</Th>
                <Th k="totalQty" cls="text-center">총수량</Th>
                <th className="px-3 py-2 text-left">거래처</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.eqId} className="border-t border-slate-100 hover:bg-blue-50/40 cursor-pointer" onClick={() => setDetail(r)}>
                  <td className="px-3 py-2"><div className="font-medium text-slate-800">{r.model}</div><div className="text-[11px] text-slate-400">{r.mfr}</div></td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-900 tnum">{fmt(r.latestPrice)}</td>
                  <td className="px-3 py-2 text-center text-xs text-slate-500">{r.latestDate || '—'}</td>
                  <td className="px-3 py-2 text-right tnum text-slate-600">{fmt(r.min)}</td>
                  <td className="px-3 py-2 text-right tnum text-slate-600">{fmt(r.avg)}</td>
                  <td className="px-3 py-2 text-right tnum text-slate-600">{fmt(r.max)}</td>
                  <td className="px-3 py-2 text-center text-slate-600">{r.count}</td>
                  <td className="px-3 py-2 text-center text-slate-600">{r.totalQty || '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 truncate max-w-[200px]" title={r.vendors.join(', ')}>{r.vendors.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail && (
        <ModalShell title={`${detail.model} — 구매 내역`} subtitle={`${detail.mfr} · 최근 ${fmt(detail.latestPrice)} (${detail.latestDate})`} onClose={() => setDetail(null)}>
          <div className="grid grid-cols-4 gap-2 mb-3 text-center">
            <div className="bg-slate-50 rounded p-2"><div className="text-[10px] text-slate-500">최소</div><div className="font-bold text-slate-800 tnum">{fmt(detail.min)}</div></div>
            <div className="bg-slate-50 rounded p-2"><div className="text-[10px] text-slate-500">평균</div><div className="font-bold text-slate-800 tnum">{fmt(detail.avg)}</div></div>
            <div className="bg-slate-50 rounded p-2"><div className="text-[10px] text-slate-500">최대</div><div className="font-bold text-slate-800 tnum">{fmt(detail.max)}</div></div>
            <div className="bg-slate-50 rounded p-2"><div className="text-[10px] text-slate-500">횟수/수량</div><div className="font-bold text-slate-800">{detail.count}회/{detail.totalQty}</div></div>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] text-slate-500"><tr><th className="px-2 py-1.5 text-left">날짜</th><th className="px-2 py-1.5 text-right">단가</th><th className="px-2 py-1.5 text-center">수량</th><th className="px-2 py-1.5 text-left">거래처</th><th className="px-2 py-1.5 text-left">납품처</th><th className="px-2 py-1.5 text-center">출처</th></tr></thead>
            <tbody>
              {detail.events.map((ev, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 text-slate-600 whitespace-nowrap">{ev.date || '—'}</td>
                  <td className="px-2 py-1.5 text-right tnum font-medium">{fmt(ev.price)}</td>
                  <td className="px-2 py-1.5 text-center text-slate-500">{ev.qty || '—'}</td>
                  <td className="px-2 py-1.5 text-slate-600">{ev.vendor || '—'}</td>
                  <td className="px-2 py-1.5 text-slate-600">{ev.site || '—'}</td>
                  <td className="px-2 py-1.5 text-center text-[10px] text-slate-400">{ev.src}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ModalShell>
      )}
    </div>
  );
}

function ManufacturerManageTab({ manufacturers, setManufacturers, equips, onEquipChange }) {
  const [search, setSearch] = React.useState('');
  const [editingId, setEditingId] = React.useState(null);
  const [expandedId, setExpandedId] = React.useState(null);
  const [catFilter, setCatFilter] = React.useState('all');
  const [deleteTarget, setDeleteTarget] = React.useState(null);
  const [deleteRefs, setDeleteRefs] = React.useState(null);
  const [deleteLoading, setDeleteLoading] = React.useState(false);
  const [deletingNow, setDeletingNow] = React.useState(false);
  React.useEffect(() => {
    if (!deleteTarget) { setDeleteRefs(null); return; }
    setDeleteLoading(true);
    (async () => {
      try {
        const [eqs, pos, payTxs] = await Promise.all([
          sb.from('equipment').select('id', { count:'exact', head:true }).eq('vendor_id', deleteTarget.id),
          sb.from('purchase_orders').select('id', { count:'exact', head:true }).eq('manufacturer_id', deleteTarget.id),
          sb.from('payable_transactions').select('id', { count:'exact', head:true }).eq('manufacturer_id', deleteTarget.id),
        ]);
        setDeleteRefs({
          equipment: eqs.count || 0,
          purchase_orders: pos.count || 0,
          payable_transactions: payTxs.count || 0,
          total: (eqs.count||0) + (pos.count||0) + (payTxs.count||0),
        });
      } finally { setDeleteLoading(false); }
    })();
  }, [deleteTarget]);

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeletingNow(true);
    try {
      await dbDeleteManufacturer(deleteTarget.id);
      setManufacturers(p => p.filter(x => x.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch(e) {
      const msg = e?.message || String(e);
      if (msg.includes('foreign key') || msg.includes('violates') || e?.code === '23503') {
        alert(`삭제 실패 — 다른 데이터(발주서·외상매입·장비)에서 이 거래처를 참조하고 있어 DB가 막았습니다.\n해당 데이터를 먼저 정리하거나 다른 거래처로 옮긴 뒤 다시 시도하세요.\n\n원본 메시지: ${msg}`);
      } else {
        alert('삭제 중 오류: ' + msg);
      }
    } finally { setDeletingNow(false); }
  };
  const [showAddForm, setShowAddForm] = React.useState(false);
  const [form, setForm] = React.useState({ name:'', category:'일반업체', contact_name:'', contact_phone:'', contact_email:'', lead_time_days:14, payment_terms:'', bank_info:'', aliases:'', notes:'' });
  const [saving, setSaving] = React.useState(false);

  // 장비 DB의 vendor(거래처) 컬럼에서만 추출 — 제조사(manufacturer)는 별개 개념
  const allVendorsFromEquips = React.useMemo(() => {
    const set = new Set();
    equips.forEach(e => { if (e.vendor) set.add(e.vendor); });
    return set;
  }, [equips]);

  // 거래처 목록 = 등록된 거래처(manufacturers 테이블) ∪ 장비 DB의 vendor에서 발견된 이름
  const allMfrs = React.useMemo(() => {
    const map = new Map();
    manufacturers.forEach(m => map.set(m.name, m));
    allVendorsFromEquips.forEach(name => { if (!map.has(name)) map.set(name, { name, notRegistered: true }); });
    return [...map.values()].sort((a,b) => a.name.localeCompare(b.name));
  }, [manufacturers, allVendorsFromEquips]);

  // 거래처별 연결된 장비 — vendor 컬럼만으로 매칭 (제조사 매칭 X)
  const equipsByMfr = React.useMemo(() => {
    const map = {};
    equips.forEach(e => {
      if (!e.vendor) return;
      if (!map[e.vendor]) map[e.vendor] = [];
      map[e.vendor].push(e);
    });
    return map;
  }, [equips]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allMfrs;
    return allMfrs.filter(m => {
      if (catFilter !== 'all' && (m.category || '일반업체') !== catFilter) return false;
      if (!q) return true;
      return m.name.toLowerCase().includes(q) ||
        (m.contact_name || '').toLowerCase().includes(q) ||
        (m.contact_phone || '').includes(q);
    });
  }, [allMfrs, search, catFilter]);

  const startEdit = (m) => {
    setEditingId(m.id || '__new__' + m.name);
    setForm({
      name: m.name || '',
      category: m.category || '일반업체',
      contact_name: m.contact_name || '',
      contact_phone: m.contact_phone || '',
      contact_email: m.contact_email || '',
      lead_time_days: m.lead_time_days || 14,
      payment_terms: m.payment_terms || '',
      bank_info: m.bank_info || '',
      aliases: m.aliases || '',
      notes: m.notes || '',
    });
  };

  const startAdd = () => {
    setShowAddForm(true);
    setEditingId('__new__');
    setForm({ name:'', category:'일반업체', contact_name:'', contact_phone:'', contact_email:'', lead_time_days:14, payment_terms:'', bank_info:'', aliases:'', notes:'' });
  };

  // 거래처명 변경 시 연결된 vendor 컬럼만 cascade — 제조사(manufacturer)는 별개 개념이므로 건들지 않음
  const cascadeRename = async (oldName, newName) => {
    if (!oldName || oldName === newName) return null;
    const cascade = { equip_vendor: 0, po_vendor: 0 };
    try {
      const r = await sb.from('equipment').update({ vendor: newName }).eq('vendor', oldName).select('id');
      cascade.equip_vendor = r.data?.length || 0;
    } catch (e) { console.warn('equipment.vendor update:', e); }
    try {
      const r = await sb.from('purchase_orders').update({ vendor_name: newName }).eq('vendor_name', oldName).select('id');
      cascade.po_vendor = r.data?.length || 0;
    } catch (e) { console.warn('purchase_orders.vendor_name update:', e); }
    if (onEquipChange) onEquipChange();
    return cascade;
  };

  const handleSave = async () => {
    if (!form.name.trim()) { alert('거래처명을 입력하세요.'); return; }
    setSaving(true);
    try {
      const isExistingRecord = editingId && !String(editingId).startsWith('__new__');
      const newName = form.name.trim();
      let oldName = '';

      if (isExistingRecord) {
        // 등록된 거래처 — ID로 정확히 매칭하여 update (이름까지)
        const oldRecord = manufacturers.find(m => m.id === editingId);
        oldName = oldRecord?.name || '';
        const dup = manufacturers.find(m => m.id !== editingId && m.name === newName);
        if (dup) {
          alert(`거래처명 "${newName}"이(가) 이미 존재합니다. 다른 이름을 사용하세요.`);
          setSaving(false);
          return;
        }
        await dbUpdateManufacturer(editingId, form);
        setManufacturers(p => p.map(m => m.id === editingId ? { ...m, ...form } : m));
      } else {
        // 미등록 거래처 [수정] 또는 [+ 새 거래처]
        // editingId='__new__이름' 형태에서 옛 이름 추출 (장비DB와의 연결을 cascade하기 위함)
        if (String(editingId).startsWith('__new__')) {
          oldName = String(editingId).replace('__new__', '');
        }
        const existing = manufacturers.find(m => m.name === newName);
        if (existing?.id) {
          await dbUpdateManufacturer(existing.id, form);
          setManufacturers(p => p.map(m => m.id === existing.id ? { ...m, ...form } : m));
        } else {
          const id = await dbSaveManufacturer(form);
          setManufacturers(p => [...p, { ...form, id, created_at: new Date().toISOString() }]);
        }
      }

      // 옛 이름 → 새 이름 cascade (이름이 바뀐 경우만, vendor 라인만)
      if (oldName && oldName !== newName) {
        const cascade = await cascadeRename(oldName, newName);
        const total = cascade.equip_vendor + cascade.po_vendor;
        if (total > 0) {
          alert(
            `거래처명 변경: "${oldName}" → "${newName}"\n` +
            `\n연결된 데이터도 함께 갱신:\n` +
            `· 장비의 거래처 컬럼: ${cascade.equip_vendor}건\n` +
            `· 발주서의 거래처명: ${cascade.po_vendor}건\n` +
            `\n※ 제조사(manufacturer) 컬럼은 거래처와 별개라서 건드리지 않습니다.`
          );
        }
      }

      setEditingId(null);
      setShowAddForm(false);
    } catch(e) {
      console.error(e);
      alert('저장 실패: ' + e.message);
    }
    setSaving(false);
  };

  const handleDelete = async (m) => {
    if (!m.id) { alert('등록되지 않은 거래처는 삭제할 수 없습니다.'); return; }
    setDeleteTarget(m);
  };

  const inputCls = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
  const labelCls = "block text-xs font-semibold text-slate-600 mb-1";

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto flex flex-col gap-5">
        {/* 헤더 + 검색 + 추가 버튼 */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0"/></svg>
              <input type="text" placeholder="거래처명, 담당자, 연락처 검색"
                value={search} onChange={e => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            </div>
            <select value={catFilter} onChange={e=>setCatFilter(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm shrink-0 focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="all">전체 카테고리</option>
              <option value="병원">병원</option>
              <option value="일반업체">일반업체</option>
              <option value="기타">기타</option>
            </select>
            <button onClick={startAdd}
              className="px-4 py-2 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-700 shrink-0">
              + 새 거래처
            </button>
          </div>
        </div>

        {/* 새 거래처 추가 폼 */}
        {showAddForm && editingId === '__new__' && (
          <div className="bg-white rounded-xl border border-blue-300 p-5 shadow-sm">
            <div className="font-bold text-slate-800 text-sm mb-4">새 거래처 등록</div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><label className={labelCls}>거래처명 <span className="text-red-400">*</span></label>
                <input value={form.name} onChange={e => setForm(p=>({...p, name:e.target.value}))} className={inputCls} placeholder="GEMSS Healthcare"/></div>
              <div><label className={labelCls}>카테고리</label>
                <select value={form.category} onChange={e => setForm(p=>({...p, category:e.target.value}))} className={inputCls}>
                  <option value="일반업체">일반업체</option>
                  <option value="병원">병원</option>
                  <option value="기타">기타</option>
                </select></div>
              <div><label className={labelCls}>담당자</label>
                <input value={form.contact_name} onChange={e => setForm(p=>({...p, contact_name:e.target.value}))} className={inputCls}/></div>
              <div><label className={labelCls}>연락처</label>
                <input value={form.contact_phone} onChange={e => setForm(p=>({...p, contact_phone:e.target.value}))} className={inputCls} placeholder="02-0000-0000"/></div>
              <div><label className={labelCls}>이메일</label>
                <input value={form.contact_email} onChange={e => setForm(p=>({...p, contact_email:e.target.value}))} className={inputCls}/></div>
              <div><label className={labelCls}>리드타임 (일)</label>
                <input type="number" value={form.lead_time_days} onChange={e => setForm(p=>({...p, lead_time_days:parseInt(e.target.value)||14}))} className={inputCls}/></div>
              <div><label className={labelCls}>결제조건</label>
                <input value={form.payment_terms} onChange={e => setForm(p=>({...p, payment_terms:e.target.value}))} className={inputCls} placeholder="납품 후 30일"/></div>
              <div className="col-span-2"><label className={labelCls}>계좌정보</label>
                <input value={form.bank_info} onChange={e => setForm(p=>({...p, bank_info:e.target.value}))} className={inputCls} placeholder="국민은행 000-00-000000"/></div>
              <div className="col-span-2"><label className={labelCls}>계좌주/별칭 <span className="text-slate-400 font-normal">(쉼표로 구분 — 통장 자동매칭용)</span></label>
                <input value={form.aliases} onChange={e => setForm(p=>({...p, aliases:e.target.value}))} className={inputCls} placeholder="오명근, 엠케이, MK베드"/></div>
              <div className="col-span-2"><label className={labelCls}>비고</label>
                <textarea value={form.notes} onChange={e => setForm(p=>({...p, notes:e.target.value}))} className={inputCls} rows={2}/></div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setEditingId(null); setShowAddForm(false); }} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50">취소</button>
              <button onClick={handleSave} disabled={saving || !form.name.trim()} className="px-5 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-500 disabled:opacity-40">{saving ? '저장 중...' : '등록'}</button>
            </div>
          </div>
        )}

        {/* 거래처 목록 */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="font-bold text-slate-800 text-sm">거래처 목록 ({filtered.length})</div>
            <div className="text-xs text-slate-400">등록 {manufacturers.length}개 · 장비 기반 {allVendorsFromEquips.size}개</div>
          </div>
          <div className="divide-y divide-slate-100">
            {filtered.length === 0 && <div className="p-8 text-center text-slate-400 text-sm">거래처가 없습니다</div>}
            {filtered.map(m => {
              const mfrEquips = equipsByMfr[m.name] || [];
              const isExpanded = expandedId === (m.id || m.name);
              const isEditing = editingId === m.id || editingId === '__new__' + m.name;

              return (
                <div key={m.id || m.name} className="p-0">
                  <div className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : (m.id || m.name))}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {m.vendor_code && <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs font-mono font-semibold rounded">{m.vendor_code}</span>}
                        <span className="font-semibold text-slate-800">{m.name}</span>
                        {!m.notRegistered && <span className={`px-1.5 py-0.5 text-xs rounded ${(m.category||'일반업체')==='병원' ? 'bg-emerald-100 text-emerald-700' : m.category==='기타' ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600'}`}>{m.category || '일반업체'}</span>}
                        {m.notRegistered && <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 text-xs rounded">미등록</span>}
                        <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 text-xs rounded">장비 {mfrEquips.length}개</span>
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {m.contact_name && `${m.contact_name} · `}
                        {m.contact_phone && `${m.contact_phone} · `}
                        {m.lead_time_days && `리드타임 ${m.lead_time_days}일`}
                        {!m.contact_name && !m.contact_phone && !m.notRegistered && '상세 정보 미입력'}
                      </div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); startEdit(m); setExpandedId(m.id || m.name); }}
                      className="px-3 py-1 text-xs border border-slate-200 text-slate-600 rounded hover:bg-slate-100">수정</button>
                    {m.id && <button onClick={(e) => { e.stopPropagation(); handleDelete(m); }}
                      className="px-2 py-1 text-xs border border-slate-200 text-slate-400 rounded hover:border-red-300 hover:text-red-500">삭제</button>}
                    <svg className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
                  </div>

                  {/* 확장 영역 */}
                  {isExpanded && (
                    <div className="px-5 py-4 bg-slate-50 border-t border-slate-100">
                      {/* 편집 모드 */}
                      {isEditing ? (
                        <>
                          <div className="grid grid-cols-2 gap-3 text-sm mb-4">
                            <div><label className={labelCls}>거래처명</label>
                              <input value={form.name} onChange={e => setForm(p=>({...p, name:e.target.value}))} className={inputCls}/></div>
                            <div><label className={labelCls}>카테고리</label>
                              <select value={form.category} onChange={e => setForm(p=>({...p, category:e.target.value}))} className={inputCls}>
                                <option value="일반업체">일반업체</option>
                                <option value="병원">병원</option>
                                <option value="기타">기타</option>
                              </select></div>
                            <div><label className={labelCls}>담당자</label>
                              <input value={form.contact_name} onChange={e => setForm(p=>({...p, contact_name:e.target.value}))} className={inputCls}/></div>
                            <div><label className={labelCls}>연락처</label>
                              <input value={form.contact_phone} onChange={e => setForm(p=>({...p, contact_phone:e.target.value}))} className={inputCls}/></div>
                            <div><label className={labelCls}>이메일</label>
                              <input value={form.contact_email} onChange={e => setForm(p=>({...p, contact_email:e.target.value}))} className={inputCls}/></div>
                            <div><label className={labelCls}>리드타임 (일)</label>
                              <input type="number" value={form.lead_time_days} onChange={e => setForm(p=>({...p, lead_time_days:parseInt(e.target.value)||14}))} className={inputCls}/></div>
                            <div><label className={labelCls}>결제조건</label>
                              <input value={form.payment_terms} onChange={e => setForm(p=>({...p, payment_terms:e.target.value}))} className={inputCls}/></div>
                            <div className="col-span-2"><label className={labelCls}>계좌정보</label>
                              <input value={form.bank_info} onChange={e => setForm(p=>({...p, bank_info:e.target.value}))} className={inputCls}/></div>
                            <div className="col-span-2"><label className={labelCls}>계좌주/별칭 <span className="text-slate-400 font-normal">(쉼표로 구분 — 통장 자동매칭용)</span></label>
                              <input value={form.aliases} onChange={e => setForm(p=>({...p, aliases:e.target.value}))} className={inputCls} placeholder="오명근, 엠케이, MK베드"/></div>
                            <div className="col-span-2"><label className={labelCls}>비고</label>
                              <textarea value={form.notes} onChange={e => setForm(p=>({...p, notes:e.target.value}))} className={inputCls} rows={2}/></div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <button onClick={() => setEditingId(null)} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50">취소</button>
                            <button onClick={handleSave} disabled={saving} className="px-5 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-500 disabled:opacity-40">{saving ? '저장 중...' : '저장'}</button>
                          </div>
                        </>
                      ) : (
                        /* 읽기 모드 */
                        <>
                          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs mb-4">
                            <div><span className="text-slate-500">담당자 </span><span className="font-medium text-slate-800">{m.contact_name || '-'}</span></div>
                            <div><span className="text-slate-500">이메일 </span><span className="font-medium text-slate-800">{m.contact_email || '-'}</span></div>
                            <div><span className="text-slate-500">연락처 </span><span className="font-medium text-slate-800">{m.contact_phone || '-'}</span></div>
                            <div><span className="text-slate-500">리드타임 </span><span className="font-medium text-slate-800">{m.lead_time_days ? m.lead_time_days + '일' : '-'}</span></div>
                            <div><span className="text-slate-500">결제조건 </span><span className="font-medium text-slate-800">{m.payment_terms || '-'}</span></div>
                            <div><span className="text-slate-500">계좌 </span><span className="font-medium text-slate-800">{m.bank_info || '-'}</span></div>
                            {m.aliases && <div className="col-span-2"><span className="text-slate-500">계좌주/별칭 </span><span className="font-medium text-slate-800">{m.aliases}</span></div>}
                            {m.notes && <div className="col-span-2"><span className="text-slate-500">비고 </span><span className="font-medium text-slate-800">{m.notes}</span></div>}
                          </div>
                        </>
                      )}

                      {/* 제조사별 장비 목록 */}
                      {mfrEquips.length > 0 && (
                        <div className="mt-4">
                          <div className="text-xs font-semibold text-slate-600 mb-2">연결된 장비 ({mfrEquips.length}개)</div>
                          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                            <table className="w-full text-xs">
                              <thead className="bg-slate-50">
                                <tr>
                                  <th className="px-3 py-2 text-left text-slate-500 font-medium">카테고리</th>
                                  <th className="px-3 py-2 text-left text-slate-500 font-medium">품목명</th>
                                  <th className="px-3 py-2 text-left text-slate-500 font-medium">모델명</th>
                                  <th className="px-3 py-2 text-right text-slate-500 font-medium">판매가</th>
                                  <th className="px-3 py-2 text-right text-slate-500 font-medium">매입가</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {mfrEquips.map(e => (
                                  <tr key={e.id}>
                                    <td className="px-3 py-2 text-slate-600">{e.catName}</td>
                                    <td className="px-3 py-2 font-medium text-slate-800">{e.itemName}</td>
                                    <td className="px-3 py-2 text-slate-600">{e.model?.name || '-'}</td>
                                    <td className="px-3 py-2 text-right tnum text-slate-800">{e.model?.price ? e.model.price.toLocaleString('ko-KR') : '-'}</td>
                                    <td className="px-3 py-2 text-right tnum text-slate-800">{e.purchasePrice ? e.purchasePrice.toLocaleString('ko-KR') : '-'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg>
                </div>
                <div>
                  <div className="font-bold text-slate-900">거래처 삭제</div>
                  <div className="text-xs text-slate-500 mt-0.5">이 작업은 되돌릴 수 없습니다</div>
                </div>
              </div>
              <div className="bg-red-50 border border-red-100 rounded-lg px-4 py-3 mb-3">
                <div className="text-sm font-semibold text-red-700 mb-1">{deleteTarget.vendor_code ? deleteTarget.vendor_code + ' · ' : ''}{deleteTarget.name}</div>
                <div className="text-xs text-red-500">거래처 마스터 정보가 영구 삭제됩니다.</div>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 mb-2 text-xs">
                <div className="font-semibold text-slate-700 mb-2">연결된 데이터 {deleteLoading ? '확인 중...' : ''}</div>
                {deleteRefs && (
                  <div className="space-y-1 text-slate-600">
                    <div className="flex justify-between"><span>장비 (vendor_id)</span><span className={`font-mono font-semibold ${deleteRefs.equipment > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{deleteRefs.equipment}</span></div>
                    <div className="flex justify-between"><span>발주서</span><span className={`font-mono font-semibold ${deleteRefs.purchase_orders > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{deleteRefs.purchase_orders}</span></div>
                    <div className="flex justify-between"><span>외상매입 거래</span><span className={`font-mono font-semibold ${deleteRefs.payable_transactions > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{deleteRefs.payable_transactions}</span></div>
                  </div>
                )}
              </div>
              {deleteRefs && deleteRefs.total > 0 && (
                <div className="text-xs text-rose-600 bg-rose-50 rounded-lg px-3 py-2 mt-2">
                  ⚠️ 연결 데이터가 있어 삭제가 막힐 수 있습니다. 외상매입 거래는 정리한 뒤 다시 시도하세요. (FK 정책 변경 후엔 장비·발주서는 연결만 끊기고 보존됩니다)
                </div>
              )}
            </div>
            <div className="px-6 pb-5 flex gap-2 justify-end">
              <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50">취소</button>
              <button onClick={handleDeleteConfirm} disabled={deletingNow || deleteLoading}
                className="px-5 py-2 text-sm bg-red-500 text-white rounded-lg font-semibold hover:bg-red-600 disabled:opacity-50 transition-colors">
                {deletingNow ? '삭제 중...' : '삭제 확인'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EquipmentManagePage({ onBack, onEquipChange, dynCats, dynItems, onCatsChange, onItemsChange, user, onLogout, nav, manufacturers = [], setManufacturers, customEquips = [] }) {
  const [activeTab, setActiveTab] = useState('list'); // 'list' | 'register' | 'catmgr'
  const emptySpec = () => ({ l:'', v:'' });
  const inputCls = "w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400";
  const labelCls = "block text-xs font-semibold text-slate-600 mb-1";

  /* ── 장비 목록 state ── */
  const [equips, setEquips]           = useState([]);
  const [loading, setLoading]         = useState(true);
  const [search, setSearch]           = useState('');
  const [catFilter, setCatFilter]     = useState('all');
  const [itemFilter, setItemFilter]   = useState('all');
  const [editTarget, setEditTarget]   = useState(null);
  const [editForm, setEditForm]       = useState(null);
  const [regPickerOpen, setRegPickerOpen] = useState(false);
  const [editPickerOpen, setEditPickerOpen] = useState(false);
  const [confirmDel, setConfirmDel]   = useState(null);
  const [saving, setSaving]           = useState(false);
  const [showPriceHistory, setShowPriceHistory] = useState(null); // 장비 객체
  const editImgRef                    = useRef(null);

  /* ── 장비 등록 state ── */
  const emptyRegForm = () => ({ catId: dynCats[0]?.id || '', itemName:'', modelName:'', manufacturer:'', vendor:'', vendorId:null, vendorCode:'', purchasePrice:'', price:'', altModels:[], homepage:'', image:null, desc:'', specs:[emptySpec()], origin:'대한민국', cert:'', as:'1년', warranty:'1년', notes:'' });
  const [regForm, setRegForm]         = useState(emptyRegForm);
  const [regSaving, setRegSaving]     = useState(false);
  const [regSaved, setRegSaved]       = useState(false);
  const regImgRef                     = useRef(null);
  const [regAltSearch, setRegAltSearch] = useState('');
  const [regAltOpen, setRegAltOpen]     = useState(false);
  const [editAltSearch, setEditAltSearch] = useState('');
  const [editAltOpen, setEditAltOpen]     = useState(false);

  /* ── 카테고리 관리 state ── */
  const [newCatName, setNewCatName]   = useState('');
  const [catSaving, setCatSaving]     = useState(false);
  const [expandedCat, setExpandedCat] = useState(null);
  const [newItemName, setNewItemName] = useState('');
  const [itemSaving, setItemSaving]   = useState(false);
  const [confirmDelCat, setConfirmDelCat]   = useState(null);
  const [confirmDelItem, setConfirmDelItem] = useState(null);

  useEffect(() => {
    dbLoadEquip().then(d => { setEquips(d); setLoading(false); }).catch(e => { console.error(e); setLoading(false); });
  }, []);

  useEffect(() => {
    if (dynCats.length > 0 && !regForm.catId) setRegForm(p => ({ ...p, catId: dynCats[0].id }));
  }, [dynCats]);

  /* ── 장비 목록 helpers ── */
  const openEdit = (e) => {
    setEditForm({
      catId: e.catId || dynCats[0]?.id || '',
      itemName: e.itemName, modelName: e.model.name, manufacturer: e.model.manufacturer,
      vendor: e.vendor || '',
      vendorId: e.vendorId || null,
      vendorCode: e.vendorCode || '',
      purchasePrice: e.purchasePrice != null ? e.purchasePrice.toLocaleString('ko-KR') : '',
      price: e.model.price != null ? e.model.price.toLocaleString('ko-KR') : '',
      altText: e.altText || '', altModels: Array.isArray(e.altModels) ? e.altModels.map(m=>({...m, price: m.price != null ? String(m.price) : ''})) : [], homepage: e.homepage || '', image: e.image || null,
      desc: e.spec?.desc || '', specs: e.spec?.specs?.length ? e.spec.specs : [emptySpec()],
      origin: e.spec?.origin || '', cert: e.spec?.cert || '', as: e.spec?.as || '', warranty: e.spec?.warranty || '', notes: e.model.notes || '',
    });
    setEditTarget(e);
    setEditAltSearch(''); setEditAltOpen(false);
  };
  const closeEdit = () => { setEditTarget(null); setEditForm(null); setEditAltSearch(''); setEditAltOpen(false); };
  const setEF = (k, v) => setEditForm(p => ({ ...p, [k]: v }));
  const addEditSpec    = () => setEF('specs', [...editForm.specs, emptySpec()]);
  const removeEditSpec = (i) => setEF('specs', editForm.specs.filter((_,idx)=>idx!==i));
  const setEditSpec    = (i,k,v) => setEF('specs', editForm.specs.map((s,idx)=>idx===i?{...s,[k]:v}:s));

  const handleEditImage = (ev) => {
    const file = ev.target.files?.[0]; if (!file) return;
    const r = new FileReader(); r.onload = (e) => setEF('image', e.target.result); r.readAsDataURL(file);
  };

  const handleSave = async () => {
    if (!editForm.itemName.trim() || !editForm.modelName.trim()) return;
    setSaving(true);
    const catObj = dynCats.find(c=>c.id===editForm.catId) || dynCats[0];
    const entry = {
      id: editTarget.id,
      catId: catObj?.id || editForm.catId, catName: catObj?.name || editForm.catId,
      itemName: editForm.itemName.trim(),
      model: { id: editTarget.model.id, name: editForm.modelName.trim(), manufacturer: editForm.manufacturer.trim(), price: parseInt(editForm.price.replace(/[^0-9]/g,''))||null, notes: editForm.notes.trim() },
      vendor: (editForm.vendor || '').trim(),
      vendorId: editForm.vendorId || null,
      purchasePrice: parseInt((editForm.purchasePrice||'').replace(/[^0-9]/g,''))||null,
      altText: editForm.altText.trim(),
      altModels: editForm.altModels || [],
      homepage: editForm.homepage?.trim() || '',
      image: editForm.image,
      spec: { desc: editForm.desc.trim(), specs: editForm.specs.filter(s=>s.l.trim()), origin: editForm.origin.trim(), cert: editForm.cert.trim(), as: editForm.as.trim(), warranty: editForm.warranty.trim() },
      createdAt: editTarget.createdAt,
    };
    try {
      await dbSaveEquip(entry);
      setEquips(p => p.map(e => e.id===editTarget.id ? entry : e));
      closeEdit(); onEquipChange?.();
    } catch(e) { console.error(e); alert('저장 중 오류가 발생했습니다.'); } finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    try { await dbDeleteEquip(id); setEquips(p=>p.filter(e=>e.id!==id)); setConfirmDel(null); onEquipChange?.(); }
    catch(e) { console.error(e); alert('삭제 중 오류가 발생했습니다.'); }
  };

  const listItemOptions = useMemo(() => {
    if (catFilter === 'all') return [];
    return dynItems.filter(it => it.catId === catFilter);
  }, [dynItems, catFilter]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return equips.filter(e => {
      const matchCat  = catFilter  === 'all' || e.catId    === catFilter;
      const matchItem = itemFilter === 'all' || e.itemName === itemFilter;
      const matchQ = !q || e.itemName.toLowerCase().includes(q) || e.model.name.toLowerCase().includes(q) || e.model.manufacturer.toLowerCase().includes(q);
      return matchCat && matchItem && matchQ;
    });
  }, [equips, search, catFilter, itemFilter]);

  /* ── 장비 등록 helpers ── */
  const setRF = (k, v) => setRegForm(p => ({ ...p, [k]: v }));
  const addRegSpec    = () => setRF('specs', [...regForm.specs, emptySpec()]);
  const removeRegSpec = (i) => setRF('specs', regForm.specs.filter((_,idx)=>idx!==i));
  const setRegSpec    = (i,k,v) => setRF('specs', regForm.specs.map((s,idx)=>idx===i?{...s,[k]:v}:s));
  const handleRegImage = (ev) => {
    const file = ev.target.files?.[0]; if (!file) return;
    const r = new FileReader(); r.onload = (e) => setRF('image', e.target.result); r.readAsDataURL(file);
  };
  const regItemOptions = useMemo(() => dynItems.filter(it=>it.catId===regForm.catId), [dynItems, regForm.catId]);

  const handleRegSubmit = async () => {
    if (!regForm.itemName || !regForm.modelName.trim()) return;
    setRegSaving(true);
    const catObj = dynCats.find(c=>c.id===regForm.catId);
    const entry = {
      id: null, catId: catObj?.id || regForm.catId, catName: catObj?.name || regForm.catId,
      itemName: regForm.itemName,
      model: { id:'cm-'+Date.now(), name: regForm.modelName.trim(), manufacturer: regForm.manufacturer.trim(), price: parseInt(regForm.price.replace(/[^0-9]/g,''))||null, notes: regForm.notes.trim() },
      vendor: (regForm.vendor || '').trim(),
      vendorId: regForm.vendorId || null,
      purchasePrice: parseInt((regForm.purchasePrice||'').replace(/[^0-9]/g,''))||null,
      altText: '',
      altModels: regForm.altModels || [],
      homepage: regForm.homepage?.trim() || '',
      image: regForm.image,
      spec: { desc: regForm.desc.trim(), specs: regForm.specs.filter(s=>s.l.trim()), origin: regForm.origin.trim(), cert: regForm.cert.trim(), as: regForm.as.trim(), warranty: regForm.warranty.trim() },
      createdAt: new Date().toLocaleDateString('ko-KR'),
    };
    try {
      const savedId = await dbSaveEquip(entry); entry.id = savedId;
      setEquips(p => [entry, ...p]);
      setRegForm(emptyRegForm()); setRegSaved(true); setTimeout(()=>setRegSaved(false),2000);
      onEquipChange?.();
    } catch(e) { console.error(e); alert('저장 중 오류가 발생했습니다.'); } finally { setRegSaving(false); }
  };

  /* ── 카테고리 관리 helpers ── */
  const handleAddCat = async () => {
    if (!newCatName.trim()) return;
    setCatSaving(true);
    try {
      const newCat = await dbSaveDynCat({ name: newCatName.trim(), sortOrder: dynCats.length + 1 });
      onCatsChange?.([...dynCats, newCat]);
      setNewCatName(''); setNewCatColor('blue');
    } catch(e) { console.error(e); alert('카테고리 추가 중 오류가 발생했습니다.'); } finally { setCatSaving(false); }
  };

  const handleDeleteCat = async (cat) => {
    try {
      // DB cat_items도 같이 정리 (orphan 방지)
      const itemsToDelete = dynItems.filter(it => it.catId === cat.id);
      await Promise.all(itemsToDelete.map(it => dbDeleteDynItem(it.id).catch(()=>{})));
      await dbDeleteDynCat(cat.dbId);
      onCatsChange?.(dynCats.filter(c=>c.dbId!==cat.dbId));
      onItemsChange?.(dynItems.filter(it=>it.catId!==cat.id));
      setConfirmDelCat(null);
    } catch(e) { console.error(e); alert('카테고리 삭제 중 오류가 발생했습니다.'); }
  };

  const handleAddItem = async (catId) => {
    if (!newItemName.trim()) return;
    setItemSaving(true);
    try {
      const newItem = await dbSaveDynItem({ catId, name: newItemName.trim() });
      onItemsChange?.([...dynItems, newItem]);
      setNewItemName('');
    } catch(e) { console.error(e); alert('품목 추가 중 오류가 발생했습니다.'); } finally { setItemSaving(false); }
  };

  const handleDeleteItem = async (id) => {
    try {
      await dbDeleteDynItem(id);
      onItemsChange?.(dynItems.filter(it=>it.id!==id));
      setConfirmDelItem(null);
    } catch(e) { console.error(e); alert('품목 삭제 중 오류가 발생했습니다.'); }
  };

  const TABS = [
    { id:'list',    label:'장비 목록',        icon:'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
    { id:'register',label:'장비 등록',        icon:'M12 4v16m8-8H4' },
    { id:'catmgr',  label:'카테고리·품목 관리', icon:'M4 6h16M4 12h16M4 18h7' },
    { id:'purchaseprice', label:'매입가 현황', icon:'M9 7h6m-6 4h6m-6 4h4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z' },
    { id:'mfrmgr',  label:'거래처 관리',       icon:'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4' },
    { id:'hospmgr', label:'병원 관리',         icon:'M9 12h6m-3 -3v6m-9 1V7a4 4 0 014-4h10a4 4 0 014 4v6a4 4 0 01-4 4H7l-4 4z' },
  ];

  return (
    <div style={{height:'100vh', display:'flex', flexDirection:'column', overflow:'hidden', background:'#f1f5f9'}}>
      {/* Header */}
      <AppHeader title="장비 및 거래처 관리" badge={`${equips.length}개 등록`} onLogoClick={onBack} user={user} onLogout={onLogout} nav={nav}/>

      {/* Tab bar */}
      <div className="bg-white border-b border-slate-200 px-6 flex items-center gap-0 shrink-0">
        {TABS.map(t => (
          <button key={t.id} onClick={()=>setActiveTab(t.id)}
            className={`flex items-center gap-1.5 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab===t.id?'border-blue-600 text-blue-700':'border-transparent text-slate-500 hover:text-slate-700'}`}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={t.icon}/></svg>
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══════════════ 장비 목록 탭 ═══════════════ */}
      {activeTab === 'list' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="bg-white border-b border-slate-200 px-6 py-3 flex flex-col gap-2 shrink-0">
            <div className="flex items-center gap-3">
              <div className="relative flex-1 max-w-xs">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0"/></svg>
                <input type="text" placeholder="품목명, 모델명, 제조사 검색..." value={search} onChange={e=>setSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"/>
                {search && <button onClick={()=>setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/></svg></button>}
              </div>
              <div className="flex flex-wrap gap-1">
                {[{id:'all',name:'전체'},...dynCats].map(c=>(
                  <button key={c.id} onClick={()=>{ setCatFilter(c.id); setItemFilter('all'); }}
                    className={`px-3 py-1 text-xs rounded-full font-medium transition-colors whitespace-nowrap ${catFilter===c.id?'bg-slate-900 text-white':'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                    {c.name}
                  </button>
                ))}
              </div>
              <span className="ml-auto text-xs text-slate-400 shrink-0">검색결과 {filtered.length}개</span>
            </div>
            {listItemOptions.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <button onClick={()=>setItemFilter('all')}
                  className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors whitespace-nowrap ${itemFilter==='all'?'bg-blue-600 text-white':'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                  전체
                </button>
                {listItemOptions.map(it=>(
                  <button key={it.id} onClick={()=>setItemFilter(it.name)}
                    className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors whitespace-nowrap ${itemFilter===it.name?'bg-blue-600 text-white':'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                    {it.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1 overflow-auto p-6">
            {loading ? (
              <div className="flex items-center justify-center h-40 text-slate-400 text-sm">
                <svg className="w-5 h-5 animate-spin mr-2 text-blue-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>로딩 중...
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-slate-400">
                <div className="text-3xl mb-2">📦</div>
                <div className="text-sm font-medium">등록된 장비가 없습니다</div>
                <div className="text-xs mt-1">장비 등록 탭에서 새 장비를 추가해주세요</div>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="px-3 py-2.5 text-center text-slate-500 font-semibold w-24">이미지</th>
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold w-28">카테고리</th>
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold">품목명</th>
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold w-32">모델명</th>
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold">제조사</th>
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold">거래처</th>
                      <th className="px-3 py-2.5 text-right text-slate-500 font-semibold w-28">매입가</th>
                      <th className="px-3 py-2.5 text-right text-slate-500 font-semibold w-28">단가</th>
                      <th className="px-3 py-2.5 text-right text-slate-500 font-semibold w-28">판매이익</th>
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold w-32">담당자</th>
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold">A/S</th>
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold">보증</th>
                      <th className="px-3 py-2.5 text-center text-slate-500 font-semibold w-36">작업</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(e => (
                      <tr key={e.id} className="border-b border-slate-100 hover:bg-blue-50/30 transition-colors group">
                        <td className="px-3 py-2.5 text-center">
                          {e.image ? <img src={e.image} alt={e.model.name} className="w-20 h-20 object-contain rounded-lg border border-slate-200 mx-auto shadow-sm bg-white"/> : (
                            <div className="w-20 h-20 rounded-lg border border-dashed border-slate-300 bg-slate-50 flex items-center justify-center mx-auto">
                              <svg className="w-6 h-6 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                            </div>)}
                        </td>
                        <td className="px-3 py-2.5"><span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full text-xs whitespace-nowrap">{e.catName}</span></td>
                        <td className="px-3 py-2.5 font-semibold text-slate-800">{e.itemName}</td>
                        <td className="px-3 py-2.5 text-slate-700">{e.model.name}</td>
                        <td className="px-3 py-2.5 text-slate-600">{e.model.manufacturer}</td>
                        <td className="px-3 py-2.5 text-slate-600">
                          {e.vendor ? <span>{e.vendor}</span> : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tnum font-medium text-slate-600">{e.purchasePrice!=null?e.purchasePrice.toLocaleString('ko-KR')+'원':<span className="text-slate-300 font-normal">—</span>}</td>
                        <td className="px-3 py-2.5 text-right tnum font-medium text-slate-800">{e.model.price!=null?e.model.price.toLocaleString('ko-KR')+'원':<span className="text-slate-400 font-normal">문의</span>}</td>
                        <td className="px-3 py-2.5 text-right tnum font-medium">
                          {e.purchasePrice!=null && e.model.price!=null
                            ? <span className={e.model.price-e.purchasePrice>=0?'text-emerald-600':'text-red-500'}>
                                {(e.model.price-e.purchasePrice).toLocaleString('ko-KR')}원
                              </span>
                            : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          {(() => {
                            const m = manufacturers.find(x => x.name === e.vendor);
                            const cn = m?.contact_name || '';
                            const cp = m?.contact_phone || '';
                            return (cn || cp)
                              ? <div className="flex flex-col gap-0.5">
                                  {cn && <span className="text-slate-700 font-medium">{cn}</span>}
                                  {cp && <span className="text-slate-500">{cp}</span>}
                                </div>
                              : <span className="text-slate-300">—</span>;
                          })()}
                        </td>
                        <td className="px-3 py-2.5 text-slate-500">{e.spec?.as||'—'}</td>
                        <td className="px-3 py-2.5 text-slate-500">{e.spec?.warranty||'—'}</td>
                        <td className="px-3 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button onClick={()=>openEdit(e)} className="px-2.5 py-1 text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 rounded font-medium transition-colors whitespace-nowrap">수정</button>
                            <button onClick={()=>setConfirmDel(e.id)} className="px-2.5 py-1 text-xs bg-red-50 text-red-600 hover:bg-red-100 rounded font-medium transition-colors whitespace-nowrap">삭제</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════════ 장비 등록 탭 ═══════════════ */}
      {activeTab === 'register' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-4xl mx-auto">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <div className="font-bold text-slate-900 text-base">새 장비 등록</div>
                  <div className="text-xs text-slate-400 mt-0.5">등록된 장비는 견적서 장비 추가 시 검색·선택할 수 있습니다</div>
                </div>
                {regSaved && <span className="px-3 py-1 bg-emerald-100 text-emerald-700 text-xs font-semibold rounded-full">✓ 저장 완료</span>}
              </div>
              <div className="p-6 flex flex-col gap-5">
                {/* Row 1: 카테고리 / 품목명 / 모델명 / 제조사 / 거래처 */}
                <div className="grid grid-cols-5 gap-4">
                  <div>
                    <label className={labelCls}>카테고리 <span className="text-red-400">*</span></label>
                    <select value={regForm.catId} onChange={e=>{setRF('catId',e.target.value);setRF('itemName','');}} className={inputCls}>
                      {dynCats.length===0 && <option value="">카테고리 없음</option>}
                      {dynCats.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>품목명 <span className="text-red-400">*</span></label>
                    <select value={regForm.itemName} onChange={e=>setRF('itemName',e.target.value)} className={inputCls}>
                      <option value="">품목 선택</option>
                      {regItemOptions.map(it=><option key={it.id} value={it.name}>{it.name}</option>)}
                    </select>
                    {regItemOptions.length===0 && <div className="text-xs text-amber-600 mt-1">카테고리·품목 관리 탭에서 품목을 먼저 등록하세요</div>}
                  </div>
                  <div>
                    <label className={labelCls}>모델명 <span className="text-red-400">*</span></label>
                    <input type="text" placeholder="예: Xvision HF 525R" value={regForm.modelName} onChange={e=>setRF('modelName',e.target.value)} className={inputCls}/>
                  </div>
                  <div>
                    <label className={labelCls}>제조사</label>
                    <input type="text" placeholder="예: Gemss healthcare" value={regForm.manufacturer} onChange={e=>setRF('manufacturer',e.target.value)} className={inputCls}/>
                  </div>
                  <div>
                    <label className={labelCls}>거래처 <span className="text-slate-400 font-normal">(매입처)</span></label>
                    <button type="button" onClick={()=>setRegPickerOpen(true)}
                      className={`${inputCls} text-left bg-white hover:bg-slate-50 truncate`}>
                      {regForm.vendorCode && <span className="font-mono text-blue-700 text-[10px] bg-blue-50 px-1 py-0.5 rounded mr-1.5">{regForm.vendorCode}</span>}
                      {regForm.vendor || <span className="text-slate-400">거래처 선택 (클릭)</span>}
                    </button>
                  </div>
                </div>
                {/* Row 2: 매입가 / 단가 / 판매이익 / 특이사항 */}
                <div className="grid grid-cols-4 gap-4">
                  <div>
                    <label className={labelCls}>매입가 (원)</label>
                    <input type="text" inputMode="numeric" placeholder="0" value={regForm.purchasePrice}
                      onChange={e=>setRF('purchasePrice',(parseInt(e.target.value.replace(/[^0-9]/g,''))||'').toLocaleString('ko-KR').replace('NaN',''))} className={inputCls}/>
                  </div>
                  <div>
                    <label className={labelCls}>단가 (원)</label>
                    <input type="text" inputMode="numeric" placeholder="0" value={regForm.price}
                      onChange={e=>setRF('price',(parseInt(e.target.value.replace(/[^0-9]/g,''))||'').toLocaleString('ko-KR').replace('NaN',''))} className={inputCls}/>
                  </div>
                  <div>
                    <label className={labelCls}>판매이익 (자동계산)</label>
                    {(() => {
                      const pp = parseInt((regForm.purchasePrice||'').replace(/[^0-9]/g,''))||null;
                      const sp = parseInt((regForm.price||'').replace(/[^0-9]/g,''))||null;
                      const profit = pp!=null && sp!=null ? sp - pp : null;
                      return <div className={`px-2.5 py-1.5 text-xs border rounded-md ${profit==null?'text-slate-300 border-slate-100 bg-slate-50':profit>=0?'text-emerald-600 border-emerald-100 bg-emerald-50 font-semibold':'text-red-500 border-red-100 bg-red-50 font-semibold'}`}>
                        {profit!=null ? profit.toLocaleString('ko-KR')+'원' : '—'}
                      </div>;
                    })()}
                  </div>
                  <div>
                    <label className={labelCls}>기타 특이사항</label>
                    <input type="text" placeholder="예: 콘덴서 포함" value={regForm.notes} onChange={e=>setRF('notes',e.target.value)} className={inputCls}/>
                  </div>
                </div>
                {/* 담당자 안내 — 거래처 마스터로 통일 */}
                <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-600">
                  💡 담당자·연락처는 <span className="font-semibold">거래처 관리</span>에서 한 번 입력하면 모든 장비/발주 화면에서 자동으로 표시됩니다.
                </div>
                {/* 대체 모델 */}
                {(() => {
                  const selectedIds = new Set(regForm.altModels.map(m=>m.equipId));
                  const regAltFiltered = equips.filter(e => {
                    if (selectedIds.has(e.id)) return false;
                    const q = regAltSearch.toLowerCase();
                    return !q || e.itemName.toLowerCase().includes(q) || e.model.name.toLowerCase().includes(q) || e.model.manufacturer.toLowerCase().includes(q);
                  });
                  return (
                    <div>
                      <label className={labelCls}>대체 모델 <span className="text-slate-400 font-normal">(견적서에서 선택 가능)</span></label>
                      <div className="relative">
                        <input type="text" placeholder="장비명 또는 모델명 검색..." value={regAltSearch}
                          onChange={e=>{setRegAltSearch(e.target.value);setRegAltOpen(true);}}
                          onFocus={()=>setRegAltOpen(true)}
                          onBlur={()=>setTimeout(()=>setRegAltOpen(false),150)}
                          className={inputCls}/>
                        {regAltOpen && regAltSearch && (
                          <div className="absolute z-20 w-full bg-white border border-slate-200 rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto">
                            {regAltFiltered.length === 0
                              ? <div className="px-3 py-2 text-xs text-slate-400">검색 결과 없음</div>
                              : regAltFiltered.map(e=>(
                                  <button key={e.id} type="button"
                                    onMouseDown={()=>{
                                      setRF('altModels',[...regForm.altModels,{equipId:e.id,itemName:e.itemName,name:e.model.name,manufacturer:e.model.manufacturer,price:e.model.price,notes:e.model.notes||''}]);
                                      setRegAltSearch(''); setRegAltOpen(false);
                                    }}
                                    className="w-full text-left px-3 py-2 text-xs hover:bg-blue-50 flex items-center justify-between gap-2">
                                    <span><span className="font-medium text-slate-800">{e.itemName}</span> <span className="text-slate-500">— {e.model.name}</span></span>
                                    <span className="text-slate-400 shrink-0">{e.model.manufacturer}</span>
                                  </button>
                                ))
                            }
                          </div>
                        )}
                      </div>
                      {regForm.altModels.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          {regForm.altModels.map((am,i)=>(
                            <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-800">
                              <span className="font-medium">{am.itemName}</span>
                              <span className="text-blue-500">—</span>
                              <span>{am.name}</span>
                              <button type="button" onClick={()=>setRF('altModels',regForm.altModels.filter((_,idx)=>idx!==i))} className="text-blue-400 hover:text-red-500 ml-0.5">
                                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/></svg>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
                {/* 이미지 + 제품소개 */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>제품 이미지</label>
                    <div className="border-2 border-dashed border-slate-300 rounded-lg p-4 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-blue-400 transition-colors bg-slate-50"
                      onClick={()=>regImgRef.current?.click()}>
                      {regForm.image ? (
                        <div className="relative w-full">
                          <img src={regForm.image} alt="preview" className="w-full h-32 object-contain rounded"/>
                          <button onClick={e=>{e.stopPropagation();setRF('image',null);}} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center hover:bg-red-400">×</button>
                        </div>
                      ) : (<>
                        <svg className="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                        <span className="text-xs text-slate-400">클릭하여 이미지 업로드</span>
                        <span className="text-xs text-slate-300">JPG, PNG, WEBP</span>
                      </>)}
                    </div>
                    <input ref={regImgRef} type="file" accept="image/*" className="hidden" onChange={handleRegImage}/>
                  </div>
                  <div>
                    <label className={labelCls}>제품소개</label>
                    <textarea placeholder="제품에 대한 간단한 소개..." value={regForm.desc} onChange={e=>setRF('desc',e.target.value)}
                      className={`${inputCls} h-[calc(100%-1.5rem)] resize-none`} rows={5}/>
                  </div>
                </div>
                {/* 주요사양 */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className={labelCls + ' mb-0'}>주요 사양</label>
                    <button onClick={addRegSpec} className="text-xs text-blue-600 hover:text-blue-800 font-medium">+ 항목 추가</button>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {regForm.specs.map((s,i)=>(
                      <div key={i} className="flex items-center gap-2">
                        <input type="text" placeholder="항목명 (예: 해상도)" value={s.l} onChange={e=>setRegSpec(i,'l',e.target.value)} className={`${inputCls} w-36`}/>
                        <input type="text" placeholder="값 (예: 43lp/mm)" value={s.v} onChange={e=>setRegSpec(i,'v',e.target.value)} className={inputCls}/>
                        {regForm.specs.length>1 && <button onClick={()=>removeRegSpec(i)} className="text-slate-400 hover:text-red-500"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg></button>}
                      </div>
                    ))}
                  </div>
                </div>
                {/* 인증/보증/홈페이지 */}
                <div className="grid grid-cols-5 gap-4">
                  <div><label className={labelCls}>제조국가</label><input type="text" value={regForm.origin} onChange={e=>setRF('origin',e.target.value)} className={inputCls}/></div>
                  <div><label className={labelCls}>인증</label><input type="text" placeholder="예: 의료기기 2등급" value={regForm.cert} onChange={e=>setRF('cert',e.target.value)} className={inputCls}/></div>
                  <div><label className={labelCls}>A/S 기간</label><input type="text" placeholder="예: 2년" value={regForm.as} onChange={e=>setRF('as',e.target.value)} className={inputCls}/></div>
                  <div><label className={labelCls}>검사주기</label><input type="text" placeholder="예: 1년" value={regForm.warranty} onChange={e=>setRF('warranty',e.target.value)} className={inputCls}/></div>
                  <div><label className={labelCls}>홈페이지</label><input type="text" placeholder="예: https://gemss.co.kr" value={regForm.homepage} onChange={e=>setRF('homepage',e.target.value)} className={inputCls}/></div>
                </div>
                <div className="flex justify-end pt-2 border-t border-slate-100">
                  <button onClick={handleRegSubmit} disabled={regSaving||!regForm.itemName||!regForm.modelName.trim()}
                    className="px-6 py-2 text-sm font-semibold rounded-lg bg-slate-900 hover:bg-slate-700 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                    {regSaving ? '저장 중...' : '장비 등록'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════ 카테고리·품목 관리 탭 ═══════════════ */}
      {activeTab === 'catmgr' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl mx-auto flex flex-col gap-5">
            {/* 새 카테고리 추가 */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <div className="font-bold text-slate-800 text-sm mb-4">새 카테고리 추가</div>
              <div className="flex items-center gap-3">
                <input type="text" placeholder="예: 안과 장비" value={newCatName} onChange={e=>setNewCatName(e.target.value)}
                  className={inputCls + ' flex-1'} onKeyDown={e=>e.key==='Enter'&&handleAddCat()}/>
                <button onClick={handleAddCat} disabled={catSaving||!newCatName.trim()}
                  className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 hover:bg-slate-700 text-white transition-colors disabled:opacity-40 shrink-0">
                  {catSaving ? '추가 중...' : '+ 추가'}
                </button>
              </div>
            </div>

            {/* 카테고리 목록 */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 font-bold text-slate-800 text-sm">카테고리 목록 ({dynCats.length})</div>
              {dynCats.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-sm">카테고리가 없습니다</div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {dynCats.map(cat => {
                    const catItemList = dynItems.filter(it=>it.catId===cat.id);
                    const catEquipCount = customEquips.filter(e => e.catId === cat.id).length;
                    const isExpanded = expandedCat === cat.id;
                    return (
                      <div key={cat.id}>
                        {/* Category row */}
                        <div className="px-5 py-3 flex items-center gap-3">
                          <span className="font-semibold text-slate-800 text-sm flex-1">{cat.name}</span>
                          <span className="text-xs text-slate-400">{catItemList.length}개 품목</span>
                          <span className="text-xs text-slate-400">·</span>
                          <span className="text-xs text-slate-500">장비 <span className="font-semibold text-slate-700">{catEquipCount}</span>대</span>
                          <button onClick={()=>setExpandedCat(isExpanded?null:cat.id)}
                            className="px-3 py-1 text-xs rounded-md bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors">
                            {isExpanded ? '닫기' : '품목 관리'}
                          </button>
                          <button onClick={()=>setConfirmDelCat(cat)}
                            className="px-3 py-1 text-xs rounded-md bg-red-50 text-red-600 hover:bg-red-100 transition-colors">
                            삭제
                          </button>
                        </div>
                        {/* Expanded items */}
                        {isExpanded && (
                          <div className="bg-slate-50 border-t border-slate-100 px-5 py-4">
                            {/* Item list */}
                            {catItemList.length === 0 ? (
                              <div className="text-xs text-slate-400 mb-3">등록된 품목이 없습니다</div>
                            ) : (
                              <div className="flex flex-wrap gap-2 mb-3">
                                {catItemList.map(it=>{
                                  const itEquipCount = customEquips.filter(e => e.itemName === it.name && e.catId === cat.id).length;
                                  return (
                                    <div key={it.id} className="flex items-center gap-1.5 px-2.5 py-1 bg-white border border-slate-200 rounded-full text-xs text-slate-700 shadow-sm">
                                      <span>{it.name}</span>
                                      <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${itEquipCount > 0 ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-400'}`}>{itEquipCount}</span>
                                      <button onClick={()=>setConfirmDelItem(it)} className="text-slate-300 hover:text-red-500 transition-colors">
                                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/></svg>
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            {/* Add new item */}
                            <div className="flex items-center gap-2">
                              <input type="text" placeholder="새 품목명 입력 (예: X-Ray (DR System))" value={newItemName}
                                onChange={e=>setNewItemName(e.target.value)}
                                onKeyDown={e=>e.key==='Enter'&&handleAddItem(cat.id)}
                                className="flex-1 px-2.5 py-1.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 bg-white"/>
                              <button onClick={()=>handleAddItem(cat.id)} disabled={itemSaving||!newItemName.trim()}
                                className="px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-40">
                                {itemSaving ? '...' : '+ 추가'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════ 매입가 현황 탭 ═══════════════ */}
      {activeTab === 'purchaseprice' && (
        <EquipmentPurchasePriceTab equips={equips} />
      )}

      {/* ═══════════════ 거래처 관리 탭 ═══════════════ */}
      {activeTab === 'mfrmgr' && (
        <ManufacturerManageTab
          manufacturers={manufacturers}
          setManufacturers={setManufacturers}
          equips={equips}
          onEquipChange={onEquipChange}
        />
      )}

      {/* ═══════════════ 병원 관리 탭 ═══════════════ */}
      {activeTab === 'hospmgr' && (
        <HospitalManageTab />
      )}

      {/* Delete equip confirm */}
      {showPriceHistory && (
        <PriceHistoryModal
          equipment={showPriceHistory}
          onClose={() => setShowPriceHistory(null)}
        />
      )}

      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={()=>setConfirmDel(null)}/>
          <div className="relative bg-white rounded-xl p-6 shadow-2xl w-80 animate-fs text-center">
            <div className="text-3xl mb-3">🗑️</div>
            <div className="font-bold text-slate-800 mb-1">장비를 삭제할까요?</div>
            <div className="text-xs text-slate-500 mb-5">삭제 후 복구가 불가능합니다.</div>
            <div className="flex gap-2">
              <button onClick={()=>setConfirmDel(null)} className="flex-1 py-2 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">취소</button>
              <button onClick={()=>handleDelete(confirmDel)} className="flex-1 py-2 text-xs rounded-lg bg-red-600 text-white hover:bg-red-700 font-semibold">삭제</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete category confirm */}
      {regPickerOpen && (
        <VendorPickerModal
          allowedKinds="vendor"
          defaultFilter="vendor"
          onClose={()=>setRegPickerOpen(false)}
          onSelect={(it)=>setRegForm(p=>({...p, vendor: it.name, vendorId: it.id, vendorCode: it.code || ''}))}
        />
      )}
      {editPickerOpen && (
        <VendorPickerModal
          allowedKinds="vendor"
          defaultFilter="vendor"
          onClose={()=>setEditPickerOpen(false)}
          onSelect={(it)=>setEditForm(p=>({...p, vendor: it.name, vendorId: it.id, vendorCode: it.code || ''}))}
        />
      )}

      {confirmDelCat && (() => {
        const itemCount = dynItems.filter(it => it.catId === confirmDelCat.id).length;
        const equipCount = customEquips.filter(e => e.catId === confirmDelCat.id).length;
        const hasEquip = equipCount > 0;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40" onClick={()=>setConfirmDelCat(null)}/>
            <div className="relative bg-white rounded-xl p-6 shadow-2xl w-96 animate-fs text-center">
              <div className="text-3xl mb-3">{hasEquip ? '⚠️' : '🗑️'}</div>
              <div className="font-bold text-slate-800 mb-2">카테고리를 삭제할까요?</div>
              <div className="text-sm text-slate-700 mb-3">「<span className="font-semibold">{confirmDelCat.name}</span>」</div>
              <div className="bg-slate-50 rounded-lg px-3 py-2.5 mb-3 text-xs text-slate-600 space-y-1">
                <div>소속 품목: <span className="font-semibold text-slate-800">{itemCount}개</span> (함께 삭제됨)</div>
                <div>연결된 장비: <span className={`font-semibold ${hasEquip ? 'text-rose-600' : 'text-slate-800'}`}>{equipCount}개</span></div>
              </div>
              {hasEquip && (
                <div className="text-xs text-rose-600 bg-rose-50 rounded-lg px-3 py-2 mb-4 text-left">
                  ⚠️ 장비는 DB에 그대로 남지만, 견적 화면의 카테고리 트리에서 <b>분류되지 않아 안 보이게</b> 됩니다.
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={()=>setConfirmDelCat(null)} className="flex-1 py-2 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">취소</button>
                <button onClick={()=>handleDeleteCat(confirmDelCat)} className="flex-1 py-2 text-xs rounded-lg bg-red-600 text-white hover:bg-red-700 font-semibold">삭제</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Delete item confirm */}
      {confirmDelItem && (() => {
        const equipCount = customEquips.filter(e => e.itemName === confirmDelItem.name && e.catId === confirmDelItem.catId).length;
        const hasEquip = equipCount > 0;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40" onClick={()=>setConfirmDelItem(null)}/>
            <div className="relative bg-white rounded-xl p-6 shadow-2xl w-96 animate-fs text-center">
              <div className="text-3xl mb-3">{hasEquip ? '⚠️' : '🗑️'}</div>
              <div className="font-bold text-slate-800 mb-2">품목을 삭제할까요?</div>
              <div className="text-sm text-slate-700 mb-3">「<span className="font-semibold">{confirmDelItem.name}</span>」</div>
              <div className="bg-slate-50 rounded-lg px-3 py-2.5 mb-3 text-xs text-slate-600">
                연결된 장비: <span className={`font-semibold ${hasEquip ? 'text-rose-600' : 'text-slate-800'}`}>{equipCount}개</span>
              </div>
              {hasEquip && (
                <div className="text-xs text-rose-600 bg-rose-50 rounded-lg px-3 py-2 mb-4 text-left">
                  ⚠️ 장비는 DB에 그대로 남지만, 견적 화면의 품목 그룹에서 <b>분류되지 않아 안 보이게</b> 됩니다.
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={()=>setConfirmDelItem(null)} className="flex-1 py-2 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">취소</button>
                <button onClick={()=>handleDeleteItem(confirmDelItem.id)} className="flex-1 py-2 text-xs rounded-lg bg-red-600 text-white hover:bg-red-700 font-semibold">삭제</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Edit Modal */}
      {editTarget && editForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={closeEdit}/>
          <div className="relative bg-white rounded-xl shadow-2xl animate-fs flex flex-col" style={{width:'780px', maxHeight:'92vh'}}>
            <div className="bg-slate-900 text-white px-5 py-3.5 rounded-t-xl flex items-center justify-between shrink-0">
              <div>
                <div className="font-bold text-sm">장비 정보 수정</div>
                <div className="text-xs text-slate-400 mt-0.5">{editTarget.itemName} · {editTarget.model.name}</div>
              </div>
              <button onClick={closeEdit} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-white hover:bg-slate-700 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-5">
              <div className="grid grid-cols-2 gap-5">
                <div className="space-y-3">
                  <div>
                    <label className={labelCls}>카테고리</label>
                    <select value={editForm.catId} onChange={e=>setEF('catId',e.target.value)} className={inputCls}>
                      {dynCats.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>품목명 <span className="text-red-500">*</span></label>
                      <select value={editForm.itemName} onChange={e=>setEF('itemName',e.target.value)} className={inputCls}>
                        <option value={editForm.itemName}>{editForm.itemName}</option>
                        {dynItems.filter(it=>it.catId===editForm.catId&&it.name!==editForm.itemName).map(it=><option key={it.id} value={it.name}>{it.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>모델명 <span className="text-red-500">*</span></label>
                      <input type="text" value={editForm.modelName} onChange={e=>setEF('modelName',e.target.value)} className={inputCls}/>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div><label className={labelCls}>제조사</label><input type="text" value={editForm.manufacturer} onChange={e=>setEF('manufacturer',e.target.value)} className={inputCls}/></div>
                    <div><label className={labelCls}>거래처 <span className="text-slate-400 font-normal">(매입처)</span></label>
                      <button type="button" onClick={()=>setEditPickerOpen(true)}
                        className={`${inputCls} text-left bg-white hover:bg-slate-50 truncate`}>
                        {editForm.vendorCode && <span className="font-mono text-blue-700 text-[10px] bg-blue-50 px-1 py-0.5 rounded mr-1.5">{editForm.vendorCode}</span>}
                        {editForm.vendor || <span className="text-slate-400">거래처 선택 (클릭)</span>}
                      </button>
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className={labelCls.replace(/mb-1$/,'')}>매입가</label>
                        {editTarget?.id && (
                          <button type="button" onClick={() => setShowPriceHistory(editTarget)}
                            className="text-[10px] text-blue-600 hover:text-blue-700 font-semibold">이력</button>
                        )}
                      </div>
                      <input type="text" value={editForm.purchasePrice||''} onChange={e=>setEF('purchasePrice',e.target.value.replace(/[^0-9]/g,'').replace(/\B(?=(\d{3})+(?!\d))/g,','))} className={inputCls} placeholder="숫자 입력"/>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className={labelCls}>단가</label><input type="text" value={editForm.price} onChange={e=>setEF('price',e.target.value.replace(/[^0-9]/g,'').replace(/\B(?=(\d{3})+(?!\d))/g,','))} className={inputCls} placeholder="숫자 입력 (문의는 빈칸)"/></div>
                    <div><label className={labelCls}>판매이익 (자동계산)</label>
                      {(() => {
                        const pp = parseInt((editForm.purchasePrice||'').replace(/[^0-9]/g,''))||null;
                        const sp = parseInt((editForm.price||'').replace(/[^0-9]/g,''))||null;
                        const profit = pp!=null && sp!=null ? sp - pp : null;
                        return <div className={`px-2.5 py-1.5 text-xs border rounded-md ${profit==null?'text-slate-300 border-slate-100 bg-slate-50':profit>=0?'text-emerald-600 border-emerald-100 bg-emerald-50 font-semibold':'text-red-500 border-red-100 bg-red-50 font-semibold'}`}>
                          {profit!=null ? profit.toLocaleString('ko-KR')+'원' : '—'}
                        </div>;
                      })()}
                    </div>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-600">
                    💡 담당자·연락처는 <span className="font-semibold">거래처 관리</span>에서 한 번 입력하면 모든 장비/발주 화면에서 자동으로 표시됩니다.
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className={labelCls}>제조국가</label><input type="text" value={editForm.origin} onChange={e=>setEF('origin',e.target.value)} className={inputCls}/></div>
                    <div><label className={labelCls}>인증</label><input type="text" value={editForm.cert} onChange={e=>setEF('cert',e.target.value)} className={inputCls}/></div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className={labelCls}>A/S 기간</label><input type="text" value={editForm.as} onChange={e=>setEF('as',e.target.value)} className={inputCls}/></div>
                    <div><label className={labelCls}>검사주기</label><input type="text" value={editForm.warranty} onChange={e=>setEF('warranty',e.target.value)} className={inputCls}/></div>
                  </div>
                  <div><label className={labelCls}>홈페이지</label><input type="text" placeholder="https://..." value={editForm.homepage||''} onChange={e=>setEF('homepage',e.target.value)} className={inputCls}/></div>
                  <div><label className={labelCls}>기타 특이사항</label><input type="text" value={editForm.notes} onChange={e=>setEF('notes',e.target.value)} className={inputCls}/></div>
                  {/* 대체 모델 */}
                  {(() => {
                    const selIds = new Set((editForm.altModels||[]).map(m=>m.equipId));
                    const editAltFiltered = equips.filter(e => {
                      if (e.id === editTarget?.id) return false;
                      if (selIds.has(e.id)) return false;
                      const q = editAltSearch.toLowerCase();
                      return !q || e.itemName.toLowerCase().includes(q) || e.model.name.toLowerCase().includes(q) || e.model.manufacturer.toLowerCase().includes(q);
                    });
                    return (
                      <div>
                        <label className={labelCls}>대체 모델</label>
                        <div className="relative">
                          <input type="text" placeholder="장비명 또는 모델명 검색..." value={editAltSearch}
                            onChange={e=>{setEditAltSearch(e.target.value);setEditAltOpen(true);}}
                            onFocus={()=>setEditAltOpen(true)}
                            onBlur={()=>setTimeout(()=>setEditAltOpen(false),150)}
                            className={inputCls}/>
                          {editAltOpen && editAltSearch && (
                            <div className="absolute z-20 w-full bg-white border border-slate-200 rounded-lg shadow-lg mt-1 max-h-40 overflow-y-auto">
                              {editAltFiltered.length === 0
                                ? <div className="px-3 py-2 text-xs text-slate-400">검색 결과 없음</div>
                                : editAltFiltered.map(e=>(
                                    <button key={e.id} type="button"
                                      onMouseDown={()=>{
                                        setEF('altModels',[...(editForm.altModels||[]),{equipId:e.id,itemName:e.itemName,name:e.model.name,manufacturer:e.model.manufacturer,price:e.model.price,notes:e.model.notes||''}]);
                                        setEditAltSearch(''); setEditAltOpen(false);
                                      }}
                                      className="w-full text-left px-3 py-2 text-xs hover:bg-blue-50 flex items-center justify-between gap-2">
                                      <span><span className="font-medium text-slate-800">{e.itemName}</span> <span className="text-slate-500">— {e.model.name}</span></span>
                                      <span className="text-slate-400 shrink-0">{e.model.manufacturer}</span>
                                    </button>
                                  ))
                              }
                            </div>
                          )}
                        </div>
                        {(editForm.altModels||[]).length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {(editForm.altModels||[]).map((am,i)=>(
                              <div key={i} className="flex items-center gap-1.5 px-2 py-1 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-800">
                                <span className="font-medium">{am.itemName}</span>
                                <span className="text-blue-400">—</span>
                                <span>{am.name}</span>
                                <button type="button" onClick={()=>setEF('altModels',(editForm.altModels||[]).filter((_,idx)=>idx!==i))} className="text-blue-400 hover:text-red-500 ml-0.5">
                                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/></svg>
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  <div>
                    <label className={labelCls}>이미지</label>
                    <div className="border-2 border-dashed border-slate-300 rounded-lg p-3 flex flex-col items-center justify-center cursor-pointer hover:border-blue-400 bg-slate-50"
                      onClick={()=>editImgRef.current?.click()}>
                      {editForm.image ? (
                        <div className="relative w-full">
                          <img src={editForm.image} alt="preview" className="w-full h-28 object-contain rounded"/>
                          <button onClick={e=>{e.stopPropagation();setEF('image',null);}} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center">×</button>
                        </div>
                      ) : <span className="text-xs text-slate-400">클릭하여 이미지 교체</span>}
                    </div>
                    <input ref={editImgRef} type="file" accept="image/*" className="hidden" onChange={handleEditImage}/>
                  </div>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className={labelCls}>제품소개</label>
                    <textarea value={editForm.desc} onChange={e=>setEF('desc',e.target.value)} className={`${inputCls} resize-none`} rows={4}/>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className={labelCls + ' mb-0'}>주요 사양</label>
                      <button onClick={addEditSpec} className="text-xs text-blue-600 hover:text-blue-800 font-medium">+ 추가</button>
                    </div>
                    <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
                      {editForm.specs.map((s,i)=>(
                        <div key={i} className="flex items-center gap-2">
                          <input type="text" placeholder="항목명" value={s.l} onChange={e=>setEditSpec(i,'l',e.target.value)} className={`${inputCls} w-28`}/>
                          <input type="text" placeholder="값" value={s.v} onChange={e=>setEditSpec(i,'v',e.target.value)} className={inputCls}/>
                          {editForm.specs.length>1 && <button onClick={()=>removeEditSpec(i)} className="text-slate-400 hover:text-red-500"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg></button>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="px-5 py-3.5 border-t border-slate-100 flex justify-end gap-2 shrink-0">
              <button onClick={closeEdit} className="px-4 py-2 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">취소</button>
              <button onClick={handleSave} disabled={saving}
                className="px-5 py-2 text-xs rounded-lg bg-slate-900 hover:bg-slate-700 text-white font-semibold transition-colors disabled:opacity-40">
                {saving ? '저장 중...' : '수정 저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   LEADS DASHBOARD
   ============================================================ */
function LeadsDashboard({ leads, loading }) {
  const [period, setPeriod] = React.useState('all');
  const [deptSort, setDeptSort] = React.useState('문의');
  const RC = window.Recharts || {};
  const { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
          LineChart, Line, PieChart, Pie, Cell, ResponsiveContainer } = RC;

  const now = new Date();

  const fl = React.useMemo(() => {
    if (period === 'month') {
      return leads.filter(l => {
        const d = new Date(l.created_at);
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      });
    }
    if (period === 'week') {
      const ago = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return leads.filter(l => new Date(l.created_at) >= ago);
    }
    return leads;
  }, [leads, period]);

  // 계약완료 이후 단계들도 "계약 성사"로 간주 (계약완료/발주진행중/납품완료)
  const isContracted = (stage) => stage === '계약완료' || stage === '발주진행중' || stage === '납품완료';

  const KPI_META = [
    { stage:'신규문의',   bg:'bg-slate-50',   border:'border-slate-200',   txt:'text-slate-600',   num:'text-slate-900'   },
    { stage:'견적발송',   bg:'bg-violet-50',  border:'border-violet-200',  txt:'text-violet-600',  num:'text-violet-900'  },
    { stage:'상담중',     bg:'bg-blue-50',    border:'border-blue-200',    txt:'text-blue-600',    num:'text-blue-900'    },
    { stage:'계약완료',   bg:'bg-emerald-50', border:'border-emerald-200', txt:'text-emerald-600', num:'text-emerald-900' },
    { stage:'발주진행중', bg:'bg-amber-50',   border:'border-amber-200',   txt:'text-amber-600',   num:'text-amber-900'   },
    { stage:'납품완료',   bg:'bg-teal-50',    border:'border-teal-200',    txt:'text-teal-600',    num:'text-teal-900'    },
    { stage:'타사계약',   bg:'bg-red-50',     border:'border-red-200',     txt:'text-red-500',     num:'text-red-800'     },
  ];

  const stageCounts = React.useMemo(() =>
    Object.fromEntries(KPI_META.map(m => [m.stage, fl.filter(l => l.stage === m.stage).length]))
  , [fl]);

  const convRate = React.useMemo(() => {
    const done = fl.filter(l => isContracted(l.stage)).length;
    return fl.length > 0 ? Math.round(done / fl.length * 100) : 0;
  }, [fl]);

  const sourceData = React.useMemo(() => {
    const map = {};
    fl.forEach(l => {
      const src = l.source || '직접입력';
      if (!map[src]) map[src] = { source: src, 문의: 0, 계약: 0 };
      map[src].문의++;
      if (isContracted(l.stage)) map[src].계약++;
    });
    return Object.values(map)
      .map(r => ({ ...r, 전환율: r.문의 > 0 ? Math.round(r.계약 / r.문의 * 100) : 0 }))
      .sort((a, b) => b.문의 - a.문의);
  }, [fl]);

  const deptData = React.useMemo(() => {
    const map = {};
    fl.forEach(l => {
      const dept = l.dept || '미입력';
      if (!map[dept]) map[dept] = { name: dept, 문의: 0, 계약: 0 };
      map[dept].문의++;
      if (isContracted(l.stage)) map[dept].계약++;
    });
    const arr = Object.values(map);
    return (deptSort === '문의' ? arr.sort((a,b)=>b.문의-a.문의) : arr.sort((a,b)=>b.계약-a.계약)).slice(0,8);
  }, [fl, deptSort]);

  const monthlyData = React.useMemo(() => {
    const result = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = d.getFullYear(), m = d.getMonth();
      const ml = leads.filter(l => { const ld = new Date(l.created_at); return ld.getFullYear()===y && ld.getMonth()===m; });
      result.push({ month: `${String(m+1).padStart(2,'0')}월`, 문의: ml.length, 계약: ml.filter(l => isContracted(l.stage)).length });
    }
    return result;
  }, [leads]);

  const assigneeData = React.useMemo(() => {
    const map = {};
    fl.forEach(l => {
      const name = l.assignee || '미배정';
      if (!map[name]) map[name] = { assignee: name, 상담중: 0, 계약완료: 0, total: 0 };
      map[name].total++;
      if (l.stage === '상담중') map[name].상담중++;
      if (isContracted(l.stage)) map[name].계약완료++;
    });
    return Object.values(map)
      .map(r => ({ ...r, 전환율: r.total > 0 ? Math.round(r.계약완료 / r.total * 100) : 0 }))
      .sort((a,b) => b.전환율 - a.전환율);
  }, [fl]);

  const DONUT_COLORS = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4','#ec4899','#84cc16'];

  const periodLabel = React.useMemo(() => {
    const DAY = ['일','월','화','수','목','금','토'];
    if (period === 'all') return '전체 기간';
    if (period === 'month') {
      const y = now.getFullYear(), m = now.getMonth();
      const last = new Date(y, m + 1, 0).getDate();
      return `${y}년 ${m+1}월 (${pad(m+1)}.01 ~ ${pad(m+1)}.${pad(last)})`;
    }
    if (period === 'week') {
      const day = now.getDay();
      const mon = new Date(now); mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      const fmtFull = d => `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}`;
      const fmtShort = d => `${pad(d.getMonth()+1)}.${pad(d.getDate())}`;
      return `${fmtFull(mon)} (${DAY[mon.getDay()]}) ~ ${fmtShort(sun)} (${DAY[sun.getDay()]})`;
    }
  }, [period]);

  const FilterBadge = () => (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-500 text-xs rounded-full font-medium border border-blue-100">
      📅 기간 필터 적용
    </span>
  );

  const Card = ({ title, filtered = false, children }) => (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="text-xs font-bold text-slate-400 uppercase tracking-widest">{title}</div>
        {filtered && <FilterBadge />}
      </div>
      {children}
    </div>
  );

  const Empty = () => (
    <div className="flex items-center justify-center h-28 text-slate-300 text-sm">데이터가 없습니다</div>
  );

  const Skeleton = () => (
    <div className="space-y-5 animate-pulse">
      <div className="grid grid-cols-5 gap-3">
        {[...Array(5)].map((_,i) => <div key={i} className="h-20 bg-slate-100 rounded-xl"/>)}
      </div>
      <div className="h-10 bg-slate-100 rounded-xl"/>
      <div className="grid grid-cols-2 gap-5">
        <div className="h-52 bg-slate-100 rounded-xl"/>
        <div className="h-52 bg-slate-100 rounded-xl"/>
      </div>
      <div className="h-52 bg-slate-100 rounded-xl"/>
      <div className="h-36 bg-slate-100 rounded-xl"/>
    </div>
  );

  if (loading) return <Skeleton />;
  if (!ResponsiveContainer) return <div className="text-slate-400 text-sm text-center p-12">차트 라이브러리를 불러오는 중...</div>;

  return (
    <div className="space-y-5">
      {/* 기간 표시 + 탭 */}
      <div>
        <div className="text-xl font-bold text-slate-800 mb-3">{periodLabel}</div>
        <div className="flex items-center gap-2">
          {[{k:'all',l:'전체'},{k:'month',l:'이번달'},{k:'week',l:'이번주'}].map(p => (
            <button key={p.k} onClick={() => setPeriod(p.k)}
              className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-colors ${period===p.k ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}>
              {p.l}
            </button>
          ))}
          <span className="ml-2 text-xs text-slate-400">총 {fl.length}건</span>
        </div>
      </div>

      {/* KPI 카드 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">KPI</span>
          <FilterBadge />
        </div>
        <div className="grid grid-cols-7 gap-2">
          {KPI_META.map(m => (
            <div key={m.stage} className={`${m.bg} border ${m.border} rounded-xl p-3`}>
              <div className={`text-xs font-semibold ${m.txt} mb-1.5`}>{m.stage}</div>
              <div className={`text-2xl font-bold ${m.num} tnum`}>{stageCounts[m.stage] || 0}</div>
            </div>
          ))}
        </div>
        {/* 전환율 바 */}
        <div className="mt-3 bg-white border border-slate-200 rounded-xl px-5 py-3 flex items-center gap-4">
          <span className="text-xs font-semibold text-slate-500 whitespace-nowrap">전환율 (문의 → 계약)</span>
          <div className="flex-1 bg-slate-100 rounded-full h-2">
            <div className="bg-emerald-500 h-2 rounded-full transition-all duration-500" style={{width:`${convRate}%`}}/>
          </div>
          <span className="text-sm font-bold text-emerald-600 whitespace-nowrap">{convRate}%</span>
          <span className="text-xs text-slate-400">({fl.filter(l => isContracted(l.stage)).length} / {fl.length}건)</span>
        </div>
      </div>

      {/* 유입경로 가로 바차트 */}
      <Card title="유입경로별 문의 vs 계약" filtered={true}>
        {sourceData.length === 0 ? <Empty /> : (
          <div>
            <ResponsiveContainer width="100%" height={Math.max(sourceData.length * 52, 120)}>
              <BarChart layout="vertical" data={sourceData} margin={{top:0,right:50,left:0,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9"/>
                <XAxis type="number" tick={{fontSize:10}} axisLine={false} tickLine={false}/>
                <YAxis type="category" dataKey="source" tick={{fontSize:10}} width={110} axisLine={false} tickLine={false}/>
                <Tooltip
                  contentStyle={{fontSize:'11px', borderRadius:'8px', border:'1px solid #e2e8f0'}}
                  formatter={(v,n) => [v+'건', n]}/>
                <Legend iconSize={8} wrapperStyle={{fontSize:'11px', paddingTop:'8px'}}/>
                <Bar dataKey="문의" fill="#3b82f6" radius={[0,3,3,0]} barSize={12} name="문의"/>
                <Bar dataKey="계약" fill="#10b981" radius={[0,3,3,0]} barSize={12} name="계약"/>
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-3 border-t border-slate-100 pt-3 space-y-1.5">
              {sourceData.map(r => (
                <div key={r.source} className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 truncate max-w-[160px]">{r.source}</span>
                  <span className={`font-bold ml-2 ${r.전환율>=50?'text-emerald-600':r.전환율>0?'text-amber-500':'text-slate-300'}`}>{r.전환율}% 전환</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* 진료과별 도넛 */}
      <Card title="진료과별 분포" filtered={true}>
        <div className="flex items-center gap-2 mb-4">
          {['문의 많은 순','계약 많은 순'].map(opt => {
            const active = opt === '문의 많은 순' ? deptSort==='문의' : deptSort==='계약';
            return (
              <button key={opt} onClick={() => setDeptSort(opt==='문의 많은 순'?'문의':'계약')}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${active ? 'bg-slate-900 text-white' : 'text-slate-400 hover:bg-slate-100'}`}>
                {opt}
              </button>
            );
          })}
        </div>
        {deptData.length === 0 ? <Empty /> : (
          <div className="flex items-start gap-3">
            <ResponsiveContainer width="45%" height={190}>
              <PieChart>
                <Pie data={deptData} dataKey={deptSort} nameKey="name" cx="50%" cy="50%" innerRadius={48} outerRadius={78} paddingAngle={2}>
                  {deptData.map((_,i) => <Cell key={i} fill={DONUT_COLORS[i%DONUT_COLORS.length]}/>)}
                </Pie>
                <Tooltip contentStyle={{fontSize:'11px',borderRadius:'8px',border:'1px solid #e2e8f0'}} formatter={(v,n)=>[v+'건',n]}/>
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-1.5 pt-2">
              {deptData.map((d,i) => (
                <div key={d.name} className="flex items-center gap-1.5 text-xs">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{background:DONUT_COLORS[i%DONUT_COLORS.length]}}/>
                  <span className="text-slate-600 flex-1 truncate">{d.name}</span>
                  <span className="font-semibold text-slate-800">{d[deptSort]}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* 담당자별 성과 */}
      <Card title="담당자별 성과" filtered={true}>
        {assigneeData.length === 0 ? <Empty /> : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="py-2 px-3 text-left text-xs font-semibold text-slate-400">담당자</th>
                <th className="py-2 px-3 text-center text-xs font-semibold text-slate-400">전체</th>
                <th className="py-2 px-3 text-center text-xs font-semibold text-blue-400">상담중</th>
                <th className="py-2 px-3 text-center text-xs font-semibold text-emerald-500">계약완료</th>
                <th className="py-2 px-3 text-left text-xs font-semibold text-slate-400">전환율</th>
              </tr>
            </thead>
            <tbody>
              {assigneeData.map((r,i) => (
                <tr key={r.assignee} className="border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{i===0?'🥇':i===1?'🥈':i===2?'🥉':'　'}</span>
                      <span className="text-xs font-semibold text-slate-700">{r.assignee}</span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-center text-xs text-slate-500">{r.total}</td>
                  <td className="py-2.5 px-3 text-center"><span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs font-semibold">{r.상담중}</span></td>
                  <td className="py-2.5 px-3 text-center"><span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-full text-xs font-semibold">{r.계약완료}</span></td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <div className="w-20 bg-slate-100 rounded-full h-1.5">
                        <div className="bg-emerald-500 h-1.5 rounded-full transition-all" style={{width:`${r.전환율}%`}}/>
                      </div>
                      <span className={`text-xs font-bold ${r.전환율>=50?'text-emerald-600':r.전환율>0?'text-amber-500':'text-slate-300'}`}>{r.전환율}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* 월별 추이 라인차트 (항상 최근 12개월 고정, 기간 필터 미적용) */}
      <Card title="월별 추이 (최근 12개월)">
        {leads.length === 0 ? <Empty /> : (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={monthlyData} margin={{top:5,right:20,left:0,bottom:5}}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9"/>
              <XAxis dataKey="month" tick={{fontSize:10}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fontSize:10}} allowDecimals={false} axisLine={false} tickLine={false}/>
              <Tooltip contentStyle={{fontSize:'11px',borderRadius:'8px',border:'1px solid #e2e8f0'}} formatter={(v,n)=>[v+'건',n]}/>
              <Legend iconSize={8} wrapperStyle={{fontSize:'11px'}}/>
              <Line type="monotone" dataKey="문의" stroke="#3b82f6" strokeWidth={2.5} dot={{r:3,fill:'#3b82f6'}} activeDot={{r:5}} name="문의"/>
              <Line type="monotone" dataKey="계약" stroke="#10b981" strokeWidth={2.5} dot={{r:3,fill:'#10b981'}} activeDot={{r:5}} name="계약완료"/>
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>
    </div>
  );
}

/* ============================================================
   LEADS CALENDAR 컴포넌트
   ============================================================ */
function LeadsCalendar({ leads, onEdit, onNewLead, onLoadQuote }) {
  const [currentDate, setCurrentDate] = React.useState(new Date());
  const [selectedAssignee, setSelectedAssignee] = React.useState('all');
  const [selectedDay, setSelectedDay] = React.useState(null);
  const [collapsedLeads, setCollapsedLeads] = React.useState(new Set()); // 접힌 리드 id Set

  const toggleCollapse = (id) => setCollapsedLeads(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const assignees = React.useMemo(() => [...new Set(leads.map(l=>l.assignee).filter(Boolean))], [leads]);

  const ASSIGNEE_COLORS = [
    { bg:'bg-blue-500',    text:'text-blue-600'    },
    { bg:'bg-emerald-500', text:'text-emerald-600' },
    { bg:'bg-violet-500',  text:'text-violet-600'  },
    { bg:'bg-amber-500',   text:'text-amber-600'   },
  ];

  const EVENT_TYPES = {
    inquiry:          { label:'신규문의', dot:'bg-slate-400',   badge:'bg-slate-400 text-white'   },
    quote_sent:       { label:'견적발송', dot:'bg-violet-500',  badge:'bg-violet-500 text-white'  },
    meeting:          { label:'미팅',    dot:'bg-blue-500',    badge:'bg-blue-500 text-white'    },
    contracted:       { label:'계약완료', dot:'bg-emerald-500', badge:'bg-emerald-500 text-white' },
    delivered:        { label:'납품',    dot:'bg-orange-500',  badge:'bg-orange-500 text-white'  },
    purchase_complete:{ label:'매입완료', dot:'bg-cyan-500',    badge:'bg-cyan-500 text-white'    },
    sales_complete:   { label:'매출완료', dot:'bg-teal-600',    badge:'bg-teal-600 text-white'    },
    lost:             { label:'타사계약', dot:'bg-red-400',     badge:'bg-red-400 text-white'     },
  };

  const toKey = (s) => (s && typeof s === 'string') ? s.substring(0,10) : null;

  const eventMap = React.useMemo(() => {
    const map = {};
    const fl = selectedAssignee === 'all' ? leads : leads.filter(l=>l.assignee===selectedAssignee);
    const add = (dateStr, lead, type, extra={}) => {
      const key = toKey(dateStr);
      if (!key) return;
      if (!map[key]) map[key] = [];
      map[key].push({ lead, type, ...extra });
    };
    fl.forEach(lead => {
      if (lead.delivered_at)           add(lead.delivered_at,           lead, 'delivered');
      const mtgs = Array.isArray(lead.meetings) ? lead.meetings : [];
      mtgs.forEach((m, i) => {
        if (m.date) {
          add(m.date, lead, 'meeting', { meetingType: m.type, meetingTime: m.time||'', meetingMemo: m.memo, meetingOrder: i+1 });
        }
      });
    });
    return map;
  }, [leads, selectedAssignee]);

  const calDays = React.useMemo(() => {
    const y = currentDate.getFullYear(), m = currentDate.getMonth();
    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m+1, 0).getDate();
    const prevMonthDays = new Date(y, m, 0).getDate();
    const days = [];
    for (let i=firstDow-1; i>=0; i--) days.push({ date: new Date(y, m-1, prevMonthDays-i), cur: false });
    for (let d=1; d<=daysInMonth; d++) days.push({ date: new Date(y, m, d), cur: true });
    const rem = 42 - days.length;
    for (let d=1; d<=rem; d++) days.push({ date: new Date(y, m+1, d), cur: false });
    return days;
  }, [currentDate]);

  const fmtKey = (dt) => {
    const y = dt.getFullYear(), m = String(dt.getMonth()+1).padStart(2,'0'), d = String(dt.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  };
  const todayKey = fmtKey(new Date());
  const prevMonth = () => setCurrentDate(d => new Date(d.getFullYear(), d.getMonth()-1, 1));
  const nextMonth = () => setCurrentDate(d => new Date(d.getFullYear(), d.getMonth()+1, 1));
  const selEvents = selectedDay ? (eventMap[selectedDay]||[]) : [];

  // 리드 전체 타임라인 빌드 (날짜순 정렬)
  const buildTimeline = (lead) => {
    const evs = [];
    (Array.isArray(lead.meetings)?lead.meetings:[]).forEach((m,i) => {
      if (m.date) evs.push({ date:m.date, type:'meeting', label:`${i+1}차 미팅`, sub:`${m.type||''}${m.time?' '+m.time:''}`, memo:m.memo||'' });
    });
    if (lead.delivered_at)         evs.push({ date:lead.delivered_at,         type:'delivered',         label:'납품',    sub:'', memo:'' });
    return evs.sort((a,b) => b.date.localeCompare(a.date));
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      {/* 헤더 */}
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
          </button>
          <span className="font-bold text-slate-800 text-base min-w-[120px] text-center">{currentDate.getFullYear()}년 {currentDate.getMonth()+1}월</span>
          <button onClick={nextMonth} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-500 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
          </button>
          {onNewLead && (
            <button onClick={() => onNewLead()}
              className="flex items-center gap-1.5 ml-2 px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors font-semibold">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>
              새 리드
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => setSelectedAssignee('all')}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${selectedAssignee==='all' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
            전체
          </button>
          {assignees.map((a,i) => {
            const c = ASSIGNEE_COLORS[i % ASSIGNEE_COLORS.length];
            return (
              <button key={a} onClick={() => setSelectedAssignee(a)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${selectedAssignee===a ? c.bg+' text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                {a}
              </button>
            );
          })}
        </div>
      </div>

      {/* 범례 */}
      <div className="px-5 py-2.5 border-b border-slate-100 flex items-center gap-4 flex-wrap">
        {Object.entries(EVENT_TYPES).map(([k,v]) => (
          <div key={k} className="flex items-center gap-1.5">
            <div className={`w-2.5 h-2.5 rounded-full ${v.dot}`}/>
            <span className="text-xs text-slate-500">{v.label}</span>
          </div>
        ))}
      </div>

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 border-b border-slate-100">
        {['일','월','화','수','목','금','토'].map((d,i) => (
          <div key={d} className={`py-2.5 text-center text-xs font-semibold ${i===0?'text-red-500':i===6?'text-blue-500':'text-slate-500'}`}>{d}</div>
        ))}
      </div>

      {/* 날짜 그리드 */}
      <div className="grid grid-cols-7">
        {calDays.map((dayObj, idx) => {
          const key = fmtKey(dayObj.date);
          const evs = eventMap[key] || [];
          const isToday = key === todayKey;
          const isSel = key === selectedDay;
          const dow = dayObj.date.getDay();
          const visible = evs.slice(0, 3);
          const extra = evs.length - 3;
          return (
            <div key={idx}
              onClick={() => evs.length > 0 ? setSelectedDay(isSel ? null : key) : null}
              className={[
                'min-h-[88px] p-1.5 border-b border-r border-slate-50 transition-colors',
                !dayObj.cur ? 'bg-slate-50/60' : 'bg-white',
                evs.length > 0 ? 'cursor-pointer hover:bg-blue-50/40' : '',
                isSel ? 'bg-blue-50 ring-1 ring-inset ring-blue-300' : '',
                idx%7===6 ? 'border-r-0' : '',
              ].join(' ')}>
              <div className={[
                'w-6 h-6 flex items-center justify-center rounded-full text-xs font-semibold mb-1',
                isToday ? 'bg-blue-600 text-white' : '',
                !isToday && dow===0 ? 'text-red-500' : '',
                !isToday && dow===6 ? 'text-blue-500' : '',
                !isToday && dow!==0 && dow!==6 ? (dayObj.cur ? 'text-slate-700' : 'text-slate-300') : '',
              ].join(' ')}>
                {dayObj.date.getDate()}
              </div>
              <div className="space-y-0.5">
                {visible.map((ev,i) => {
                  const ti = EVENT_TYPES[ev.type] || EVENT_TYPES.inquiry;
                  const label = ev.meetingOrder ? `${ev.lead.contact_name}` : ev.lead.contact_name;
                  return (
                    <div key={i} className={`flex items-center gap-1 px-1 py-0.5 rounded truncate ${ti.badge}`}
                      title={`${ev.lead.contact_name} · ${ti.label}${ev.meetingType ? ' ('+ev.meetingType+')' : ''}`}>
                      <span className="truncate text-[10px] leading-snug">{label}</span>
                    </div>
                  );
                })}
                {extra > 0 && <div className="text-[10px] text-slate-400 px-1">+{extra}건</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* 하단 패널 — 날짜 클릭 시 리드별 히스토리 (기본 펼침) */}
      {selectedDay && (
        <div className="border-t border-slate-200 bg-slate-50 p-4">
          {/* 패널 헤더 */}
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold text-slate-800 text-sm">
              {selectedDay.replace(/(\d{4})-(\d{2})-(\d{2})/,'$1년 $2월 $3일')}
              {selEvents.length > 0 && <span className="ml-2 text-slate-400 font-normal">{[...new Map(selEvents.map(e=>[e.lead.id,e])).values()].length}명</span>}
            </span>
            <button onClick={() => { setSelectedDay(null); setCollapsedLeads(new Set()); }}
              className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-slate-200 text-slate-400">✕</button>
          </div>

          {selEvents.length === 0 ? (
            <div className="text-xs text-slate-400 py-4 text-center">이 날에 등록된 일정이 없습니다</div>
          ) : (
            <div className="space-y-3">
              {/* lead.id 기준 중복 제거 후 각 리드별 히스토리 */}
              {[...new Map(selEvents.map(e=>[e.lead.id, e.lead])).values()].map(lead => {
                const timeline = buildTimeline(lead);
                const isCollapsed = collapsedLeads.has(lead.id);
                const ai = assignees.indexOf(lead.assignee);
                const ac = ai >= 0 ? ASSIGNEE_COLORS[ai % ASSIGNEE_COLORS.length] : null;
                return (
                  <div key={lead.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                    {/* 카드 헤더 */}
                    <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-100">
                      <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-slate-800 text-sm">{lead.contact_name}</span>
                        {lead.hospital_name && <span className="text-xs text-slate-400">{lead.hospital_name}</span>}
                        {lead.dept && <span className="text-xs text-slate-400">{lead.dept}</span>}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${LEAD_STAGE_COLORS[lead.stage]||'bg-slate-100 text-slate-600'}`}>{lead.stage}</span>
                        {lead.quote_no && onLoadQuote && (
                          <button onClick={() => onLoadQuote(lead, lead.quote_no)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-violet-50 text-violet-600 border border-violet-200 rounded text-[10px] font-mono font-medium hover:bg-violet-100 transition-colors"
                            title="견적서 불러오기">
                            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                            {lead.quote_no}
                          </button>
                        )}
                        {lead.assignee && <span className={`text-xs font-medium ${ac ? ac.text : 'text-slate-500'}`}>{lead.assignee}</span>}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {onEdit && (
                          <button onClick={() => onEdit(lead)}
                            className="px-2 py-1 text-xs border border-slate-200 text-slate-500 rounded hover:bg-slate-50 transition-colors">
                            수정
                          </button>
                        )}
                        <button onClick={() => toggleCollapse(lead.id)}
                          className="w-6 h-6 flex items-center justify-center rounded hover:bg-slate-100 text-slate-400 transition-colors">
                          <svg className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? '' : 'rotate-180'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                    {/* 타임라인 (접힘 토글) */}
                    {!isCollapsed && (
                      <div className="p-3">
                        {timeline.length === 0 ? (
                          <div className="text-xs text-slate-400 py-2 text-center">등록된 이력이 없습니다</div>
                        ) : (
                          <div className="relative">
                            <div className="absolute left-[9px] top-2.5 bottom-2.5 w-0.5 bg-slate-100"/>
                            <div className="space-y-2">
                              {timeline.map((ev, i) => {
                                const ti = EVENT_TYPES[ev.type] || EVENT_TYPES.inquiry;
                                const isLast = i === timeline.length - 1;
                                return (
                                  <div key={i} className="flex items-start gap-2.5 relative">
                                    <div className={`w-[18px] h-[18px] rounded-full ${ti.dot} shrink-0 mt-0.5 z-10 ring-2 ring-white`}/>
                                    <div className={`flex-1 rounded-lg border px-2.5 py-2 ${isLast ? 'border-slate-200 bg-slate-50' : 'border-transparent'}`}>
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[11px] text-slate-400 font-mono tabular-nums">{ev.date}</span>
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${ti.badge}`}>
                                          {ev.label}{ev.sub ? ` · ${ev.sub}` : ''}
                                        </span>
                                      </div>
                                      {ev.memo && <div className="text-xs text-slate-500 mt-0.5 italic">"{ev.memo}"</div>}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        {/* 연락처·메모 */}
                        {(lead.contact_phone || lead.notes) && (
                          <div className="mt-2 pt-2 border-t border-slate-100 flex flex-wrap gap-3">
                            {lead.contact_phone && <span className="text-xs text-slate-400">📞 {lead.contact_phone}</span>}
                            {lead.notes && <span className="text-xs text-slate-400 truncate max-w-xs" title={lead.notes}>💬 {lead.notes}</span>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   QUOTE PICKER MODAL (견적서 선택)
   ============================================================ */
function QuotePickerModal({ onSelect, onClose, quotes = [] }) {
  const [loading] = React.useState(false);
  const [search, setSearch] = React.useState('');

  const filtered = React.useMemo(() => {
    if (!search.trim()) return quotes;
    const q = search.toLowerCase();
    return quotes.filter(e =>
      (e.quoteNo || '').toLowerCase().includes(q) ||
      (e.hospital || '').toLowerCase().includes(q) ||
      (e.doctor || '').toLowerCase().includes(q) ||
      (e.dept || '').toLowerCase().includes(q)
    );
  }, [quotes, search]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" style={{background:'rgba(0,0,0,0.6)'}}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden flex flex-col" style={{maxHeight:'80vh'}}>
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div className="font-bold text-slate-900">견적서 선택</div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="px-4 py-3 border-b border-slate-100 shrink-0">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="견적번호, 병원명, 원장명, 진료과 검색..."
            autoFocus
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"/>
        </div>
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="py-10 text-center text-slate-400 text-sm">불러오는 중...</div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-slate-400 text-sm">검색 결과가 없습니다</div>
          ) : filtered.map(e => (
            <button key={e.id} onClick={() => { onSelect(e.quoteNo); onClose(); }}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-violet-50 border-b border-slate-50 last:border-0 transition-colors text-left">
              <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-violet-700 text-sm">{e.quoteNo}</span>
                  {e.dept && <span className="text-xs px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">{e.dept}</span>}
                </div>
                <div className="text-xs text-slate-500 mt-0.5 truncate">
                  {[e.hospital, e.doctor].filter(Boolean).join(' · ') || '—'}
                </div>
              </div>
              <div className="text-xs text-slate-400 shrink-0">{e.savedAt?.slice(0,10) || ''}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   QUOTE NO INPUT MODAL (견적발송 단계 전환 시)
   ============================================================ */
/* ============================================================
   LEADS PAGE (영업 파이프라인)
   ============================================================ */
const LEAD_STAGES = ['신규문의', '견적발송', '상담중', '계약완료', '발주진행중', '납품완료', '타사계약'];
const LEAD_STAGE_COLORS = {
  '신규문의': 'bg-slate-100 text-slate-600',
  '견적발송': 'bg-violet-100 text-violet-700',
  '상담중':   'bg-blue-100 text-blue-700',
  '계약완료': 'bg-emerald-100 text-emerald-700',
  '발주진행중': 'bg-amber-100 text-amber-700',
  '납품완료': 'bg-teal-100 text-teal-700',
  '타사계약': 'bg-red-100 text-red-600',
};
const LEAD_STAGE_BTN = {
  '신규문의': 'bg-slate-500',
  '견적발송': 'bg-violet-500',
  '상담중':   'bg-blue-500',
  '계약완료': 'bg-emerald-500',
  '발주진행중': 'bg-amber-500',
  '납품완료': 'bg-teal-600',
  '타사계약': 'bg-red-500',
};
const OPENING_DATE_OPTIONS = ['3개월 미만', '6개월 미만', '1년 미만', '1년 이상'];
const EMPTY_LEAD = { hospital_name:'', hospital_id:null, contact_name:'', contact_phone:'', dept:'', opening_date:'', source:'직접입력', stage:'신규문의', assignee:'', notes:'', quote_sent_date:'', contracted_at:'', delivered_at:'', purchase_complete_at:'', sales_complete_at:'', lost_at:'', meetings:[], quote_no:'' };

// 발주 계획서 페이지 — 견적서 형식의 풀페이지 뷰
function PurchaseOrderPlanPage({ lead, equipments = [], manufacturers = [], setManufacturers, onBack, onLeadUpdate, user, onLogout, nav, backLabel = '영업관리로' }) {
  const [quote, setQuote] = React.useState(null);
  const [contract, setContract] = React.useState(null);
  const [pos, setPos] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  // 정책: 모든 입력 단가는 부가세 포함 기준. 표시도 그대로. (vatIncluded=false 고정)
  const [vatIncluded] = React.useState(false);
  const [planItems, setPlanItems] = React.useState([]); // 편집 가능한 발주 계획 항목
  const [hospitalAddress, setHospitalAddress] = React.useState('');
  const [hospitalRow, setHospitalRow] = React.useState(null);
  const [hospitalPickerOpen, setHospitalPickerOpen] = React.useState(false);
  const [hospitalMustPick, setHospitalMustPick] = React.useState(false); // 진입 강제
  const [kakaoModal, setKakaoModal] = React.useState(null); // { vendor, text }
  const [deliveryDate, setDeliveryDate] = React.useState('');
  const [dirty, setDirty] = React.useState(false); // 저장 안 한 변경 여부

  // 거래처 후보 (장비DB + manufacturers 테이블 + manual 입력)
  const vendorOptions = React.useMemo(() => {
    const set = new Set();
    equipments.forEach(e => { if (e.vendor) set.add(e.vendor); if (e.model.manufacturer) set.add(e.model.manufacturer); });
    manufacturers.forEach(m => { if (m.name) set.add(m.name); });
    return Array.from(set).filter(Boolean).sort();
  }, [equipments, manufacturers]);

  const manufacturerOptions = React.useMemo(() => {
    const set = new Set();
    equipments.forEach(e => { if (e.model.manufacturer) set.add(e.model.manufacturer); });
    return Array.from(set).filter(Boolean).sort();
  }, [equipments]);

  React.useEffect(() => {
    (async () => {
      if (!lead?.quote_no) { setLoading(false); return; }
      setLoading(true);
      try {
        // categories가 필요한 발주계획서 — quote, contract(단건+categories), 그 contract에 묶인 PO만 로드
        const [q, contractRow] = await Promise.all([
          dbLoadQuoteByNo(lead.quote_no),
          dbLoadContractWithCategories({ quoteName: lead.quote_no }),
        ]);
        setQuote(q);
        let c = contractRow;
        // 리비전으로 견적번호가 바뀌어(R3→R4) 정확 일치 계약을 못 찾는 경우:
        // R번호를 뗀 기준 견적번호로 기존 계약을 찾아 재사용 (빈 계약 중복 생성 방지)
        if (!c && q && lead.quote_no) {
          const base = lead.quote_no.replace(/-R\d+$/i, '');
          if (base && base !== lead.quote_no) {
            try {
              const { data: cands } = await sb.from('contracts')
                .select('id,quote_name,created_at')
                .like('quote_name', base + '%')
                .order('created_at', { ascending: false });
              // 같은 기준 견적의 계약만 (base 또는 base-R숫자 형태)
              const same = (cands || []).filter(x => {
                const suffix = (x.quote_name || '').slice(base.length);
                return suffix === '' || /^-R\d+$/i.test(suffix);
              });
              if (same.length) {
                // 발주(PO)가 붙어있는 계약을 우선 선택, 없으면 가장 최근
                const ids = same.map(x => x.id);
                const { data: poRows } = await sb.from('purchase_orders').select('contract_id').in('contract_id', ids);
                const poSet = new Set((poRows || []).map(p => p.contract_id));
                const chosen = same.find(x => poSet.has(x.id)) || same[0];
                if (chosen) c = await dbLoadContractWithCategories({ id: chosen.id });
              }
            } catch (revErr) { console.warn('기준 견적번호 계약 탐색 실패:', revErr); }
          }
        }
        if (!c && q) {
          // 계약 자동 생성
          let hospitalId = null;
          const hospitalName = (q.hospital || lead.hospital_name || '').trim();
          if (hospitalName) {
            const { data: existingHosp } = await sb.from('hospitals').select('id').eq('name', hospitalName).maybeSingle();
            if (existingHosp) hospitalId = existingHosp.id;
            // 자동 등록 제거 — 병원 마스터는 '영업관리 → 납품완료 → 관리등록' 또는 '병원 관리' 메뉴에서만 등록
            // 마스터에 없으면 hospital_id=null로 계약 생성, 추후 관리등록 시 contract.hospital_id 자동 연결
          }
          const newContractId = await dbSaveContract({
            hospital_id: hospitalId, hospital_name: hospitalName || null,
            quote_name: lead.quote_no, contract_date: lead.contracted_at || new Date().toISOString().split('T')[0],
            amount: q.finalAmt || null, status: '완료',
            categories: (q.categories || []).map(cat => ({ ...cat, items: (cat.items || []).filter(item => !item.excluded) })).filter(cat => (cat.items || []).length > 0),
            delivery_target_date: lead.delivered_at || null,
          });
          c = await dbLoadContractWithCategories({ id: newContractId });
        }
        setContract(c);
        // 이 계약에 묶인 PO만 로드 (전체 PO 풀로드 회피)
        const allPos = c ? await dbLoadPurchaseOrders(c.id) : [];
        setDeliveryDate(c?.delivery_target_date || lead.delivered_at || '');
        const cPos = c ? allPos.filter(p => p.contract_id === c.id && p.is_active !== false) : [];
        setPos(cPos);

        // 병원 주소 로드
        let hospId = c?.hospital_id || lead?.hospital_id || null;
        if (!hospId && (q?.hospital || lead.hospital_name)) {
          const { data: hRow } = await sb.from('hospitals').select('*').eq('name', q?.hospital || lead.hospital_name).maybeSingle();
          if (hRow) hospId = hRow.id;
          if (hRow) { setHospitalRow(hRow); setHospitalAddress(hRow.address || ''); }
        } else if (hospId) {
          const { data: hRow } = await sb.from('hospitals').select('*').eq('id', hospId).maybeSingle();
          if (hRow) { setHospitalRow(hRow); setHospitalAddress(hRow.address || ''); }
        }

        // 마스터 정책: 발주계획서 진입 시 hospital_id 없으면 강제 선택
        if (!hospId) {
          setHospitalMustPick(true);
          setHospitalPickerOpen(true);
        }

        // ── 발주 독립 모델 ──
        // 이미 저장된 발주 품목(PO items)이 있으면 그게 SoT (발주 진행 중 추가/취소 반영분 보존)
        // PO items가 없으면(=첫 발주) 견적/계약 품목으로 초기화
        const hasPoItems = cPos.some(p => (p.purchase_order_items || []).length > 0);
        const items = [];

        if (hasPoItems) {
          // 발주가 주인 — 저장된 PO 품목 그대로 로드
          cPos.forEach(po => {
            (po.purchase_order_items || []).forEach(pi => {
              const eq = equipments.find(e =>
                (e.model.name === pi.model_name && (!pi.manufacturer || e.model.manufacturer === pi.manufacturer)));
              const vInfo = manufacturers.find(m => m.name === po.manufacturer_name);
              items.push({
                key: `po-${pi.id}`,
                poItemId: pi.id,
                catName: eq?.catName || '',
                itemName: pi.item_name || '',
                modelName: pi.model_name || '',
                modelId: eq?.model.id || '',
                equipmentId: eq?.id || null,
                manufacturer: pi.manufacturer || '',
                vendor: po.manufacturer_name || '',
                quantity: pi.quantity || 1,
                salePrice: (pi.sale_price != null && pi.sale_price > 0) ? pi.sale_price : (eq?.model.price || 0),
                purchasePrice: Number(pi.unit_price) || 0,
                vendorContactName:  vInfo?.contact_name  || '',
                vendorContactPhone: vInfo?.contact_phone || '',
                ordered:    !!pi.ordered,
                ordered_at: pi.ordered_at || null,
                paid:        !!pi.paid,
                paid_at:     pi.paid_at || null,
                taxInvoiced: !!pi.tax_invoiced,
                tax_invoiced_at: pi.tax_invoiced_at || null,
                delivered:  !!pi.delivered,
                delivered_at: pi.delivered_at || null,
                memo: pi.memo || '',
                note: '',
              });
            });
          });
        } else {
          // 첫 발주 — 견적/계약 품목으로 초기화
          const sourceCategories = (c?.categories && c.categories.length > 0) ? c.categories : (q?.categories || []);
          sourceCategories.forEach(cat => {
            (cat.items || []).filter(i => !i.excluded).forEach(item => {
              const model = item.models?.find(m => m.id === item.selectedModelId) || item.models?.[0];
              const eq = equipments.find(e =>
                e.model.id === model?.id || (e.model.name === model?.name && e.model.manufacturer === model?.manufacturer)
              );
              const manufacturer = model?.manufacturer || eq?.model.manufacturer || '';
              const vendor = eq?.vendor || manufacturer || '';
              const vInfo = manufacturers.find(m => m.name === vendor);
              items.push({
                key: `item-${cat.id}-${item.id}`,
                poItemId: null,
                catName: cat.name,
                itemName: item.name,
                modelName: model?.name || '',
                modelId: model?.id || '',
                equipmentId: eq?.id || null,
                manufacturer,
                vendor,
                quantity: item.quantity || 1,
                salePrice: model?.price || 0,
                purchasePrice: Number(eq?.purchasePrice) || 0,
                vendorContactName:  vInfo?.contact_name  || '',
                vendorContactPhone: vInfo?.contact_phone || '',
                ordered: false, ordered_at: null,
                taxInvoiced: false, tax_invoiced_at: null,
                delivered: false, delivered_at: null,
                memo: '', note: '',
              });
            });
          });
        }
        setPlanItems(items);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, [lead?.id, lead?.quote_no]);

  // 정렬: 매입처(vendor) 알파벳 → 모델명
  const sortedItems = React.useMemo(() => {
    // 매출 단가(salePrice) 높은 순. 동일하면 모델명 가나다.
    return [...planItems].sort((a, b) => {
      const sa = Number(a.salePrice) || 0;
      const sb = Number(b.salePrice) || 0;
      if (sa !== sb) return sb - sa;
      return (a.modelName || '').localeCompare(b.modelName || '');
    });
  }, [planItems]);

  // 거래처별 그룹
  const vendorGroups = React.useMemo(() => {
    const groups = {};
    sortedItems.forEach(it => {
      const v = it.vendor || '(미지정)';
      if (!groups[v]) groups[v] = [];
      groups[v].push(it);
    });
    return groups;
  }, [sortedItems]);

  const setItem = (key, patch) => { setDirty(true); setPlanItems(p => p.map(it => it.key === key ? { ...it, ...patch } : it)); };

  // 발주 독립 — 품목 추가/삭제 (추가주문/취소)
  const addPlanItem = (vendor) => {
    setDirty(true);
    setPlanItems(p => [...p, {
      key: `new-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      poItemId: null, catName: '', itemName: '', modelName: '', modelId: '',
      equipmentId: null, manufacturer: '', vendor: (vendor && vendor !== '(미지정)') ? vendor : '',
      quantity: 1, salePrice: 0, purchasePrice: 0,
      vendorContactName: '', vendorContactPhone: '',
      ordered: false, ordered_at: null, taxInvoiced: false, tax_invoiced_at: null,
      delivered: false, delivered_at: null, memo: '', note: '',
    }]);
  };
  const removePlanItem = (key) => {
    if (!window.confirm('이 품목을 발주에서 제거할까요? (저장 시 반영)')) return;
    setDirty(true);
    setPlanItems(p => p.filter(it => it.key !== key));
  };

  // 견적에서 다시 불러오기 — 견적 품목 기준으로 재구성 (발주/세금계산서/납품/매입가는 모델명 매칭 보존)
  const reloadFromQuote = () => {
    if (!window.confirm('견적 품목으로 다시 불러옵니다.\n\n· 발주에 직접 추가했던 품목은 사라지고 견적 기준으로 교체됩니다.\n· 모델명이 같은 품목의 발주/세금계산서/납품 체크와 매입가는 유지됩니다.\n\n계속할까요?')) return;
    const sourceCategories = (contract?.categories && contract.categories.length > 0) ? contract.categories : (quote?.categories || []);
    const newItems = [];
    sourceCategories.forEach(cat => {
      (cat.items || []).filter(i => !i.excluded).forEach(item => {
        const model = item.models?.find(m => m.id === item.selectedModelId) || item.models?.[0];
        const eq = equipments.find(e => e.model.id === model?.id || (e.model.name === model?.name && e.model.manufacturer === model?.manufacturer));
        const manufacturer = model?.manufacturer || eq?.model.manufacturer || '';
        const vendor = eq?.vendor || manufacturer || '';
        const vInfo = manufacturers.find(m => m.name === vendor);
        const prev = planItems.find(p => p.modelName === model?.name); // 기존 상태 보존용
        newItems.push({
          key: `q-${cat.id}-${item.id}`,
          poItemId: prev?.poItemId || null,
          catName: cat.name, itemName: item.name, modelName: model?.name || '', modelId: model?.id || '',
          equipmentId: eq?.id || null, manufacturer, vendor,
          quantity: item.quantity || 1,
          salePrice: model?.price || 0,
          purchasePrice: prev?.purchasePrice ?? Number(eq?.purchasePrice) ?? 0,
          vendorContactName: vInfo?.contact_name || '', vendorContactPhone: vInfo?.contact_phone || '',
          ordered: prev?.ordered || false, ordered_at: prev?.ordered_at || null,
          taxInvoiced: prev?.taxInvoiced || false, tax_invoiced_at: prev?.tax_invoiced_at || null,
          delivered: prev?.delivered || false, delivered_at: prev?.delivered_at || null,
          memo: prev?.memo || '', note: '',
        });
      });
    });
    setPlanItems(newItems);
    setDirty(true);
  };

  // 저장하지 않고 나갈 때 확인
  const handleBack = async () => {
    if (dirty && contract) {
      const ok = window.confirm('저장하지 않은 변경사항이 있습니다.\n\n[확인] 저장하고 나가기\n[취소] 저장하지 않고 나가기');
      if (ok) { await handleSave(); }
    }
    onBack();
  };

  // 합계 (부가세 포함/별도 반영) — Number() 캐스팅으로 NaN 방지
  const totals = React.useMemo(() => {
    const baseSale = sortedItems.reduce((s, it) => s + ((Number(it.salePrice)||0) * (Number(it.quantity)||0)), 0);
    const basePurchase = sortedItems.reduce((s, it) => s + ((Number(it.purchasePrice)||0) * (Number(it.quantity)||0)), 0);
    const sale = vatIncluded ? Math.round(baseSale * 1.1) : baseSale;
    const purchase = vatIncluded ? Math.round(basePurchase * 1.1) : basePurchase;
    const margin = sale - purchase;
    const marginRate = sale > 0 ? Math.round((margin/sale)*100*10)/10 : 0;
    return { sale, purchase, margin, marginRate, baseSale, basePurchase };
  }, [sortedItems, vatIncluded]);

  // 거래처별 합계
  const vendorTotal = (items) => {
    const base = items.reduce((s, it) => s + ((Number(it.purchasePrice)||0) * (Number(it.quantity)||0)), 0);
    return vatIncluded ? Math.round(base * 1.1) : base;
  };
  const vendorSaleTotal = (items) => {
    const base = items.reduce((s, it) => s + ((Number(it.salePrice)||0) * (Number(it.quantity)||0)), 0);
    return vatIncluded ? Math.round(base * 1.1) : base;
  };
  // 거래처별 펼침/접힘 상태 (기본: 접힘 — false면 펼침)
  const [expandedVendors, setExpandedVendors] = React.useState({});
  const toggleVendor = (v) => setExpandedVendors(p => ({ ...p, [v]: !p[v] }));
  const [itemMemoModal, setItemMemoModal] = React.useState(null); // { key, item }
  const [contactModal, setContactModal] = React.useState(null);   // { vendor, items }
  const [vendorPickFor, setVendorPickFor] = React.useState(null); // 행 key

  // 저장: 거래처별로 PO upsert (장비 매입가도 갱신 + 이력 기록)
  const handleSave = async () => {
    if (!contract) { alert('계약 정보가 없습니다.'); return; }
    setSaving(true);
    try {
      // 병원 주소 업데이트
      if (hospitalRow?.id && hospitalAddress !== (hospitalRow.address || '')) {
        try { await sb.from('hospitals').update({ address: hospitalAddress }).eq('id', hospitalRow.id); }
        catch (_) {}
      }
      // 계약의 납기일 업데이트 — lead.delivered_at도 양방향 동기화
      if (deliveryDate && deliveryDate !== contract.delivery_target_date) {
        try { await sb.from('contracts').update({ delivery_target_date: deliveryDate }).eq('id', contract.id); }
        catch (_) {}
        setContract(p => ({ ...p, delivery_target_date: deliveryDate }));
        if (lead?.id && deliveryDate !== lead.delivered_at) {
          try { await sb.from('leads').update({ delivered_at: deliveryDate }).eq('id', lead.id); } catch (_) {}
          onLeadUpdate?.(lead.id, { delivered_at: deliveryDate });
        }
      }
      // 정책: 1 PO = 1 model. 같은 거래처라도 모델이 다르면 별도 PO 발급.
      const groups = {};
      sortedItems.forEach(it => {
        const v = it.vendor || '(미지정)';
        const m = it.modelName || it.itemName || '(미정)';
        const key = `${v} ${m}`;
        if (!groups[key]) groups[key] = { vendor: v, model: m, items: [] };
        groups[key].items.push(it);
      });

      for (const { vendor, model, items } of Object.values(groups)) {
        const totalPurchaseBase = items.reduce((s, it) => s + ((Number(it.purchasePrice)||0) * (Number(it.quantity)||0)), 0);
        const totalAmount = vatIncluded ? Math.round(totalPurchaseBase * 1.1) : totalPurchaseBase;
        const totalSaleBase = items.reduce((s, it) => s + ((Number(it.salePrice)||0) * (Number(it.quantity)||0)), 0);
        const saleAmount = vatIncluded ? Math.round(totalSaleBase * 1.1) : totalSaleBase;
        const mfr = manufacturers.find(m => m.name === vendor);
        const itemContact = items.find(i => i.vendorContactName || i.vendorContactPhone);
        const today = new Date().toISOString().split('T')[0];
        const poItems = items.map(it => ({
          equipment_id: it.equipmentId || null,
          item_name: it.itemName, model_name: it.modelName,
          manufacturer: it.manufacturer || vendor,
          quantity: Number(it.quantity)||1, unit_price: Number(it.purchasePrice)||0,
          amount: (Number(it.purchasePrice)||0) * (Number(it.quantity)||0),
          sale_price: Number(it.salePrice) || 0,
          ordered: !!it.ordered,
          ordered_at: it.ordered ? (it.ordered_at || today) : null,
          paid: !!it.paid,
          paid_at: it.paid ? (it.paid_at || today) : null,
          tax_invoiced: !!it.taxInvoiced,
          tax_invoiced_at: it.taxInvoiced ? (it.tax_invoiced_at || today) : null,
          delivered: !!it.delivered,
          delivered_at: it.delivered ? (it.delivered_at || today) : null,
          memo: it.memo || null,
        }));

        // 거래처(=manufacturers 테이블) 담당자 정보 동기화/upsert
        if (vendor && vendor !== '(미지정)' && (itemContact?.vendorContactName || itemContact?.vendorContactPhone)) {
          try {
            const existing = manufacturers.find(m => m.name === vendor);
            const contactPatch = {
              contact_name: itemContact.vendorContactName || existing?.contact_name || '',
              contact_phone: itemContact.vendorContactPhone || existing?.contact_phone || '',
            };
            if (existing?.id) {
              await dbUpdateManufacturer(existing.id, contactPatch);
            } else {
              await dbSaveManufacturer({ name: vendor, ...contactPatch });
            }
            // 캐시 갱신
            const fresh = await dbLoadManufacturers();
            if (typeof setManufacturers === 'function') setManufacturers(fresh);
          } catch (mfrErr) { console.warn('거래처 정보 동기화 실패:', mfrErr); }
        }
        const existingPo = pos.find(p =>
          p.manufacturer_name === vendor &&
          (p.purchase_order_items || []).some(it => (it.model_name || it.item_name) === model)
        );
        if (!existingPo) {
          const poNo = await dbGeneratePoNo();
          await dbSavePurchaseOrder({
            contract_id: contract.id,
            po_no: poNo,
            manufacturer_id: mfr?.id || null,
            manufacturer_name: vendor, vendor_name: vendor,
            hospital_name: contract.hospital_name,
            delivery_date: contract.delivery_target_date,
            total_amount: totalAmount, sale_amount: saleAmount,
            status: '준비중',
          }, poItems);
        } else {
          // 발주 독립 모델 — 자동 리비전 없이 같은 PO에 갱신
          // (품목 추가/삭제/단가변경이 일상 편집이므로 PO 번호를 유지하고 내용만 갱신)
          await dbUpdatePurchaseOrder(existingPo.id, {
            total_amount: totalAmount, sale_amount: saleAmount,
            vendor_name: vendor, manufacturer_id: mfr?.id || existingPo.manufacturer_id || null,
          });
          await sb.from('purchase_order_items').delete().eq('po_id', existingPo.id);
          await sb.from('purchase_order_items').insert(poItems.map(i => ({ ...i, po_id: existingPo.id })));
        }

        // 장비 매입가 자동 갱신 + 이력
        for (const it of items) {
          if (!it.equipmentId) continue;
          const eq = equipments.find(e => e.id === it.equipmentId);
          const prevPrice = Number(eq?.purchasePrice) || 0;
          if (prevPrice !== Number(it.purchasePrice) && it.purchasePrice > 0) {
            try {
              await dbLogPriceChange({
                equipmentId: it.equipmentId,
                price: it.purchasePrice,
                prevPrice,
                source: 'po',
                vendor,
                note: '발주 계획서 저장',
                autoUpdate: true,
              });
            } catch (_) {}
          }
          // 거래처/제조사 정보가 비어있던 장비는 채워주기
          const updates = {};
          if (!eq?.vendor && it.vendor) updates.vendor = it.vendor;
          if (!eq?.model.manufacturer && it.manufacturer) updates.manufacturer = it.manufacturer;
          if (Object.keys(updates).length > 0) {
            try { await sb.from('equipment').update(updates).eq('id', it.equipmentId); } catch (_) {}
          }
        }
      }

      // 사라진 PO 무력화 — 이 contract의 기존 PO 중 새 groups에 없는 것은 is_active=false
      const newKeySet = new Set();
      for (const { vendor, model } of Object.values(groups)) {
        newKeySet.add(`${vendor} ${model}`);
      }
      for (const op of pos) {
        const firstItem = (op.purchase_order_items || [])[0];
        const opModel = firstItem?.model_name || firstItem?.item_name || '';
        const opVendor = op.manufacturer_name || '(미지정)';
        if (!newKeySet.has(`${opVendor} ${opModel}`)) {
          try { await dbUpdatePurchaseOrder(op.id, { is_active: false, status: '취소' }); } catch (_) {}
        }
      }

      // 새로고침
      const refreshed = await dbLoadPurchaseOrders(contract.id);
      setPos(refreshed.filter(p => p.is_active !== false));

      // 외상매입(줄 돈)은 「매입매출 관리 > 세금계산서」 탭으로 일원화함.
      // 발주계획서 저장은 줄 돈(payable)에 더 이상 반영하지 않는다 — 이중계상 방지.
      // 📄(세금계산서) 아이콘은 "이 품목 세금계산서 받음" 표시 용도로만 유지되며(tax_invoiced 컬럼),
      // 실제 매입 금액은 세금계산서 탭에서 입력해야 거래처 외상에 잡힌다.
      setDirty(false);
      alert('발주 계획서가 저장되었습니다.\n\n※ 매입(줄 돈)은 「매입매출 관리 > 세금계산서」 탭에서 입력하세요.');
    } catch (e) {
      console.error(e);
      alert('저장 중 오류: ' + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  // 거래처별 발주 취소 — cancel 트랜잭션 추가 + PO 비활성화 (히스토리 보존)
  const handleCancelVendor = async (vendor, vItems) => {
    const po = pos.find(p => p.manufacturer_name === vendor && p.is_active !== false);
    if (!po) { alert('이 거래처의 활성 발주서가 없습니다.'); return; }
    if (po.status !== '발주완료' && po.status !== '납품완료') {
      alert('아직 발주완료 상태가 아닙니다.');
      return;
    }
    const reason = prompt(`[${vendor}] 발주를 취소합니다.\n취소 사유를 입력하세요 (선택사항):`);
    if (reason === null) return; // 사용자가 취소 버튼
    if (!confirm(`정말 [${vendor}] 발주를 취소하시겠습니까?\n\n발주서는 비활성화됩니다 (히스토리는 보존).\n매입(줄 돈)은 「매입매출 관리 > 세금계산서」 탭에서 관리하세요.`)) return;
    try {
      const today = new Date().toISOString().split('T')[0];
      let result = null;
      if (po.manufacturer_id) {
        result = await dbCancelPayableForPo({ poId: po.id, manufacturerId: po.manufacturer_id, txDate: today, reason: reason || null });
      }
      await dbUpdatePurchaseOrder(po.id, { status: '취소', is_active: false });
      const refreshed = await dbLoadPurchaseOrders(contract.id);
      setPos(refreshed.filter(p => p.is_active !== false));

      let msg = `[${vendor}] 발주 취소 완료`;
      if (result) {
        msg += `\n\n· 매입 청산: -${result.canceled.toLocaleString()}원`;
        if (result.refundDue > 0) {
          msg += `\n· 환불 예정 보정: +${result.refundDue.toLocaleString()}원\n\n⚠ 이미 지급된 ${result.refundDue.toLocaleString()}원은 거래처에서 별도로 환수해 주세요.\n   거래 이력에 "발주 취소 환불 예정" 메모로 추적됩니다.`;
        } else {
          msg += `\n· 거래처 외상 잔액 정상 차감 완료`;
        }
      }
      alert(msg);
    } catch (e) {
      console.error('cancel vendor failed:', e);
      alert('취소 실패: ' + (e.message || e));
    }
  };

  // 거래명세서 PDF 생성 — 병원용 (매출가, AS 정보 포함, 거래처 노출 안 함)
  const handleHospitalStatement = () => {
    if (!contract) { alert('계약 정보가 없습니다.'); return; }
    const company = (typeof getCompanyInfo === 'function') ? getCompanyInfo() : {};
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    // 발주 완료된 품목만 (또는 전체?) — 발주 완료된 것만 표시
    const items = sortedItems.filter(it => it.ordered || it.delivered);
    if (items.length === 0) { alert('발주 완료된 품목이 없습니다. 체크박스를 먼저 표시해주세요.'); return; }
    const totalBase = items.reduce((s, it) => s + ((Number(it.salePrice)||0) * (Number(it.quantity)||0)), 0);
    const total = vatIncluded ? Math.round(totalBase * 1.1) : totalBase;
    const vatLabel = vatIncluded ? 'VAT 포함' : 'VAT 별도';

    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { alert('팝업이 차단되었습니다.'); return; }
    const rows = items.map((it, i) => {
      const eq = equipments.find(e => e.id === it.equipmentId);
      const asPeriod = eq?.spec?.as || '';
      const warranty = eq?.spec?.warranty || '';
      const unitPrice = vatIncluded ? Math.round(it.salePrice * 1.1) : it.salePrice;
      const amount = unitPrice * it.quantity;
      return `<tr>
        <td class="c">${i+1}</td>
        <td>${it.itemName}</td>
        <td>${it.modelName}</td>
        <td>${it.manufacturer || '-'}</td>
        <td class="c">${it.quantity}</td>
        <td class="r">${unitPrice.toLocaleString('ko-KR')}</td>
        <td class="r">${amount.toLocaleString('ko-KR')}</td>
        <td class="c">${asPeriod || '-'}</td>
        <td class="c">${warranty || '-'}</td>
        <td class="c">${it.delivered_at || ''}</td>
      </tr>`;
    }).join('');

    win.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>거래명세서</title>
      <style>@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap');
      *{box-sizing:border-box;margin:0;padding:0;}body{font-family:'Noto Sans KR',sans-serif;font-size:11px;color:#000;padding:24px 32px;}
      .header-row{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px;font-size:11px;}
      .title{text-align:center;font-size:36px;font-weight:900;letter-spacing:18px;padding:14px 0;margin-bottom:12px;border-top:3px double #000;border-bottom:3px double #000;}
      .info-table{width:100%;border-collapse:collapse;margin-bottom:10px;}
      .info-table td{border:1px solid #000;padding:5px 8px;font-size:11px;}
      .info-table td.label{background:#f0f0f0;font-weight:700;text-align:center;width:80px;}
      .items-table{width:100%;border-collapse:collapse;margin-bottom:10px;}
      .items-table th{border:1px solid #000;background:#e8e8e8;padding:6px 4px;font-size:10px;font-weight:700;text-align:center;}
      .items-table td{border:1px solid #000;padding:5px 4px;font-size:10px;vertical-align:middle;}
      .items-table td.c{text-align:center;}.items-table td.r{text-align:right;}
      .total{border:1px solid #000;padding:8px;text-align:right;font-weight:700;font-size:13px;background:#f8f8f8;margin-bottom:10px;}
      .as-notice{font-size:10px;color:#444;line-height:1.6;border-top:1px solid #999;padding-top:8px;margin-top:8px;}
      .footer{margin-top:16px;text-align:center;font-size:9px;color:#999;}
      @media print{@page{margin:10mm;size:A4;}body{padding:0;}}</style></head><body>
      <div class="header-row"><div><strong>발행일자</strong> ${today}</div><div>${company.name||'대원메디칼'} 발행</div></div>
      <div class="title">거 래 명 세 서</div>
      <table class="info-table">
        <tr><td class="label">공급자</td><td colspan="3">${company.name||''} ${company.contact_name?`(${company.contact_name})`:''}</td><td class="label">전화</td><td>${company.phone||''}</td></tr>
        <tr><td class="label">주소</td><td colspan="5">${company.address||''}</td></tr>
        <tr><td class="label">공급받는자</td><td colspan="3"><strong>${contract.hospital_name||''}</strong> ${lead.contact_name?`(${lead.contact_name})`:''}</td><td class="label">전화</td><td>${lead.contact_phone||''}</td></tr>
        <tr><td class="label">주소</td><td colspan="5">${hospitalAddress||''}</td></tr>
      </table>
      <table class="items-table">
        <thead><tr>
          <th style="width:32px">No</th><th>품목</th><th style="width:130px">모델명</th>
          <th style="width:100px">제조사</th><th style="width:40px">수량</th>
          <th style="width:90px">단가</th><th style="width:100px">금액</th>
          <th style="width:60px">A/S</th><th style="width:60px">보증</th><th style="width:80px">납품일</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="total">총 합계: ${total.toLocaleString('ko-KR')}원 (${vatLabel})</div>
      <div class="as-notice">
        ※ 본 거래명세서는 향후 A/S 요청, 자산 관리에 활용되는 자료입니다. 분실 시 ${company.name||'당사'}에 문의 부탁드립니다.<br/>
        ※ A/S 문의: ${company.phone||''} ${company.contact_name?`(${company.contact_name})`:''}
      </div>
      <div class="footer">${company.name||''} · ${today}</div>
      <script>window.onload=function(){window.print();}<\/script>
      </body></html>`);
    win.document.close();
  };

  // 거래명세서 PDF 생성 — 내부용 (매입가/매출가/마진/거래처 표시)
  const handleInternalStatement = () => {
    if (!contract) { alert('계약 정보가 없습니다.'); return; }
    const company = (typeof getCompanyInfo === 'function') ? getCompanyInfo() : {};
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    if (sortedItems.length === 0) { alert('품목이 없습니다.'); return; }

    // 거래처별 그룹
    const groupedHtml = Object.entries(vendorGroups).map(([vendor, vItems]) => {
      const vendorSaleBase = vItems.reduce((s, it) => s + ((Number(it.salePrice)||0) * (Number(it.quantity)||0)), 0);
      const vendorPurchaseBase = vItems.reduce((s, it) => s + ((Number(it.purchasePrice)||0) * (Number(it.quantity)||0)), 0);
      const vendorSale = vatIncluded ? Math.round(vendorSaleBase * 1.1) : vendorSaleBase;
      const vendorPurchase = vatIncluded ? Math.round(vendorPurchaseBase * 1.1) : vendorPurchaseBase;
      const vendorMargin = vendorSale - vendorPurchase;
      const rows = vItems.map((it, i) => {
        const sale = vatIncluded ? Math.round(it.salePrice * 1.1) : it.salePrice;
        const purchase = vatIncluded ? Math.round(it.purchasePrice * 1.1) : it.purchasePrice;
        const margin = (sale - purchase) * it.quantity;
        return `<tr>
          <td class="c">${i+1}</td><td>${it.itemName}</td><td>${it.modelName}</td>
          <td>${it.manufacturer||'-'}</td>
          <td class="c">${it.quantity}</td>
          <td class="r">${sale.toLocaleString('ko-KR')}</td>
          <td class="r">${purchase.toLocaleString('ko-KR')}</td>
          <td class="r ${margin>=0?'pos':'neg'}">${margin.toLocaleString('ko-KR')}</td>
          <td class="c">${it.ordered ? '✓' : ''}</td>
          <td class="c">${it.delivered ? '✓' : ''}</td>
        </tr>`;
      }).join('');
      return `
        <div class="vendor-group">
          <div class="vendor-head">📦 ${vendor} <span style="color:#666;font-weight:400">· ${vItems.length}개 품목</span></div>
          <table class="items-table">
            <thead><tr>
              <th style="width:30px">No</th><th>품목</th><th style="width:120px">모델</th>
              <th style="width:100px">제조사</th><th style="width:36px">수량</th>
              <th style="width:80px">매출가</th><th style="width:80px">매입가</th>
              <th style="width:80px">마진</th>
              <th style="width:36px">발주</th><th style="width:36px">납품</th>
            </tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr class="vendor-sub">
              <td colspan="5" class="r"><strong>${vendor} 소계</strong></td>
              <td class="r"><strong>${vendorSale.toLocaleString('ko-KR')}</strong></td>
              <td class="r"><strong>${vendorPurchase.toLocaleString('ko-KR')}</strong></td>
              <td class="r ${vendorMargin>=0?'pos':'neg'}"><strong>${vendorMargin.toLocaleString('ko-KR')}</strong></td>
              <td colspan="2"></td>
            </tr></tfoot>
          </table>
        </div>`;
    }).join('');

    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { alert('팝업이 차단되었습니다.'); return; }
    win.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>내부 거래명세서</title>
      <style>@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap');
      *{box-sizing:border-box;margin:0;padding:0;}body{font-family:'Noto Sans KR',sans-serif;font-size:11px;color:#000;padding:20px 28px;}
      .header-row{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:6px;font-size:11px;}
      .title{text-align:center;font-size:24px;font-weight:900;letter-spacing:8px;padding:10px 0;margin-bottom:10px;border-top:2px solid #000;border-bottom:2px solid #000;}
      .meta{margin-bottom:10px;font-size:11px;display:flex;gap:16px;flex-wrap:wrap;}
      .summary{display:flex;gap:8px;margin-bottom:14px;}
      .summary>div{flex:1;border:1px solid #ccc;padding:8px;text-align:center;border-radius:4px;}
      .summary .label{font-size:10px;color:#666;}.summary .val{font-size:14px;font-weight:700;}
      .vendor-group{margin-bottom:14px;}.vendor-head{font-weight:700;background:#fef3c7;padding:6px 10px;border-radius:4px 4px 0 0;border:1px solid #d97706;border-bottom:none;}
      .items-table{width:100%;border-collapse:collapse;}
      .items-table th{border:1px solid #999;background:#f1f5f9;padding:5px 4px;font-size:10px;font-weight:700;text-align:center;}
      .items-table td{border:1px solid #ccc;padding:4px 4px;font-size:10px;vertical-align:middle;}
      .items-table td.c{text-align:center;}.items-table td.r{text-align:right;}
      .items-table .pos{color:#059669;}.items-table .neg{color:#dc2626;}
      .vendor-sub{background:#fef9c3;}
      .grand-total{border:2px solid #000;padding:10px;text-align:right;font-weight:700;font-size:13px;background:#fff;margin-top:10px;}
      .footer{margin-top:14px;text-align:center;font-size:9px;color:#999;}
      .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:120px;color:rgba(220,38,38,0.05);font-weight:900;pointer-events:none;z-index:-1;}
      @media print{@page{margin:8mm;size:A4 landscape;}body{padding:0;}}</style></head><body>
      <div class="watermark">INTERNAL</div>
      <div class="header-row"><div><strong>발행일자</strong> ${today} <span style="margin-left:12px;color:#dc2626;font-weight:700">⚠ 내부용 — 외부 유출 금지</span></div><div>${company.name||''}</div></div>
      <div class="title">내 부 거 래 명 세 서</div>
      <div class="meta">
        <div><strong>병원</strong> ${contract.hospital_name||'-'}</div>
        <div><strong>견적번호</strong> ${quote?.quoteNo||'-'}</div>
        <div><strong>납기일</strong> ${deliveryDate||'-'}</div>
      </div>
      <div class="summary">
        <div><div class="label">매출 합계 (${vatIncluded?'VAT포함':'VAT별도'})</div><div class="val">${totals.sale.toLocaleString('ko-KR')}</div></div>
        <div><div class="label">매입 합계</div><div class="val">${totals.purchase.toLocaleString('ko-KR')}</div></div>
        <div><div class="label">마진</div><div class="val" style="color:${totals.margin>=0?'#059669':'#dc2626'}">${totals.margin.toLocaleString('ko-KR')} (${totals.marginRate}%)</div></div>
        <div><div class="label">품목 / 거래처</div><div class="val">${sortedItems.length} / ${Object.keys(vendorGroups).length}</div></div>
      </div>
      ${groupedHtml}
      <div class="footer">${company.name||''} 내부 자료 · ${today}</div>
      <script>window.onload=function(){window.print();}<\/script>
      </body></html>`);
    win.document.close();
  };

  // 거래처별 PDF 생성
  const handleGeneratePdf = (vendor, items) => {
    if (!contract) return;
    const company = (typeof getCompanyInfo === 'function') ? getCompanyInfo() : {};
    const mfr = manufacturers.find(m => m.name === vendor);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const existingPo = pos.find(p => p.manufacturer_name === vendor);
    const poNo = existingPo?.po_no || `PO-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const totalBase = items.reduce((s, it) => s + ((Number(it.purchasePrice)||0) * (Number(it.quantity)||0)), 0);
    const total = vatIncluded ? Math.round(totalBase * 1.1) : totalBase;
    const vatLabel = vatIncluded ? 'VAT 포함' : 'VAT 별도';
    const rowSlots = 15;
    const itemContact = items.find(i => i.vendorContactName || i.vendorContactPhone);

    const printWin = window.open('', '_blank', 'width=900,height=700');
    if (!printWin) { alert('팝업이 차단되었습니다.'); return; }
    const itemRows = [];
    for (let i = 0; i < rowSlots; i++) {
      const it = items[i];
      if (it) itemRows.push(`<tr><td class="c">${i+1}</td><td>${it.itemName||''}</td><td>${it.modelName||''}</td><td class="c">${it.quantity}</td><td class="r">${(it.purchasePrice||0).toLocaleString('ko-KR')}</td><td class="r">${(it.purchasePrice*it.quantity).toLocaleString('ko-KR')}</td></tr>`);
      else itemRows.push(`<tr><td class="c">${i+1}</td><td></td><td></td><td></td><td></td><td></td></tr>`);
    }
    printWin.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>발주서 - ${vendor}</title>
      <style>@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap');
      *{box-sizing:border-box;margin:0;padding:0;}body{font-family:'Noto Sans KR',sans-serif;font-size:11px;color:#000;padding:24px 32px;}
      .header-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}.title{text-align:center;font-size:40px;font-weight:900;letter-spacing:20px;padding:14px 0;margin-bottom:12px;border-top:3px double #000;border-bottom:3px double #000;}
      .info-table{width:100%;border-collapse:collapse;margin-bottom:10px;}.info-table td{border:1px solid #000;padding:5px 8px;height:24px;font-size:11px;vertical-align:middle;}.info-table td.label{background:#f0f0f0;font-weight:700;text-align:center;width:70px;}.info-table td.sep{border-right:2px solid #000;width:8px;background:#fff;border-top:none;border-bottom:none;}
      .items-table{width:100%;border-collapse:collapse;margin-bottom:10px;}.items-table th{border:1px solid #000;background:#e8e8e8;padding:6px 4px;font-size:11px;font-weight:700;text-align:center;}.items-table td{border:1px solid #000;padding:5px 6px;height:26px;font-size:11px;}.items-table td.c{text-align:center;}.items-table td.r{text-align:right;}
      .total-row{border:1px solid #000;border-top:none;}.total-row td{border:1px solid #000;padding:8px;font-size:12px;font-weight:700;height:30px;}.total-row td.label{background:#f0f0f0;text-align:center;}.total-row td.amount{text-align:right;font-size:13px;}
      .notes-box{border:1px solid #000;padding:10px;min-height:60px;margin-top:8px;}.notes-box .title-sm{font-weight:700;margin-bottom:6px;}.notes-box .content{font-size:10px;line-height:1.6;color:#333;}
      .footer{margin-top:12px;text-align:center;font-size:9px;color:#999;}@media print{@page{margin:10mm;size:A4;}body{padding:0;}}</style></head>
      <body>
      <div class="header-row"><div><strong>발행일자</strong> ${today}</div><div><strong>No.</strong> ${poNo}</div></div>
      <div class="title">발 주 서</div>
      <table class="info-table">
        <tr><td class="label">발주처</td><td colspan="2">${company.name||''}</td><td class="sep"></td><td class="label">병원명</td><td colspan="2">${contract.hospital_name||''}</td></tr>
        <tr><td class="label">전화</td><td>${company.phone||''}</td><td class="label">팩스</td><td class="sep"></td><td class="label">주소</td><td colspan="2">${company.address||''}</td></tr>
        <tr><td class="label">담당자</td><td>${company.contact_name||''}</td><td class="label">H.P</td><td class="sep"></td><td class="label">담당</td><td colspan="2">${lead.contact_name||''}${lead.dept ? ' ('+lead.dept+')' : ''}</td></tr>
        <tr><td class="label">매입처</td><td>${vendor}</td><td class="label">담당</td><td class="sep"></td><td class="label">전화</td><td colspan="2">${lead.contact_phone||''}</td></tr>
        <tr><td class="label">담당</td><td>${itemContact?.vendorContactName || mfr?.contact_name || ''}</td><td class="label">전화</td><td class="sep"></td><td class="label">납기일</td><td colspan="2"><strong>${contract.delivery_target_date||''}</strong></td></tr>
        <tr><td class="label">전화</td><td>${itemContact?.vendorContactPhone || mfr?.contact_phone || ''}</td><td class="label">팩스</td><td class="sep"></td><td class="label">결제조건</td><td colspan="2">${mfr?.payment_terms||''}</td></tr>
      </table>
      <table class="items-table"><thead><tr><th style="width:40px">No.</th><th>품목</th><th style="width:140px">규격</th><th style="width:60px">수량</th><th style="width:110px">단가</th><th style="width:110px">금액</th></tr></thead><tbody>${itemRows.join('')}</tbody></table>
      <table class="total-row"><tr><td class="label" style="width:40px"></td><td class="label" style="width:160px">총 합 계</td><td></td><td style="width:60px"></td><td class="amount" style="width:110px">${total.toLocaleString('ko-KR')}</td><td class="label" style="width:140px">${vatLabel}</td></tr></table>
      <div class="notes-box"><div class="title-sm">특이사항</div><div class="content">• 상기 품목을 <strong>${contract.delivery_target_date||'협의된 납기일'}</strong>까지 <strong>${contract.hospital_name||'납품처'}</strong>로 직접 배송 부탁드립니다.<br/>• 제품 검수 후 인수증을 회신해 주시기 바랍니다.${mfr?.payment_terms?'<br/>• 결제조건: '+mfr.payment_terms:''}</div></div>
      <div class="footer">${company.name||''} · ${today}</div>
      <script>window.onload=function(){window.print();}<\/script>
      </body></html>`);
    printWin.document.close();
  };

  return (
    <div style={{height:'100vh',display:'flex',flexDirection:'column',overflow:'hidden',background:'#f1f5f9'}}>
      <AppHeader title="발주 계획서" badge={lead?.quote_no || ''} onLogoClick={handleBack} user={user} onLogout={onLogout} nav={nav}>
        <button onClick={handleBack} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 hover:bg-slate-800 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18"/></svg>
          {backLabel}
        </button>
        <button onClick={reloadFromQuote} disabled={loading || !quote}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-50 transition-colors">
          견적에서 다시 불러오기
        </button>
        <button onClick={handleHospitalStatement} disabled={loading || !contract}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors">
          거래명세서 (병원용)
        </button>
        <button onClick={handleInternalStatement} disabled={loading || !contract}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-50 transition-colors">
          거래명세서 (내부용)
        </button>
      </AppHeader>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400">불러오는 중...</div>
        ) : !quote ? (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400">
            견적서를 찾을 수 없습니다 ({lead?.quote_no})
          </div>
        ) : (
          <div className="max-w-7xl mx-auto space-y-1">
            {/* 헤더 정보 */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
              <div className="grid grid-cols-12 gap-4 items-start">
                <div className="col-span-3">
                  <div className="text-xs text-slate-500 mb-1">병원 / 담당자</div>
                  <div className="font-bold text-slate-900">{quote.hospital || lead.hospital_name || '-'}</div>
                  <div className="text-sm text-slate-600">{quote.doctor || lead.contact_name} {lead.dept && `· ${lead.dept}`}</div>
                </div>
                <div className="col-span-2">
                  <div className="text-xs text-slate-500 mb-1">견적번호</div>
                  <div className="font-mono font-semibold text-slate-800">{quote.quoteNo}</div>
                </div>
                <div className="col-span-3">
                  <label className="text-xs text-slate-500 mb-1 block">납기일</label>
                  <input type="date" value={deliveryDate} onChange={e => { setDeliveryDate(e.target.value); setDirty(true); }}
                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
                <div className="col-span-4 flex items-end justify-end text-xs text-slate-400">
                  모든 단가는 부가세 포함 기준
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">병원 주소 <span className="text-slate-400 font-normal">(저장 시 병원 정보에 반영됨)</span></label>
                <input value={hospitalAddress} onChange={e => { setHospitalAddress(e.target.value); setDirty(true); }}
                  placeholder="예: 서울특별시 강남구 테헤란로 123, 대원빌딩 5층"
                  className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
              </div>
            </div>

            {/* 합계 카드 */}
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="grid grid-cols-4 gap-4">
                <div>
                  <div className="text-xs text-slate-500">매출 합계</div>
                  <div className="text-lg font-bold text-slate-800 tnum">{totals.sale.toLocaleString('ko-KR')}원</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">매입 합계</div>
                  <div className="text-lg font-bold text-slate-800 tnum">{totals.purchase.toLocaleString('ko-KR')}원</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">예상 마진</div>
                  <div className={`text-lg font-bold tnum ${totals.margin >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {totals.margin.toLocaleString('ko-KR')}원 ({totals.marginRate}%)
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">품목 / 거래처</div>
                  <div className="text-lg font-bold text-slate-800">{sortedItems.length}개 / {Object.keys(vendorGroups).length}곳</div>
                </div>
              </div>
            </div>

            {/* 단일 표 — 한 줄 = 한 발주(품목) */}
            {sortedItems.length > 0 && (
              <div className="bg-white border border-slate-200 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-100 text-slate-600 text-[11px] uppercase">
                    <tr>
                      <th className="px-2 py-2 text-center w-8">No</th>
                      <th className="px-2 py-2 text-left w-24">PO번호</th>
                      <th className="px-2 py-2 text-left w-32">거래처</th>
                      <th className="px-2 py-2 text-left whitespace-nowrap" style={{minWidth:'210px'}}>모델명 / 제조사</th>
                      <th className="px-2 py-2 text-center w-14">수량</th>
                      <th className="px-2 py-2 text-right w-24">매출단가</th>
                      <th className="px-2 py-2 text-right w-28">매출공급가액</th>
                      <th className="px-2 py-2 text-right w-24">매입단가</th>
                      <th className="px-2 py-2 text-right w-28">매입공급가액</th>
                      <th className="px-2 py-2 text-right w-28">마진</th>
                      <th className="px-2 py-2 text-center w-14">발주</th>
                      <th className="px-2 py-2 text-center w-14">입금</th>
                      <th className="px-2 py-2 text-center w-20">세금계산서</th>
                      <th className="px-2 py-2 text-center w-14">납품</th>
                      <th className="px-2 py-2 text-left w-40">메모</th>
                      <th className="px-2 py-2 text-center w-16">담당자</th>
                      <th className="px-2 py-2 text-center w-14">카톡</th>
                      <th className="px-2 py-2 text-center w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedItems.map((it, idx) => {
                      const po = pos.find(p => (p.purchase_order_items||[]).some(pi => pi.id === it.poItemId)) || pos.find(p => p.manufacturer_name === it.vendor);
                      const poNo = po ? `${po.po_no}${po.revision ? '-R'+po.revision : ''}` : <span className="text-slate-400">신규</span>;
                      const today = () => new Date().toISOString().slice(0,10);
                      const saleAmt = (Number(it.salePrice)||0) * (Number(it.quantity)||0);
                      const purAmt  = (Number(it.purchasePrice)||0) * (Number(it.quantity)||0);
                      const IconPill = ({ on, icon, title, onClick }) => (
                        <button onClick={onClick} title={title}
                          className={`inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${on ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}>
                          {icon}
                        </button>
                      );
                      const ICON = {
                        send: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>,
                        cash: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>,
                        doc:  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>,
                        box:  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>,
                      };
                      const sendKakaoOne = () => {
                        const company = (typeof getCompanyInfo === 'function') ? getCompanyInfo() : {};
                        const cleanName = (company.name || '대원메디칼').replace(/^(주식회사|㈜|\(주\))\s*/, '').trim();
                        const cleanCo = `(주)${cleanName}`;
                        const sender = '권우혁';
                        const fmtKDate = (s) => {
                          if (!s) return '';
                          const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
                          if (!m) return s;
                          const d = new Date(`${s}T00:00:00`);
                          const days = ['일','월','화','수','목','금','토'];
                          return `${parseInt(m[2])}월 ${parseInt(m[3])}일 ${days[d.getDay()]}요일`;
                        };
                        // 거래처 담당자 이름이 있으면 그 사람 기준으로 인사
                        const vMfr = manufacturers.find(m => m.name === it.vendor);
                        const contactName = (vMfr?.contact_name || '').trim();
                        const greeting = contactName ? `${contactName}님 안녕하세요` : '대표님 안녕하세요';
                        const lines = [];
                        lines.push(`${greeting} ${cleanCo} ${sender}입니다.`);
                        lines.push('발주내용 보내드립니다.');
                        lines.push('');
                        lines.push(`${it.modelName || it.itemName || ''} ${it.quantity}대`);
                        lines.push('');
                        const hosp = quote.hospital || lead.hospital_name || '';
                        if (hosp) lines.push(`병원명 : ${hosp}`);
                        if (hospitalAddress) lines.push(`주소 : ${hospitalAddress}`);
                        if (deliveryDate) lines.push(`납품일자 : ${fmtKDate(deliveryDate)}`);
                        lines.push('담당자 : 010-9471-0522 최윤철 과장');
                        lines.push('');
                        lines.push('감사합니다.');
                        lines.push(`${sender}올림`);
                        setKakaoModal({ vendor: it.vendor, text: lines.join('\n') });
                      };
                      return (
                        <tr key={it.key} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-2 py-1.5 text-center font-mono text-xs text-slate-400 font-semibold">{idx + 1}</td>
                          <td className="px-2 py-1.5 font-mono text-[10px] text-slate-500">{poNo}</td>
                          <td className="px-2 py-1.5 text-slate-800 font-medium">
                            {it.poItemId ? (it.vendor || <span className="text-amber-600">미지정</span>) : (
                              <button type="button" onClick={()=>setVendorPickFor(it.key)}
                                className={`w-full text-left px-1.5 py-0.5 border rounded text-xs ${it.vendor ? 'border-slate-200 bg-white' : 'border-amber-300 bg-amber-50'}`}>
                                {it.vendor || <span className="text-amber-600">거래처 선택</span>}
                              </button>
                            )}
                          </td>
                          <td className="px-2 py-1.5 align-top" style={{minWidth:'210px'}}>
                            {it.poItemId ? (
                              <>
                                <div className="text-slate-800 whitespace-nowrap">{it.modelName || it.itemName || '—'}</div>
                                {it.manufacturer && <div className="text-[10px] text-slate-400 whitespace-nowrap">{it.manufacturer}</div>}
                              </>
                            ) : (
                              <>
                                <input list={`model-list-${it.key}`} value={it.modelName || ''}
                                  onChange={e => {
                                    const v = e.target.value;
                                    const eq = equipments.find(eq => (eq.vendor === it.vendor || eq.model?.manufacturer === it.vendor) && eq.model?.name === v);
                                    if (eq) setItem(it.key, { modelName: v, manufacturer: eq.model?.manufacturer || '', purchasePrice: Number(eq.purchasePrice)||0, salePrice: Number(eq.model?.price)||0, itemName: eq.catName || v });
                                    else setItem(it.key, { modelName: v });
                                  }}
                                  placeholder={it.vendor ? '모델 선택/입력' : '거래처 먼저 선택'}
                                  disabled={!it.vendor}
                                  className="w-full px-1 py-0.5 border border-slate-200 rounded text-xs disabled:bg-slate-50"/>
                                <datalist id={`model-list-${it.key}`}>
                                  {equipments.filter(eq => eq.vendor === it.vendor || eq.model?.manufacturer === it.vendor).map(eq => <option key={eq.id} value={eq.model?.name || ''}>{eq.model?.manufacturer || ''}</option>)}
                                </datalist>
                              </>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <EditableNumber value={it.quantity} onSave={v => setItem(it.key, { quantity: Math.max(1, v||1) })} />
                          </td>
                          <td className="px-2 py-1.5 text-right text-slate-700">
                            <EditableNumber value={Number(it.salePrice)||0} onSave={v => setItem(it.key, { salePrice: Math.max(0, v||0) })} />
                          </td>
                          <td className="px-2 py-1.5 text-right font-medium text-slate-800 tabular-nums">
                            {saleAmt.toLocaleString()}
                          </td>
                          <td className="px-2 py-1.5 text-right text-slate-700">
                            <EditableNumber value={Number(it.purchasePrice)||0} onSave={v => setItem(it.key, { purchasePrice: Math.max(0, v||0) })} />
                          </td>
                          <td className="px-2 py-1.5 text-right font-medium text-slate-800 tabular-nums">
                            {purAmt.toLocaleString()}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {(() => {
                              const m = saleAmt - purAmt;
                              const rate = saleAmt > 0 ? Math.round(m / saleAmt * 1000) / 10 : 0;
                              return (
                                <span className={`font-semibold ${m >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                  {m.toLocaleString()}
                                  {saleAmt > 0 && <span className="text-[10px] text-slate-400 ml-1">{rate}%</span>}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-2 py-1.5 text-center"><IconPill on={it.ordered} icon={ICON.send} title={it.ordered ? `발주: ${it.ordered_at||''}` : '발주'}
                            onClick={() => setItem(it.key, { ordered: !it.ordered, ordered_at: !it.ordered ? (it.ordered_at||today()) : null })}/></td>
                          <td className="px-2 py-1.5 text-center"><IconPill on={it.paid} icon={ICON.cash} title={it.paid ? `입금: ${it.paid_at||''}` : '입금'}
                            onClick={() => setItem(it.key, { paid: !it.paid, paid_at: !it.paid ? (it.paid_at||today()) : null })}/></td>
                          <td className="px-2 py-1.5 text-center"><IconPill on={it.taxInvoiced} icon={ICON.doc} title={it.taxInvoiced ? `세금계산서: ${it.tax_invoiced_at||''}` : '세금계산서'}
                            onClick={() => setItem(it.key, { taxInvoiced: !it.taxInvoiced, tax_invoiced_at: !it.taxInvoiced ? (it.tax_invoiced_at||today()) : null })}/></td>
                          <td className="px-2 py-1.5 text-center"><IconPill on={it.delivered} icon={ICON.box} title={it.delivered ? `납품: ${it.delivered_at||''}` : '납품'}
                            onClick={() => setItem(it.key, { delivered: !it.delivered, delivered_at: !it.delivered ? (it.delivered_at||today()) : null })}/></td>
                          <td className="px-2 py-1.5">
                            <button onClick={() => setItemMemoModal({ key: it.key, item: it })}
                              className={`w-full text-left px-2 py-1 rounded text-[11px] border ${it.memo ? 'bg-amber-50 border-amber-200 text-amber-800 hover:bg-amber-100' : 'border-dashed border-slate-200 text-slate-400 hover:bg-slate-50'}`}
                              title={it.memo || '메모 작성'}>
                              {it.memo ? <span className="line-clamp-1 break-all">{it.memo.split('\n')[0]}</span> : <span>+ 메모</span>}
                            </button>
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            {(() => {
                              const vMfr = manufacturers.find(m => m.name === it.vendor);
                              const hasContact = !!((vMfr?.contact_name || '').trim() || (vMfr?.contact_phone || '').trim());
                              return (
                                <button onClick={() => setContactModal({ vendor: it.vendor, items: [it] })}
                                  title={hasContact ? '담당자 / 연락처' : '담당자 정보 미입력 — 클릭하여 등록'}
                                  className={`inline-flex items-center justify-center w-7 h-7 rounded border ${
                                    hasContact
                                      ? 'bg-slate-100 text-slate-600 hover:bg-slate-200 border-slate-200'
                                      : 'bg-rose-100 text-rose-700 hover:bg-rose-200 border-rose-300 ring-1 ring-rose-200 animate-pulse'
                                  }`}>
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
                                  </svg>
                                </button>
                              );
                            })()}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button onClick={sendKakaoOne}
                              title="카카오톡 발주서 메시지"
                              className="inline-flex items-center justify-center w-7 h-7 rounded bg-yellow-400 text-slate-900 hover:bg-yellow-300">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                              </svg>
                            </button>
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button onClick={() => removePlanItem(it.key)} title="이 발주 제거"
                              className="text-slate-300 hover:text-red-500 text-sm leading-none">✕</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* + 품목 추가 (별도 발주) */}
            {!loading && quote && (
              <button onClick={() => addPlanItem('')}
                className="w-full py-3 border-2 border-dashed border-slate-200 rounded text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors">
                + 발주 추가 (거래처는 행에서 선택)
              </button>
            )}

            {sortedItems.length === 0 && (
              <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400">발주할 품목이 없습니다.</div>
            )}
          </div>
        )}
      </div>

      {/* 하단 저장 바 */}
      {!loading && quote && (
        <div className="shrink-0 border-t border-slate-200 bg-white px-6 py-3 flex items-center justify-between">
          <div className="text-sm">
            {dirty
              ? <span className="text-amber-600 font-medium">● 저장하지 않은 변경사항이 있습니다</span>
              : <span className="text-slate-400">모든 변경사항이 저장되었습니다</span>}
          </div>
          <button onClick={handleSave} disabled={saving || !contract}
            className="px-7 py-2.5 text-sm bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-500 disabled:opacity-50 transition-colors shadow-sm">
            {saving ? '저장 중...' : '발주 계획 저장'}
          </button>
        </div>
      )}

      {kakaoModal && (
        <KakaoMessageModal
          vendor={kakaoModal.vendor}
          text={kakaoModal.text}
          onClose={() => setKakaoModal(null)}
        />
      )}
      {itemMemoModal && (
        <ItemMemoModal
          item={itemMemoModal.item}
          onSave={(text) => { setItem(itemMemoModal.key, { memo: text }); setItemMemoModal(null); }}
          onClose={() => setItemMemoModal(null)}
        />
      )}
      {hospitalPickerOpen && (
        <VendorPickerModal
          allowedKinds="hospital"
          defaultFilter="hospital"
          onClose={() => {
            if (hospitalMustPick) {
              if (!confirm('병원을 선택하지 않으면 발주계획서를 진행할 수 없습니다. 영업관리로 돌아갈까요?')) return;
              onBack?.();
            } else {
              setHospitalPickerOpen(false);
            }
          }}
          onSelect={async (it) => {
            try {
              // contract / lead 양쪽 update
              if (contract?.id) await sb.from('contracts').update({ hospital_id: it.id, hospital_name: it.name }).eq('id', contract.id);
              if (lead?.id) await sb.from('leads').update({ hospital_id: it.id, hospital_name: it.name }).eq('id', lead.id);
              setContract(p => p ? { ...p, hospital_id: it.id, hospital_name: it.name } : p);
              // hospital row 로드 후 주소 채움
              const { data: hRow } = await sb.from('hospitals').select('*').eq('id', it.id).maybeSingle();
              if (hRow) { setHospitalRow(hRow); setHospitalAddress(hRow.address || ''); }
              // 부모 lead state 갱신
              onLeadUpdate?.(lead?.id, { hospital_id: it.id, hospital_name: it.name });
              setHospitalMustPick(false);
              setHospitalPickerOpen(false);
            } catch (e) { alert('병원 연결 실패: ' + (e.message||e)); }
          }}
        />
      )}
      {vendorPickFor && (
        <VendorPickerModal
          allowedKinds="vendor"
          defaultFilter="vendor"
          onClose={()=>setVendorPickFor(null)}
          onSelect={(it)=>setItem(vendorPickFor, { vendor: it.name, modelName: '', manufacturer: '', purchasePrice: 0, salePrice: 0 })}
        />
      )}
      {contactModal && (
        <VendorContactModal
          vendor={contactModal.vendor}
          items={contactModal.items}
          manufacturers={manufacturers}
          onSave={(patch) => {
            // 거래처의 모든 행에 담당자/연락처 반영 + manufacturers 마스터도 갱신
            contactModal.items.forEach(it => setItem(it.key, { vendorContactName: patch.contact_name, vendorContactPhone: patch.contact_phone }));
            const mfr = manufacturers.find(m => m.name === contactModal.vendor);
            if (mfr) { try { dbUpdateManufacturer(mfr.id, { contact_name: patch.contact_name, contact_phone: patch.contact_phone }); } catch(_){} }
            setContactModal(null);
          }}
          onClose={() => setContactModal(null)}
        />
      )}
    </div>
  );
}

function VendorContactModal({ vendor, items, manufacturers = [], onSave, onClose }) {
  const mfr = manufacturers.find(m => m.name === vendor);
  const first = items?.[0] || {};
  const [name, setName] = React.useState(first.vendorContactName || mfr?.contact_name || '');
  const [phone, setPhone] = React.useState(first.vendorContactPhone || mfr?.contact_phone || '');
  const inputCls = "bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400";
  return (
    <ModalShell title={`거래처 담당자 — ${vendor}`} onClose={onClose}>
      <div className="space-y-3 mb-4">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">담당자명</label>
          <input value={name} onChange={e=>setName(e.target.value)} className={`w-full ${inputCls}`} placeholder="담당자 이름"/>
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">연락처</label>
          <input value={phone} onChange={e=>setPhone(e.target.value)} className={`w-full ${inputCls}`} placeholder="010-0000-0000"/>
        </div>
        <div className="text-[11px] text-slate-400">저장 시 거래처 마스터(거래처 관리)에도 함께 갱신됩니다.</div>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500 hover:bg-slate-100 rounded">취소</button>
        <button onClick={() => onSave({ contact_name: name.trim(), contact_phone: phone.trim() })}
          className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded font-semibold">저장</button>
      </div>
    </ModalShell>
  );
}

function EditableNumber({ value, onSave, className = '', display }) {
  const [editing, setEditing] = React.useState(false);
  const [tmp, setTmp] = React.useState('');
  const v = Number(value) || 0;
  const shown = display ? display(v) : v.toLocaleString();
  if (editing) {
    return (
      <input autoFocus type="text" value={tmp}
        onChange={e => setTmp(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={() => { onSave(Number(tmp)||0); setEditing(false); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { onSave(Number(tmp)||0); setEditing(false); }
          if (e.key === 'Escape') setEditing(false);
        }}
        className={`px-1 py-0.5 border border-blue-400 rounded text-xs font-mono w-full text-right ${className}`}/>
    );
  }
  return (
    <span onDoubleClick={() => { setTmp(String(v)); setEditing(true); }}
      className={`cursor-pointer hover:bg-blue-50 px-1 rounded inline-block font-mono ${className}`}
      title="더블클릭하여 수정">{shown}</span>
  );
}

function ItemMemoModal({ item, onSave, onClose }) {
  const [text, setText] = React.useState(item?.memo || '');
  return (
    <ModalShell
      title={`품목 메모`}
      subtitle={`${item?.itemName || ''}${item?.modelName ? ' · ' + item.modelName : ''}${item?.vendor ? ' · ' + item.vendor : ''}`}
      onClose={onClose}>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={10}
        autoFocus
        placeholder="이 품목의 특이사항·이슈·변경 내역을 자유롭게 기록하세요.

예)
- 5/15 원장이 모델 X로 변경 요청
- 5/20 매입가 1,000,000 → 1,200,000 협상 완료
- 5/25 도착 예정 (영남베드 → 카톡 확인)"
        className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400 leading-relaxed"
        style={{minHeight:'240px', resize:'vertical'}} />
      <div className="flex items-center justify-end gap-2 mt-3">
        <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500 hover:bg-slate-100 rounded">취소</button>
        <button onClick={() => onSave(text)}
          className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded font-semibold">저장 후 닫기</button>
      </div>
    </ModalShell>
  );
}

// 카톡 발주 메시지 모달
function KakaoMessageModal({ vendor, text, onClose }) {
  const [editText, setEditText] = React.useState(text);
  const [copied, setCopied] = React.useState(false);
  const taRef = React.useRef(null);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(editText);
      } else if (taRef.current) {
        taRef.current.select();
        document.execCommand('copy');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert('복사에 실패했습니다. 메시지를 직접 선택해 복사해주세요.');
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center" style={{background:'rgba(0,0,0,0.6)'}}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden flex flex-col" style={{maxHeight:'85vh'}}>
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div>
            <div className="font-bold text-slate-900 flex items-center gap-2">💬 카톡 발주 메시지</div>
            <div className="text-xs text-slate-500 mt-0.5">{vendor}</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1">
          <div className="text-xs text-slate-500 mb-2">아래 내용을 복사해서 카톡에 붙여넣으세요. 필요시 수정 가능합니다.</div>
          <textarea ref={taRef} value={editText} onChange={e => setEditText(e.target.value)}
            rows={Math.min(20, Math.max(8, editText.split('\n').length + 2))}
            className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm font-mono whitespace-pre-wrap focus:outline-none focus:ring-2 focus:ring-yellow-400"
            style={{lineHeight:'1.6', resize:'vertical'}}/>
        </div>

        <div className="px-6 py-3 border-t border-slate-100 flex justify-between items-center shrink-0">
          <span className={`text-xs font-semibold transition-opacity ${copied ? 'text-emerald-600 opacity-100' : 'opacity-0'}`}>
            ✓ 복사되었습니다
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded hover:bg-slate-50">닫기</button>
            <button onClick={handleCopy}
              className="px-5 py-2 text-sm bg-yellow-400 text-slate-900 rounded font-bold hover:bg-yellow-300">
              복사
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 장비 매입가 이력 모달
function PriceHistoryModal({ equipment, onClose }) {
  const [history, setHistory] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      try { setHistory(await dbLoadPriceHistory(equipment.id)); }
      finally { setLoading(false); }
    })();
  }, [equipment.id]);

  const stats = React.useMemo(() => {
    if (history.length === 0) return null;
    const prices = history.map(h => Number(h.price)).filter(p => p > 0);
    if (prices.length === 0) return null;
    return {
      avg: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length),
      min: Math.min(...prices),
      max: Math.max(...prices),
      count: prices.length,
    };
  }, [history]);

  // 차트용 데이터 (오래된 → 최신)
  const chartData = React.useMemo(() => {
    return [...history].reverse().map((h, i) => ({
      idx: i + 1,
      date: h.recorded_at ? h.recorded_at.slice(5, 10) : '',
      price: Number(h.price) || 0,
    }));
  }, [history]);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center" style={{background:'rgba(0,0,0,0.6)'}}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden flex flex-col" style={{maxHeight:'85vh'}}>
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div>
            <div className="font-bold text-slate-900 flex items-center gap-2">📈 매입가 이력</div>
            <div className="text-xs text-slate-500 mt-0.5">{equipment.itemName} · {equipment.model.name} · {equipment.model.manufacturer}</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1">
          {loading ? (
            <div className="text-center text-slate-400 py-12 text-sm">불러오는 중...</div>
          ) : history.length === 0 ? (
            <div className="text-center text-slate-400 py-12 text-sm">
              <div className="text-4xl mb-2">📭</div>
              <div>아직 기록된 매입가 변동이 없습니다.</div>
              <div className="text-xs text-slate-300 mt-2">발주 수정 시 단가를 변경하면 자동으로 기록됩니다.</div>
            </div>
          ) : (
            <>
              {/* 통계 */}
              {stats && (
                <div className="grid grid-cols-4 gap-3 mb-4">
                  <div className="bg-slate-50 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-slate-500 mb-0.5">기록 건수</div>
                    <div className="font-bold text-slate-800 text-sm">{stats.count}건</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-slate-500 mb-0.5">평균</div>
                    <div className="font-bold text-slate-800 text-sm tnum">{stats.avg.toLocaleString('ko-KR')}</div>
                  </div>
                  <div className="bg-emerald-50 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-emerald-600 mb-0.5">최저</div>
                    <div className="font-bold text-emerald-700 text-sm tnum">{stats.min.toLocaleString('ko-KR')}</div>
                  </div>
                  <div className="bg-red-50 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-red-600 mb-0.5">최고</div>
                    <div className="font-bold text-red-700 text-sm tnum">{stats.max.toLocaleString('ko-KR')}</div>
                  </div>
                </div>
              )}

              {/* 차트 */}
              {chartData.length >= 2 && window.Recharts && (
                <div className="bg-white border border-slate-200 rounded-lg p-3 mb-4" style={{height:200}}>
                  {React.createElement(window.Recharts.ResponsiveContainer, { width:'100%', height:'100%' },
                    React.createElement(window.Recharts.LineChart, { data: chartData },
                      React.createElement(window.Recharts.CartesianGrid, { strokeDasharray:'3 3', stroke:'#e2e8f0' }),
                      React.createElement(window.Recharts.XAxis, { dataKey:'date', tick:{fontSize:11}, stroke:'#94a3b8' }),
                      React.createElement(window.Recharts.YAxis, { tick:{fontSize:11}, stroke:'#94a3b8', tickFormatter:(v)=> (v/10000).toFixed(0)+'만' }),
                      React.createElement(window.Recharts.Tooltip, { formatter:(v)=> [Number(v).toLocaleString('ko-KR')+'원','매입가'] }),
                      React.createElement(window.Recharts.Line, { type:'monotone', dataKey:'price', stroke:'#3b82f6', strokeWidth:2, dot:{r:4} })
                    )
                  )}
                </div>
              )}

              {/* 이력 테이블 */}
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left">일시</th>
                      <th className="px-3 py-2 text-right">매입가</th>
                      <th className="px-3 py-2 text-center">변동</th>
                      <th className="px-3 py-2 text-left">발주번호</th>
                      <th className="px-3 py-2 text-left">거래처</th>
                      <th className="px-3 py-2 text-left">메모</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map(h => {
                      const price = Number(h.price)||0, prev = Number(h.prev_price)||0;
                      const diff = prev > 0 ? price - prev : 0;
                      const pct = prev > 0 ? Math.round((diff/prev)*100*10)/10 : 0;
                      return (
                        <tr key={h.id} className="border-t border-slate-100">
                          <td className="px-3 py-2 text-slate-700">{h.recorded_at ? h.recorded_at.slice(0,16).replace('T',' ') : '-'}</td>
                          <td className="px-3 py-2 text-right tnum font-semibold text-slate-800">{price.toLocaleString('ko-KR')}</td>
                          <td className="px-3 py-2 text-center">
                            {prev > 0 ? (
                              <span className={`text-xs font-semibold ${diff > 0 ? 'text-red-600' : diff < 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                                {diff > 0 ? '▲' : diff < 0 ? '▼' : '='} {Math.abs(pct)}%
                              </span>
                            ) : <span className="text-slate-300 text-xs">-</span>}
                          </td>
                          <td className="px-3 py-2 font-mono text-[10px] text-slate-500">{h.po_no || (h.source==='manual' ? '수동' : '-')}</td>
                          <td className="px-3 py-2 text-slate-600">{h.vendor || '-'}</td>
                          <td className="px-3 py-2 text-slate-500 truncate max-w-[200px]">{h.note || '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-slate-100 flex justify-end shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded hover:bg-slate-50">닫기</button>
        </div>
      </div>
    </div>
  );
}

function PoRevisionEditModal({ po, items, totalSale, mfrName, equipments = [], onClose, onSaved }) {
  const [editItems, setEditItems] = React.useState(() => items.map(i => ({
    item_name: i.itemName, model_name: i.modelName, manufacturer: i.manufacturer || mfrName,
    quantity: i.quantity, unit_price: i.purchase_price || 0,
    _origPrice: i.purchase_price || 0,
  })));
  const [reason, setReason] = React.useState('');
  const [deliveryDate, setDeliveryDate] = React.useState(po.delivery_date || '');
  const [notes, setNotes] = React.useState(po.notes || '');
  const [saving, setSaving] = React.useState(false);

  const totalPurchase = editItems.reduce((s, it) => s + (Number(it.unit_price)||0) * (Number(it.quantity)||0), 0);
  const margin = totalSale - totalPurchase;
  const marginRate = totalSale > 0 ? Math.round((margin / totalSale) * 100) : 0;
  const isDeficit = totalPurchase > 0 && margin < 0;

  const setItem = (idx, key, val) => setEditItems(p => p.map((it, i) => i === idx ? { ...it, [key]: val } : it));
  const addItem = () => setEditItems(p => [...p, { item_name:'', model_name:'', manufacturer: mfrName, quantity:1, unit_price:0 }]);
  const removeItem = (idx) => setEditItems(p => p.filter((_, i) => i !== idx));

  const handleSave = async () => {
    if (!reason.trim()) { alert('변경 사유를 입력해주세요.'); return; }
    if (editItems.length === 0) { alert('품목이 1개 이상 있어야 합니다.'); return; }
    setSaving(true);
    try {
      const cleanItems = editItems.map(it => ({
        item_name: (it.item_name||'').trim(),
        model_name: (it.model_name||'').trim(),
        manufacturer: it.manufacturer || mfrName,
        quantity: Number(it.quantity)||1,
        unit_price: Number(it.unit_price)||0,
        amount: (Number(it.quantity)||1) * (Number(it.unit_price)||0),
      }));
      const newPoData = {
        contract_id: po.contract_id,
        manufacturer_id: po.manufacturer_id,
        manufacturer_name: po.manufacturer_name,
        hospital_name: po.hospital_name,
        delivery_date: deliveryDate || null,
        total_amount: totalPurchase,
        sale_amount: totalSale,
        notes: notes || null,
        status: po.status || '준비중',
        ordered_at: po.ordered_at,
        delivered: false,
        delivered_at: null,
      };
      const { newPoId, newPoNo } = await dbSavePurchaseOrderRevision(po.id, newPoData, cleanItems, reason.trim());

      // 매입가 변경 자동 기록 + equipment.purchase_price 갱신
      for (let idx = 0; idx < editItems.length; idx++) {
        const it = editItems[idx];
        const newPrice = Number(it.unit_price) || 0;
        const origPrice = Number(it._origPrice) || 0;
        if (newPrice === origPrice || newPrice === 0) continue;
        // equipment_id 찾기 (모델명 매칭)
        const eq = equipments.find(e =>
          e.model.name === it.model_name &&
          (e.model.manufacturer === it.manufacturer || (e.vendor || '') === mfrName)
        ) || equipments.find(e => e.model.name === it.model_name);
        if (!eq?.id) continue;
        try {
          await dbLogPriceChange({
            equipmentId: eq.id,
            price: newPrice,
            prevPrice: origPrice,
            source: 'po',
            poId: newPoId,
            poNo: newPoNo,
            vendor: mfrName,
            note: reason.trim(),
            autoUpdate: true,
          });
        } catch (logErr) {
          console.warn('매입가 이력 기록 실패:', logErr);
        }
      }

      onSaved && onSaved();
    } catch (e) {
      console.error(e);
      alert('저장 중 오류가 발생했습니다.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{background:'rgba(0,0,0,0.6)'}}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-4 overflow-hidden flex flex-col" style={{maxHeight:'85vh'}}>
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div>
            <div className="font-bold text-slate-900">발주서 수정 (리비전 생성)</div>
            <div className="text-xs text-slate-500 mt-0.5">{mfrName} · <span className="font-mono">{po.po_no}</span> → 새 리비전</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-4">
          {/* 마진 요약 (실시간) */}
          <div className={`rounded-lg border px-4 py-3 ${isDeficit ? 'bg-red-50 border-red-300' : 'bg-slate-50 border-slate-200'}`}>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-xs text-slate-500">매출 (견적 기준)</div>
                <div className="font-bold text-slate-800 tnum">{totalSale.toLocaleString('ko-KR')}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">매입 (수정 후)</div>
                <div className="font-bold text-slate-800 tnum">{totalPurchase.toLocaleString('ko-KR')}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">마진</div>
                <div className={`font-bold tnum ${margin >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {margin.toLocaleString('ko-KR')} ({marginRate}%)
                </div>
              </div>
            </div>
            {isDeficit && (
              <div className="mt-2 text-xs font-semibold text-red-700 flex items-center gap-1">
                ⚠️ 매입가가 매출가를 초과합니다 (적자 발주). 저장 가능하나 확인 필요.
              </div>
            )}
          </div>

          {/* 품목 편집 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-slate-600">품목</label>
              <button onClick={addItem} className="text-xs text-blue-600 hover:text-blue-700 font-semibold">+ 품목 추가</button>
            </div>
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-slate-50">
                  <tr className="text-slate-600">
                    <th className="px-2 py-1.5 text-left">품목</th>
                    <th className="px-2 py-1.5 text-left">모델</th>
                    <th className="px-2 py-1.5 text-center w-16">수량</th>
                    <th className="px-2 py-1.5 text-right w-28">단가</th>
                    <th className="px-2 py-1.5 text-right w-28">금액</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {editItems.map((it, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-1 py-1"><input value={it.item_name} onChange={e => setItem(i, 'item_name', e.target.value)} className="w-full px-2 py-1 border border-slate-200 rounded"/></td>
                      <td className="px-1 py-1"><input value={it.model_name} onChange={e => setItem(i, 'model_name', e.target.value)} className="w-full px-2 py-1 border border-slate-200 rounded"/></td>
                      <td className="px-1 py-1"><input type="number" min="1" value={it.quantity} onChange={e => setItem(i, 'quantity', e.target.value)} className="w-full px-2 py-1 border border-slate-200 rounded text-center"/></td>
                      <td className="px-1 py-1"><input type="number" min="0" value={it.unit_price} onChange={e => setItem(i, 'unit_price', e.target.value)} className="w-full px-2 py-1 border border-slate-200 rounded text-right tnum"/></td>
                      <td className="px-2 py-1 text-right tnum text-slate-700">{((Number(it.quantity)||0) * (Number(it.unit_price)||0)).toLocaleString('ko-KR')}</td>
                      <td className="px-1 py-1 text-center">
                        <button onClick={() => removeItem(i)} className="text-red-400 hover:text-red-600 text-base">×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 납기일 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">납기일</label>
              <input type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"/>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">메모 (PDF에 반영)</label>
              <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="추가 안내사항" className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"/>
            </div>
          </div>

          {/* 변경 사유 */}
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">변경 사유 <span className="text-red-500">*</span></label>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
              placeholder="예: 제조사 단가 인상, 고객 모델 변경 요청, 수량 조정 등"
              className="w-full px-3 py-2 border border-slate-200 rounded text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex gap-2 justify-end shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded hover:bg-slate-50">취소</button>
          <button onClick={handleSave} disabled={saving}
            className={`px-5 py-2 text-sm rounded font-semibold text-white ${isDeficit ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'} disabled:opacity-50`}>
            {saving ? '저장 중...' : (isDeficit ? '적자 발주로 저장' : '리비전 저장')}
          </button>
        </div>
      </div>
    </div>
  );
}

// 병원명 자동완성 (기존 병원 선택 또는 새 이름 입력)
// 관리병원 등록 모달: 리드의 계약을 병원 관리 시스템에 등록
function RegisterHospitalModal({ lead, hospitals, setHospitals, onClose, onDone }) {
  const [selectedHospitalId, setSelectedHospitalId] = React.useState(lead.hospital_id || null);
  const [saving, setSaving] = React.useState(false);

  // 유사한 이름의 기존 병원 찾기 (대소문자 무시, 공백 무시)
  const normalize = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, '');
  const targetNorm = normalize(lead.hospital_name);

  const candidates = React.useMemo(() => {
    if (!targetNorm) return [];
    return hospitals.filter(h => {
      const hn = normalize(h.name);
      return hn === targetNorm || hn.includes(targetNorm) || targetNorm.includes(hn);
    }).sort((a, b) => {
      // 완전 일치 우선
      const aExact = normalize(a.name) === targetNorm ? 0 : 1;
      const bExact = normalize(b.name) === targetNorm ? 0 : 1;
      return aExact - bExact;
    });
  }, [hospitals, targetNorm]);

  const hasExisting = candidates.length > 0;

  // 기본 선택: 완전 일치하는 병원이 있으면 자동 선택
  React.useEffect(() => {
    if (!selectedHospitalId && candidates.length > 0) {
      const exact = candidates.find(h => normalize(h.name) === targetNorm);
      if (exact) setSelectedHospitalId(exact.id);
    }
  }, [candidates]);

  const handleRegister = async () => {
    setSaving(true);
    try {
      let targetHospId = selectedHospitalId;

      // 기존 병원 선택 안 했으면 → 새 병원 생성
      if (!targetHospId) {
        const newId = await dbSaveHospital({
          name: lead.hospital_name.trim(),
          contact_name: lead.contact_name || '',
          contact_phone: lead.contact_phone || '',
        });
        targetHospId = newId;
        // hospitals 캐시 갱신
        const fresh = await dbLoadHospitals();
        setHospitals(fresh);
      }

      // 1. 리드에 hospital_id 연결
      await dbUpdateLead(lead.id, { hospital_id: targetHospId });

      // 2. 해당 리드의 계약(quote_name으로 매칭)을 찾아서 hospital_id 업데이트
      if (lead.quote_no) {
        const allContracts = await dbLoadAllContracts();
        const contract = allContracts.find(c => c.quote_name === lead.quote_no);
        if (contract && contract.hospital_id !== targetHospId) {
          await dbUpdateContract(contract.id, { hospital_id: targetHospId });
        }
      }

      if (window.toast) window.toast.success('관리 병원으로 등록되었습니다');
      onDone && onDone(targetHospId);
    } catch(e) {
      console.error(e);
      if (window.handleError) window.handleError(e, '병원 등록 실패');
      else alert('병원 등록 실패: ' + e.message);
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div>
            <div className="font-bold text-slate-900">🏥 관리 병원 등록</div>
            <div className="text-xs text-slate-500 mt-0.5">{lead.hospital_name} · {lead.contact_name || ''} · {lead.quote_no || ''}</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {hasExisting ? (
            <>
              <div className="text-sm text-slate-700 mb-3">
                <strong>"{lead.hospital_name}"</strong>와 유사한 병원이 이미 있습니다. 어느 병원에 이 계약을 추가할까요?
              </div>
              <div className="space-y-2 mb-4">
                {candidates.map(h => {
                  const isSelected = selectedHospitalId === h.id;
                  return (
                    <button key={h.id} onClick={() => setSelectedHospitalId(h.id)}
                      className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-colors ${isSelected ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-slate-800">{h.name}</div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {h.region && `${h.region} · `}
                            {h.address || '주소 없음'}
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            {h.contact_name || '-'} {h.contact_phone ? `· ${h.contact_phone}` : ''}
                          </div>
                        </div>
                        {isSelected && (
                          <svg className="w-5 h-5 text-blue-500 shrink-0 ml-2" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/></svg>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-slate-100 pt-3">
                <button onClick={() => setSelectedHospitalId(null)}
                  className={`w-full text-left px-4 py-3 rounded-lg border-2 border-dashed transition-colors ${!selectedHospitalId ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 hover:border-slate-300'}`}>
                  <div className="font-semibold text-slate-800 text-sm">+ 새 병원으로 등록</div>
                  <div className="text-xs text-slate-500 mt-0.5">"{lead.hospital_name}"을(를) 새 병원으로 등록합니다</div>
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="text-center py-6">
                <div className="text-5xl mb-3">🏥</div>
                <div className="font-semibold text-slate-800 mb-2">새로운 병원 등록</div>
                <div className="text-sm text-slate-600">
                  <strong>"{lead.hospital_name}"</strong>을(를) 새 병원으로 등록하겠습니까?
                </div>
                <div className="text-xs text-slate-400 mt-2">
                  등록 후 병원 관리 페이지에서 주소/연락처 등을 추가할 수 있습니다
                </div>
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 disabled:opacity-40">취소</button>
          <button onClick={handleRegister} disabled={saving}
            className="px-5 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-500 disabled:opacity-40">
            {saving ? '등록 중...' : (selectedHospitalId ? '이 병원에 등록' : '새 병원으로 등록')}
          </button>
        </div>
      </div>
    </div>
  );
}

function HospitalPickerModal({ hospitals = [], leads = [], onSelect, onClose }) {
  const [search, setSearch] = React.useState('');

  const latestLeadByHospital = React.useMemo(() => {
    const map = {};
    (leads || []).forEach(l => {
      const hid = l.hospital_id;
      if (!hid) return;
      const prev = map[hid];
      const t = l.created_at || '';
      if (!prev || (t > (prev.created_at || ''))) map[hid] = l;
    });
    return map;
  }, [leads]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return hospitals;
    return hospitals.filter(h =>
      (h.name||'').toLowerCase().includes(q) ||
      (h.region||'').toLowerCase().includes(q) ||
      (h.address||'').toLowerCase().includes(q)
    );
  }, [hospitals, search]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" style={{background:'rgba(0,0,0,0.6)'}}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden flex flex-col" style={{maxHeight:'80vh'}}>
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div className="font-bold text-slate-900">기존 병원 불러오기</div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="px-4 py-3 border-b border-slate-100 shrink-0">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="병원명, 지역, 주소 검색..."
            autoFocus
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
        </div>
        <div className="overflow-y-auto flex-1">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-slate-400 text-sm">검색 결과가 없습니다</div>
          ) : filtered.map(h => {
            const last = latestLeadByHospital[h.id];
            return (
              <button key={h.id} onClick={() => { onSelect(h, last); onClose(); }}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-blue-50 border-b border-slate-50 last:border-0 transition-colors text-left">
                <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-800 text-sm truncate">{h.name}</span>
                    {h.region && <span className="text-xs px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded shrink-0">{h.region}</span>}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 truncate">
                    {last
                      ? [last.contact_name, last.dept, last.contact_phone].filter(Boolean).join(' · ')
                      : (h.address || '—')}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function HospitalAutocomplete({ value, hospitalId, onChange, hospitals = [], placeholder = '병원명' }) {
  const [open, setOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState(value || '');
  const wrapperRef = React.useRef(null);

  React.useEffect(() => { setInputValue(value || ''); }, [value]);

  React.useEffect(() => {
    const handler = (e) => { if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = React.useMemo(() => {
    const q = inputValue.trim().toLowerCase();
    if (!q) return hospitals.slice(0, 8);
    return hospitals.filter(h => (h.name || '').toLowerCase().includes(q)).slice(0, 10);
  }, [hospitals, inputValue]);

  // 정확히 일치하는 기존 병원
  const exactMatch = hospitals.find(h => (h.name || '').trim() === inputValue.trim());
  const showNewHint = inputValue.trim() && !exactMatch;

  const handleSelect = (h) => {
    setInputValue(h.name);
    onChange(h.name, h.id);
    setOpen(false);
  };

  const handleInputChange = (e) => {
    const v = e.target.value;
    setInputValue(v);
    // 타이핑 중엔 id 제거 (직접 입력으로 간주)
    onChange(v, null);
    setOpen(true);
  };

  return (
    <div className="relative" ref={wrapperRef}>
      <input
        value={inputValue}
        onChange={handleInputChange}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
      {hospitalId && exactMatch && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-emerald-600 pointer-events-none">✓ 연결됨</span>
      )}
      {open && (filtered.length > 0 || showNewHint) && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {filtered.map(h => (
            <button key={h.id} type="button" onClick={() => handleSelect(h)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-blue-50 transition-colors">
              <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
              <span className="flex-1 truncate">{h.name}</span>
              {h.region && <span className="text-xs text-slate-400 shrink-0">{h.region}</span>}
            </button>
          ))}
          {showNewHint && (
            <div className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100 bg-slate-50">
              저장 시 <strong>"{inputValue.trim()}"</strong>이(가) 새 병원으로 등록됩니다
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QuoteQuickPreviewModal({ quoteNo, onClose, onEdit }) {
  const [quote, setQuote] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!quoteNo) return;
    setLoading(true);
    dbLoadQuoteByNo(quoteNo)
      .then(q => setQuote(q))
      .catch(e => console.error(e))
      .finally(() => setLoading(false));
  }, [quoteNo]);

  if (!quoteNo) return null;

  // 총 품목 수 / 카테고리별 집계
  const categoriesWithItems = (quote?.categories || []).map(cat => ({
    ...cat,
    items: (cat.items || []).filter(it => !it.excluded)
  })).filter(cat => cat.items.length > 0);

  const totalItems = categoriesWithItems.reduce((s, c) => s + c.items.length, 0);

  const getItemPrice = (item) => {
    const model = item.models?.find(m => m.id === item.selectedModelId) || item.models?.[0];
    const qty = item.quantity || 1;
    const gross = (model?.price || 0) * qty;
    const disc = item.itemDiscount?.type === 'rate'
      ? Math.floor(gross * (item.itemDiscount.value || 0) / 100)
      : (item.itemDiscount?.value || 0);
    return { gross, net: gross - disc, model, qty };
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-4 max-h-[85vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <svg className="w-5 h-5 text-violet-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            <div className="min-w-0">
              <div className="font-bold text-slate-900">{quoteNo}</div>
              {quote && <div className="text-xs text-slate-500 truncate">{quote.hospital || ''} {quote.doctor ? `· ${quote.doctor} 원장` : ''}{quote.dept ? ` · ${quote.dept}` : ''}</div>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onEdit && <button onClick={onEdit} className="px-3 py-1.5 bg-amber-500 text-white text-xs font-semibold rounded-lg hover:bg-amber-400">견적 수정</button>}
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading && <div className="text-center text-slate-400 py-10 text-sm">불러오는 중...</div>}
          {!loading && !quote && <div className="text-center text-slate-400 py-10 text-sm">견적서를 찾을 수 없습니다.</div>}
          {!loading && quote && (
            <>
              {/* 기본 정보 */}
              <div className="grid grid-cols-2 gap-3 mb-5 text-xs">
                {quote.quoteInfo?.date && <div><span className="text-slate-500">견적일자</span><span className="ml-2 font-medium text-slate-800">{quote.quoteInfo.date}</span></div>}
                {quote.quoteInfo?.validity && <div><span className="text-slate-500">유효기간</span><span className="ml-2 font-medium text-slate-800">{quote.quoteInfo.validity}</span></div>}
                {quote.finalAmt != null && <div className="col-span-2 mt-1 p-3 bg-slate-900 text-white rounded-lg flex justify-between">
                  <span className="text-xs text-slate-300">최종 제안금액 {quote.vatIncluded ? '(VAT 포함)' : '(VAT 별도)'}</span>
                  <span className="font-bold text-lg tnum">{quote.finalAmt.toLocaleString('ko-KR')}원</span>
                </div>}
              </div>

              {/* 카테고리별 품목 */}
              {totalItems === 0 && <div className="text-center text-slate-400 py-8 text-sm">반영된 품목이 없습니다.</div>}
              {categoriesWithItems.map(cat => (
                <div key={cat.id} className="mb-4">
                  <div className="text-xs font-bold text-slate-600 mb-1.5">{cat.name} · {cat.items.length}개</div>
                  <div className="bg-slate-50 rounded-lg overflow-hidden border border-slate-100">
                    {cat.items.map((it, idx) => {
                      const { net, model, qty } = getItemPrice(it);
                      return (
                        <div key={it.id} className={`flex items-center gap-3 px-3 py-2.5 text-xs ${idx > 0 ? 'border-t border-slate-200' : ''}`}>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-slate-800 truncate">{it.name}</div>
                            <div className="text-slate-500 truncate">{model?.name || ''}{model?.manufacturer ? ` · ${model.manufacturer}` : ''}</div>
                          </div>
                          <div className="text-slate-500 shrink-0">{qty}개</div>
                          <div className="text-right font-semibold text-slate-800 tnum shrink-0 w-28">{net != null ? net.toLocaleString('ko-KR') + '원' : '—'}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GcalSettingsModal({ connected, onConnect, onDisconnect, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="font-bold text-slate-900">구글 캘린더 연동</div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
            <div>
              <div className="text-sm font-semibold text-slate-800">구글 계정 연결</div>
              <div className="text-xs text-slate-500 mt-1">{connected ? '연결됨 — 미팅 등록 시 구글 캘린더에 자동 추가됩니다' : '연결하면 미팅이 구글 캘린더에 자동 등록됩니다'}</div>
            </div>
            {connected ? (
              <button onClick={onDisconnect} className="px-3 py-1.5 text-xs bg-red-100 text-red-600 rounded-lg hover:bg-red-200 font-medium shrink-0 ml-3">연결 해제</button>
            ) : (
              <button onClick={onConnect} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-500 font-medium shrink-0 ml-3">구글 로그인</button>
            )}
          </div>
          {connected && (
            <div className="text-xs text-slate-500 bg-blue-50 rounded-lg p-3 space-y-1">
              <div className="font-semibold text-blue-700 mb-1">사용 방법</div>
              <div>1. 구글 캘린더에서 "DW미팅" 캘린더 생성</div>
              <div>2. 영업사원에게 캘린더 공유</div>
              <div>3. mediquote에서 미팅 등록하면 자동 추가</div>
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg font-semibold hover:bg-slate-800">닫기</button>
        </div>
      </div>
    </div>
  );
}

function LeadsPage({ onBack, onCreateQuote, user, onLogout, nav, leads = [], setLeads, leadsLoading = false, quotes = [], equipments = [], manufacturers = [], hospitals = [], setHospitals, initialStage = null }) {
  const loading = leadsLoading;
  const [filter, setFilter] = React.useState(initialStage || '신규문의');
  const [sortDesc, setSortDesc] = React.useState(true); // true=최신순
  const [showDashboard, setShowDashboard] = React.useState(false);
  const [showCalendar, setShowCalendar] = React.useState(false);
  const [showForm, setShowForm] = React.useState(false);
  const [editingLead, setEditingLead] = React.useState(null);
  const [form, setForm] = React.useState(EMPTY_LEAD);
  const [saving, setSaving] = React.useState(false);
  const [stagePopup, setStagePopup] = React.useState(null);
  const [confirmDel, setConfirmDel] = React.useState(null);
  const [quoteOptionsLead, setQuoteOptionsLead] = React.useState(null);
  const [showQuotePicker, setShowQuotePicker] = React.useState(false);
  const [previewQuoteNo, setPreviewQuoteNo] = React.useState(null);
  const [orderManageLead, setOrderManageLead] = React.useState(null);
  const [registerHospitalLead, setRegisterHospitalLead] = React.useState(null);
  const [showHospitalPicker, setShowHospitalPicker] = React.useState(false);
  const [showGcalSettings, setShowGcalSettings] = React.useState(false);
  const [gcalConnected, setGcalConnected] = React.useState(!!gcalAccessToken);

  // 바깥 클릭 시 단계 팝업 닫기
  React.useEffect(() => {
    if (!stagePopup) return;
    const close = () => setStagePopup(null);
    setTimeout(() => window.addEventListener('click', close), 0);
    return () => window.removeEventListener('click', close);
  }, [stagePopup]);

  const openNew = (prefillDate) => {
    setEditingLead(null);
    if (prefillDate) {
      setForm({ ...EMPTY_LEAD, meetings:[{ id:Date.now().toString(36), type:'온라인', date:prefillDate, time:'', memo:'' }] });
    } else {
      setForm(EMPTY_LEAD);
    }
    setShowForm(true);
  };
  const openEdit = (lead) => {
    setEditingLead(lead);
    setForm({ hospital_name:lead.hospital_name||'', hospital_id:lead.hospital_id||null, contact_name:lead.contact_name||'', contact_phone:lead.contact_phone||'', dept:lead.dept||'', opening_date:lead.opening_date||'', source:lead.source||'직접입력', stage:lead.stage||'신규문의', assignee:lead.assignee||'', notes:lead.notes||'', quote_sent_date:lead.quote_sent_date||'', contracted_at:lead.contracted_at||'', delivered_at:lead.delivered_at||'', purchase_complete_at:lead.purchase_complete_at||'', sales_complete_at:lead.sales_complete_at||'', lost_at:lead.lost_at||'', meetings:Array.isArray(lead.meetings)?lead.meetings:[], quote_no:lead.quote_no||'' });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.contact_name.trim()) { alert('이름을 입력해주세요.'); return; }
    setSaving(true);
    try {
      // 빈 문자열 DATE 필드 → null 변환 (PostgreSQL DATE 타입 오류 방지)
      const payload = { ...form };
      ['quote_sent_date','contracted_at','delivered_at','purchase_complete_at','sales_complete_at','lost_at'].forEach(f => { if (payload[f] === '') payload[f] = null; });
      if (payload.quote_no === '') payload.quote_no = null;
      // meetings 빈 date 항목 제거
      payload.meetings = (payload.meetings || []).map(m => ({ ...m, date: m.date || null }));

      // 구글 캘린더 연동: 새 미팅 또는 날짜 변경된 미팅 → 리드관리자 캘린더에 자동 추가
      const oldMeetings = editingLead ? (Array.isArray(editingLead.meetings) ? editingLead.meetings : []) : [];
      if (gcalAccessToken) {
        for (const mtg of (payload.meetings || [])) {
          if (!mtg.date) continue;
          const old = oldMeetings.find(o => o.id === mtg.id);
          const isNew = !old;
          const isChanged = old && (old.date !== mtg.date || old.time !== mtg.time);
          if (isNew || isChanged) {
            try {
              if (isChanged && mtg.google_event_id) {
                await gcalDeleteEvent(mtg.google_event_id);
              }
              const eventId = await gcalCreateEvent(mtg, payload, null);
              mtg.google_event_id = eventId;
            } catch (e) { console.warn('구글 캘린더 이벤트 생성 실패:', e); }
          }
        }
        for (const old of oldMeetings) {
          if (old.google_event_id && !(payload.meetings || []).find(m => m.id === old.id)) {
            try { await gcalDeleteEvent(old.google_event_id); } catch(e) {}
          }
        }

        // 납품·정산 일정도 구글 캘린더에 종일 이벤트로 추가
        const dateFields = [
          { key: 'delivered_at', label: '납품일', gcalKey: 'gcal_delivered_id' },
          { key: 'purchase_complete_at', label: '매입완료일', gcalKey: 'gcal_purchase_id' },
          { key: 'sales_complete_at', label: '매출완료일', gcalKey: 'gcal_sales_id' },
        ];
        for (const df of dateFields) {
          const newVal = payload[df.key] || null;
          const oldVal = editingLead ? (editingLead[df.key] || null) : null;
          const oldGcalId = editingLead ? (editingLead[df.gcalKey] || null) : null;
          if (newVal && newVal !== oldVal) {
            try {
              if (oldGcalId) await gcalDeleteEvent(oldGcalId);
              const event = {
                summary: `[DW] ${payload.contact_name || ''} ${df.label}${payload.hospital_name ? ' - ' + payload.hospital_name : ''}`,
                description: `${df.label}\n담당: ${payload.assignee || '미배정'}\n---\nmediquote에서 자동 생성됨`,
                start: { date: newVal },
                end: { date: newVal },
              };
              const resp = await fetch(`${GCAL_API}/calendars/${encodeURIComponent(GCAL_CALENDAR_ID)}/events`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + gcalAccessToken, 'Content-Type': 'application/json' },
                body: JSON.stringify(event),
              });
              if (resp.ok) {
                const data = await resp.json();
                payload[df.gcalKey] = data.id;
              }
            } catch (e) { console.warn(`${df.label} 캘린더 등록 실패:`, e); }
          } else if (!newVal && oldGcalId) {
            try { await gcalDeleteEvent(oldGcalId); payload[df.gcalKey] = null; } catch(e) {}
          }
        }
      }

      // 병원명 입력 + hospital_id 미연결 → 기존 마스터에서만 매칭 (자동 등록 안 함)
      // 마스터 등록은 '영업관리 → 납품완료 → 관리등록' 또는 '병원 관리' 메뉴에서만 수행
      const hospName = (payload.hospital_name || '').trim();
      if (hospName && !payload.hospital_id) {
        const existing = hospitals.find(h => (h.name || '').trim() === hospName);
        if (existing) payload.hospital_id = existing.id;
        // 없으면 hospital_id=null 유지 — hospital_name 텍스트만 lead에 보존
      }
      if (!hospName) payload.hospital_id = null;

      if (editingLead) {
        await dbUpdateLead(editingLead.id, payload);
        setLeads(p => p.map(l => l.id === editingLead.id ? { ...l, ...payload } : l));
        // 납품일 변경 → 연결된 contract의 delivery_target_date 동기화
        if (payload.quote_no && payload.delivered_at !== editingLead.delivered_at) {
          try {
            const allContracts = await dbLoadAllContracts();
            const contract = allContracts.find(c => c.quote_name === payload.quote_no);
            if (contract) {
              await dbUpdateContract(contract.id, { delivery_target_date: payload.delivered_at || null });
            }
          } catch(err) { console.warn('계약 납기일 동기화 실패:', err); }
        }
      } else {
        const id = await dbSaveLead(payload);
        setLeads(p => [{ id, ...payload, created_at: new Date().toISOString() }, ...p]);
      }
      setShowForm(false); setEditingLead(null);
    } catch(e) { window.handleError ? window.handleError(e, '저장 중 오류가 발생했습니다') : alert('저장 중 오류가 발생했습니다.'); }
    setSaving(false);
  };

  const handleStageChange = async (lead, stage) => {
    setStagePopup(null);
    try {
      const today = new Date().toISOString().split('T')[0];
      const updates = { stage };
      if (stage === '견적발송' && !lead.quote_sent_date) updates.quote_sent_date = today;
      if (stage === '계약완료' && !lead.contracted_at)  updates.contracted_at   = today;
      if (stage === '납품완료' && !lead.delivered_at)    updates.delivered_at    = today;
      if (stage === '타사계약' && !lead.lost_at)         updates.lost_at         = today;
      await dbUpdateLead(lead.id, updates);
      setLeads(p => p.map(l => l.id === lead.id ? { ...l, ...updates } : l));
    } catch(e) { console.error(e); alert('단계 변경 중 오류가 발생했습니다.'); }
  };

  // 발주 진행하기: 리드 단계 '발주진행중'으로 변경 + 발주 관리 모달 열기
  const handleStartOrder = async (lead) => {
    try {
      if (!lead.quote_no) { alert('견적서가 연결되지 않았습니다.'); return; }
      // 리드 단계를 '발주진행중'으로 변경
      let updated = lead;
      if (lead.stage !== '발주진행중' && lead.stage !== '납품완료') {
        await dbUpdateLead(lead.id, { stage: '발주진행중' });
        updated = { ...lead, stage: '발주진행중' };
        setLeads(p => p.map(l => l.id === lead.id ? updated : l));
      }
      // 발주 계획서 페이지로 이동
      if (nav?.poPlan) nav.poPlan(updated);
    } catch(e) {
      console.error(e);
      alert('오류: ' + e.message);
    }
  };

  const handleDelete = async (id) => {
    try {
      await dbDeleteLead(id);
      setLeads(p => p.filter(l => l.id !== id));
      setConfirmDel(null);
    } catch(e) { console.error(e); alert('삭제 중 오류가 발생했습니다.'); }
  };

  const filtered = (filter === 'all' ? leads : leads.filter(l => l.stage === filter))
    .slice()
    .sort((a, b) => {
      const da = a.created_at || '', db = b.created_at || '';
      return sortDesc ? db.localeCompare(da) : da.localeCompare(db);
    });
  const counts = Object.fromEntries(['all', ...LEAD_STAGES].map(s => [s, s === 'all' ? leads.length : leads.filter(l => l.stage === s).length]));

  return (
    <div style={{height:'100vh', display:'flex', flexDirection:'column', overflow:'hidden', background:'#f1f5f9'}}>
      {/* 헤더 */}
      <AppHeader title="영업 관리" onLogoClick={onBack} user={user} onLogout={onLogout} nav={nav}>
        <div className="flex items-center gap-1">
          {[
            { id:'list',      label:'목록',    icon:'M4 6h16M4 10h16M4 14h16M4 18h16' },
            { id:'dashboard', label:'대시보드', icon:'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
          ].map(tab => {
            const active = tab.id==='list' ? !showDashboard : showDashboard;
            return (
              <button key={tab.id} onClick={() => { setShowDashboard(tab.id==='dashboard'); setShowCalendar(false); }}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors ${active ? 'bg-white text-slate-900 border-white' : 'border-slate-600 text-slate-300 hover:bg-slate-800'}`}>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab.icon}/></svg>
                {tab.label}
              </button>
            );
          })}
        </div>
        {!showDashboard && <>
          <button onClick={() => setShowGcalSettings(true)}
            className={`flex items-center gap-1 px-2.5 py-1.5 text-xs rounded transition-colors ${gcalAccessToken ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-slate-200 text-slate-600 hover:bg-slate-300'}`}>
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            {gcalAccessToken ? '캘린더 연동 중' : '구글 캘린더'}
          </button>
          <button onClick={() => openNew()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>
            새 리드
          </button>
        </>}
      </AppHeader>

      {/* 영업 단계 필터 + 보기 토글 */}
      {!showDashboard && <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center gap-2 shrink-0 overflow-x-auto">
        {!showCalendar && <>
          <button onClick={() => setFilter('all')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors whitespace-nowrap ${filter==='all' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}>
            전체 <span className={`px-1.5 py-0.5 rounded-full text-xs ${filter==='all' ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'}`}>{counts.all}</span>
          </button>
          {LEAD_STAGES.map(s => (
            <button key={s} onClick={() => setFilter(s)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors whitespace-nowrap ${filter===s ? LEAD_STAGE_BTN[s]+' text-white' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}>
              {s} <span className={`px-1.5 py-0.5 rounded-full text-xs ${filter===s ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'}`}>{counts[s]}</span>
            </button>
          ))}
        </>}
        <div className="ml-auto shrink-0 flex items-center gap-2">
        {!showCalendar && <button onClick={() => setSortDesc(p => !p)}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"/></svg>
          {sortDesc ? '최신순' : '오래된순'}
        </button>}
        <div className="flex items-center gap-1 border border-slate-200 rounded-lg p-0.5">
          <button onClick={() => setShowCalendar(false)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-semibold transition-colors ${!showCalendar ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-700'}`}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg>
            리스트
          </button>
          <button onClick={() => setShowCalendar(true)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-semibold transition-colors ${showCalendar ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-700'}`}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            캘린더
          </button>
        </div>
        </div>
      </div>}

      {/* 파이프라인 진행 바 */}
      {!showDashboard && !showCalendar && filter === 'all' && leads.length > 0 && (
        <div className="bg-white border-b border-slate-100 px-6 py-2.5 flex items-center gap-1 shrink-0 flex-wrap">
          {['신규문의','견적발송','상담중','계약완료'].map((s, i) => {
            const colors = ['bg-slate-400','bg-violet-400','bg-blue-400','bg-emerald-400'];
            return (
              <React.Fragment key={s}>
                {i > 0 && <svg className="w-3 h-3 text-slate-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>}
                <div className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${colors[i]}`}/>
                  <span className="text-xs text-slate-500 whitespace-nowrap">{s}</span>
                  <span className="text-xs font-bold text-slate-700">{counts[s]}</span>
                </div>
              </React.Fragment>
            );
          })}
          {counts['타사계약'] > 0 && (
            <React.Fragment>
              <span className="mx-2 text-slate-200">|</span>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-red-400"/>
                <span className="text-xs text-red-400 whitespace-nowrap">타사계약</span>
                <span className="text-xs font-bold text-red-500">{counts['타사계약']}</span>
              </div>
            </React.Fragment>
          )}
        </div>
      )}

      {/* 대시보드 or 캘린더 or 테이블 */}
      <div className="flex-1 overflow-y-auto p-6">
        <div>
          {showDashboard && <LeadsDashboard leads={leads} loading={loading} />}
        </div>
        <div>
          {showCalendar && <LeadsCalendar leads={leads} onEdit={openEdit} onNewLead={openNew} onLoadQuote={onCreateQuote ? (lead, qNo) => onCreateQuote(lead, 'load', qNo) : null} />}
        </div>
        <div style={{display: (showDashboard || showCalendar) ? 'none' : 'block'}}>
          {loading ? (
            <div className="bg-white rounded-xl border border-slate-200 p-16 text-center text-slate-400 text-sm">불러오는 중...</div>
          ) : filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 p-16 text-center text-slate-400">
              <svg className="w-10 h-10 mx-auto mb-3 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
              <div className="text-sm font-medium">{filter === 'all' ? '등록된 리드가 없습니다' : `"${filter}" 단계의 리드가 없습니다`}</div>
              {filter === 'all' && <div className="text-xs mt-1">"새 리드" 버튼으로 추가하세요</div>}
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto" style={{minHeight:'400px'}}>
              <table className="w-full text-sm" style={{minWidth:'1100px'}}>
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 rounded-t-xl">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 w-32">이름</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 w-28">연락처</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 w-20">진료과</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 w-24">개원예정일</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 w-20">영업담당</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 w-20">유입경로</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 w-28">미팅일</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 w-24">영업단계</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 w-32">견적번호</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 w-32">기타</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 w-36">등록일</th>
                    <th className="px-3 py-3 w-32"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(lead => <React.Fragment key={lead.id}>
                    <tr className="border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-800 text-sm cursor-pointer hover:text-blue-600 transition-colors" onClick={() => openEdit(lead)}>{lead.contact_name || <span className="text-slate-400">이름 없음</span>}</div>
                        {lead.hospital_name && <div className="text-xs text-slate-400 mt-0.5">{lead.hospital_name}</div>}
                      </td>
                      <td className="px-3 py-3 text-slate-500 text-xs whitespace-nowrap">{lead.contact_phone || <span className="text-slate-300">—</span>}</td>
                      <td className="px-3 py-3 text-slate-500 text-xs">{lead.dept || <span className="text-slate-300">—</span>}</td>
                      <td className="px-3 py-3">
                        {lead.opening_date
                          ? <span className="px-2 py-0.5 bg-amber-50 text-amber-700 text-xs rounded-full font-medium border border-amber-200 whitespace-nowrap">{lead.opening_date}</span>
                          : <span className="text-slate-300 text-xs">—</span>}
                      </td>
                      <td className="px-3 py-3">
                        {lead.assignee
                          ? <span className="px-2 py-0.5 bg-slate-100 text-slate-700 text-xs rounded-full font-medium">{lead.assignee}</span>
                          : <span className="text-slate-300 text-xs">—</span>}
                      </td>
                      <td className="px-3 py-3 text-slate-400 text-xs">{lead.source || '—'}</td>
                      <td className="px-3 py-3 text-xs whitespace-nowrap">
                        {(() => {
                          const ms = Array.isArray(lead.meetings) ? lead.meetings.filter(m=>m.date) : [];
                          if (ms.length === 0) return <span className="text-slate-300">—</span>;
                          return (
                            <div>
                              <span className="text-blue-600 font-medium">{ms[0].date}</span>
                              <span className="text-slate-400 ml-1">({ms[0].type})</span>
                              {ms.length > 1 && <span className="text-slate-400 ml-1">+{ms.length-1}</span>}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-3 relative">
                        <button
                          onClick={e => { e.stopPropagation(); setStagePopup(stagePopup === lead.id ? null : lead.id); }}
                          className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-colors whitespace-nowrap ${LEAD_STAGE_COLORS[lead.stage] || 'bg-slate-100 text-slate-600'}`}>
                          {lead.stage} ▾
                        </button>
                        {stagePopup === lead.id && (
                          <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-50 w-32" onClick={e => e.stopPropagation()}>
                            {LEAD_STAGES.map(s => (
                              <button key={s} onClick={() => handleStageChange(lead, s)}
                                className={`w-full text-left px-3 py-2 text-xs font-semibold hover:bg-slate-50 transition-colors ${lead.stage === s ? 'text-blue-600 bg-blue-50' : 'text-slate-700'}`}>
                                {lead.stage === s && '✓ '}{s}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {lead.quote_no
                          ? <button
                              onClick={() => setPreviewQuoteNo({ quoteNo: lead.quote_no, lead })}
                              className="inline-flex items-center gap-1 px-2 py-1 bg-violet-50 text-violet-700 border border-violet-200 rounded-lg text-xs font-mono font-medium hover:bg-violet-100 transition-colors whitespace-nowrap"
                              title="견적서 미리보기"
                            >
                              <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                              {lead.quote_no}
                            </button>
                          : <span className="text-slate-300 text-xs">—</span>}
                      </td>
                      <td className="px-3 py-3 text-xs max-w-[160px]">
                        {lead.notes
                          ? <span className="line-clamp-2 leading-relaxed text-slate-500" title={lead.notes}>{lead.notes}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-3 text-slate-400 text-xs whitespace-nowrap">
                        {lead.created_at ? new Date(lead.created_at).toLocaleString('ko-KR', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—'}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-1 justify-end flex-nowrap">
                          {/* 납품완료 단계는 견적 수정/발주 관리 대신 병원 관리로 이동 */}
                          {lead.stage === '납품완료' ? (
                            <button onClick={() => {
                              // 이미 병원에 등록되어 있으면 → 병원 상세로 바로 이동
                              if (lead.hospital_id && nav?.goToHospital) {
                                nav.goToHospital(lead.hospital_id, 'contracts');
                              } else {
                                // 아직 등록 안 됐으면 → 관리 등록 모달 열기
                                setRegisterHospitalLead(lead);
                              }
                            }}
                              className="px-2.5 py-1 text-xs bg-teal-600 text-white rounded font-semibold hover:bg-teal-500 transition-colors whitespace-nowrap">
                              {lead.hospital_id ? '병원 보기' : '관리 등록'}
                            </button>
                          ) : (
                            <>
                              {onCreateQuote && (
                                lead.quote_no
                                  ? <button onClick={() => onCreateQuote(lead, 'load', lead.quote_no)}
                                      className="px-2.5 py-1 text-xs bg-amber-500 text-white rounded font-semibold hover:bg-amber-400 transition-colors whitespace-nowrap">
                                      견적수정
                                    </button>
                                  : <button onClick={() => setQuoteOptionsLead(lead)}
                                      className="px-2.5 py-1 text-xs bg-blue-600 text-white rounded font-semibold hover:bg-blue-500 transition-colors whitespace-nowrap">
                                      견적작성
                                    </button>
                              )}
                              {lead.quote_no && (lead.stage === '계약완료' || lead.stage === '발주진행중') && (
                                <button onClick={() => {
                                  if (lead.stage === '계약완료') {
                                    handleStartOrder(lead);
                                  } else {
                                    nav?.poPlan && nav.poPlan(lead);
                                  }
                                }}
                                  className={`px-2.5 py-1 text-xs text-white rounded font-semibold whitespace-nowrap transition-colors ${lead.stage === '계약완료' ? 'bg-amber-600 hover:bg-amber-500' : 'bg-amber-500 hover:bg-amber-400'}`}>
                                  {lead.stage === '계약완료' ? '발주 시작' : '발주 계획서'}
                                </button>
                              )}
                            </>
                          )}
                          <button onClick={() => openEdit(lead)}
                            className="px-2.5 py-1 text-xs border border-slate-200 text-slate-500 rounded hover:bg-slate-50 transition-colors whitespace-nowrap">
                            수정
                          </button>
                          {confirmDel === lead.id ? (
                            <div className="flex items-center gap-1 flex-nowrap">
                              <button onClick={() => handleDelete(lead.id)} className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-500 transition-colors whitespace-nowrap">확인</button>
                              <button onClick={() => setConfirmDel(null)} className="px-2 py-1 text-xs border border-slate-200 text-slate-500 rounded hover:bg-slate-50 whitespace-nowrap">취소</button>
                            </div>
                          ) : (
                            <button onClick={() => setConfirmDel(lead.id)} className="px-2.5 py-1 text-xs border border-slate-200 text-slate-400 rounded hover:border-red-300 hover:text-red-500 transition-colors whitespace-nowrap">삭제</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  </React.Fragment>)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 등록/수정 모달 */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="font-bold text-slate-900">{editingLead ? '리드 수정' : '새 리드 등록'}</div>
                {!editingLead && (
                  <button type="button" onClick={() => setShowHospitalPicker(true)}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
                    기존 병원 불러오기
                  </button>
                )}
              </div>
              <button onClick={() => { setShowForm(false); setEditingLead(null); }} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="p-6 space-y-3 max-h-[70vh] overflow-y-auto">
              {/* 이름 (필수) */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">이름 *</label>
                <input value={form.contact_name} onChange={e => setForm(p=>({...p,contact_name:e.target.value}))}
                  placeholder="홍길동"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
              </div>
              {/* 2열 그리드 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">휴대폰 번호</label>
                  <input value={form.contact_phone} onChange={e => setForm(p=>({...p,contact_phone:e.target.value}))}
                    placeholder="010-0000-0000"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">진료과</label>
                  <input value={form.dept} onChange={e => setForm(p=>({...p,dept:e.target.value}))}
                    placeholder="정형외과"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">영업 담당자</label>
                  <input value={form.assignee} onChange={e => setForm(p=>({...p,assignee:e.target.value}))}
                    placeholder="김영업"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">유입경로</label>
                  <input value={form.source} onChange={e => setForm(p=>({...p,source:e.target.value}))}
                    placeholder="구글폼, 소개 등"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
              </div>
              {/* 개원예정일 */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">개원예정일</label>
                <div className="flex gap-2 flex-wrap">
                  {OPENING_DATE_OPTIONS.map(o => (
                    <button key={o} type="button" onClick={() => setForm(p=>({...p,opening_date:form.opening_date===o?'':o}))}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 transition-all ${form.opening_date===o ? 'bg-amber-500 text-white border-transparent' : 'border-slate-200 text-slate-500 hover:border-slate-400'}`}>
                      {o}
                    </button>
                  ))}
                </div>
              </div>
              {/* 기타 */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">기타</label>
                <textarea value={form.notes} onChange={e => setForm(p=>({...p,notes:e.target.value}))} rows={4}
                  placeholder="특이사항, 요청사항 등"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"/>
              </div>
              {/* 병원명 (선택) */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">병원명 <span className="text-slate-400 font-normal">(선택)</span></label>
                <HospitalAutocomplete
                  value={form.hospital_name}
                  hospitalId={form.hospital_id}
                  hospitals={hospitals}
                  placeholder="병원명 입력 또는 기존 병원 선택"
                  onChange={(name, id) => setForm(p => ({ ...p, hospital_name: name, hospital_id: id }))}
                />
              </div>
              {/* 영업 단계 */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">영업 단계</label>
                <div className="flex flex-wrap gap-2">
                  {LEAD_STAGES.map(s => (
                    <button key={s} type="button" onClick={() => setForm(p=>({...p,stage:s}))}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 transition-all ${form.stage===s ? LEAD_STAGE_BTN[s]+' text-white border-transparent' : 'border-slate-200 text-slate-500 hover:border-slate-400'}`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              {/* 미팅 일정 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-semibold text-slate-600">미팅 일정</label>
                  <button type="button"
                    onClick={() => setForm(p => ({...p, meetings:[...(p.meetings||[]), {id:Date.now().toString(36)+Math.random().toString(36).slice(2,5), type:'온라인', date:'', time:'', memo:''}]}))}
                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-semibold">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>
                    미팅 추가
                  </button>
                </div>
                {(form.meetings||[]).length === 0 && (
                  <div className="text-xs text-slate-400 py-2 text-center border border-dashed border-slate-200 rounded-lg">미팅 일정이 없습니다</div>
                )}
                <div className="space-y-2">
                  {(form.meetings||[]).map((m, i) => (
                    <div key={m.id} className="flex items-start gap-2 p-2.5 bg-slate-50 rounded-lg border border-slate-100">
                      <span className="text-xs font-bold text-slate-500 pt-2 shrink-0 w-8">{i+1}차</span>
                      <div className="flex-1 space-y-2">
                        <div className="grid grid-cols-3 gap-2">
                          <select value={m.type}
                            onChange={e => setForm(p => ({...p, meetings:p.meetings.map(x => x.id===m.id ? {...x, type:e.target.value} : x)}))}
                            className="border border-slate-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                            <option>온라인</option>
                            <option>병원방문</option>
                            <option>쇼룸방문</option>
                          </select>
                          <input type="date" value={m.date||''}
                            onChange={e => setForm(p => ({...p, meetings:p.meetings.map(x => x.id===m.id ? {...x, date:e.target.value} : x)}))}
                            className="border border-slate-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"/>
                          <select value={m.time||''}
                            onChange={e => setForm(p => ({...p, meetings:p.meetings.map(x => x.id===m.id ? {...x, time:e.target.value} : x)}))}
                            className="border border-slate-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                            <option value="">시간</option>
                            {Array.from({length:96},(_,i)=>{const h=String(Math.floor(i/4)).padStart(2,'0'),m=String((i%4)*15).padStart(2,'0');return `${h}:${m}`;}).map(t=>(
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </div>
                        <input value={m.memo||''} placeholder="메모 (특이사항)"
                          onChange={e => setForm(p => ({...p, meetings:p.meetings.map(x => x.id===m.id ? {...x, memo:e.target.value} : x)}))}
                          className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"/>
                      </div>
                      <button type="button"
                        onClick={() => setForm(p => ({...p, meetings:p.meetings.filter(x => x.id !== m.id)}))}
                        className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-red-100 text-slate-300 hover:text-red-500 transition-colors shrink-0 mt-1">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              {/* 납품일정 */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-2">납품 일정</label>
                <div className="space-y-2">
                  {[
                    { key:'delivered_at',        label:'납품일',     color:'bg-orange-500' },
                  ].map(({ key, label, color }) => (
                    <div key={key} className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${color} shrink-0`}/>
                      <span className="text-xs text-slate-500 w-20 shrink-0">{label}</span>
                      <input type="date" value={form[key]||''}
                        onChange={e => setForm(p=>({...p,[key]:e.target.value}))}
                        className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"/>
                      {form[key] && (
                        <button type="button" onClick={() => setForm(p=>({...p,[key]:''}))}
                          className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-red-100 text-slate-300 hover:text-red-500 transition-colors">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              {/* 견적서 연결 */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">
                  견적서 연결 <span className="text-slate-400 font-normal">(선택)</span>
                </label>
                {form.quote_no ? (
                  <div className="flex items-center gap-2 p-2.5 bg-violet-50 border border-violet-200 rounded-lg">
                    <svg className="w-4 h-4 text-violet-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                    <span className="flex-1 text-sm font-mono font-semibold text-violet-700">{form.quote_no}</span>
                    <button type="button" onClick={() => setShowQuotePicker(true)}
                      className="text-xs text-violet-500 hover:text-violet-700 font-medium">변경</button>
                    <button type="button" onClick={() => setForm(p=>({...p,quote_no:''}))}
                      className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-red-100 text-slate-300 hover:text-red-400 transition-colors">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setShowQuotePicker(true)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 border-2 border-dashed border-slate-200 rounded-lg text-sm text-slate-400 hover:border-violet-300 hover:text-violet-500 transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
                    견적서 선택하기
                  </button>
                )}
                <p className="text-xs text-slate-400 mt-1">연결하면 리드 목록에서 견적서를 바로 불러올 수 있고, 수정 저장 시 자동으로 업데이트됩니다.</p>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex gap-2 justify-end">
              <button onClick={() => { setShowForm(false); setEditingLead(null); }} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50">취소</button>
              <button onClick={handleSave} disabled={saving}
                className="px-5 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-500 disabled:opacity-50">
                {saving ? '저장 중...' : (editingLead ? '수정 완료' : '등록')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showQuotePicker && (
        <QuotePickerModal
          onSelect={qNo => setForm(p => ({ ...p, quote_no: qNo }))}
          onClose={() => setShowQuotePicker(false)}
          quotes={quotes}
        />
      )}

      {showHospitalPicker && (
        <HospitalPickerModal
          hospitals={hospitals}
          leads={leads}
          onClose={() => setShowHospitalPicker(false)}
          onSelect={(h, last) => {
            setForm(p => ({
              ...p,
              hospital_name: h.name || '',
              hospital_id: h.id || null,
              contact_name: (last && last.contact_name) || p.contact_name || '',
              contact_phone: (last && last.contact_phone) || p.contact_phone || '',
              dept: (last && last.dept) || p.dept || '',
              source: '재구매',
            }));
          }}
        />
      )}

      {/* 구글 캘린더 설정 모달 */}
      {showGcalSettings && <GcalSettingsModal
        connected={gcalConnected}
        onConnect={() => {
          gcalAuth((token) => {
            setGcalConnected(true);
          });
        }}
        onDisconnect={() => {
          gcalAccessToken = null;
          localStorage.removeItem('gcal_token');
          setGcalConnected(false);
        }}
        onClose={() => setShowGcalSettings(false)}
      />}

      {previewQuoteNo && <QuoteQuickPreviewModal
        quoteNo={previewQuoteNo.quoteNo}
        onClose={() => setPreviewQuoteNo(null)}
        onEdit={() => {
          const { lead, quoteNo } = previewQuoteNo;
          setPreviewQuoteNo(null);
          onCreateQuote && onCreateQuote(lead, 'load', quoteNo);
        }}
      />}

      {registerHospitalLead && <RegisterHospitalModal
        lead={registerHospitalLead}
        hospitals={hospitals}
        setHospitals={setHospitals}
        onClose={() => setRegisterHospitalLead(null)}
        onDone={(hospId) => {
          // 리드 상태 업데이트 (hospital_id 반영)
          setLeads(p => p.map(l => l.id === registerHospitalLead.id ? { ...l, hospital_id: hospId } : l));
          setRegisterHospitalLead(null);
          // 병원 상세 페이지로 이동
          if (nav?.goToHospital) {
            nav.goToHospital(hospId, 'contracts');
          }
        }}
      />}


      {quoteOptionsLead && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <div className="font-bold text-slate-900">견적서 작성</div>
                <div className="text-xs text-slate-400 mt-0.5">{quoteOptionsLead.contact_name}{quoteOptionsLead.dept ? ` · ${quoteOptionsLead.dept}` : ''}</div>
              </div>
              <button onClick={() => setQuoteOptionsLead(null)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="p-5 space-y-3">
              <button onClick={() => { onCreateQuote(quoteOptionsLead, 'new'); setQuoteOptionsLead(null); }}
                className="w-full flex items-start gap-4 p-4 rounded-xl border-2 border-slate-200 hover:border-blue-400 hover:bg-blue-50 transition-all text-left group">
                <div className="w-9 h-9 rounded-lg bg-slate-100 group-hover:bg-blue-100 flex items-center justify-center shrink-0 transition-colors">
                  <svg className="w-5 h-5 text-slate-500 group-hover:text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                </div>
                <div>
                  <div className="font-semibold text-slate-800 text-sm group-hover:text-blue-700">새로운 견적서 작성</div>
                  <div className="text-xs text-slate-400 mt-0.5">빈 견적서에서 직접 장비를 추가합니다</div>
                </div>
              </button>
              <button onClick={() => { onCreateQuote(quoteOptionsLead, 'standard'); setQuoteOptionsLead(null); }}
                className="w-full flex items-start gap-4 p-4 rounded-xl border-2 border-slate-200 hover:border-violet-400 hover:bg-violet-50 transition-all text-left group">
                <div className="w-9 h-9 rounded-lg bg-slate-100 group-hover:bg-violet-100 flex items-center justify-center shrink-0 transition-colors">
                  <svg className="w-5 h-5 text-slate-500 group-hover:text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 12h6m-6 4h6"/></svg>
                </div>
                <div>
                  <div className="font-semibold text-slate-800 text-sm group-hover:text-violet-700">표준견적서 가져오기</div>
                  <div className="text-xs text-slate-400 mt-0.5">진료과별 표준견적서에서 선택해 시작합니다{quoteOptionsLead.dept ? ` (${quoteOptionsLead.dept})` : ''}</div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   SAVED QUOTES LIST PAGE
   ============================================================ */
/* ============================================================
   CONTRACT FORM MODAL
   ============================================================ */
function ContractFormModal({ quote, onClose, onSaved }) {
  const linkedLead = quote?.linkedLead || null;
  const [hospitalName, setHospitalName] = React.useState(quote?.quoteInfo?.hospital || linkedLead?.hospital_name || '');
  const [contractDate, setContractDate] = React.useState(getToday());
  const [amount, setAmount] = React.useState(quote?.finalAmt || '');
  const [status, setStatus] = React.useState('완료');
  const [notes, setNotes] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [hospitals, setHospitals] = React.useState([]);
  const [suggestions, setSuggestions] = React.useState([]);

  React.useEffect(() => { dbLoadHospitals().then(setHospitals); }, []);
  React.useEffect(() => {
    if (hospitalName.length < 1) { setSuggestions([]); return; }
    setSuggestions(hospitals.filter(h => h.name.includes(hospitalName)).slice(0, 5));
  }, [hospitalName, hospitals]);

  const handleSave = async () => {
    if (status === '완료' && !hospitalName.trim()) { alert('완료 처리 시 병원명을 입력해주세요.'); return; }
    setSaving(true);
    try {
      let hospitalId = null;
      if (hospitalName.trim()) {
        const hosp = hospitals.find(h => h.name === hospitalName.trim());
        if (hosp) {
          hospitalId = hosp.id;
          // 리드 연락처 정보로 병원 업데이트 (완료 시) — 기존 마스터에 연락처 없으면 보강
          if (status === '완료' && linkedLead) {
            await dbUpdateHospital(hosp.id, {
              contact_name: hosp.contact_name || linkedLead.contact_name || '',
              contact_phone: hosp.contact_phone || linkedLead.contact_phone || '',
              phone: hosp.phone || linkedLead.contact_phone || '',
            });
          }
        }
        // 마스터에 없으면 hospital_id=null — 자동 등록 안 함
        // (병원 마스터 등록은 '영업관리 → 납품완료 → 관리등록' 또는 '병원 관리' 메뉴에서만)
      }
      await dbSaveContract({
        hospital_id: hospitalId,
        hospital_name: hospitalName.trim() || null,
        quote_name: quote?.quoteNo || '',
        contract_date: contractDate,
        amount: typeof amount === 'string' ? (parseInt(amount.replace(/,/g, '')) || null) : (amount || null),
        status,
        categories: (quote?.categories || []).map(cat => ({
          ...cat,
          items: (cat.items || []).filter(item => !item.excluded),
        })).filter(cat => (cat.items || []).length > 0),
        notes,
      });
      onSaved && onSaved();
      onClose();
    } catch(e) { console.error('계약 등록 오류:', e); alert('저장 중 오류가 발생했습니다.'); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div className="font-bold text-slate-900">계약 등록</div>
            <div className="text-xs text-slate-400 mt-0.5">{quote?.quoteNo} 기반 계약</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="p-6 space-y-4">
          {linkedLead && (
            <div className="flex items-center gap-2 px-3 py-2 bg-violet-50 border border-violet-200 rounded-lg">
              <svg className="w-3.5 h-3.5 text-violet-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
              <span className="text-xs text-violet-700 font-medium">리드 연결됨 — {linkedLead.source || '리드'}</span>
              <span className="text-xs text-violet-500">{linkedLead.contact_name}{linkedLead.contact_phone ? ` · ${linkedLead.contact_phone}` : ''}</span>
              {status === '완료' && <span className="ml-auto text-xs text-violet-400">계약 완료 시 병원에 연락처 자동 등록</span>}
            </div>
          )}
          <div className="relative">
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">
              병원명 {status === '완료' ? <span className="text-red-400">*</span> : <span className="text-slate-400 font-normal">(선택 — 취소 시 미입력 가능)</span>}
            </label>
            <input value={hospitalName} onChange={e => setHospitalName(e.target.value)}
              placeholder={status === '완료' ? '병원명 입력 또는 검색' : '미정인 경우 비워두세요'}
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${status === '취소' ? 'border-slate-100 bg-slate-50' : 'border-slate-200'}`}/>
            {suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 bg-white border border-slate-200 rounded-lg shadow-lg mt-1 z-10 overflow-hidden">
                {suggestions.map(h => (
                  <button key={h.id} onClick={() => { setHospitalName(h.name); setSuggestions([]); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors">
                    {h.name}{h.region && <span className="text-slate-400 text-xs ml-2">· {h.region}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">견적번호</label>
            <input value={quote?.quoteNo || ''} readOnly className="w-full border border-slate-100 bg-slate-50 rounded-lg px-3 py-2 text-sm text-slate-500"/>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">계약일자</label>
            <input type="date" value={contractDate} onChange={e => setContractDate(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">계약금액 (원)</label>
            <input type="number" value={amount || ''} onChange={e => setAmount(e.target.value)}
              placeholder="자동입력 (수정 가능)"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">계약상태</label>
            <select value={status} onChange={e => setStatus(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="완료">완료</option>
              <option value="취소">취소</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">메모</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              placeholder="계약 관련 메모"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"/>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50">취소</button>
          <button onClick={handleSave} disabled={saving}
            className="px-5 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-500 disabled:opacity-50">
            {saving ? '저장 중...' : '계약 등록'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   HOSPITALS PAGE
   ============================================================ */
function HospitalDashboard({ hospitals, contracts, serviceReqs, inspectionItems = [], onSelectHosp }) {
  const [deliveries, setDeliveries] = React.useState([]);
  const [loadingDash, setLoadingDash] = React.useState(true);

  React.useEffect(() => {
    (async () => {
      setLoadingDash(true);
      try {
        const { data } = await sb.from('deliveries').select('id, hospital_id, delivered_date, total_amount').order('delivered_date', { ascending: true }).limit(5000);
        setDeliveries(data || []);
      } catch(e) { console.error(e); }
      setLoadingDash(false);
    })();
  }, []);

  const today = new Date();
  today.setHours(0,0,0,0);
  const fmtDate = d => `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}`;
  const daysDiff = d => Math.ceil((new Date(d) - today) / (1000*60*60*24));
  const daysPast = d => Math.floor((today - new Date(d)) / (1000*60*60*24));

  // 이번주 월~일
  const dow = today.getDay();
  const weekMon = new Date(today); weekMon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  const weekSun = new Date(weekMon); weekSun.setDate(weekMon.getDate() + 6);
  const isThisWeek = d => { const dt = new Date(d); return dt >= weekMon && dt <= weekSun; };
  // 이번달
  const isThisMonth = d => { const dt = new Date(d); return dt.getFullYear() === today.getFullYear() && dt.getMonth() === today.getMonth(); };

  // KPI
  const totalDeliveryAmt = deliveries.reduce((s, d) => s + (d.total_amount || 0), 0);
  const thisYear = today.getFullYear();
  const yearDeliveryAmt = deliveries.filter(d => d.delivered_date?.startsWith(String(thisYear))).reduce((s, d) => s + (d.total_amount || 0), 0);
  const activeContracts = contracts.filter(c => c.status === '진행중');
  const pendingSR = serviceReqs.filter(s => s.status === '접수' || s.status === '처리중');
  const thisMonthHosps = hospitals.filter(h => h.created_at && isThisMonth(h.created_at));

  const fmt = n => n >= 100000000 ? `${(n/100000000).toFixed(1)}억` : n >= 10000 ? `${Math.round(n/10000).toLocaleString()}만` : n.toLocaleString();

  // ── 할 일 항목 생성 ──
  const allTodoItems = [];

  // A/S 미처리  (sortVal: 음수 = 오래될수록 먼저)
  serviceReqs.filter(s => s.status === '접수' || s.status === '처리중').forEach(s => {
    const days = s.requested_at ? daysPast(s.requested_at) : 0;
    const hosp = hospitals.find(h => h.id === s.hospital_id);
    if (!hosp) return;
    const item = { type: 'as', hosp, tab: 'service', detail: s.equipment_name || '장비 미상', days, sortVal: -days };
    if (days >= 14) allTodoItems.push({ ...item, bucket: 'today', label: `A/S 미처리 ${days}일`, urgency: 'red' });
    else if (days >= 7) allTodoItems.push({ ...item, bucket: 'today', label: `A/S 미처리 ${days}일`, urgency: 'amber' });
    else if (days >= 3) allTodoItems.push({ ...item, bucket: 'week', label: `A/S 미처리 ${days}일`, urgency: 'amber' });
    else allTodoItems.push({ ...item, bucket: 'month', label: days === 0 ? 'A/S 신규 접수 (오늘)' : `A/S 신규 접수 ${days}일`, urgency: 'blue' });
  });

  // 보증기간 만료  (sortVal: dl = 남은 일수, 적을수록 먼저)
  contracts.forEach(c => {
    if (!c.contract_date || !c.hospital_id) return;
    const cats = Array.isArray(c.categories) ? c.categories : [];
    cats.forEach(cat => (cat.items || []).forEach(item => {
      const months = item.warranty_months ?? 12;
      const exp = new Date(c.contract_date);
      exp.setMonth(exp.getMonth() + Number(months));
      const dl = daysDiff(exp);
      const hosp = hospitals.find(h => h.id === c.hospital_id);
      if (!hosp || dl < 0 || dl > 90) return;
      const base = { type: 'warranty', hosp, tab: 'contracts', detail: item.name || '장비', sortVal: dl };
      if (dl <= 7)  allTodoItems.push({ ...base, bucket: 'today', label: `보증만료 D-${dl}`, urgency: dl <= 3 ? 'red' : 'amber' });
      else if (dl <= 21) allTodoItems.push({ ...base, bucket: 'week',  label: `보증만료 D-${dl}`, urgency: 'amber' });
      else          allTodoItems.push({ ...base, bucket: 'month', label: `보증만료 D-${dl}`, urgency: dl <= 60 ? 'blue' : 'green' });
    }));
  });

  // 납품 30일 점검  (sortVal: 30일 기준까지 남은 일수, 음수 = 지난)
  deliveries.forEach(d => {
    if (!d.delivered_date || !d.hospital_id) return;
    const elapsed = daysPast(d.delivered_date);
    const hosp = hospitals.find(h => h.id === d.hospital_id);
    if (!hosp) return;
    const base = { type: 'check', hosp, tab: 'deliveries', detail: fmtDate(new Date(d.delivered_date)) + ' 납품', sortVal: 30 - elapsed };
    if (elapsed >= 28 && elapsed <= 35)      allTodoItems.push({ ...base, bucket: 'today', label: `납품 ${elapsed}일 점검`, urgency: 'green' });
    else if (elapsed >= 21 && elapsed <= 27) allTodoItems.push({ ...base, bucket: 'week',  label: `납품 점검 예정 D-${28-elapsed}`, urgency: 'green' });
    else if (elapsed >= 7  && elapsed <= 20) allTodoItems.push({ ...base, bucket: 'month', label: `납품 ${elapsed}일 경과 (점검 예정)`, urgency: 'blue' });
  });

  // 방사선 발생장치 3년 주기 검사  (sortVal: dl = 남은 일수)
  inspectionItems.forEach(item => {
    if (!item.delivered_date || !item.hospital_id) return;
    const hosp = hospitals.find(h => h.id === item.hospital_id);
    if (!hosp) return;
    const next = new Date(item.delivered_date);
    next.setFullYear(next.getFullYear() + 3);
    const dl = Math.ceil((next - today) / (1000*60*60*24));
    const detail = item.item_name + (item.model_name ? ` (${item.model_name})` : '');
    const base = { type: 'inspection', hosp, tab: 'info', detail, sortVal: dl };
    if (dl < 0)         allTodoItems.push({ ...base, bucket: 'today', label: `검사만료 ${Math.abs(dl)}일 경과`, urgency: 'red' });
    else if (dl <= 30)  allTodoItems.push({ ...base, bucket: 'today', label: `방사선검사 D-${dl}`, urgency: dl <= 7 ? 'red' : 'amber' });
    else if (dl <= 90)  allTodoItems.push({ ...base, bucket: 'week',  label: `방사선검사 D-${dl}`, urgency: 'amber' });
    else if (dl <= 180) allTodoItems.push({ ...base, bucket: 'month', label: `방사선검사 D-${dl}`, urgency: 'blue' });
  });

  // sortVal 기준 오름차순 정렬 (가장 급한 것 = 가장 작은 값 먼저)
  allTodoItems.sort((a, b) => (a.sortVal ?? 0) - (b.sortVal ?? 0));

  const todayItems  = allTodoItems.filter(t => t.bucket === 'today');
  const weekItems   = allTodoItems.filter(t => t.bucket === 'week');
  const monthItems  = allTodoItems.filter(t => t.bucket === 'month');

  const urgencyStyle = { red:'border-red-200 bg-red-50', amber:'border-amber-200 bg-amber-50', green:'border-emerald-100 bg-emerald-50', blue:'border-blue-100 bg-blue-50' };
  const urgencyDot   = { red:'bg-red-500', amber:'bg-amber-400', green:'bg-emerald-500', blue:'bg-blue-400' };
  const urgencyText  = { red:'text-red-700', amber:'text-amber-700', green:'text-emerald-700', blue:'text-blue-700' };

  const TodoSection = ({ title, items, emptyMsg, badgeColor = 'bg-slate-100 text-slate-500' }) => (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-xs font-bold text-slate-400 uppercase tracking-widest">{title}</div>
        <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${items.length > 0 ? badgeColor : 'bg-slate-100 text-slate-400'}`}>{items.length}</span>
      </div>
      {loadingDash ? <div className="text-xs text-slate-400">불러오는 중...</div>
       : items.length === 0 ? <div className="text-xs text-slate-400 py-1">{emptyMsg}</div>
       : <div className="space-y-1.5">
           {items.map((t, i) => (
             <div key={i} onClick={() => onSelectHosp(t.hosp, t.tab)}
               className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer hover:brightness-95 transition-all ${urgencyStyle[t.urgency]}`}>
               <span className={`w-2 h-2 rounded-full shrink-0 ${urgencyDot[t.urgency]}`}/>
               <span className={`text-xs font-bold w-28 shrink-0 ${urgencyText[t.urgency]}`}>{t.label}</span>
               <span className="font-semibold text-slate-800 text-sm">{t.hosp.name}</span>
               <span className="text-xs text-slate-400 ml-auto truncate max-w-[120px]">{t.detail}</span>
               <svg className="w-3 h-3 text-slate-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
             </div>
           ))}
         </div>}
    </div>
  );

  // 월별 납품 추이 — 올해 1월~12월
  const monthlyData = Array.from({length:12}, (_, i) => {
    const key = `${thisYear}-${pad(i+1)}`;
    const amt = deliveries.filter(d => d.delivered_date?.startsWith(key)).reduce((s,d) => s+(d.total_amount||0), 0);
    return { month: `${i+1}월`, amount: amt, isCurrent: i === today.getMonth() };
  });
  const maxMonthly = Math.max(...monthlyData.map(m => m.amount), 1);

  // 납품금액 Top 10
  const hospAmtMap = {};
  deliveries.forEach(d => { if (d.hospital_id) hospAmtMap[d.hospital_id] = (hospAmtMap[d.hospital_id] || 0) + (d.total_amount || 0); });
  const top10 = Object.entries(hospAmtMap).map(([hid, amt]) => ({ hosp: hospitals.find(h => h.id === hid), amt }))
    .filter(x => x.hosp).sort((a,b) => b.amt - a.amt).slice(0, 10);
  const maxTop = Math.max(...top10.map(x => x.amt), 1);

  // 재구매 많은 병원 (납품 건수 기준)
  const hospCntMap = {};
  deliveries.forEach(d => { if (d.hospital_id) hospCntMap[d.hospital_id] = (hospCntMap[d.hospital_id] || 0) + 1; });
  const repeatTop = Object.entries(hospCntMap)
    .filter(([, cnt]) => cnt >= 2)
    .map(([hid, cnt]) => ({ hosp: hospitals.find(h => h.id === hid), cnt, amt: hospAmtMap[hid] || 0 }))
    .filter(x => x.hosp).sort((a,b) => b.cnt - a.cnt).slice(0, 10);
  const maxCnt = Math.max(...repeatTop.map(x => x.cnt), 1);

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-slate-50">
      <div className="max-w-7xl mx-auto space-y-5">

        {/* KPI 카드 */}
        <div className="grid grid-cols-4 gap-4">
          {[
            { label:'관리 병원', value:hospitals.length, sub:`이번달 +${thisMonthHosps.length}`, color:'text-blue-600' },
            { label:'총 납품금액', value:fmt(totalDeliveryAmt)+'원', sub:`올해 ${fmt(yearDeliveryAmt)}원`, color:'text-violet-600' },
            { label:'진행중 계약', value:activeContracts.length+'건', sub:`전체 ${contracts.length}건`, color:'text-emerald-600' },
            { label:'미처리 A/S', value:pendingSR.length+'건', sub:`접수 ${serviceReqs.filter(s=>s.status==='접수').length} · 처리중 ${serviceReqs.filter(s=>s.status==='처리중').length}`, color:pendingSR.length > 0 ? 'text-red-600':'text-slate-600' },
          ].map((k,i) => (
            <div key={i} className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">{k.label}</div>
              <div className={`text-2xl font-bold ${k.color}`}>{k.value}</div>
              <div className="text-xs text-slate-400 mt-1">{k.sub}</div>
            </div>
          ))}
        </div>

        {/* 할 일 3단계 */}
        <TodoSection title="오늘 할 일" items={todayItems} emptyMsg="오늘 처리할 항목이 없습니다" badgeColor="bg-red-100 text-red-600" />
        <TodoSection title="이번주 할 일" items={weekItems} emptyMsg="이번주 예정 항목이 없습니다" badgeColor="bg-amber-100 text-amber-700" />
        <TodoSection title="이번달 할 일" items={monthItems} emptyMsg="이번달 예정 항목이 없습니다" badgeColor="bg-blue-100 text-blue-700" />

        {/* 차트 영역 */}
        <div className="grid grid-cols-3 gap-5">
          {/* 월별 납품 추이 — 1월~12월 */}
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">{thisYear}년 월별 납품금액</div>
            {loadingDash ? <div className="text-xs text-slate-400">불러오는 중...</div> : (
              <div className="space-y-1.5">
                {monthlyData.map((m, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className={`text-xs w-8 shrink-0 text-right font-medium ${m.isCurrent ? 'text-blue-600' : 'text-slate-400'}`}>{m.month}</div>
                    <div className="flex-1 h-4 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${m.isCurrent ? 'bg-blue-500' : 'bg-blue-300'}`}
                        style={{width:`${m.amount > 0 ? Math.max((m.amount/maxMonthly)*100, 2) : 0}%`}}/>
                    </div>
                    <div className="text-xs font-mono text-slate-500 w-14 text-right shrink-0">{m.amount > 0 ? fmt(m.amount) : '—'}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 납품금액 Top 10 */}
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">납품금액 Top 10</div>
            {loadingDash ? <div className="text-xs text-slate-400">불러오는 중...</div> : top10.length === 0 ? (
              <div className="text-xs text-slate-400">납품 데이터가 없습니다</div>
            ) : (
              <div className="space-y-2">
                {top10.map((x, i) => (
                  <div key={i} className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 rounded-lg px-1 py-0.5 transition-colors"
                    onClick={() => onSelectHosp(x.hosp, 'deliveries')}>
                    <div className={`text-xs font-bold w-4 text-center shrink-0 ${i < 3 ? 'text-amber-500':'text-slate-300'}`}>{i+1}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-slate-700 truncate">{x.hosp.name}</div>
                      <div className="h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden">
                        <div className="h-full bg-violet-400 rounded-full" style={{width:`${(x.amt/maxTop)*100}%`}}/>
                      </div>
                    </div>
                    <div className="text-xs font-mono text-slate-500 shrink-0">{fmt(x.amt)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 재구매 Top 10 */}
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">재구매 많은 병원</div>
            <div className="text-xs text-slate-400 mb-4">납품 건수 기준</div>
            {loadingDash ? <div className="text-xs text-slate-400">불러오는 중...</div> : repeatTop.length === 0 ? (
              <div className="text-xs text-slate-400">재구매 데이터가 없습니다</div>
            ) : (
              <div className="space-y-2">
                {repeatTop.map((x, i) => (
                  <div key={i} className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 rounded-lg px-1 py-0.5 transition-colors"
                    onClick={() => onSelectHosp(x.hosp, 'deliveries')}>
                    <div className={`text-xs font-bold w-4 text-center shrink-0 ${i < 3 ? 'text-emerald-500':'text-slate-300'}`}>{i+1}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-slate-700 truncate">{x.hosp.name}</div>
                      <div className="h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden">
                        <div className="h-full bg-emerald-400 rounded-full" style={{width:`${(x.cnt/maxCnt)*100}%`}}/>
                      </div>
                    </div>
                    <div className="flex flex-col items-end shrink-0">
                      <div className="text-xs font-bold text-emerald-600">{x.cnt}회</div>
                      <div className="text-xs font-mono text-slate-400">{fmt(x.amt)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

function HospitalsPage({ onBack, initialHospId = null, initialTab = 'info', onNavigated, user, onLogout, nav }) {
  const [hospitals, setHospitals] = React.useState([]);
  const [contracts, setContracts] = React.useState([]);
  const [serviceReqs, setServiceReqs] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [selectedHosp, setSelectedHosp] = React.useState(null);
  const [detailTab, setDetailTab] = React.useState('info');
  const [showDashboard, setShowDashboard] = React.useState(false);
  const [showNewHospForm, setShowNewHospForm] = React.useState(false);
  const [editingHosp, setEditingHosp] = React.useState(null);
  const [newHosp, setNewHosp] = React.useState({ name:'', region:'', address:'', phone:'', contact_name:'', contact_phone:'', contact_email:'', notes:'', access_pin:'' });
  const [savingHosp, setSavingHosp] = React.useState(false);
  const [linkCopied, setLinkCopied] = React.useState(false);
  const [showNewSRForm, setShowNewSRForm] = React.useState(false);
  const [newSR, setNewSR] = React.useState({ equipment_name:'', model_name:'', issue:'', status:'접수', requested_at:getToday(), engineer:'', notes:'' });
  const [savingSR, setSavingSR] = React.useState(false);
  const [expandedContractId, setExpandedContractId] = React.useState(null);
  const [deliveries, setDeliveries] = React.useState([]);
  const [loadingDeliveries, setLoadingDeliveries] = React.useState(false);
  const [expandedDeliveryId, setExpandedDeliveryId] = React.useState(null);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [deletingHosp, setDeletingHosp] = React.useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [hospRefs, setHospRefs] = React.useState(null); // { leads, contracts, exp_rev, recv_tx, total }
  const [refsLoading, setRefsLoading] = React.useState(false);
  React.useEffect(() => {
    if (!showDeleteConfirm || !selectedHosp) { setHospRefs(null); return; }
    setRefsLoading(true);
    (async () => {
      try {
        const [leads, contracts, expRev, recvTx] = await Promise.all([
          sb.from('leads').select('id', { count:'exact', head:true }).eq('hospital_id', selectedHosp.id),
          sb.from('contracts').select('id', { count:'exact', head:true }).eq('hospital_id', selectedHosp.id),
          sb.from('expected_revenue').select('id', { count:'exact', head:true }).eq('target_hospital_id', selectedHosp.id),
          sb.from('receivable_transactions').select('id', { count:'exact', head:true }).eq('hospital_id', selectedHosp.id),
        ]);
        const refs = {
          leads: leads.count || 0, contracts: contracts.count || 0,
          exp_rev: expRev.count || 0, recv_tx: recvTx.count || 0,
        };
        refs.total = refs.leads + refs.contracts + refs.exp_rev + refs.recv_tx;
        setHospRefs(refs);
      } finally { setRefsLoading(false); }
    })();
  }, [showDeleteConfirm, selectedHosp]);
  const [inspectionItems, setInspectionItems] = React.useState([]);

  const STATUS_COLORS = { '진행중':'bg-blue-100 text-blue-700', '완료':'bg-emerald-100 text-emerald-700', '취소':'bg-slate-100 text-slate-500', '접수':'bg-amber-100 text-amber-700', '처리중':'bg-blue-100 text-blue-700' };

  const loadAll = async () => {
    setLoading(true);
    try {
      const [h, c, s, insp] = await Promise.all([dbLoadHospitals(), dbLoadContracts(), dbLoadServiceRequests(), dbLoadAllInspectionItems()]);
      setHospitals(h); setContracts(c); setServiceReqs(s); setInspectionItems(insp);
      if (initialHospId) {
        const target = h.find(x => x.id === initialHospId);
        if (target) {
          setSelectedHosp(target);
          setDetailTab(initialTab);
          setShowDashboard(false);
          if (initialTab === 'deliveries') loadDeliveries(target.id);
        }
        if (onNavigated) onNavigated();
      }
    } catch(e) { console.error(e); }
    setLoading(false);
  };
  React.useEffect(() => { loadAll(); }, []);

  const loadDeliveries = async (hospId) => {
    setLoadingDeliveries(true);
    const data = await dbLoadDeliveries(hospId);
    setDeliveries(data);
    setLoadingDeliveries(false);
  };

  const openNewHospForm = () => {
    setEditingHosp(null);
    setNewHosp({ name:'', region:'', address:'', phone:'', contact_name:'', contact_phone:'', contact_email:'', notes:'', access_pin:'' });
    setShowNewHospForm(true);
  };
  const openEditHospForm = (h) => {
    setEditingHosp(h);
    setNewHosp({ name:h.name||'', region:h.region||'', address:h.address||'', phone:h.phone||'', contact_name:h.contact_name||'', contact_phone:h.contact_phone||'', contact_email:h.contact_email||'', notes:h.notes||'', access_pin:h.access_pin||'' });
    setShowNewHospForm(true);
  };

  const handleSaveHosp = async () => {
    if (!newHosp.name.trim()) { alert('병원명을 입력해주세요.'); return; }
    setSavingHosp(true);
    try {
      if (editingHosp) {
        await dbUpdateHospital(editingHosp.id, newHosp);
        setHospitals(p => p.map(h => h.id === editingHosp.id ? { ...h, ...newHosp } : h));
        if (selectedHosp?.id === editingHosp.id) setSelectedHosp(p => ({ ...p, ...newHosp }));
      } else {
        const id = await dbSaveHospital(newHosp);
        setHospitals(p => [{ id, ...newHosp, created_at: new Date().toISOString() }, ...p]);
      }
      setShowNewHospForm(false); setEditingHosp(null);
    } catch(e) { console.error(e); alert('저장 중 오류가 발생했습니다.'); }
    setSavingHosp(false);
  };

  const handleDeleteHosp = async () => {
    if (!selectedHosp) return;
    setDeletingHosp(true);
    try {
      await dbDeleteHospital(selectedHosp.id);
      setHospitals(p => p.filter(h => h.id !== selectedHosp.id));
      setSelectedHosp(null);
      setShowDeleteConfirm(false);
    } catch(e) {
      console.error(e);
      const msg = e?.message || String(e);
      if (msg.includes('foreign key') || msg.includes('violates') || e?.code === '23503') {
        alert(`삭제 실패 — 다른 데이터(영업 lead·계약·매출·수금)에서 이 병원을 참조하고 있어 DB가 막았습니다.\n해당 데이터를 먼저 정리하거나 다른 병원으로 옮긴 뒤 다시 시도하세요.\n\n원본 메시지: ${msg}`);
      } else {
        alert(`삭제 중 오류: ${msg}`);
      }
    }
    setDeletingHosp(false);
  };

  const handleSaveSR = async () => {
    setSavingSR(true);
    try {
      const sr = { ...newSR, hospital_id: selectedHosp.id, hospital_name: selectedHosp.name };
      await dbSaveServiceRequest(sr);
      await loadAll();
      setShowNewSRForm(false);
      setNewSR({ equipment_name:'', model_name:'', issue:'', status:'접수', requested_at:getToday(), engineer:'', notes:'' });
    } catch(e) { console.error(e); alert('저장 중 오류가 발생했습니다.'); }
    setSavingSR(false);
  };

  const filteredHospitals = hospitals.filter(h => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.trim().toLowerCase();
    return (h.name||'').toLowerCase().includes(q) ||
           (h.region||'').toLowerCase().includes(q) ||
           (h.contact_name||'').toLowerCase().includes(q) ||
           (h.phone||'').includes(q) ||
           (h.contact_phone||'').includes(q);
  });
  const hospContracts = contracts.filter(c => c.hospital_id === selectedHosp?.id);
  const hospSRs = serviceReqs.filter(s => s.hospital_id === selectedHosp?.id);
  const hospInspItems = inspectionItems.filter(i => i.hospital_id === selectedHosp?.id);

  // 방사선 검사 D-day 계산
  const calcInsp = (deliveredDate) => {
    if (!deliveredDate) return null;
    const next = new Date(deliveredDate);
    next.setFullYear(next.getFullYear() + 3);
    const diff = Math.ceil((next - new Date()) / (1000*60*60*24));
    return { next, diff };
  };

  return (
    <div style={{height:'100vh', display:'flex', flexDirection:'column', overflow:'hidden', background:'#f1f5f9'}}>
      {/* 헤더 */}
      <AppHeader title="병원 관리" onLogoClick={onBack} user={user} onLogout={onLogout} nav={nav}>
        <button onClick={() => nav?.service?.()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 hover:bg-slate-800 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
          전체 A/S 이력
        </button>
        <button onClick={() => setShowDashboard(p => !p)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors ${showDashboard ? 'bg-white text-slate-900 border-white' : 'border-slate-600 text-slate-300 hover:bg-slate-800'}`}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
          {showDashboard ? '목록 보기' : '대시보드'}
        </button>
        <button onClick={()=>nav?.manage?.()}
          title="병원 마스터 등록은 장비 및 거래처 관리 → 병원 관리 탭에서"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>
          신규 등록 → 거래처 관리
        </button>
      </AppHeader>

      {/* 대시보드 */}
      {showDashboard && (
        <HospitalDashboard
          hospitals={hospitals}
          contracts={contracts}
          serviceReqs={serviceReqs}
          inspectionItems={inspectionItems}
          onSelectHosp={(hosp, tab) => {
            setSelectedHosp(hosp);
            setDetailTab(tab);
            setShowDashboard(false);
            setDeliveries([]);
            if (tab === 'deliveries') loadDeliveries(hosp.id);
          }}
        />
      )}

      {/* 바디 — 좌우 패널 */}
      <div className="flex-1 overflow-hidden flex" style={{display: showDashboard ? 'none' : 'flex'}}>
        {/* 좌: 병원 목록 */}
        <div className={`${selectedHosp ? 'w-80' : 'flex-1'} border-r border-slate-200 overflow-y-auto bg-white shrink-0`}>
          {loading ? (
            <div className="p-10 text-center text-slate-400 text-sm">불러오는 중...</div>
          ) : hospitals.length === 0 ? (
            <div className="p-10 text-center text-slate-400">
              <div className="text-sm font-medium">등록된 병원이 없습니다</div>
              <div className="text-xs mt-1"><b>장비 및 거래처 관리 → 병원 관리</b> 탭에서 등록하세요</div>
            </div>
          ) : (
            <div>
              {/* 검색창 */}
              <div className="px-3 py-2.5 border-b border-slate-100 sticky top-0 bg-white z-10">
                <div className="relative">
                  <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0"/></svg>
                  <input
                    type="text"
                    placeholder="병원명, 지역, 담당자 검색..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-7 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-slate-50"
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                  )}
                </div>
              </div>
              <div className="px-5 py-2 border-b border-slate-100 text-xs text-slate-400 font-medium bg-white sticky top-[52px] z-10">
                {searchQuery ? `"${searchQuery}" 검색 결과 ${filteredHospitals.length}개` : `총 ${hospitals.length}개 병원`}
              </div>
              {filteredHospitals.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs">검색 결과가 없습니다</div>
              ) : filteredHospitals.map(h => {
                const hC = contracts.filter(c => c.hospital_id === h.id).length;
                const hS = serviceReqs.filter(s => s.hospital_id === h.id).length;
                const isSel = selectedHosp?.id === h.id;
                return (
                  <div key={h.id} onClick={() => { setSelectedHosp(h); setDetailTab('info'); setDeliveries([]); setExpandedDeliveryId(null); }}
                    className={`px-5 py-3.5 cursor-pointer border-b border-slate-50 hover:bg-slate-50 transition-colors ${isSel ? 'bg-blue-50 border-l-4 border-l-blue-500' : 'border-l-4 border-l-transparent'}`}>
                    <div className="font-semibold text-slate-800 text-sm">{h.name}</div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {h.region && <span className="text-xs text-slate-400">{h.region}</span>}
                      {h.contact_name && <span className="text-xs text-slate-400">{h.contact_name}</span>}
                      <span className="text-xs text-slate-300">계약 {hC} · A/S {hS}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 우: 병원 상세 */}
        {selectedHosp && (
          <div className="flex-1 overflow-y-auto bg-slate-50 min-w-0">
            <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-start justify-between">
              <div>
                <div className="font-bold text-slate-900 text-base">{selectedHosp.name}</div>
                {selectedHosp.region && <div className="text-xs text-slate-400 mt-0.5">{selectedHosp.region}</div>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => openEditHospForm(selectedHosp)}
                  className="px-3 py-1.5 text-xs border border-slate-200 text-slate-600 rounded hover:bg-slate-50">수정</button>
                <button onClick={() => setShowDeleteConfirm(true)}
                  className="px-3 py-1.5 text-xs border border-red-200 text-red-500 rounded hover:bg-red-50 transition-colors">삭제</button>
                <button onClick={() => setSelectedHosp(null)} className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
              </div>
            </div>
            <div className="bg-white border-b border-slate-200 px-6">
              {[
                {key:'info',label:'기본 정보'},
                {key:'contracts',label:`계약 이력 (${hospContracts.length})`},
                {key:'service',label:`A/S 이력 (${hospSRs.length})`},
                {key:'deliveries',label:'납품 이력'},
              ].map(tab => (
                <button key={tab.key} onClick={() => {
                  setDetailTab(tab.key);
                  if (tab.key === 'deliveries' && deliveries.length === 0) loadDeliveries(selectedHosp.id);
                }}
                  className={`px-4 py-3 text-sm font-semibold border-b-2 mr-1 transition-colors ${detailTab===tab.key ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-400 hover:text-slate-700'}`}>
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="p-6">
              {/* 기본 정보 탭 */}
              {detailTab === 'info' && (
                <div className="space-y-4">
                  <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                    {[{label:'병원명',value:selectedHosp.name},{label:'지역',value:selectedHosp.region},{label:'주소',value:selectedHosp.address},{label:'병원 전화',value:selectedHosp.phone},{label:'담당자',value:selectedHosp.contact_name},{label:'담당자 연락처',value:selectedHosp.contact_phone},{label:'담당자 이메일',value:selectedHosp.contact_email},{label:'메모',value:selectedHosp.notes}].map(row => (
                      <div key={row.label} className="flex px-5 py-3 border-b border-slate-50 last:border-0">
                        <div className="w-36 text-xs font-semibold text-slate-500 shrink-0 pt-0.5">{row.label}</div>
                        <div className="text-sm text-slate-800">{row.value || <span className="text-slate-300">—</span>}</div>
                      </div>
                    ))}
                    <div className="flex px-5 py-3">
                      <div className="w-36 text-xs font-semibold text-slate-500 shrink-0">등록일</div>
                      <div className="text-sm text-slate-500">{selectedHosp.created_at ? new Date(selectedHosp.created_at).toLocaleDateString('ko-KR') : '—'}</div>
                    </div>
                  </div>

                  {/* 방사선 발생장치 검사 현황 */}
                  {hospInspItems.length > 0 && (
                    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                      <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                        <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
                        <div className="font-semibold text-slate-800 text-sm">방사선 발생장치 안전관리 검사</div>
                        <span className="ml-1 text-xs text-slate-400 font-normal">3년 주기 의무 검사</span>
                        <span className="ml-auto text-xs font-semibold text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">{hospInspItems.length}대</span>
                      </div>
                      <table className="w-full">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-100">
                            <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500">품목명</th>
                            <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500">모델명</th>
                            <th className="text-center px-4 py-2 text-xs font-semibold text-slate-500">납품일</th>
                            <th className="text-center px-4 py-2 text-xs font-semibold text-slate-500">다음 검사 만료일</th>
                            <th className="text-center px-4 py-2 text-xs font-semibold text-slate-500">상태</th>
                          </tr>
                        </thead>
                        <tbody>
                          {hospInspItems.map((item, i) => {
                            const r = calcInsp(item.delivered_date);
                            if (!r) return null;
                            const { next, diff } = r;
                            const nextStr = next.toISOString().substring(0, 10);
                            const isOverdue = diff < 0;
                            const statusLabel = isOverdue ? `만료 ${Math.abs(diff)}일 경과` : `D-${diff}`;
                            const statusCls = isOverdue ? 'bg-red-100 text-red-600 border-red-200'
                              : diff <= 30  ? 'bg-amber-100 text-amber-700 border-amber-200'
                              : diff <= 180 ? 'bg-blue-100 text-blue-700 border-blue-200'
                              : 'bg-emerald-100 text-emerald-700 border-emerald-200';
                            return (
                              <tr key={i} className={`border-b border-slate-50 last:border-0 ${isOverdue ? 'bg-red-50/30' : diff <= 30 ? 'bg-amber-50/30' : ''}`}>
                                <td className="px-4 py-2.5 text-xs font-semibold text-slate-700">{item.item_name}</td>
                                <td className="px-4 py-2.5 text-xs text-slate-500">{item.model_name || '—'}</td>
                                <td className="px-4 py-2.5 text-xs text-center text-slate-500">{item.delivered_date}</td>
                                <td className="px-4 py-2.5 text-xs text-center font-medium text-slate-700">{nextStr}</td>
                                <td className="px-4 py-2.5 text-center">
                                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${statusCls}`}>{statusLabel}</span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* 병원 포털 링크 */}
                  <div className="bg-blue-50 rounded-xl border border-blue-200 overflow-hidden">
                    <div className="px-5 py-3 border-b border-blue-100 flex items-center gap-2">
                      <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
                      <div className="font-semibold text-blue-900 text-sm">병원 포털 링크</div>
                    </div>
                    {!selectedHosp.token || !selectedHosp.access_pin ? (
                      <div className="px-5 py-4 text-xs text-blue-700">
                        병원 수정에서 <span className="font-semibold">접속 코드(PIN)</span>를 설정하면 포털 링크가 생성됩니다.
                      </div>
                    ) : (
                      <div className="px-5 py-4 space-y-3">
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-blue-600 font-semibold mb-1">포털 URL</div>
                            <div className="bg-white border border-blue-200 rounded-lg px-3 py-2 text-xs font-mono text-slate-600 break-all">
                              {window.location.origin}/hospital.html?token={selectedHosp.token}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div>
                            <div className="text-xs text-blue-600 font-semibold mb-1">접속 코드</div>
                            <div className="bg-white border border-blue-200 rounded-lg px-3 py-2 text-sm font-bold text-slate-800 tracking-widest inline-block">
                              {selectedHosp.access_pin}
                            </div>
                          </div>
                          <div className="flex flex-col gap-2 ml-auto">
                            <button
                              onClick={() => {
                                const url = `${window.location.origin}/hospital.html?token=${selectedHosp.token}`;
                                navigator.clipboard.writeText(url).then(() => {
                                  setLinkCopied(true);
                                  setTimeout(() => setLinkCopied(false), 2000);
                                });
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-500 transition-colors whitespace-nowrap"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                              {linkCopied ? '복사됨!' : 'URL 복사'}
                            </button>
                            <button
                              onClick={() => {
                                const text = `DWmedi 병원 포털 접속 안내\n\nURL: ${window.location.origin}/hospital.html?token=${selectedHosp.token}\n접속 코드: ${selectedHosp.access_pin}`;
                                navigator.clipboard.writeText(text);
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-blue-300 text-blue-700 rounded-lg font-medium hover:bg-blue-100 transition-colors whitespace-nowrap"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
                              전체 복사
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {/* 계약 이력 탭 */}
              {detailTab === 'contracts' && (
                hospContracts.length === 0 ? (
                  <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400">
                    <div className="text-sm font-medium">등록된 계약이 없습니다</div>
                    <div className="text-xs mt-1">견적서 목록에서 "계약 등록" 버튼을 사용하세요</div>
                  </div>
                ) : (
                  <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">견적번호</th>
                          <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">계약일</th>
                          <th className="px-5 py-3 text-right text-xs font-semibold text-slate-500">계약금액</th>
                          <th className="px-5 py-3 text-center text-xs font-semibold text-slate-500">상태</th>
                          <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">메모</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hospContracts.map(c => {
                          const isExpanded = expandedContractId === c.id;
                          const cats = Array.isArray(c.categories) ? c.categories : [];
                          const allItems = cats.flatMap(cat => (cat.items||[]).map(item => ({ catName: cat.name, item })));
                          return (
                            <React.Fragment key={c.id}>
                              <tr className={`border-b border-slate-50 last:border-0 transition-colors ${isExpanded ? 'bg-blue-50' : 'hover:bg-slate-50'}`}>
                                <td className="px-5 py-3">
                                  <button
                                    onClick={() => setExpandedContractId(isExpanded ? null : c.id)}
                                    className="flex items-center gap-1.5 font-mono text-blue-700 text-xs font-semibold hover:text-blue-500 transition-colors">
                                    <svg className={`w-3 h-3 transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7"/></svg>
                                    {c.quote_name || '—'}
                                    {allItems.length > 0 && <span className="ml-1 px-1.5 py-0.5 bg-blue-100 text-blue-600 text-xs rounded-full font-semibold">{allItems.length}</span>}
                                  </button>
                                </td>
                                <td className="px-5 py-3 text-slate-500 text-xs">{c.contract_date}</td>
                                <td className="px-5 py-3 text-right text-slate-700 text-xs font-mono">{c.amount ? c.amount.toLocaleString('ko-KR')+'원' : '—'}</td>
                                <td className="px-5 py-3 text-center"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLORS[c.status]||'bg-slate-100 text-slate-500'}`}>{c.status}</span></td>
                                <td className="px-5 py-3 text-slate-400 text-xs">{c.notes||'—'}</td>
                              </tr>
                              {isExpanded && (
                                <tr className="bg-blue-50/60 border-b border-blue-100">
                                  <td colSpan={5} className="px-8 py-3">
                                    {allItems.length === 0 ? (
                                      <div className="text-xs text-slate-400 py-1">장비 정보가 없습니다</div>
                                    ) : (
                                      <div className="space-y-1">
                                        <div className="text-xs font-semibold text-slate-500 mb-2">장비 목록 ({allItems.length}개)</div>
                                        <table className="w-full text-xs">
                                          <thead>
                                            <tr className="border-b border-blue-200">
                                              <th className="text-left py-1 px-2 text-slate-400 font-semibold">카테고리</th>
                                              <th className="text-left py-1 px-2 text-slate-400 font-semibold">장비명</th>
                                              <th className="text-left py-1 px-2 text-slate-400 font-semibold">모델명</th>
                                              <th className="text-center py-1 px-2 text-slate-400 font-semibold">수량</th>
                                              <th className="text-right py-1 px-2 text-slate-400 font-semibold">금액</th>
                                              <th className="text-center py-1 px-2 text-emerald-600 font-semibold">보증기간 만료</th>
                                              <th className="text-center py-1 px-2 text-blue-600 font-semibold">A/S기간 만료</th>
                                              <th className="text-center py-1 px-2 text-amber-600 font-semibold">연락 시점</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                          {allItems.map((row, i) => {
                                            const model = (row.item.models||[]).find(m => m.id === row.item.selectedModelId) || (row.item.models||[])[0] || {};
                                            const price = model.price != null ? model.price * (row.item.quantity || 1) : null;
                                            const contractDate = c.contract_date ? new Date(c.contract_date) : null;
                                            const warrantyMonths = row.item.warranty_months ?? 12;
                                            const asMonths = row.item.as_months ?? 12;
                                            const calcExpiry = (months) => {
                                              if (!contractDate || !months) return null;
                                              const d = new Date(contractDate);
                                              d.setMonth(d.getMonth() + Number(months));
                                              return d;
                                            };
                                            const warrantyExp = calcExpiry(warrantyMonths);
                                            const asExp = calcExpiry(asMonths);
                                            const contactDate = warrantyExp && asExp
                                              ? new Date(Math.max(warrantyExp.getTime(), asExp.getTime()))
                                              : (warrantyExp || asExp);
                                            const today = new Date();
                                            const fmtDate = d => d ? d.toLocaleDateString('ko-KR', {year:'2-digit', month:'2-digit', day:'2-digit'}) : '—';
                                            const daysLeft = d => d ? Math.ceil((d - today) / (1000*60*60*24)) : null;
                                            const urgency = d => {
                                              const dl = daysLeft(d);
                                              if (dl === null) return '';
                                              if (dl < 0) return 'text-red-500 font-bold';
                                              if (dl < 90) return 'text-amber-600 font-semibold';
                                              return 'text-slate-500';
                                            };
                                            return (
                                              <tr key={i} className="border-b border-blue-50 last:border-0 hover:bg-blue-100/30 transition-colors">
                                                <td className="py-1.5 px-2"><span className="px-1.5 py-0.5 bg-slate-200 text-slate-500 rounded shrink-0">{row.catName}</span></td>
                                                <td className="py-1.5 px-2 font-medium text-slate-700">{row.item.name}</td>
                                                <td className="py-1.5 px-2 text-slate-400">{model.name || '—'}</td>
                                                <td className="py-1.5 px-2 text-center text-slate-500">{row.item.quantity > 1 ? `×${row.item.quantity}` : '1'}</td>
                                                <td className="py-1.5 px-2 text-right font-mono text-slate-600">{price != null ? price.toLocaleString('ko-KR')+'원' : '—'}</td>
                                                <td className={`py-1.5 px-2 text-center ${urgency(warrantyExp)}`}>{fmtDate(warrantyExp)}{warrantyMonths ? <span className="ml-1 text-slate-300">({warrantyMonths}개월)</span> : ''}</td>
                                                <td className={`py-1.5 px-2 text-center ${urgency(asExp)}`}>{fmtDate(asExp)}{asMonths ? <span className="ml-1 text-slate-300">({asMonths}개월)</span> : ''}</td>
                                                <td className={`py-1.5 px-2 text-center font-semibold ${urgency(contactDate)}`}>
                                                  {fmtDate(contactDate)}
                                                  {daysLeft(contactDate) !== null && (
                                                    <div className={`text-xs mt-0.5 ${daysLeft(contactDate) < 0 ? 'text-red-500' : daysLeft(contactDate) < 90 ? 'text-amber-500' : 'text-slate-300'}`}>
                                                      {daysLeft(contactDate) < 0 ? `${Math.abs(daysLeft(contactDate))}일 초과` : `D-${daysLeft(contactDate)}`}
                                                    </div>
                                                  )}
                                                </td>
                                              </tr>
                                            );
                                          })}
                                          </tbody>
                                        </table>
                                        <div className="mt-2 text-xs text-slate-300">* 보증기간/A/S기간은 견적서 작성 시 설정한 값 기준 (미설정 시 12개월 기본값)</div>
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              )}
              {/* 납품 이력 탭 */}
              {detailTab === 'deliveries' && (
                <div>
                  {loadingDeliveries ? (
                    <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400 text-sm">불러오는 중...</div>
                  ) : deliveries.length === 0 ? (
                    <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400">
                      <svg className="w-10 h-10 mb-3 mx-auto opacity-25" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"/></svg>
                      <div className="text-sm font-medium">등록된 납품 이력이 없습니다</div>
                      <div className="text-xs mt-1">Excel import 후 이 곳에 표시됩니다</div>
                    </div>
                  ) : (
                    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                        <div className="text-sm font-bold text-slate-800">납품 이력</div>
                        <div className="text-xs text-slate-400">총 {deliveries.length}건 · 합계 {deliveries.reduce((s,d)=>s+(d.total_amount||0),0).toLocaleString('ko-KR')}원</div>
                      </div>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">납품일</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">문서번호</th>
                            <th className="px-5 py-3 text-center text-xs font-semibold text-slate-500">품목 수</th>
                            <th className="px-5 py-3 text-right text-xs font-semibold text-slate-500">공급가액</th>
                            <th className="px-5 py-3 text-right text-xs font-semibold text-slate-500">부가세</th>
                            <th className="px-5 py-3 text-right text-xs font-semibold text-slate-500">합계금액</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">메모</th>
                          </tr>
                        </thead>
                        <tbody>
                          {deliveries.map(d => {
                            const isExp = expandedDeliveryId === d.id;
                            const items = d.delivery_items || [];
                            return (
                              <React.Fragment key={d.id}>
                                <tr className={`border-b border-slate-50 last:border-0 transition-colors ${isExp ? 'bg-amber-50' : 'hover:bg-slate-50'}`}>
                                  <td className="px-5 py-3 text-slate-700 text-xs whitespace-nowrap">{d.delivered_date || '—'}</td>
                                  <td className="px-5 py-3">
                                    <button onClick={() => setExpandedDeliveryId(isExp ? null : d.id)}
                                      className="flex items-center gap-1.5 text-amber-700 text-xs font-semibold hover:text-amber-500 transition-colors">
                                      <svg className={`w-3 h-3 transition-transform shrink-0 ${isExp ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7"/></svg>
                                      {d.doc_no || '—'}
                                      {items.length > 0 && <span className="ml-1 px-1.5 py-0.5 bg-amber-100 text-amber-700 text-xs rounded-full">{items.length}</span>}
                                    </button>
                                  </td>
                                  <td className="px-5 py-3 text-center text-xs text-slate-500">{items.length}개</td>
                                  <td className="px-5 py-3 text-right text-xs font-mono text-slate-600">{d.supply_amount != null ? d.supply_amount.toLocaleString('ko-KR')+'원' : '—'}</td>
                                  <td className="px-5 py-3 text-right text-xs font-mono text-slate-400">{d.vat != null ? d.vat.toLocaleString('ko-KR')+'원' : '—'}</td>
                                  <td className="px-5 py-3 text-right text-xs font-mono font-semibold text-slate-800">{d.total_amount != null ? d.total_amount.toLocaleString('ko-KR')+'원' : '—'}</td>
                                  <td className="px-5 py-3 text-xs text-slate-400 max-w-[120px] truncate">{d.notes || '—'}</td>
                                </tr>
                                {isExp && (
                                  <tr className="bg-amber-50/60 border-b border-amber-100">
                                    <td colSpan={7} className="px-8 py-3">
                                      {items.length === 0 ? (
                                        <div className="text-xs text-slate-400">품목 정보가 없습니다</div>
                                      ) : (
                                        <div>
                                          <div className="text-xs font-semibold text-slate-500 mb-2">품목 목록 ({items.length}개)</div>
                                          <table className="w-full text-xs">
                                            <thead>
                                              <tr className="border-b border-amber-200">
                                                <th className="text-left py-1 px-2 text-slate-400 font-semibold">품목코드</th>
                                                <th className="text-left py-1 px-2 text-slate-400 font-semibold">품목명</th>
                                                <th className="text-left py-1 px-2 text-slate-400 font-semibold">모델명</th>
                                                <th className="text-left py-1 px-2 text-slate-400 font-semibold">규격</th>
                                                <th className="text-center py-1 px-2 text-slate-400 font-semibold">수량</th>
                                                <th className="text-right py-1 px-2 text-slate-400 font-semibold">단가</th>
                                                <th className="text-right py-1 px-2 text-slate-400 font-semibold">공급가액</th>
                                                <th className="text-right py-1 px-2 text-slate-400 font-semibold">부가세</th>
                                                <th className="text-right py-1 px-2 text-slate-400 font-semibold">합계</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {items.map((it, i) => (
                                                <tr key={i} className="border-b border-amber-50 last:border-0 hover:bg-amber-100/30 transition-colors">
                                                  <td className="py-1.5 px-2 text-slate-400 font-mono">{it.item_code || '—'}</td>
                                                  <td className="py-1.5 px-2 font-medium text-slate-700">{it.item_name || '—'}</td>
                                                  <td className="py-1.5 px-2 text-slate-500">{it.model_name || '—'}</td>
                                                  <td className="py-1.5 px-2 text-slate-400">{it.spec || '—'}</td>
                                                  <td className="py-1.5 px-2 text-center text-slate-500">{it.quantity ?? 1}</td>
                                                  <td className="py-1.5 px-2 text-right font-mono text-slate-600">{it.unit_price != null ? it.unit_price.toLocaleString('ko-KR') : '—'}</td>
                                                  <td className="py-1.5 px-2 text-right font-mono text-slate-600">{it.supply_amount != null ? it.supply_amount.toLocaleString('ko-KR') : '—'}</td>
                                                  <td className="py-1.5 px-2 text-right font-mono text-slate-400">{it.vat != null ? it.vat.toLocaleString('ko-KR') : '—'}</td>
                                                  <td className="py-1.5 px-2 text-right font-mono font-semibold text-slate-800">{it.total_amount != null ? it.total_amount.toLocaleString('ko-KR') : '—'}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* A/S 이력 탭 */}
              {detailTab === 'service' && (
                <div>
                  <div className="flex justify-end mb-3">
                    <button onClick={() => { setShowNewSRForm(true); setNewSR({ equipment_name:'', model_name:'', issue:'', status:'접수', requested_at:getToday(), engineer:'', notes:'' }); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded font-semibold hover:bg-blue-500 transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>
                      A/S 등록
                    </button>
                  </div>
                  {hospSRs.length === 0 ? (
                    <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400">
                      <div className="text-sm font-medium">등록된 A/S 요청이 없습니다</div>
                    </div>
                  ) : (
                    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">장비명</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">모델명</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">증상</th>
                            <th className="px-5 py-3 text-center text-xs font-semibold text-slate-500">상태</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">접수일</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">엔지니어</th>
                          </tr>
                        </thead>
                        <tbody>
                          {hospSRs.map(s => (
                            <tr key={s.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50">
                              <td className="px-5 py-3 font-medium text-slate-800">{s.equipment_name||'—'}</td>
                              <td className="px-5 py-3 text-slate-500 text-xs">{s.model_name||'—'}</td>
                              <td className="px-5 py-3 text-slate-500 text-xs max-w-[160px] truncate">{s.issue||'—'}</td>
                              <td className="px-5 py-3 text-center"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLORS[s.status]||'bg-slate-100 text-slate-500'}`}>{s.status}</span></td>
                              <td className="px-5 py-3 text-slate-500 text-xs">{s.requested_at||'—'}</td>
                              <td className="px-5 py-3 text-slate-500 text-xs">{s.engineer||'—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 병원 등록/수정 모달 */}
      {showNewHospForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div className="font-bold text-slate-900">{editingHosp ? '병원 정보 수정' : '새 병원 등록'}</div>
              <button onClick={() => { setShowNewHospForm(false); setEditingHosp(null); }} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="p-6 space-y-3 max-h-[70vh] overflow-y-auto">
              {[{key:'name',label:'병원명 *',placeholder:'○○○○ 의원'},{key:'region',label:'지역',placeholder:'서울 강남구'},{key:'address',label:'주소',placeholder:'상세 주소'},{key:'phone',label:'병원 전화',placeholder:'02-0000-0000'},{key:'contact_name',label:'담당자',placeholder:'홍길동 원장'},{key:'contact_phone',label:'담당자 연락처',placeholder:'010-0000-0000'},{key:'contact_email',label:'담당자 이메일',placeholder:'email@hospital.com'}].map(f => (
                <div key={f.key}>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">{f.label}</label>
                  <input value={newHosp[f.key]} onChange={e => setNewHosp(p => ({...p,[f.key]:e.target.value}))}
                    placeholder={f.placeholder}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
              ))}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">메모</label>
                <textarea value={newHosp.notes} onChange={e => setNewHosp(p => ({...p,notes:e.target.value}))} rows={2}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"/>
              </div>
              <div className="border-t border-slate-100 pt-3">
                <label className="block text-xs font-semibold text-blue-700 mb-1">
                  접속 코드 (PIN)
                  <span className="ml-1 text-slate-400 font-normal">— 병원 포털 로그인에 사용됩니다</span>
                </label>
                <input
                  value={newHosp.access_pin}
                  onChange={e => setNewHosp(p => ({...p, access_pin: e.target.value}))}
                  placeholder="예: 1234, ABCD (병원에 알려줄 코드)"
                  className="w-full border border-blue-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 tracking-widest"
                />
                <div className="text-xs text-slate-400 mt-1">설정 후 URL과 함께 병원에 전달하세요</div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex gap-2 justify-end">
              <button onClick={() => { setShowNewHospForm(false); setEditingHosp(null); }} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50">취소</button>
              <button onClick={handleSaveHosp} disabled={savingHosp}
                className="px-5 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-500 disabled:opacity-50">
                {savingHosp ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 병원 삭제 확인 모달 */}
      {showDeleteConfirm && selectedHosp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg>
                </div>
                <div>
                  <div className="font-bold text-slate-900">병원 삭제</div>
                  <div className="text-xs text-slate-500 mt-0.5">이 작업은 되돌릴 수 없습니다</div>
                </div>
              </div>
              <div className="bg-red-50 border border-red-100 rounded-lg px-4 py-3 mb-3">
                <div className="text-sm font-semibold text-red-700 mb-1">{selectedHosp.name}</div>
                <div className="text-xs text-red-500">병원 정보가 영구 삭제됩니다.</div>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 mb-2 text-xs">
                <div className="font-semibold text-slate-700 mb-2">연결된 데이터 {refsLoading ? '확인 중...' : ''}</div>
                {hospRefs && (
                  <div className="space-y-1 text-slate-600">
                    <div className="flex justify-between"><span>영업 lead</span><span className={`font-mono font-semibold ${hospRefs.leads > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{hospRefs.leads}</span></div>
                    <div className="flex justify-between"><span>계약</span><span className={`font-mono font-semibold ${hospRefs.contracts > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{hospRefs.contracts}</span></div>
                    <div className="flex justify-between"><span>예상 매출</span><span className={`font-mono font-semibold ${hospRefs.exp_rev > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{hospRefs.exp_rev}</span></div>
                    <div className="flex justify-between"><span>수금 거래</span><span className={`font-mono font-semibold ${hospRefs.recv_tx > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{hospRefs.recv_tx}</span></div>
                  </div>
                )}
              </div>
              {hospRefs && hospRefs.total > 0 && (
                <div className="text-xs text-rose-600 bg-rose-50 rounded-lg px-3 py-2 mt-2">
                  ⚠️ 연결 데이터가 있어 삭제가 막힐 수 있습니다. 먼저 해당 데이터를 정리하거나 다른 병원으로 옮기세요.
                </div>
              )}
            </div>
            <div className="px-6 pb-5 flex gap-2 justify-end">
              <button onClick={() => setShowDeleteConfirm(false)} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50">취소</button>
              <button onClick={handleDeleteHosp} disabled={deletingHosp || refsLoading}
                className="px-5 py-2 text-sm bg-red-500 text-white rounded-lg font-semibold hover:bg-red-600 disabled:opacity-50 transition-colors">
                {deletingHosp ? '삭제 중...' : '삭제 확인'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* A/S 등록 모달 */}
      {showNewSRForm && selectedHosp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <div className="font-bold text-slate-900">A/S 등록</div>
                <div className="text-xs text-slate-400 mt-0.5">{selectedHosp.name}</div>
              </div>
              <button onClick={() => setShowNewSRForm(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="p-6 space-y-3">
              {[{key:'equipment_name',label:'장비명',placeholder:'X-Ray DR System'},{key:'model_name',label:'모델명',placeholder:'Xvision HF 525R'},{key:'engineer',label:'담당 엔지니어',placeholder:'홍길동'}].map(f => (
                <div key={f.key}>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">{f.label}</label>
                  <input value={newSR[f.key]} onChange={e => setNewSR(p => ({...p,[f.key]:e.target.value}))}
                    placeholder={f.placeholder}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
              ))}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">증상/문제</label>
                <textarea value={newSR.issue} onChange={e => setNewSR(p => ({...p,issue:e.target.value}))} rows={3}
                  placeholder="증상 및 문제 상황을 입력하세요"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"/>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">접수일</label>
                  <input type="date" value={newSR.requested_at} onChange={e => setNewSR(p => ({...p,requested_at:e.target.value}))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">상태</label>
                  <select value={newSR.status} onChange={e => setNewSR(p => ({...p,status:e.target.value}))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="접수">접수</option><option value="처리중">처리중</option><option value="완료">완료</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">메모</label>
                <textarea value={newSR.notes} onChange={e => setNewSR(p => ({...p,notes:e.target.value}))} rows={2}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"/>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex gap-2 justify-end">
              <button onClick={() => setShowNewSRForm(false)} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50">취소</button>
              <button onClick={handleSaveSR} disabled={savingSR}
                className="px-5 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-500 disabled:opacity-50">
                {savingSR ? '저장 중...' : 'A/S 등록'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   SERVICE REQUESTS PAGE (전체 A/S 관리)
   ============================================================ */
function ServiceRequestsPage({ onBack, user, onLogout, nav }) {
  const [serviceReqs, setServiceReqs] = React.useState([]);
  const [hospitals, setHospitals] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [filter, setFilter] = React.useState('all');
  const [showForm, setShowForm] = React.useState(false);
  const [editingSR, setEditingSR] = React.useState(null);
  const [form, setForm] = React.useState({ hospital_name:'', equipment_name:'', model_name:'', issue:'', status:'접수', requested_at:getToday(), resolved_at:'', engineer:'', notes:'' });
  const [saving, setSaving] = React.useState(false);
  const [hospSuggestions, setHospSuggestions] = React.useState([]);

  const STATUS_COLORS = { '접수':'bg-amber-100 text-amber-700', '처리중':'bg-blue-100 text-blue-700', '완료':'bg-emerald-100 text-emerald-700' };

  const loadAll = async () => {
    setLoading(true);
    try {
      const [s, h] = await Promise.all([dbLoadServiceRequests(), dbLoadHospitals()]);
      setServiceReqs(s); setHospitals(h);
    } catch(e) { console.error(e); }
    setLoading(false);
  };
  React.useEffect(() => { loadAll(); }, []);

  React.useEffect(() => {
    if (form.hospital_name.length < 1) { setHospSuggestions([]); return; }
    setHospSuggestions(hospitals.filter(h => h.name.includes(form.hospital_name)).slice(0, 5));
  }, [form.hospital_name, hospitals]);

  const openNew = () => {
    setEditingSR(null);
    setForm({ hospital_name:'', equipment_name:'', model_name:'', issue:'', status:'접수', requested_at:getToday(), resolved_at:'', engineer:'', notes:'' });
    setShowForm(true);
  };
  const openEdit = (sr) => {
    setEditingSR(sr);
    setForm({ hospital_name:sr.hospital_name||'', equipment_name:sr.equipment_name||'', model_name:sr.model_name||'', issue:sr.issue||'', status:sr.status||'접수', requested_at:sr.requested_at||getToday(), resolved_at:sr.resolved_at||'', engineer:sr.engineer||'', notes:sr.notes||'' });
    setShowForm(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const hosp = hospitals.find(h => h.name === form.hospital_name.trim());
      const sr = { ...form, hospital_id: hosp?.id || null };
      if (editingSR) {
        await dbUpdateServiceRequest(editingSR.id, sr);
      } else {
        await dbSaveServiceRequest(sr);
      }
      await loadAll();
      setShowForm(false); setEditingSR(null);
    } catch(e) { console.error(e); alert('저장 중 오류가 발생했습니다.'); }
    setSaving(false);
  };

  const filtered = filter === 'all' ? serviceReqs : serviceReqs.filter(s => s.status === filter);
  const counts = { all: serviceReqs.length, '접수': serviceReqs.filter(s=>s.status==='접수').length, '처리중': serviceReqs.filter(s=>s.status==='처리중').length, '완료': serviceReqs.filter(s=>s.status==='완료').length };

  return (
    <div style={{height:'100vh', display:'flex', flexDirection:'column', overflow:'hidden', background:'#f1f5f9'}}>
      <AppHeader title="병원 관리 · 전체 A/S 이력" onLogoClick={onBack} user={user} onLogout={onLogout} nav={nav}>
        <button onClick={() => nav?.hospitals?.()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 hover:bg-slate-800 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18"/></svg>
          병원 목록
        </button>
        <button onClick={openNew}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>
          A/S 등록
        </button>
      </AppHeader>

      {/* 상태 필터 바 */}
      <div className="bg-white border-b border-slate-200 px-8 py-3 flex items-center gap-3 shrink-0">
        {[{key:'all',label:'전체',count:counts.all},{key:'접수',label:'접수',count:counts['접수']},{key:'처리중',label:'처리중',count:counts['처리중']},{key:'완료',label:'완료',count:counts['완료']}].map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${filter===f.key ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-800'}`}>
            {f.label}
            <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${filter===f.key ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'}`}>{f.count}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-6xl mx-auto">
          {loading ? (
            <div className="bg-white rounded-xl border border-slate-200 p-16 text-center text-slate-400 text-sm">불러오는 중...</div>
          ) : filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 p-16 text-center text-slate-400">
              <div className="text-sm font-medium">등록된 A/S 요청이 없습니다</div>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">병원명</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">장비명</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">모델명</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">증상</th>
                    <th className="px-5 py-3 text-center text-xs font-semibold text-slate-500">상태</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">접수일</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500">엔지니어</th>
                    <th className="px-4 py-3 w-16"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(s => (
                    <tr key={s.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50">
                      <td className="px-5 py-3 font-medium text-slate-800">{s.hospital_name||'—'}</td>
                      <td className="px-5 py-3 text-slate-700">{s.equipment_name||'—'}</td>
                      <td className="px-5 py-3 text-slate-500 text-xs">{s.model_name||'—'}</td>
                      <td className="px-5 py-3 text-slate-500 text-xs max-w-[180px] truncate" title={s.issue}>{s.issue||'—'}</td>
                      <td className="px-5 py-3 text-center"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLORS[s.status]||'bg-slate-100 text-slate-500'}`}>{s.status}</span></td>
                      <td className="px-5 py-3 text-slate-500 text-xs">{s.requested_at||'—'}</td>
                      <td className="px-5 py-3 text-slate-500 text-xs">{s.engineer||'—'}</td>
                      <td className="px-4 py-3">
                        <button onClick={() => openEdit(s)} className="px-2.5 py-1 text-xs border border-slate-200 text-slate-500 rounded hover:bg-slate-50 transition-colors">수정</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 등록/수정 모달 */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.55)'}}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div className="font-bold text-slate-900">{editingSR ? 'A/S 수정' : 'A/S 등록'}</div>
              <button onClick={() => { setShowForm(false); setEditingSR(null); }} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="p-6 space-y-3 max-h-[70vh] overflow-y-auto">
              <div className="relative">
                <label className="block text-xs font-semibold text-slate-600 mb-1">병원명</label>
                <input value={form.hospital_name} onChange={e => setForm(p => ({...p,hospital_name:e.target.value}))}
                  placeholder="병원명 입력"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                {hospSuggestions.length > 0 && (
                  <div className="absolute top-full left-0 right-0 bg-white border border-slate-200 rounded-lg shadow-lg mt-1 z-10 overflow-hidden">
                    {hospSuggestions.map(h => (
                      <button key={h.id} onClick={() => { setForm(p => ({...p,hospital_name:h.name})); setHospSuggestions([]); }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors">{h.name}</button>
                    ))}
                  </div>
                )}
              </div>
              {[{key:'equipment_name',label:'장비명',placeholder:'X-Ray DR System'},{key:'model_name',label:'모델명',placeholder:'Xvision HF 525R'},{key:'engineer',label:'담당 엔지니어',placeholder:'홍길동'}].map(f => (
                <div key={f.key}>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">{f.label}</label>
                  <input value={form[f.key]} onChange={e => setForm(p => ({...p,[f.key]:e.target.value}))}
                    placeholder={f.placeholder}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
              ))}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">증상/문제</label>
                <textarea value={form.issue} onChange={e => setForm(p => ({...p,issue:e.target.value}))} rows={3}
                  placeholder="증상 및 문제 상황"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"/>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">접수일</label>
                  <input type="date" value={form.requested_at} onChange={e => setForm(p => ({...p,requested_at:e.target.value}))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">상태</label>
                  <select value={form.status} onChange={e => setForm(p => ({...p,status:e.target.value}))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="접수">접수</option><option value="처리중">처리중</option><option value="완료">완료</option>
                  </select>
                </div>
              </div>
              {editingSR && (
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">처리 완료일</label>
                  <input type="date" value={form.resolved_at} onChange={e => setForm(p => ({...p,resolved_at:e.target.value}))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">메모</label>
                <textarea value={form.notes} onChange={e => setForm(p => ({...p,notes:e.target.value}))} rows={2}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"/>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex gap-2 justify-end">
              <button onClick={() => { setShowForm(false); setEditingSR(null); }} className="px-4 py-2 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50">취소</button>
              <button onClick={handleSave} disabled={saving}
                className="px-5 py-2 text-sm bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-500 disabled:opacity-50">
                {saving ? '저장 중...' : (editingSR ? '수정 완료' : 'A/S 등록')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


/* ============================================================
   SAVED QUOTES LIST
   ============================================================ */
function SavedQuotesList({ onLoad, onBack, onHospitals, onService, onLeads, customEquips = [], dynCats = [], initialTab = 'saved', initialDept = null, user, onLogout, nav, saves: savesProp = [], setSaves: setSavesProp, quotesLoading = false, allLeads: allLeadsProp = [] }) {
  const [saves, setSavesLocal] = React.useState(savesProp);
  const [loading, setLoading] = React.useState(quotesLoading);
  const setSaves = React.useCallback((updater) => {
    setSavesLocal(updater);
    if (setSavesProp) setSavesProp(updater);
  }, [setSavesProp]);
  const [confirmId, setConfirmId] = React.useState(null);
  const [contractModalQuote, setContractModalQuote] = React.useState(null);
  const [activeTab, setActiveTab] = React.useState(initialTab === 'standard' ? 'standard' : 'list');
  const [statusFilter, setStatusFilter] = React.useState(
    initialTab === 'done' ? '완료' : initialTab === 'cancelled' ? '취소' : '진행중'
  );
  const [selectedDept, setSelectedDept] = React.useState(initialDept);
  const [selectedTier, setSelectedTier] = React.useState(null);
  const [templates, setTemplates] = React.useState({});
  const [loadingTpls, setLoadingTpls] = React.useState(true);
  const [editMode, setEditMode] = React.useState(false);
  const [editingItems, setEditingItems] = React.useState([]);
  const [savingTpl, setSavingTpl] = React.useState(false);
  const [showTplEquipModal, setShowTplEquipModal] = React.useState(false);
  const [allContracts, setAllContracts] = React.useState([]);
  const [updatingContractId, setUpdatingContractId] = React.useState(null);
  const allLeads = allLeadsProp;
  const [toasts, setToasts] = React.useState([]);
  const addToast = React.useCallback((msg, type='success') => {
    const id = Date.now();
    setToasts(p => [...p, {id, msg, type}]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3000);
  }, []);

  // props에서 받은 데이터가 바뀌면 local state 동기화
  React.useEffect(() => { setSavesLocal(savesProp); setLoading(quotesLoading); }, [savesProp, quotesLoading]);

  React.useEffect(() => {
    dbLoadTemplates().then(data => { setTemplates(data); setLoadingTpls(false); });
    dbLoadContracts().then(data => setAllContracts(data || []));
  }, []);

  const handleContractStatusChange = async (contractId, newStatus) => {
    const prevContracts = allContracts;
    setUpdatingContractId(contractId);
    setAllContracts(p => p.map(c => c.id === contractId ? { ...c, status: newStatus } : c));
    try {
      await dbUpdateContract(contractId, { status: newStatus });
      // 모든 상태 변경 후 데이터 재로드 (세 탭 동일)
      const [freshContracts, freshSaves] = await Promise.all([
        dbLoadContracts(),
        dbLoadQuotes(),
      ]);
      setAllContracts(freshContracts || []);
      setSaves(freshSaves || []);
      addToast('상태가 변경되었습니다', 'success');
    } catch(e) {
      console.error(e);
      setAllContracts(prevContracts);
      addToast('상태 변경 중 오류가 발생했습니다.', 'error');
    }
    setUpdatingContractId(null);
  };

  // 통합 테이블 상태 변경
  const handleStatusChange = async (row, newStatus) => {
    if (newStatus === row.status) return;
    if (row.contract) {
      await handleContractStatusChange(row.contract.id, newStatus);
    } else {
      if (newStatus === '완료') {
        const linkedLead = row.lead_id ? allLeads.find(l => l.id === row.lead_id) : null;
        setContractModalQuote({ ...row, linkedLead });
      } else if (newStatus === '취소') {
        setUpdatingContractId(row.id);
        try {
          await dbSaveContract({ quote_name: row.quoteNo, hospital_name: row.hospital, status: '취소' });
          const [freshContracts, freshSaves] = await Promise.all([dbLoadContracts(), dbLoadQuotes()]);
          setAllContracts(freshContracts || []);
          setSaves(freshSaves || []);
          addToast('상태가 변경되었습니다', 'success');
        } catch(e) {
          console.error(e);
          addToast('상태 변경 중 오류가 발생했습니다.', 'error');
        }
        setUpdatingContractId(null);
      }
    }
  };

  /* ── Template helpers ── */
  const tplKey = (dept, tier) => dept + '__' + tier;

  const catsToFlatItems = (categories) => {
    const items = [];
    for (const cat of (categories || [])) {
      for (const item of (cat.items || [])) {
        const model = (item.models || [])[0] || {};
        items.push({
          uid: item.id || ('uid-' + Math.random()),
          catId: cat.id, catName: cat.name,
          itemName: item.name,
          modelName: model.name || '',
          manufacturer: model.manufacturer || '',
          price: model.price || null,
          notes: model.notes || '',
        });
      }
    }
    return items;
  };

  const flatItemsToCats = (items) => {
    const catMap = {};
    for (const item of items) {
      if (!catMap[item.catId]) catMap[item.catId] = { id: item.catId, name: item.catName, colorKey: 'neutral', items: [] };
      const uid = Date.now() + Math.random();
      catMap[item.catId].items.push({
        id: 'tpl-' + uid,
        name: item.itemName,
        selectedModelId: 'tplm-' + uid,
        quantity: 1, itemDiscount: 0, excluded: false, memo: '',
        models: [{ id: 'tplm-' + uid, name: item.modelName || '표준모델', manufacturer: item.manufacturer || '', price: item.price || null, notes: item.notes || '' }],
      });
    }
    return Object.values(catMap);
  };

  const handleStartEdit = () => {
    const tpl = templates[tplKey(selectedDept, selectedTier)];
    setEditingItems(tpl ? catsToFlatItems(tpl.categories) : []);
    setEditMode(true); setShowTplEquipModal(false);
  };

  const handleCancelEdit = () => { setEditMode(false); setShowTplEquipModal(false); };

  const handleSaveTpl = async () => {
    setSavingTpl(true);
    try {
      await dbUpsertTemplate(selectedDept, selectedTier, flatItemsToCats(editingItems));
      const updated = await dbLoadTemplates();
      setTemplates(updated); setEditMode(false); setShowTplEquipModal(false);
    } catch(e) { console.error('템플릿 저장 오류:', e); alert('저장 중 오류가 발생했습니다.'); }
    finally { setSavingTpl(false); }
  };

  const handleDeleteTpl = async () => {
    if (!window.confirm('이 템플릿을 삭제하시겠습니까?')) return;
    try {
      const quoteNo = 'TMPL-' + selectedDept + '-' + selectedTier;
      await dbDeleteTemplate(quoteNo);
      const updated = await dbLoadTemplates();
      setTemplates(updated);
    } catch(e) { console.error('템플릿 삭제 오류:', e); alert('삭제 중 오류가 발생했습니다.'); }
  };

  const handleLoadTierQuote = () => {
    const tpl = templates[tplKey(selectedDept, selectedTier)];
    const tier = BUDGET_TIERS.find(t => t.key === selectedTier);
    if (tpl && tpl.categories.length > 0) {
      onLoad({ quoteNo: '', quoteInfo: { hospital: '○○○○ 의원', doctor: '홍길동', dept: selectedDept, quoteNo: '', date: getToday(), validity: getValidity() }, categories: JSON.parse(JSON.stringify(tpl.categories)), globalDiscount: { type: 'rate', value: 0 }, vatIncluded: false });
    } else {
      generateStandardQuote(selectedDept, tier);
    }
  };

  // AddEquipmentModal의 onAdd 포맷: { catId, itemName, modelName, manufacturer, price, notes }
  const handleAddFromModal = ({ catId, itemName, modelName, manufacturer, price, notes }) => {
    const catName = dynCats.find(c => c.id === catId)?.name || customEquips.find(e => e.catId === catId)?.catName || catId;
    setEditingItems(p => [...p, {
      uid: 'uid-' + Date.now() + Math.random(),
      catId, catName, itemName,
      modelName: modelName || '', manufacturer: manufacturer || '',
      price: price || null, notes: notes || '',
    }]);
  };

  const currentTplItems = React.useMemo(() => {
    if (!selectedDept || !selectedTier) return null;
    const tpl = templates[tplKey(selectedDept, selectedTier)];
    return tpl ? catsToFlatItems(tpl.categories) : null;
  }, [selectedDept, selectedTier, templates]);

  const handleDelete = async (id) => {
    try {
      await dbDeleteQuote(id);
      setSaves(p => p.filter(s => s.id !== id));
      setConfirmId(null);
    } catch(e) {
      console.error('삭제 오류:', e);
      alert('삭제 중 오류가 발생했습니다.');
    }
  };

  // 진료과별 선호 카테고리 키워드
  const DEPT_CAT_KEYWORDS = {
    '정형외과':       ['영상진단','물리치료','수술','기타의료'],
    '내과':           ['영상진단','검사','내시경','기타의료'],
    '가정의학과':     ['영상진단','검사','기타의료'],
    '재활의학과':     ['물리치료','영상진단','검사','기타의료'],
    '산부인과':       ['영상진단','수술','검사','기타의료'],
    '피부과':         ['미용','레이저','기타의료','검사'],
    '응급의학과':     ['영상진단','수술','검사','기타의료'],
    '영상의학과':     ['영상진단','기타의료'],
    '안과':           ['영상진단','검사','수술','기타의료'],
    '흉부외과':       ['영상진단','수술','기타의료'],
    '성형외과':       ['미용','레이저','수술','기타의료'],
    '비뇨기과':       ['영상진단','수술','내시경','기타의료'],
    '이비인후과':     ['영상진단','검사','내시경','수술','기타의료'],
    '소아과':         ['영상진단','검사','기타의료'],
    '신경외과':       ['영상진단','수술','기타의료'],
    '정신건강의학과': ['검사','기타의료'],
    '마취통증의학과': ['물리치료','수술','기타의료'],
    '직업의학과':     ['검사','영상진단','기타의료'],
    '신경과':         ['영상진단','검사','기타의료'],
    '외과':           ['영상진단','수술','기타의료'],
  };

  // 카테고리별 기본 단가 (가격 null인 장비용 예산 계산에만 사용)
  const catDefaultPrice = (catName) => {
    if (catName.includes('영상진단')) return 8000000;
    if (catName.includes('물리치료') || catName.includes('재활')) return 2000000;
    if (catName.includes('수술기구') || catName.includes('소모품')) return 300000;
    if (catName.includes('수술')) return 5000000;
    if (catName.includes('내시경')) return 12000000;
    if (catName.includes('검사') || catName.includes('측정')) return 1500000;
    if (catName.includes('미용') || catName.includes('성형') || catName.includes('레이저')) return 15000000;
    return 800000;
  };

  const BUDGET_TIERS = [
    { label: '1억 미만', key: '1억', max: 100000000, minItems: 5, maxItems: 8 },
    { label: '3억 미만', key: '3억', max: 300000000, minItems: 10, maxItems: 15 },
    { label: '5억 미만', key: '5억', max: 500000000, minItems: 15, maxItems: 20 },
  ];

  const generateStandardQuote = (dept, tier) => {
    const keywords = DEPT_CAT_KEYWORDS[dept] || ['기타의료'];
    const withPrice = customEquips.map(e => ({
      ...e, effectivePrice: e.model.price || catDefaultPrice(e.catName),
    }));

    const score = (e) => {
      const idx = keywords.findIndex(k => e.catName.includes(k));
      return idx === -1 ? keywords.length : idx;
    };
    const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);
    const pool = shuffle(withPrice).sort((a, b) => score(a) - score(b));

    const selected = [];
    const seenNames = new Set();
    let total = 0;
    for (const e of pool) {
      if (selected.length >= tier.maxItems) break;
      if (seenNames.has(e.itemName)) continue;
      if (total + e.effectivePrice <= tier.max) {
        selected.push(e); seenNames.add(e.itemName); total += e.effectivePrice;
      }
    }
    // fill to minItems if needed
    if (selected.length < tier.minItems) {
      for (const e of pool) {
        if (selected.length >= tier.minItems) break;
        if (!seenNames.has(e.itemName)) { selected.push(e); seenNames.add(e.itemName); }
      }
    }

    const catMap = {};
    for (const e of selected) {
      if (!catMap[e.catId]) catMap[e.catId] = { id: e.catId, name: e.catName, colorKey: 'neutral', items: [] };
      const uid = Date.now() + Math.random();
      catMap[e.catId].items.push({
        id: 'std-' + uid,
        name: e.itemName,
        selectedModelId: 'stdm-' + uid,
        quantity: 1, itemDiscount: 0, excluded: false, memo: '',
        models: [{
          id: 'stdm-' + uid,
          name: e.model.name || '표준모델',
          manufacturer: e.model.manufacturer || '',
          price: e.model.price || null,
          notes: e.model.notes || '',
        }],
      });
    }

    onLoad({
      quoteNo: '',
      quoteInfo: { hospital: '○○○○ 의원', doctor: '홍길동', dept, quoteNo: '', date: getToday(), validity: getValidity() },
      categories: Object.values(catMap),
      globalDiscount: { type: 'rate', value: 0 },
      vatIncluded: false,
    });
  };

  return (
    <div style={{height:'100vh', display:'flex', flexDirection:'column', overflow:'hidden', background:'#f1f5f9'}}>
      {/* Header */}
      <AppHeader title="견적서 관리" onLogoClick={onBack} user={user} onLogout={onLogout} nav={nav}>
        <Toast toasts={toasts}/>
        <button onClick={onBack} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 hover:bg-slate-800 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
          견적 작성
        </button>
      </AppHeader>

      {/* Tabs */}
      <div className="bg-white border-b border-slate-200 px-8 shrink-0">
        <div className="max-w-7xl mx-auto flex">
          {[
            { key: 'list',     label: '견적서 목록' },
            { key: 'standard', label: '진료과별 견적서' },
          ].map(tab => (
            <button key={tab.key}
              onClick={() => { setActiveTab(tab.key); setSelectedDept(null); }}
              className={`px-5 py-3 text-sm font-semibold border-b-2 transition-colors mr-1 ${
                activeTab === tab.key
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-400 hover:text-slate-700'
              }`}
            >{tab.label}</button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-7xl mx-auto">

          {/* ── 통합 견적서 목록 ── */}
          {activeTab === 'list' && (() => {
            const contractMap = {};
            allContracts.forEach(c => { if (c.quote_name) contractMap[c.quote_name] = c; });
            const unifiedRows = saves.map(s => {
              const contract = contractMap[s.quoteNo] || null;
              return { ...s, contract, status: contract ? contract.status : '진행중' };
            });
            const filteredRows = unifiedRows;

            return (
              <div className="space-y-4">

                {/* 테이블 */}
                {loading ? (
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-20 flex flex-col items-center justify-center text-slate-400">
                    <div className="text-sm">불러오는 중...</div>
                  </div>
                ) : filteredRows.length === 0 ? (
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-20 flex flex-col items-center justify-center text-slate-400">
                    <svg className="w-12 h-12 mb-4 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                    <div className="font-medium text-sm">견적서가 없습니다</div>
                  </div>
                ) : (
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                      <div className="text-sm font-bold text-slate-800">견적서 목록</div>
                      <div className="text-xs text-slate-400">{filteredRows.length}건</div>
                    </div>
                    <div className="overflow-x-auto">
                    <table className="w-full text-sm" style={{minWidth:'1100px'}}>
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">견적번호</th>
                          <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">병원명</th>
                          <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">원장명</th>
                          <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">진료과</th>
                          <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">저장일시</th>
                          <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">작성자</th>
                          <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">리드</th>
                          <th className="px-3 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">최종금액</th>
                          <th className="px-3 py-3"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRows.map((row, idx) => {
                          const linkedLead = row.lead_id ? allLeads.find(l => l.id === row.lead_id) : null;
                          const isUpdating = updatingContractId === (row.contract?.id || row.id);
                          return (
                            <tr key={row.id} className="border-b border-slate-100 last:border-0 hover:bg-blue-50 transition-colors">
                              <td className="px-3 py-3 whitespace-nowrap">
                                <span className="font-mono font-semibold text-blue-700 text-xs">{row.quoteNo}</span>
                                {idx === 0 && <span className="ml-1.5 px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded font-medium">최신</span>}
                              </td>
                              <td className="px-3 py-3 font-medium text-slate-800 whitespace-nowrap">{row.hospital}</td>
                              <td className="px-3 py-3 text-slate-600 whitespace-nowrap">{row.doctor || <span className="text-slate-300">—</span>}</td>
                              <td className="px-3 py-3 text-slate-500 whitespace-nowrap">{row.dept || <span className="text-slate-300">—</span>}</td>
                              <td className="px-3 py-3 text-slate-500 text-xs whitespace-nowrap">{row.savedAt}</td>
                              <td className="px-3 py-3 text-slate-500 text-xs whitespace-nowrap max-w-[120px] truncate" title={row.author}>
                                {row.author || <span className="text-slate-300">—</span>}
                              </td>
                              <td className="px-3 py-3 whitespace-nowrap" style={{maxWidth:'60px'}}>
                                {linkedLead
                                  ? <span className="flex items-center gap-1 px-1.5 py-0.5 bg-violet-50 text-violet-700 text-xs rounded-full border border-violet-200 font-medium" style={{maxWidth:'56px',overflow:'hidden'}}>
                                      <svg className="w-2.5 h-2.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
                                      <span className="truncate">{linkedLead.source || '리드'}</span>
                                    </span>
                                  : <span className="text-slate-300 text-xs">—</span>}
                              </td>
                              <td className="px-3 py-3 text-right font-semibold tnum text-slate-800 whitespace-nowrap">
                                {row.finalAmt != null ? row.finalAmt.toLocaleString('ko-KR') + '원' : '—'}
                              </td>
                              <td className="px-3 py-3 whitespace-nowrap">
                                <div className="flex items-center gap-2 justify-end">
                                  <button
                                    onClick={() => onLoad(row)}
                                    className="px-3 py-1.5 text-xs bg-slate-900 text-white rounded font-semibold hover:bg-slate-700 transition-colors whitespace-nowrap"
                                  >불러오기</button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>{/* overflow-x-auto */}
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── TAB 2: 진료과별 표준견적서 ── */}
          {activeTab === 'standard' && (
            customEquips.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-16 flex flex-col items-center justify-center text-slate-400">
                <div className="text-sm font-medium">장비 데이터가 없습니다</div>
                <div className="text-xs mt-1">장비 관리 화면에서 먼저 장비를 등록해주세요</div>
              </div>
            ) : (
              <div className="space-y-5">

                {/* ① 진료과 선택 */}
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                  <div className="text-sm font-bold text-slate-900 mb-0.5">① 진료과 선택</div>
                  <div className="text-xs text-slate-400 mb-4">표준견적서를 생성할 진료과를 선택하세요</div>
                  <div className="grid grid-cols-5 gap-2">
                    {DEPT_LIST.map(dept => (
                      <button key={dept}
                        onClick={() => { if (dept === selectedDept) { setSelectedDept(null); setSelectedTier(null); setEditMode(false); } else { setSelectedDept(dept); setSelectedTier(null); setEditMode(false); } }}
                        className={`px-3 py-2.5 rounded-lg text-sm font-medium transition-all border ${selectedDept === dept ? 'bg-slate-900 text-white border-slate-900 shadow-sm' : 'bg-slate-50 text-slate-700 border-slate-200 hover:border-slate-400 hover:bg-slate-100'}`}
                      >{dept}</button>
                    ))}
                  </div>
                </div>

                {/* ② 금액대 선택 */}
                {selectedDept && (
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <div className="text-sm font-bold text-slate-900 mb-0.5">② 금액대 선택</div>
                    <div className="text-xs text-slate-400 mb-5">
                      <span className="font-semibold text-slate-700">{selectedDept}</span> 진료과 — 금액대를 선택하면 장비 목록을 확인하고 견적서를 불러올 수 있습니다
                    </div>
                    <div className="flex gap-4">
                      {BUDGET_TIERS.map(tier => {
                        const hasSaved = !!templates[tplKey(selectedDept, tier.key)];
                        const isSelected = selectedTier === tier.key;
                        return (
                          <button key={tier.key}
                            onClick={() => { setSelectedTier(tier.key === selectedTier ? null : tier.key); setEditMode(false); setShowTplEquipModal(false); }}
                            className={`flex-1 py-4 rounded-xl border-2 transition-all text-center relative ${isSelected ? 'border-slate-900 bg-slate-900 text-white shadow' : 'border-slate-200 hover:border-slate-400 hover:bg-slate-50'}`}
                          >
                            {hasSaved && (
                              <span className={`absolute top-2 right-2 px-1.5 py-0.5 rounded text-xs font-semibold ${isSelected ? 'bg-white/20 text-white' : 'bg-emerald-100 text-emerald-700'}`}>저장됨</span>
                            )}
                            <div className={`text-lg font-bold ${isSelected ? 'text-white' : 'text-slate-800'}`}>{tier.label}</div>
                            <div className={`text-xs mt-1 ${isSelected ? 'text-slate-300' : 'text-slate-400'}`}>장비 {tier.minItems}~{tier.maxItems}개</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ③ 템플릿 뷰 (일반 모드) */}
                {selectedDept && selectedTier && !editMode && (
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="font-bold text-slate-900 text-sm">{selectedDept} · {selectedTier} 미만</span>
                        {currentTplItems !== null
                          ? <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs font-semibold rounded-full">저장된 템플릿 ({currentTplItems.length}개)</span>
                          : <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-semibold rounded-full">템플릿 없음 · 랜덤 생성</span>
                        }
                      </div>
                      <div className="flex items-center gap-2">
                        {currentTplItems !== null && (
                          <button onClick={handleDeleteTpl} className="px-3 py-1.5 text-xs border border-slate-200 text-slate-400 rounded hover:border-red-300 hover:text-red-500 transition-colors">템플릿 삭제</button>
                        )}
                        <button onClick={handleStartEdit} className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-slate-300 text-slate-600 rounded font-medium hover:bg-slate-50 transition-colors">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                          템플릿 편집
                        </button>
                        <button onClick={handleLoadTierQuote} className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-slate-900 text-white rounded font-semibold hover:bg-slate-700 transition-colors">
                          불러오기
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6"/></svg>
                        </button>
                      </div>
                    </div>
                    {currentTplItems !== null && currentTplItems.length > 0 ? (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-100">
                            <th className="px-5 py-2.5 text-left text-xs font-semibold text-slate-500 w-36">카테고리</th>
                            <th className="px-5 py-2.5 text-left text-xs font-semibold text-slate-500">장비명</th>
                            <th className="px-5 py-2.5 text-left text-xs font-semibold text-slate-500 w-48">모델명</th>
                            <th className="px-5 py-2.5 text-left text-xs font-semibold text-slate-500 w-32">제조사</th>
                            <th className="px-5 py-2.5 text-right text-xs font-semibold text-slate-500 w-32">단가</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentTplItems.map((item, i) => (
                            <tr key={item.uid} className="border-b border-slate-50 last:border-0 hover:bg-slate-50">
                              <td className="px-5 py-2.5"><span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded">{item.catName}</span></td>
                              <td className="px-5 py-2.5 font-medium text-slate-800">{item.itemName}</td>
                              <td className="px-5 py-2.5 text-slate-500 text-xs">{item.modelName || <span className="text-slate-300">—</span>}</td>
                              <td className="px-5 py-2.5 text-slate-500 text-xs">{item.manufacturer || <span className="text-slate-300">—</span>}</td>
                              <td className="px-5 py-2.5 text-right text-slate-700 text-xs font-mono">{item.price ? item.price.toLocaleString('ko-KR') + '원' : <span className="text-slate-300">—</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="py-12 flex flex-col items-center justify-center text-slate-400 gap-2">
                        <svg className="w-8 h-8 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                        <div className="text-sm font-medium">등록된 템플릿이 없습니다</div>
                        <div className="text-xs">불러오기 시 자동 랜덤 생성 · "템플릿 편집"으로 고정 장비 목록을 설정할 수 있습니다</div>
                      </div>
                    )}
                  </div>
                )}

                {/* ③ 편집 모드 */}
                {selectedDept && selectedTier && editMode && (
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    {/* 편집 헤더 */}
                    <div className="px-6 py-4 border-b border-slate-100 bg-amber-50 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                        <span className="font-bold text-slate-900 text-sm">템플릿 편집 중 — {selectedDept} · {selectedTier} 미만</span>
                        <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-semibold rounded-full">{editingItems.length}개</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setShowTplEquipModal(true)}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded font-medium border border-blue-300 text-blue-700 hover:bg-blue-50 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>
                          장비 추가
                        </button>
                        <button onClick={handleCancelEdit} className="px-3 py-1.5 text-xs border border-slate-300 text-slate-600 rounded hover:bg-slate-50 transition-colors">취소</button>
                        <button onClick={handleSaveTpl} disabled={savingTpl} className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-emerald-600 text-white rounded font-semibold hover:bg-emerald-500 disabled:opacity-50 transition-colors">
                          {savingTpl ? '저장 중...' : (
                            <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/></svg>저장</>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* 편집 중인 장비 목록 */}
                    {editingItems.length === 0 ? (
                      <div className="py-14 flex flex-col items-center justify-center text-slate-400 gap-2">
                        <svg className="w-8 h-8 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4"/></svg>
                        <div className="text-sm">위 "장비 추가" 버튼으로 장비를 추가하세요</div>
                      </div>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-100">
                            <th className="px-5 py-2.5 text-left text-xs font-semibold text-slate-500 w-36">카테고리</th>
                            <th className="px-5 py-2.5 text-left text-xs font-semibold text-slate-500">장비명</th>
                            <th className="px-5 py-2.5 text-left text-xs font-semibold text-slate-500 w-48">모델명</th>
                            <th className="px-5 py-2.5 text-left text-xs font-semibold text-slate-500 w-32">제조사</th>
                            <th className="px-5 py-2.5 text-right text-xs font-semibold text-slate-500 w-32">단가</th>
                            <th className="px-4 py-2.5 w-10"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {editingItems.map(item => (
                            <tr key={item.uid} className="border-b border-slate-50 last:border-0 hover:bg-red-50 group">
                              <td className="px-5 py-2.5"><span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded">{item.catName}</span></td>
                              <td className="px-5 py-2.5 font-medium text-slate-800">{item.itemName}</td>
                              <td className="px-5 py-2.5 text-slate-500 text-xs">{item.modelName || <span className="text-slate-300">—</span>}</td>
                              <td className="px-5 py-2.5 text-slate-500 text-xs">{item.manufacturer || <span className="text-slate-300">—</span>}</td>
                              <td className="px-5 py-2.5 text-right text-slate-700 text-xs font-mono">{item.price ? item.price.toLocaleString('ko-KR') + '원' : <span className="text-slate-300">—</span>}</td>
                              <td className="px-4 py-2.5 text-center">
                                <button onClick={() => setEditingItems(p => p.filter(i => i.uid !== item.uid))} className="w-6 h-6 rounded-full flex items-center justify-center text-slate-300 hover:bg-red-100 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12"/></svg>
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    {/* 편집 푸터 */}
                    <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between bg-slate-50">
                      <span className="text-xs text-slate-400">총 {editingItems.length}개 장비</span>
                      <div className="flex gap-2">
                        <button onClick={handleCancelEdit} className="px-4 py-1.5 text-xs border border-slate-300 text-slate-600 rounded hover:bg-white transition-colors">취소</button>
                        <button onClick={handleSaveTpl} disabled={savingTpl} className="flex items-center gap-1.5 px-5 py-1.5 text-xs bg-emerald-600 text-white rounded font-semibold hover:bg-emerald-500 disabled:opacity-50 transition-colors">
                          {savingTpl ? '저장 중...' : (<><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/></svg>저장</>)}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

              </div>
            )
          )}


        </div>
      </div>

      {/* 템플릿 편집 — 장비 추가 모달 (AddEquipmentModal 재사용) */}
      {showTplEquipModal && (
        <AddEquipmentModal
          categories={dynCats.length > 0 ? dynCats : []}
          customEquips={customEquips}
          dynCats={dynCats}
          dynItems={dynItems}
          onAdd={handleAddFromModal}
          onClose={() => setShowTplEquipModal(false)}
          onViewProduct={() => {}}
          onViewManufacturer={() => {}}
        />
      )}

      {/* 계약 등록 모달 */}
      {contractModalQuote && (
        <ContractFormModal
          quote={contractModalQuote}
          onClose={() => setContractModalQuote(null)}
          onSaved={() => {
            setContractModalQuote(null);
            dbLoadContracts().then(data => setAllContracts(data || []));
          }}
        />
      )}
    </div>
  );
}

/* ============================================================
   TAX INVOICE TAB — 매출/매입 세금계산서 (엑셀형 입력)
   ============================================================ */
function TaxInvoiceTab({ onChanged }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const today = new Date().toISOString().slice(0,10);
  const [form, setForm] = useState({ kind: 'sale', issue_date: today, party_name: '', hospital_id: null, manufacturer_id: null, amount: '', memo: '' });
  const [pickerOpen, setPickerOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const { data } = await sb.from('tax_invoices').select('*').order('issue_date', { ascending: false }).order('created_at', { ascending: false });
    setRows(data || []);
    setLoading(false);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const fmt = (n) => (n || 0).toLocaleString() + '원';

  const handleAdd = async () => {
    const amt = parseInt((form.amount||'').toString().replace(/[^0-9-]/g,''), 10) || 0;
    if (!form.issue_date || !form.party_name.trim() || amt === 0) {
      alert('발급일자·상호·금액을 모두 입력하세요. (수정·취소 계산서는 금액 앞에 −)');
      return;
    }
    try {
      await sb.from('tax_invoices').insert({
        kind: form.kind, issue_date: form.issue_date,
        party_name: form.party_name.trim(), amount: amt,
        hospital_id: form.hospital_id || null,
        manufacturer_id: form.manufacturer_id || null,
        memo: form.memo.trim() || null,
      });
      setForm(p => ({ ...p, party_name: '', hospital_id: null, manufacturer_id: null, amount: '', memo: '' }));
      reload();
      onChanged && onChanged(true); // 거래처 원장 잔액도 갱신
    } catch (e) { alert('저장 실패: '+(e.message||e)); }
  };

  const handleDelete = async (id) => {
    if (!confirm('이 세금계산서를 삭제할까요?')) return;
    try {
      await sb.from('tax_invoices').delete().eq('id', id);
      reload();
      onChanged && onChanged(true); // 거래처 원장 잔액도 갱신
    } catch (e) { alert('삭제 실패: '+(e.message||e)); }
  };

  const sales = rows.filter(r => r.kind === 'sale');
  const purchases = rows.filter(r => r.kind === 'purchase');
  const totalSale = sales.reduce((s, r) => s + (Number(r.amount)||0), 0);
  const totalPur = purchases.reduce((s, r) => s + (Number(r.amount)||0), 0);

  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('all'); // all | sale | purchase

  // 검색 + 매출/매입 섞어서 발급일자 DESC 정렬
  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false;
      if (!q) return true;
      return (r.party_name||'').toLowerCase().includes(q) || (r.issue_date||'').includes(q) || String(r.amount||'').includes(q) || (r.memo||'').toLowerCase().includes(q);
    }).sort((a,b) => (b.issue_date||'').localeCompare(a.issue_date||'') || (b.created_at||'').localeCompare(a.created_at||''));
  }, [rows, search, kindFilter]);

  return (
    <div className="p-4 space-y-4" style={{maxHeight:'calc(100vh - 240px)', overflowY:'auto'}}>
      {/* 입력 폼 — 엑셀형 한 줄 */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
        <div className="text-xs font-semibold text-slate-700 mb-2">세금계산서 입력</div>
        <div className="flex gap-2 flex-wrap">
          <div className="flex gap-1 border border-slate-300 rounded p-0.5 bg-white">
            <button onClick={()=>setForm(p=>({...p, kind:'sale', party_name:'', hospital_id:null, manufacturer_id:null}))}
              className={`px-3 py-1 text-xs rounded ${form.kind==='sale' ? 'bg-emerald-500 text-white font-semibold' : 'text-slate-600 hover:bg-slate-100'}`}>매출</button>
            <button onClick={()=>setForm(p=>({...p, kind:'purchase', party_name:'', hospital_id:null, manufacturer_id:null}))}
              className={`px-3 py-1 text-xs rounded ${form.kind==='purchase' ? 'bg-rose-500 text-white font-semibold' : 'text-slate-600 hover:bg-slate-100'}`}>매입</button>
          </div>
          <input type="date" value={form.issue_date}
            onChange={e=>setForm(p=>({...p, issue_date:e.target.value}))}
            className="border border-slate-300 rounded px-2 py-1 text-sm"/>
          <button type="button" onClick={()=>setPickerOpen(true)}
            className="flex-1 min-w-[200px] border border-slate-300 rounded px-2 py-1 text-sm text-left bg-white hover:bg-slate-50 truncate">
            {form.party_name || <span className="text-slate-400">상호 선택 (클릭)</span>}
          </button>
          <input type="text" value={form.amount==='' || form.amount==='-' ? form.amount : Number(form.amount).toLocaleString()}
            onChange={e=>setForm(p=>({...p, amount:e.target.value.replace(/[^0-9-]/g,'').replace(/(?!^)-/g,'')}))}
            onKeyDown={e=>{ if (e.key==='Enter') handleAdd(); }}
            placeholder="합계금액 (수정계산서는 −)"
            className="w-40 border border-slate-300 rounded px-2 py-1 text-sm tnum text-right"/>
          <input type="text" value={form.memo}
            onChange={e=>setForm(p=>({...p, memo:e.target.value}))}
            onKeyDown={e=>{ if (e.key==='Enter') handleAdd(); }}
            placeholder="메모 (선택)"
            className="w-48 border border-slate-300 rounded px-2 py-1 text-sm"/>
          <button onClick={handleAdd}
            className="px-4 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-semibold">+ 추가</button>
        </div>
        <div className="text-[10px] text-slate-400 mt-2">상호 칸 클릭 → 검색 모달에서 선택. 발급일자·상호·금액 모두 필수. <span className="text-rose-500">수정·취소 계산서는 금액 앞에 −(마이너스)</span> 입력.</div>
      </div>
      {pickerOpen && (
        <VendorPickerModal
          onClose={()=>setPickerOpen(false)}
          onSelect={(it)=>setForm(p=>({...p, party_name: it.name, hospital_id: it.kind==='hospital' ? it.id : null, manufacturer_id: it.kind==='hospital' ? null : it.id }))}
          defaultFilter={form.kind === 'sale' ? 'hospital' : 'vendor'}
          allowedKinds='both'
        />
      )}

      {/* 검색 바 */}
      <div className="bg-white rounded-lg border border-slate-200 px-3 py-2 flex items-center gap-3 flex-wrap">
        <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="상호·발급일자·금액 검색"
          className="flex-1 min-w-[240px] border border-slate-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"/>
        <div className="flex gap-1 border border-slate-200 rounded-lg p-0.5">
          {[{k:'all', l:'전체'}, {k:'sale', l:'매출'}, {k:'purchase', l:'매입'}].map(t => (
            <button key={t.k} onClick={()=>setKindFilter(t.k)}
              className={`px-3 py-1 text-xs rounded transition-colors ${kindFilter===t.k ? 'bg-slate-900 text-white font-semibold' : 'text-slate-600 hover:bg-slate-50'}`}>{t.l}</button>
          ))}
        </div>
        <span className="text-xs text-slate-500 ml-auto">{sorted.length}건 / 전체 {rows.length}</span>
      </div>

      {loading ? (
        <div className="p-12 text-center text-slate-400 text-sm">불러오는 중...</div>
      ) : (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase border-b border-slate-100 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-center w-16">종류</th>
                <th className="px-3 py-2 text-left w-32">발급일자</th>
                <th className="px-3 py-2 text-left">상호</th>
                <th className="px-3 py-2 text-right w-40">합계금액</th>
                <th className="px-3 py-2 text-left">메모</th>
                <th className="px-3 py-2 text-center w-12"></th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-12 text-center text-slate-400 text-xs">등록된 세금계산서가 없습니다.</td></tr>
              ) : sorted.map(r => {
                const matched = !!r.matched_payment_id;
                return (
                <tr key={r.id} className={`border-t border-slate-100 hover:bg-slate-50 ${matched ? 'opacity-40' : ''}`} title={matched ? '송금에 매칭됨 (자금흐름에서 해제 가능)' : ''}>
                  <td className="px-3 py-1.5 text-center">
                    {r.kind === 'sale' ? (
                      <span className="inline-block px-2 py-0.5 bg-emerald-100 text-emerald-700 text-[10px] font-semibold rounded">매출</span>
                    ) : (
                      <span className="inline-block px-2 py-0.5 bg-rose-100 text-rose-700 text-[10px] font-semibold rounded">매입{matched && ' ✓'}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-600">{r.issue_date}</td>
                  <td className="px-3 py-1.5 text-slate-800">{r.party_name}</td>
                  <td className={`px-3 py-1.5 text-right tnum font-medium ${r.kind === 'sale' ? 'text-emerald-700' : 'text-rose-700'}`}>{fmt(r.amount)}</td>
                  <td className="px-3 py-1.5 text-slate-500 text-xs">{r.memo || ''}</td>
                  <td className="px-3 py-1.5 text-center">
                    <button onClick={()=>handleDelete(r.id)} className="text-slate-300 hover:text-rose-500 text-xs">✕</button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   CASHFLOW TAB — 활성 발주 기반 자금 흐름 (병원/계약별)
   ============================================================ */
function CashflowTab({ contracts = [], hospitals = [], manufacturers = [] }) {
  const [pos, setPos] = useState([]);
  const [recvTx, setRecvTx] = useState([]);    // 병원 → 우리 입금
  const [payTx, setPayTx] = useState([]);      // 우리 → 거래처 송금
  const [taxInv, setTaxInv] = useState([]);    // 세금계산서 (매입)
  const [balances, setBalances] = useState([]); // v_payable_balance — 거래처별 줄 돈
  const [cashLog, setCashLog] = useState([]);   // cash_balance_log — 발주 외 매출 집계용
  const [exFrom, setExFrom] = useState('');
  const [exTo, setExTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [openHosps, setOpenHosps] = useState({}); // hospName → bool
  const [selectingTaxFor, setSelectingTaxFor] = useState(null);  // 세금계산서 선택 모달 { id, name }
  const [selectingPayFor, setSelectingPayFor] = useState(null);  // 송금 선택 모달 { id, name }

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [poRes, recvRes, payRes, tiRes, balRes, cashRes] = await Promise.all([
        sb.from('purchase_orders').select('id, po_no, contract_id, manufacturer_id, manufacturer_name, vendor_name, hospital_name, total_amount, sale_amount, purchase_order_items(id, model_name, item_name, quantity, unit_price, sale_price, ordered, paid, tax_invoiced, delivered)').eq('is_active', true),
        sb.from('receivable_transactions').select('*').eq('tx_type', 'collect').order('tx_date', { ascending: true }),
        sb.from('payable_transactions').select('*').eq('tx_type', 'payment').order('tx_date', { ascending: true }),
        sb.from('tax_invoices').select('id, manufacturer_id, issue_date, amount, party_name, matched_payment_id, confirmed').eq('kind', 'purchase').order('issue_date', { ascending: false }),
        dbLoadPayableBalances(),
        dbLoadCashBalanceLog({ limit: 3000 }),
      ]);
      setPos(poRes.data || []);
      setRecvTx(recvRes.data || []);
      setPayTx(payRes.data || []);
      setTaxInv(tiRes.data || []);
      setBalances(balRes || []);
      setCashLog(cashRes || []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // contract.id → hospital_name / hospital_id 매핑
  const hospByContract = useMemo(() => {
    const m = new Map();
    contracts.forEach(c => m.set(c.id, { name: c.hospital_name, id: c.hospital_id }));
    return m;
  }, [contracts]);
  const hospIdByName = useMemo(() => {
    const m = new Map();
    hospitals.forEach(h => m.set(h.name, h.id));
    return m;
  }, [hospitals]);

  // 병원별 입금 / 거래처별 송금 매핑
  const recvByHospId = useMemo(() => {
    const m = new Map();
    recvTx.forEach(t => { if (!m.has(t.hospital_id)) m.set(t.hospital_id, []); m.get(t.hospital_id).push(t); });
    return m;
  }, [recvTx]);
  // 거래처별 송금 — 사용자가 [확인]한 것만 (자동 매칭 manufacturer_id는 보존, confirmed=true만 집계)
  const payByVendorId = useMemo(() => {
    const m = new Map();
    payTx.forEach(t => {
      if (!t.manufacturer_id || !t.confirmed) return;
      if (!m.has(t.manufacturer_id)) m.set(t.manufacturer_id, []);
      m.get(t.manufacturer_id).push(t);
    });
    return m;
  }, [payTx]);

  // 거래처별 세금계산서 합 — 사용자가 [확인]한 것만 (confirmed=true)
  const taxByVendor = useMemo(() => {
    const m = new Map();
    taxInv.forEach(t => {
      if (!t.manufacturer_id || !t.confirmed) return;
      if (!m.has(t.manufacturer_id)) m.set(t.manufacturer_id, { count: 0, sum: 0 });
      const v = m.get(t.manufacturer_id);
      v.count++; v.sum += Number(t.amount)||0;
    });
    return m;
  }, [taxInv]);

  // ===== 매입 측 거래처 정합성 점검 (세금계산서 vs 실제 지급) =====
  // 거래처별 세금계산서(매입) 전체 합 — 확정 여부 무관 (줄 돈 잔액과 같은 기준)
  const taxAllByVendor = useMemo(() => {
    const m = new Map();
    taxInv.forEach(t => {
      if (!t.manufacturer_id) return;
      const v = m.get(t.manufacturer_id) || { count: 0, sum: 0 };
      v.count++; v.sum += Number(t.amount) || 0;
      m.set(t.manufacturer_id, v);
    });
    return m;
  }, [taxInv]);
  // 거래처별 송금 건수 — 전체 (버튼 라벨용)
  const payCountByVendor = useMemo(() => {
    const m = new Map();
    payTx.forEach(t => { if (t.manufacturer_id) m.set(t.manufacturer_id, (m.get(t.manufacturer_id) || 0) + 1); });
    return m;
  }, [payTx]);
  // 거래처별 점검 행 — v_payable_balance(줄 돈) 기준 + 세금계산서/지급
  const vendorRows = useMemo(() => {
    return balances.map(b => {
      const tax = taxAllByVendor.get(b.manufacturer_id) || { count: 0, sum: 0 };
      const balance = b.balance || 0;
      return {
        mfrId: b.manufacturer_id, name: b.manufacturer_name, code: b.vendor_code,
        taxSum: tax.sum, taxCount: tax.count,
        paid: b.total_payment || 0,
        balance,
        payCount: payCountByVendor.get(b.manufacturer_id) || 0,
        warn: balance < 0,   // 과지급 — 계산서 누락/대신지급 의심
      };
    }).filter(r => r.taxSum || r.paid || r.balance)
      .sort((a, b) => {
        if (a.warn !== b.warn) return a.warn ? -1 : 1;
        return a.warn ? (a.balance - b.balance) : (b.balance - a.balance);
      });
  }, [balances, taxAllByVendor, payCountByVendor]);
  const vendorTotals = useMemo(() => ({
    tax: vendorRows.reduce((s, r) => s + r.taxSum, 0),
    paid: vendorRows.reduce((s, r) => s + r.paid, 0),
    owe: vendorRows.reduce((s, r) => s + Math.max(0, r.balance), 0),
    warnCount: vendorRows.filter(r => r.warn).length,
  }), [vendorRows]);

  // ===== 발주 외 매출 (광고·수수료·기타 수입) — 거래 입력에서 들어온 통장 입금 모아보기 =====
  const EXTRA_INCOME_TYPES = ['광고 매출', '수수료', '잡수입'];
  const extraRows = useMemo(() => {
    return cashLog
      .filter(c => (c.delta || 0) > 0 && EXTRA_INCOME_TYPES.includes(c.entry_type))
      .filter(c => (!exFrom && !exTo) ? true : ((!exFrom || (c.log_date || '') >= exFrom) && (!exTo || (c.log_date || '') <= exTo)))
      .sort((a, b) => (b.log_date || '').localeCompare(a.log_date || ''));
  }, [cashLog, exFrom, exTo]);
  const extraByType = useMemo(() => {
    const m = { '광고 매출': 0, '수수료': 0, '잡수입': 0 };
    extraRows.forEach(c => { m[c.entry_type] = (m[c.entry_type] || 0) + (c.delta || 0); });
    return m;
  }, [extraRows]);
  const extraTotal = useMemo(() => extraRows.reduce((s, c) => s + (c.delta || 0), 0), [extraRows]);

  // 병원별 그룹
  const byHosp = useMemo(() => {
    const m = new Map();
    pos.forEach(p => {
      const hospName = hospByContract.get(p.contract_id)?.name || p.hospital_name || '(병원 미지정)';
      if (!m.has(hospName)) m.set(hospName, []);
      m.get(hospName).push(p);
    });
    return m;
  }, [pos, hospByContract]);

  // 한 PO 또는 한 contract의 자금 집계 — 각 단계는 독립 (중복 가산 가능)
  const tally = (poList) => {
    const r = {
      // 매출 측
      incomeTotal: 0,         // 매출금액 = 전체 매출 합
      incomeInvoiced: 0,      // 세금계산서 발행 (tax_invoiced=true)
      // 매입 측
      outflowTotal: 0,        // 매입금액 = 전체 매입 합
      outflowInvoiced: 0,     // 세금계산서 받음 (tax_invoiced=true)
      outflowPaid: 0,         // 송금 완료 (paid=true)
    };
    poList.forEach(p => {
      (p.purchase_order_items || []).forEach(it => {
        const sale  = (Number(it.sale_price)||0) * (Number(it.quantity)||0);
        const purch = (Number(it.unit_price)||0) * (Number(it.quantity)||0);
        // 매출
        r.incomeTotal += sale;
        if (it.tax_invoiced) r.incomeInvoiced += sale;
        // 매입
        r.outflowTotal += purch;
        if (it.tax_invoiced) r.outflowInvoiced += purch;
        if (it.paid) r.outflowPaid += purch;
      });
    });
    r.outflowRemaining = r.outflowTotal - r.outflowPaid; // 아직 송금 안 한 매입
    r.net = r.incomeTotal - r.outflowRemaining;
    return r;
  };

  // 병원별 합산 + 거래처별 분할 + 입금 내역
  const hospEntries = useMemo(() => {
    return Array.from(byHosp.entries()).map(([hosp, poList]) => {
      const sums = tally(poList);
      const hospId = hospByContract.get(poList[0]?.contract_id)?.id || hospIdByName.get(hosp) || null;
      const incomes = (hospId && recvByHospId.get(hospId)) || [];
      const totalCollected = incomes.reduce((s, t) => s + (Number(t.amount)||0), 0);
      sums.totalCollected = totalCollected;
      sums.incomeRemaining = Math.max(0, sums.incomeTotal - totalCollected);
      // 거래처별 매입 합 + 송금 내역
      const byVendor = new Map();
      poList.forEach(p => {
        const v = p.manufacturer_name || p.vendor_name || '(미지정)';
        if (!byVendor.has(v)) byVendor.set(v, { list: [], mfrId: p.manufacturer_id });
        byVendor.get(v).list.push(p);
        if (p.manufacturer_id) byVendor.get(v).mfrId = p.manufacturer_id;
      });
      const vendors = Array.from(byVendor.entries()).map(([v, { list, mfrId }]) => {
        const t = tally(list);
        const sentTx = (mfrId && payByVendorId.get(mfrId)) || [];
        const sentSum = sentTx.reduce((s, x) => s + (Number(x.amount)||0), 0);
        return { vendor: v, mfrId, ...t, poCount: list.length, sentTx, sentSum, outflowRemaining: Math.max(0, t.outflowTotal - sentSum) };
      }).sort((a,b) => b.outflowRemaining - a.outflowRemaining);
      const totalSentForHosp = vendors.reduce((s, v) => s + v.sentSum, 0);
      sums.totalSentOut = totalSentForHosp;
      sums.outflowRemaining = Math.max(0, sums.outflowTotal - totalSentForHosp);
      sums.net = sums.incomeRemaining - sums.outflowRemaining;
      return { hosp, hospId, poCount: poList.length, ...sums, incomes, vendors };
    }).sort((a,b) => b.incomeRemaining - a.incomeRemaining);
  }, [byHosp, recvByHospId, payByVendorId, hospByContract, hospIdByName]);

  // 전체 합산 — 활성 PO 기준, 미정산 매입은 거래처별 매칭(hospEntries) 결과를 합산
  const grand = useMemo(() => {
    const t = tally(pos);
    t.totalCollected = hospEntries.reduce((s, h) => s + (h.totalCollected||0), 0);
    t.totalSentOut = hospEntries.reduce((s, h) => s + (h.totalSentOut||0), 0);
    t.incomeRemaining = Math.max(0, t.incomeTotal - t.totalCollected);
    t.outflowRemaining = hospEntries.reduce((s, h) => s + (h.outflowRemaining||0), 0);
    t.net = t.incomeRemaining - t.outflowRemaining;
    return t;
  }, [pos, hospEntries]);

  const today = new Date().toISOString().slice(0,10);
  const [collectInputs, setCollectInputs] = useState({}); // hospName → { date, amount }
  const getCI = (hosp) => collectInputs[hosp] || { date: today, amount: '' };
  const setCI = (hosp, patch) => setCollectInputs(p => ({ ...p, [hosp]: { ...getCI(hosp), ...patch } }));

  const addCollect = async (hospId, hospName) => {
    const ci = getCI(hospName);
    const amt = Number((ci.amount||'').toString().replace(/[^0-9]/g,'')) || 0;
    if (!hospId) { alert('병원 ID가 없어 저장할 수 없습니다.'); return; }
    if (amt <= 0) { alert('금액을 입력하세요.'); return; }
    try {
      await sb.from('receivable_transactions').insert({
        hospital_id: hospId, tx_date: ci.date, tx_type: 'collect', amount: amt, memo: '자금 흐름 탭에서 입력',
      });
      await sb.from('cash_balance_log').insert({
        log_date: ci.date, delta: amt, memo: `${hospName} 입금 (자금 흐름)`,
      });
      setCI(hospName, { amount: '' });
      reload();
    } catch (e) { alert('저장 실패: '+(e.message||e)); }
  };

  const confirmPayment = async (mfrId, vendorName, amount) => {
    if (!mfrId) { alert('거래처 ID가 없습니다. manufacturers에 등록 후 시도하세요.'); return; }
    const date = prompt(`${vendorName} 송금 날짜? (YYYY-MM-DD)`, today);
    if (!date) return;
    try {
      await sb.from('payable_transactions').insert({
        manufacturer_id: mfrId, tx_date: date, tx_type: 'payment', amount, memo: '자금 흐름 탭에서 입력',
      });
      await sb.from('cash_balance_log').insert({
        log_date: date, delta: -amount, memo: `${vendorName} 송금 (자금 흐름)`,
      });
      reload();
    } catch (e) { alert('저장 실패: '+(e.message||e)); }
  };

  if (loading) return <div className="p-12 text-center text-slate-400 text-sm">불러오는 중...</div>;

  const fmt = (n) => (n || 0).toLocaleString() + '원';

  return (
    <div className="p-4 space-y-4" style={{maxHeight:'calc(100vh - 240px)', overflowY:'auto'}}>
      <div>
        <div className="text-sm font-semibold text-slate-700">💰 발주 외 매출 — 광고·수수료·기타 수입</div>
        <div className="text-xs text-slate-500 mt-0.5">장비 발주(병원 매출)와 무관한 수입을 모아 봅니다. 입력은 「거래 입력」 탭에서 <b>광고 매출 · 수수료 · 잡수입</b> 유형으로 하세요 — 여기는 보기 전용입니다.</div>
      </div>

      {/* 기간 */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">기간</span>
        <input type="date" value={exFrom} onChange={e => setExFrom(e.target.value)} className="bg-white border border-slate-200 rounded px-2 py-1 text-sm" />
        <span className="text-xs text-slate-400">~</span>
        <input type="date" value={exTo} onChange={e => setExTo(e.target.value)} className="bg-white border border-slate-200 rounded px-2 py-1 text-sm" />
        {(exFrom || exTo) && <button onClick={() => { setExFrom(''); setExTo(''); }} className="text-xs text-slate-500 hover:text-slate-700">전체</button>}
        <span className="ml-auto text-xs text-slate-400">{(exFrom || exTo) ? '선택 기간' : '전체 기간'} 기준</span>
      </div>

      {/* 합계 카드 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-teal-200 p-4">
          <div className="text-[11px] font-semibold text-teal-700 mb-1">📢 광고 매출</div>
          <div className="text-xl font-bold text-teal-700 tnum">{fmt(extraByType['광고 매출'])}</div>
        </div>
        <div className="bg-white rounded-xl border border-cyan-200 p-4">
          <div className="text-[11px] font-semibold text-cyan-700 mb-1">🤝 수수료</div>
          <div className="text-xl font-bold text-cyan-700 tnum">{fmt(extraByType['수수료'])}</div>
        </div>
        <div className="bg-white rounded-xl border border-lime-200 p-4">
          <div className="text-[11px] font-semibold text-lime-700 mb-1">🧾 기타 수입</div>
          <div className="text-xl font-bold text-lime-700 tnum">{fmt(extraByType['잡수입'])}</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-300 p-4">
          <div className="text-[11px] font-semibold text-slate-600 mb-1">합계</div>
          <div className="text-xl font-bold text-slate-800 tnum">{fmt(extraTotal)}</div>
        </div>
      </div>

      {/* 목록 */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="px-3 py-2.5 text-left w-28">날짜</th>
              <th className="px-3 py-2.5 text-left w-28">유형</th>
              <th className="px-3 py-2.5 text-left">출처</th>
              <th className="px-3 py-2.5 text-right w-32">금액</th>
              <th className="px-3 py-2.5 text-left">메모</th>
            </tr>
          </thead>
          <tbody>
            {extraRows.length === 0 ? (
              <tr><td colSpan={5} className="py-10 text-center text-slate-400 text-sm">
                발주 외 매출 기록이 없습니다.<br/>
                <span className="text-xs">「거래 입력」에서 <b>광고 매출 · 수수료 · 잡수입</b> 유형으로 입력하면 여기 모입니다.</span>
              </td></tr>
            ) : extraRows.map(c => {
              const st = CASH_TAG_STYLE[c.entry_type] || { bg: 'bg-slate-100', text: 'text-slate-600' };
              return (
                <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{c.log_date}</td>
                  <td className="px-3 py-2"><span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${st.bg} ${st.text}`}>{c.entry_type === '잡수입' ? '기타 수입' : c.entry_type}</span></td>
                  <td className="px-3 py-2 text-slate-800">{c.counterparty || '—'}</td>
                  <td className="px-3 py-2 text-right tnum font-semibold text-emerald-700">+{fmt(c.delta)}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{c.memo || ''}</td>
                </tr>
              );
            })}
          </tbody>
          {extraRows.length > 0 && (
            <tfoot className="bg-slate-100 font-semibold text-sm">
              <tr>
                <td className="px-3 py-2.5" colSpan={3}>합계 ({extraRows.length}건)</td>
                <td className="px-3 py-2.5 text-right tnum text-emerald-700">+{fmt(extraTotal)}</td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

/* ============================================================
/* ============================================================
   TAX SELECT MODAL — 그 거래처에 묶을 세금계산서를 사용자가 직접 선택
   ============================================================ */
function TaxSelectModal({ mfrId, mfrName, allTaxInv, manufacturers = [], onClose, onChanged }) {
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const fmt = (n) => (n || 0).toLocaleString() + '원';
  const mfrById = useMemo(() => new Map(manufacturers.map(m => [m.id, m])), [manufacturers]);
  const vendorName = (t) => t.manufacturer_id ? (mfrById.get(t.manufacturer_id)?.name || '') : '';

  const toggle = async (taxId, checked) => {
    setSaving(true);
    try {
      // 체크: 이 거래처로 묶고 confirmed=true. 해제: confirmed만 false (manufacturer_id 보존)
      const update = checked
        ? { manufacturer_id: mfrId, confirmed: true }
        : { confirmed: false };
      await sb.from('tax_invoices').update(update).eq('id', taxId);
      await onChanged?.();
    } catch (e) { alert('저장 실패: '+(e.message||e)); }
    finally { setSaving(false); }
  };

  const isMine = (t) => t.manufacturer_id === mfrId && t.confirmed;

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = allTaxInv.filter(t => t.kind === 'purchase' || !t.kind).filter(t => {
      if (!q) return true;
      return (t.issue_date||'').includes(q)
        || (t.party_name||'').toLowerCase().includes(q)
        || vendorName(t).toLowerCase().includes(q)
        || String(t.amount||'').includes(q.replace(/[^0-9]/g,''));
    });
    return filtered.sort((a,b) => {
      const aMine = isMine(a) ? 1 : 0;
      const bMine = isMine(b) ? 1 : 0;
      if (aMine !== bMine) return bMine - aMine;
      return (b.issue_date||'').localeCompare(a.issue_date||'');
    });
  }, [allTaxInv, search, mfrId]);

  const minePool = allTaxInv.filter(isMine);
  const matchedCount = minePool.length;
  const matchedSum = minePool.reduce((s,t)=>s+Number(t.amount||0),0);

  return (
    <ModalShell title={`📄 ${mfrName} — 세금계산서 선택`} onClose={onClose} wide z={60}>
      <div className="flex flex-col" style={{height:'520px'}}>
        <div className="flex items-center gap-2 mb-3 shrink-0">
          <div className="text-xs text-slate-600">
            묶인 세금계산서 <span className="font-bold text-emerald-700">{matchedCount}건</span> · <span className="tnum">{fmt(matchedSum)}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] text-slate-400">state:'<b className="text-rose-600">{search}</b>' / 표시 <b className="text-slate-700">{list.length}</b>건</span>
            <input type="text" value={search}
              onChange={e=>setSearch(e.target.value)}
              placeholder="날짜·상호·거래처명·금액"
              className="border border-slate-300 rounded px-2 py-1 text-xs w-72 focus:outline-none focus:border-blue-400"/>
            {search && <button onClick={()=>setSearch('')} className="text-[10px] text-slate-400 hover:text-slate-700">✕ 지움</button>}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto border border-slate-100 rounded">
          {list.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">세금계산서가 없습니다.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-[10px] text-slate-500 sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 w-10"></th>
                  <th className="px-2 py-1.5 text-left">발급일</th>
                  <th className="px-2 py-1.5 text-left">상호</th>
                  <th className="px-2 py-1.5 text-right">금액</th>
                </tr>
              </thead>
              <tbody>
                {list.map(t => {
                  const mine = isMine(t);
                  return (
                    <tr key={t.id} className={`border-t border-slate-100 hover:bg-slate-50 ${mine ? 'bg-emerald-50' : ''}`}>
                      <td className="px-2 py-1.5 text-center">
                        <input type="checkbox" checked={mine} disabled={saving}
                          onChange={e => toggle(t.id, e.target.checked)} className="cursor-pointer"/>
                      </td>
                      <td className="px-2 py-1.5 text-slate-700 whitespace-nowrap">{t.issue_date}</td>
                      <td className="px-2 py-1.5 text-slate-800" title={t.party_name}>{t.party_name}</td>
                      <td className="px-2 py-1.5 text-right tnum text-slate-800 whitespace-nowrap">{fmt(t.amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="text-[10px] text-slate-400 mt-2 shrink-0">
          ※ 체크하면 그 세금계산서가 이 거래처에 묶입니다. 다른 거래처에 묶인 것도 체크하면 이쪽으로 옮겨집니다.
        </div>
      </div>
    </ModalShell>
  );
}

/* ============================================================
   PAYMENT SELECT MODAL — 그 거래처에 묶을 송금을 사용자가 직접 선택
   ============================================================ */
function PaymentSelectModal({ mfrId, mfrName, allPayTx, manufacturers = [], onClose, onChanged }) {
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const fmt = (n) => (n || 0).toLocaleString() + '원';
  const mfrById = useMemo(() => new Map(manufacturers.map(m => [m.id, m])), [manufacturers]);
  const vendorName = (p) => p.manufacturer_id ? (mfrById.get(p.manufacturer_id)?.name || '') : '';

  const toggle = async (payId, checked) => {
    setSaving(true);
    try {
      // 체크: manufacturer_id=mfrId + confirmed=true / 해제: confirmed=false (manufacturer_id 보존)
      const update = checked
        ? { manufacturer_id: mfrId, confirmed: true }
        : { confirmed: false };
      await sb.from('payable_transactions').update(update).eq('id', payId);
      await onChanged?.();
    } catch (e) { alert('저장 실패: '+(e.message||e)); }
    finally { setSaving(false); }
  };

  const isMine = (p) => p.manufacturer_id === mfrId && p.confirmed;

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = allPayTx.filter(p => {
      if (!q) return true;
      return (p.tx_date||'').includes(q)
        || (p.memo||'').toLowerCase().includes(q)
        || vendorName(p).toLowerCase().includes(q)
        || String(p.amount||'').includes(q.replace(/[^0-9]/g,''));
    });
    return filtered.sort((a,b) => {
      const aMine = isMine(a) ? 1 : 0;
      const bMine = isMine(b) ? 1 : 0;
      if (aMine !== bMine) return bMine - aMine;
      return (b.tx_date||'').localeCompare(a.tx_date||'');
    }).slice(0, 200);
  }, [allPayTx, search, mfrId]);

  const minePool = allPayTx.filter(isMine);
  const matchedCount = minePool.length;
  const matchedSum = minePool.reduce((s,p)=>s+Number(p.amount||0),0);

  return (
    <ModalShell title={`📤 ${mfrName} — 송금 내역 선택`} onClose={onClose} wide z={60}>
      <div className="flex flex-col" style={{height:'520px'}}>
        <div className="flex items-center gap-2 mb-3 shrink-0">
          <div className="text-xs text-slate-600">
            묶인 송금 <span className="font-bold text-emerald-700">{matchedCount}건</span> · <span className="tnum">{fmt(matchedSum)}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] text-slate-400">state:'<b className="text-rose-600">{search}</b>' / 표시 <b className="text-slate-700">{list.length}</b>건</span>
            <input type="text" value={search}
              onChange={e=>setSearch(e.target.value)}
              placeholder="날짜·금액·메모·거래처"
              className="border border-slate-300 rounded px-2 py-1 text-xs w-72 focus:outline-none focus:border-blue-400"/>
            {search && <button onClick={()=>setSearch('')} className="text-[10px] text-slate-400 hover:text-slate-700">✕ 지움</button>}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto border border-slate-100 rounded">
          {list.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">송금 내역이 없습니다.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-[10px] text-slate-500 sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 w-10"></th>
                  <th className="px-2 py-1.5 text-left">송금일</th>
                  <th className="px-2 py-1.5 text-right">금액</th>
                  <th className="px-2 py-1.5 text-left">거래처</th>
                  <th className="px-2 py-1.5 text-left">메모</th>
                </tr>
              </thead>
              <tbody>
                {list.map(p => {
                  const mine = isMine(p);
                  const vname = p.manufacturer_id ? (manufacturers.find(m=>m.id===p.manufacturer_id)?.name || '') : '';
                  return (
                    <tr key={p.id} className={`border-t border-slate-100 hover:bg-slate-50 ${mine ? 'bg-emerald-50' : ''} ${!p.cash_log_id ? 'opacity-60' : ''}`}>
                      <td className="px-2 py-1.5 text-center">
                        <input type="checkbox" checked={mine} disabled={saving}
                          onChange={e => toggle(p.id, e.target.checked)} className="cursor-pointer"/>
                      </td>
                      <td className="px-2 py-1.5 text-slate-700 whitespace-nowrap">{p.tx_date}
                        {!p.cash_log_id && <span className="ml-1 text-[9px] text-amber-600" title="통장에 대응 출금이 없는 송금 (결산 entry 등)">통장無</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right tnum text-slate-800 whitespace-nowrap">{fmt(p.amount)}</td>
                      <td className="px-2 py-1.5 text-slate-800" title={vname}>{vname || <span className="text-slate-300">—</span>}</td>
                      <td className="px-2 py-1.5 text-slate-600 break-words" title={p.memo}>{p.memo || <span className="text-slate-300">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="text-[10px] text-slate-400 mt-2 shrink-0">
          ※ 체크하면 그 송금이 이 거래처에 묶입니다. 다른 거래처에 묶인 것도 체크하면 이쪽으로 옮겨집니다.
        </div>
      </div>
    </ModalShell>
  );
}

/* ============================================================
   ORDER REQUESTS (발주 요청함) PAGE — 현장/영업 요청 빠른 캡처 inbox
   ============================================================ */
function OrderRequestsPage({ onBack, user, onLogout, nav }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ site: '', requester: '', model_name: '', quantity: '', quote_price: '', content: '' });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('대기'); // 대기 | 전체 | 완료 | 보류

  const reload = useCallback(async () => {
    setLoading(true);
    const { data } = await sb.from('order_requests').select('*').order('created_at', { ascending: false });
    setRows(data || []);
    setLoading(false);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const handleAdd = async () => {
    if (!form.content.trim() && !form.model_name.trim()) { alert('모델명 또는 요청 내용을 입력하세요.'); return; }
    setSaving(true);
    try {
      await sb.from('order_requests').insert({
        site: form.site.trim() || null,
        requester: form.requester.trim() || null,
        model_name: form.model_name.trim() || null,
        quantity: form.quantity ? Number(form.quantity) : null,
        quote_price: form.quote_price ? Number(String(form.quote_price).replace(/[^0-9]/g, '')) : null,
        content: form.content.trim(),
        status: '대기',
      });
      setForm({ site: '', requester: '', model_name: '', quantity: '', quote_price: '', content: '' });
      reload();
    } catch (e) { alert('저장 실패: ' + (e.message || e)); }
    finally { setSaving(false); }
  };

  const setStatus = async (id, status) => {
    try {
      await sb.from('order_requests').update({ status, processed_at: status === '완료' ? new Date().toISOString() : null }).eq('id', id);
      reload();
    } catch (e) { alert('변경 실패: ' + (e.message || e)); }
  };
  const updateMemo = async (id, memo) => {
    try { await sb.from('order_requests').update({ memo: memo || null }).eq('id', id); reload(); }
    catch (e) { alert('메모 저장 실패: ' + (e.message || e)); }
  };
  const handleDelete = async (id) => {
    if (!confirm('이 요청을 삭제할까요?')) return;
    try { await sb.from('order_requests').delete().eq('id', id); reload(); }
    catch (e) { alert('삭제 실패: ' + (e.message || e)); }
  };

  const counts = useMemo(() => {
    const c = { 대기: 0, 완료: 0, 보류: 0 };
    rows.forEach(r => { if (c[r.status] != null) c[r.status]++; });
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (statusFilter !== '전체' && r.status !== statusFilter) return false;
      if (!q) return true;
      return [r.site, r.content, r.requester, r.model_name, r.memo].some(v => (v || '').toLowerCase().includes(q));
    });
  }, [rows, search, statusFilter]);

  const fmtDate = (s) => s ? new Date(s).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const STATUS_STYLE = { '대기': 'bg-amber-100 text-amber-700', '완료': 'bg-emerald-100 text-emerald-700', '보류': 'bg-slate-200 text-slate-600' };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <AppHeader title="발주 요청함" onLogoClick={onBack} user={user} onLogout={onLogout} nav={nav} />
      <div className="flex-1 overflow-y-auto p-4 md:p-6 w-full max-w-4xl mx-auto space-y-4">
        {/* 빠른 입력 */}
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-sm font-semibold text-slate-700 mb-3">빠른 발주 요청 추가</div>
          <div className="space-y-2">
            <div className="flex gap-2 flex-wrap">
              <input value={form.site} onChange={e => setForm(p => ({ ...p, site: e.target.value }))}
                placeholder="현장/병원 (예: 아이비어린이병원)"
                className="flex-1 min-w-[200px] border border-slate-300 rounded px-3 py-2 text-sm" />
              <input value={form.requester} onChange={e => setForm(p => ({ ...p, requester: e.target.value }))}
                placeholder="요청자 (선택)" className="w-36 border border-slate-300 rounded px-3 py-2 text-sm" />
            </div>
            <div className="flex gap-2 flex-wrap">
              <input value={form.model_name} onChange={e => setForm(p => ({ ...p, model_name: e.target.value }))}
                placeholder="모델명" className="flex-1 min-w-[160px] border border-slate-300 rounded px-3 py-2 text-sm" />
              <input value={form.quantity} onChange={e => setForm(p => ({ ...p, quantity: e.target.value.replace(/[^0-9]/g, '') }))}
                placeholder="수량" className="w-24 border border-slate-300 rounded px-3 py-2 text-sm text-right" />
              <input value={form.quote_price ? Number(form.quote_price).toLocaleString() : ''}
                onChange={e => setForm(p => ({ ...p, quote_price: e.target.value.replace(/[^0-9]/g, '') }))}
                placeholder="견적가격" className="w-36 border border-slate-300 rounded px-3 py-2 text-sm text-right tnum" />
            </div>
            <textarea value={form.content} onChange={e => setForm(p => ({ ...p, content: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAdd(); }}
              placeholder="추가 요청 내용 (선택) — 거래처·납기 등 자유롭게 (카톡 내용 붙여넣기 OK). Ctrl+Enter로 추가"
              rows={2} className="w-full border border-slate-300 rounded px-3 py-2 text-sm resize-y" />
            <div className="flex justify-end">
              <button onClick={handleAdd} disabled={saving}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-semibold disabled:opacity-50">추가</button>
            </div>
          </div>
        </div>

        {/* 필터/검색 */}
        <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 border border-slate-200 rounded-lg p-0.5">
            {['대기', '전체', '완료', '보류'].map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`px-3 py-1 text-xs rounded ${statusFilter === s ? 'bg-slate-900 text-white font-semibold' : 'text-slate-600 hover:bg-slate-50'}`}>
                {s}{s !== '전체' && counts[s] > 0 ? ` ${counts[s]}` : ''}
              </button>
            ))}
          </div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="검색"
            className="flex-1 min-w-[180px] border border-slate-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
          <span className="text-xs text-slate-500">{filtered.length}건</span>
        </div>

        {/* 목록 */}
        {loading ? (
          <div className="p-12 text-center text-slate-400 text-sm">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm">요청이 없습니다.</div>
        ) : (
          <div className="space-y-2">
            {filtered.map(r => (
              <div key={r.id} className={`bg-white border rounded-lg p-3 ${r.status === '완료' ? 'border-slate-100 opacity-60' : 'border-slate-200'}`}>
                <div className="flex items-center gap-2 flex-wrap text-xs text-slate-500 mb-1">
                  <span className={`px-2 py-0.5 rounded font-semibold ${STATUS_STYLE[r.status] || ''}`}>{r.status}</span>
                  {r.site && <span className="font-semibold text-slate-800">{r.site}</span>}
                  {r.requester && <span>· {r.requester}</span>}
                  <span className="ml-auto">{fmtDate(r.created_at)}</span>
                </div>
                {(r.model_name || r.quantity || r.quote_price) && (
                  <div className="text-sm text-slate-800 font-medium">
                    {r.model_name || ''}
                    {r.quantity ? <span className="font-normal text-slate-500"> · 수량 {r.quantity}</span> : ''}
                    {r.quote_price ? <span className="font-normal text-slate-500"> · 견적 {Number(r.quote_price).toLocaleString()}원</span> : ''}
                  </div>
                )}
                {r.content && <div className="text-sm text-slate-700 whitespace-pre-wrap break-words mt-0.5">{r.content}</div>}
                {r.memo && <div className="mt-1 text-xs text-slate-500">메모: {r.memo}</div>}
                <div className="flex items-center gap-1 mt-2 flex-wrap">
                  {r.status !== '완료' && <button onClick={() => setStatus(r.id, '완료')} className="px-2 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-500">완료</button>}
                  {r.status !== '보류' && <button onClick={() => setStatus(r.id, '보류')} className="px-2 py-1 text-xs bg-slate-200 text-slate-700 rounded hover:bg-slate-300">보류</button>}
                  {r.status !== '대기' && <button onClick={() => setStatus(r.id, '대기')} className="px-2 py-1 text-xs border border-slate-300 text-slate-600 rounded hover:bg-slate-50">대기로</button>}
                  <button onClick={() => { const m = prompt('처리 메모', r.memo || ''); if (m !== null) updateMemo(r.id, m); }} className="px-2 py-1 text-xs border border-slate-300 text-slate-600 rounded hover:bg-slate-50">메모</button>
                  <button onClick={() => handleDelete(r.id)} className="px-2 py-1 text-xs text-rose-400 hover:text-rose-600 ml-auto">삭제</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   PAYABLES (외상매입금 관리) PAGE
   ============================================================ */
function PayablesPage({ onBack, user, onLogout, nav, manufacturers = [], setManufacturers }) {
  const [tab, setTab] = useState('entry'); // entry | balance | history | cash | report
  const [balances, setBalances] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [cashLogs, setCashLogs] = useState([]);
  const [arBalances, setArBalances] = useState([]);       // 병원별 매출/수금/미수금 (legacy)
  const [arTransactions, setArTransactions] = useState([]); // receivable_transactions (legacy)
  const [expectedRev, setExpectedRev] = useState([]);     // 예상 매출 (신규 모듈)
  const [hospitals, setHospitals] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [saleTax, setSaleTax] = useState([]); // 매출 세금계산서 (거래처 받을돈 집계용)
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [hideZero, setHideZero] = useState(true);
  const [catFilter, setCatFilter] = useState('all'); // all | 병원 | 일반업체 | 기타

  const [purchaseModal, setPurchaseModal] = useState(false);
  const [paymentModal, setPaymentModal] = useState(false);
  const [historyModal, setHistoryModal] = useState(null); // { manufacturerId, name }
  const [cashAddOpen, setCashAddOpen] = useState(false);

  const [toast, setToast] = useState(null);
  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  };

  const [poTxs, setPoTxs] = useState([]); // po_id가 있는 매입 트랜잭션 (발주 기반)

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [b, t, c, p, ab, at, hosp, ctr, er, st] = await Promise.all([
        dbLoadPayableBalances(),
        dbLoadPayableTransactions(),
        dbLoadCashBalanceLog({ limit: 1000 }),
        dbLoadActivePoTransactions(),
        dbLoadReceivableBalances(),
        dbLoadReceivableTransactions(),
        dbLoadHospitals(),
        dbLoadAllContracts(),
        dbLoadExpectedRevenue(),
        sb.from('tax_invoices').select('manufacturer_id, hospital_id, amount, issue_date').eq('kind', 'sale').then(r => r.data || []),
      ]);
      setBalances(b);
      setTransactions(t);
      setCashLogs(c);
      setPoTxs(p);
      setArBalances(ab);
      setArTransactions(at);
      setHospitals(hosp);
      setContracts(ctr);
      setExpectedRev(er);
      setSaleTax(st);
    } catch (e) {
      console.error(e);
      showToast('데이터 로드 실패: ' + (e.message || e), 'error');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // 거래처별 미정산 발주 매입 그룹 (PaymentBatchModal에 전달)
  const poByMfr = useMemo(() => {
    const m = {};
    poTxs.forEach(t => {
      if (!m[t.manufacturer_id]) m[t.manufacturer_id] = [];
      m[t.manufacturer_id].push(t);
    });
    return m;
  }, [poTxs]);

  // 거래처(manufacturer)에 발생한 매출 미수금 — receivable_transactions의 manufacturer_id 기준
  const recvByMfr = useMemo(() => {
    const m = new Map();
    arTransactions.forEach(t => {
      if (!t.manufacturer_id) return;
      const a = Number(t.amount) || 0;
      const s = (t.tx_type === 'collect' || t.tx_type === 'cancel') ? -a : a;
      m.set(t.manufacturer_id, (m.get(t.manufacturer_id) || 0) + s);
    });
    // 거래처 매출 세금계산서(6/1 이후)도 받을돈에 포함 — 병원 v_receivable_balance와 대칭. 5/29 이전은 이월에 포함이라 제외
    saleTax.forEach(t => {
      if (!t.manufacturer_id || (t.issue_date || '') <= '2026-05-29') return;
      m.set(t.manufacturer_id, (m.get(t.manufacturer_id) || 0) + (Number(t.amount) || 0));
    });
    return m;
  }, [arTransactions, saleTax]);

  // 거래처(매입) + 병원(매출)을 한 목록으로 — 카테고리 포함
  const unifiedParties = useMemo(() => {
    const mfrCat = new Map(manufacturers.map(m => [m.id, m.category || '일반업체']));
    const items = [];
    balances.forEach(b => items.push({
      kind: 'vendor', id: b.manufacturer_id, name: b.manufacturer_name, code: b.vendor_code,
      category: mfrCat.get(b.manufacturer_id) || '일반업체',
      owe: b.balance || 0, due: recvByMfr.get(b.manufacturer_id) || 0, last_tx_date: b.last_tx_date,
    }));
    arBalances.forEach(a => items.push({
      kind: 'hospital', id: a.hospital_id, name: a.hospital_name, code: null,
      category: '병원', owe: 0, due: a.balance || 0, last_tx_date: a.last_tx_date,
    }));
    return items;
  }, [balances, arBalances, manufacturers, recvByMfr]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return unifiedParties.filter(b => {
      if (catFilter !== 'all' && b.category !== catFilter) return false;
      // 잔액 0원 제외 — 단, 받을돈 마이너스(선수금)는 의미가 있으므로 남긴다
      if (hideZero && (b.owe || 0) <= 0 && (b.due || 0) === 0) return false;
      if (!q) return true;
      return (b.name || '').toLowerCase().includes(q) || (b.code || '').toLowerCase().includes(q);
    });
  }, [unifiedParties, search, hideZero, catFilter]);

  const [sortKey, setSortKey] = useState('balance');
  const [sortDir, setSortDir] = useState('desc');
  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(key); setSortDir('desc'); }
  };
  const sortIcon = (key) => sortKey === key ? (sortDir === 'desc' ? '▼' : '▲') : '↕';

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let va, vb;
      if (sortKey === 'balance') {
        va = a.owe || a.due || 0; vb = b.owe || b.due || 0;
      } else { // lastTx
        va = a.last_tx_date || ''; vb = b.last_tx_date || '';
      }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  // 거래처별 가장 최근 거래 (요약 내용 표시용) — transactions는 tx_date desc 정렬
  const lastTxByMfr = useMemo(() => {
    const m = new Map();
    transactions.forEach(t => { if (!m.has(t.manufacturer_id)) m.set(t.manufacturer_id, t); });
    return m;
  }, [transactions]);

  const totals = useMemo(() => {
    // 양수 잔액만 합산 (거래처 원장·리포트와 일치) — 음수 거래처는 과지급/이월누락이므로 줄 돈에서 제외
    const totalBal = balances.reduce((s, b) => s + Math.max(0, b.balance || 0), 0);
    const totalPurchase = balances.reduce((s, b) => s + (b.total_purchase || 0), 0);
    const totalPayment = balances.reduce((s, b) => s + (b.total_payment || 0), 0);
    const activeCount = balances.filter(b => (b.balance || 0) > 0).length;
    return { totalBal, totalPurchase, totalPayment, activeCount };
  }, [balances]);

  // 통장잔액 = 시간순 누적. balance_after가 명시된 행은 그 값을 기준점으로 리셋, 나머지는 delta 누적
  const cashCurrent = useMemo(() => {
    if (!cashLogs || cashLogs.length === 0) return null;
    const asc = [...cashLogs].sort((a, b) =>
      (a.log_date < b.log_date ? -1 : a.log_date > b.log_date ? 1 : (a.created_at || '') < (b.created_at || '') ? -1 : 1));
    let running = 0, seen = false;
    asc.forEach(r => {
      if (r.balance_after != null) { running = r.balance_after; seen = true; }
      else { running += (r.delta || 0); seen = true; }
    });
    return seen ? running : null;
  }, [cashLogs]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div style={{minHeight:'100vh', background:'#f1f5f9', display:'flex', flexDirection:'column'}}>
      <AppHeader title="매입매출 관리" onLogoClick={onBack} user={user} onLogout={onLogout} nav={nav} />

      <div style={{maxWidth:'1400px', margin:'0 auto', padding:'24px', width:'100%'}}>

        {/* 탭 */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="flex border-b border-slate-200">
            {[
              { k: 'entry', l: '거래 입력' },
              { k: 'balance', l: '거래처 원장' },
              { k: 'cashflow', l: '발주 외 매출' },
              { k: 'cash', l: '통장 출납' },
              { k: 'taxinv', l: '세금계산서' },
              { k: 'report', l: '리포트' },
            ].map(t => (
              <button key={t.k} onClick={() => { setTab(t.k); if (t.k === 'balance' || t.k === 'report' || t.k === 'cashflow') reload(true); }}
                className={`px-5 py-3 text-sm font-medium transition-colors ${tab === t.k ? 'border-b-2 border-blue-500 text-blue-600 bg-blue-50' : 'text-slate-600 hover:bg-slate-50'}`}>
                {t.l}
              </button>
            ))}
            <div className="ml-auto flex items-center px-4 text-xs text-slate-400">
              모든 입력은 「거래 입력」 탭에서
            </div>
          </div>

          {loading ? (
            <div className="p-12 text-center text-slate-400 text-sm">로딩 중...</div>
          ) : tab === 'balance' ? (
            <div>
              <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 bg-slate-50">
                <input
                  type="text"
                  placeholder="거래처명 검색"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="flex-1 max-w-sm bg-white border border-slate-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                />
                <div className="flex gap-1 border border-slate-200 rounded-lg p-0.5 bg-white">
                  {['all','병원','일반업체','기타'].map(c => (
                    <button key={c} type="button" onClick={() => setCatFilter(c)}
                      className={`px-2.5 py-1 text-xs rounded ${catFilter===c ? 'bg-slate-900 text-white font-semibold' : 'text-slate-600 hover:bg-slate-50'}`}>{c==='all'?'전체':c}</button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setHideZero(prev => !prev)}
                  className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border transition-colors ${hideZero ? 'bg-blue-100 text-blue-700 border-blue-300' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'}`}
                >
                  <span className="text-sm leading-none">{hideZero ? '☑' : '☐'}</span>
                  잔액 0원 제외
                </button>
                <div className="ml-auto text-xs text-slate-500">
                  {filtered.length}개 표시 / 전체 {balances.length}
                </div>
              </div>
              {/* 합계 바 — 표 위 고정(스크롤 없이 보임) */}
              <div className="px-4 py-2.5 bg-slate-100 border-b border-slate-200 flex flex-wrap items-center gap-x-6 gap-y-1">
                <span className="text-sm font-bold text-slate-700">합 계 (외상·미수)</span>
                <span className="text-sm text-slate-600">줄 돈 <b className="font-mono text-slate-900">{filtered.reduce((s, b) => s + Math.max(0, b.owe || 0), 0).toLocaleString()}</b></span>
                <span className="text-sm text-slate-600">받을 돈 <b className="font-mono text-blue-700">{filtered.reduce((s, b) => s + Math.max(0, b.due || 0), 0).toLocaleString()}</b></span>
                {(() => {
                  const overpaid = filtered.reduce((s, b) => s + Math.max(0, -(b.owe || 0)), 0);
                  const advance  = filtered.reduce((s, b) => s + Math.max(0, -(b.due || 0)), 0);
                  if (overpaid <= 0 && advance <= 0) return null;
                  return (
                    <span className="ml-auto text-[11px] text-slate-500">└ 점검 대상(별도): {overpaid > 0 && <span className="text-rose-600 font-medium">과지급 −{overpaid.toLocaleString()} </span>}{advance > 0 && <span className="text-violet-600 font-medium">선수금 −{advance.toLocaleString()}</span>}</span>
                  );
                })()}
              </div>
              <div className="overflow-auto" style={{maxHeight:'calc(100vh - 400px)'}}>
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
                    <tr>
                      <th className="px-4 py-2.5 text-left">거래처명</th>
                      <th onClick={() => toggleSort('balance')}
                          className={`px-4 py-2.5 text-right w-36 cursor-pointer select-none hover:bg-slate-100 ${sortKey === 'balance' ? 'text-blue-600' : ''}`}>
                        <div>줄 돈 (매입) <span className="ml-1">{sortIcon('balance')}</span></div>
                        <div className="text-[10px] text-slate-400 font-normal normal-case mt-0.5">{today} 기준</div>
                      </th>
                      <th className="px-4 py-2.5 text-right w-36">받을 돈 (매출)</th>
                      <th onClick={() => toggleSort('lastTx')}
                          className={`px-4 py-2.5 text-center w-28 cursor-pointer select-none hover:bg-slate-100 ${sortKey === 'lastTx' ? 'text-blue-600' : ''}`}>
                        최근 거래 <span className="ml-1">{sortIcon('lastTx')}</span>
                      </th>
                      <th className="px-4 py-2.5 text-center w-20"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(b => {
                      const catCls = b.category === '병원' ? 'bg-emerald-100 text-emerald-700' : b.category === '기타' ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600';
                      return (
                      <tr key={b.kind + ':' + b.id} className="border-t border-slate-100 hover:bg-blue-50/40 cursor-pointer"
                          onClick={() => setHistoryModal({ kind: b.kind, id: b.id, name: b.name, code: b.code, category: b.category })}>
                        <td className="px-4 py-2.5 text-slate-800 font-medium">
                          <span className={`mr-2 px-1.5 py-0.5 text-[10px] rounded align-middle ${catCls}`}>{b.category}</span>
                          {b.name}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${(b.owe || 0) > 0 ? 'text-slate-900' : 'text-slate-300'}`}>
                          {b.owe ? b.owe.toLocaleString() : '—'}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${(b.due || 0) > 0 ? 'text-blue-700' : (b.due || 0) < 0 ? 'text-violet-600' : 'text-slate-300'}`}>
                          {b.due ? b.due.toLocaleString() + ((b.due || 0) < 0 ? ' (선수금)' : '') : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-center text-xs text-slate-500">{b.last_tx_date || '—'}</td>
                        <td className="px-4 py-2.5 text-center">
                          <span className="text-xs text-blue-500">상세 →</span>
                        </td>
                      </tr>
                      );
                    })}
                    {sorted.length === 0 && (
                      <tr><td colSpan={5} className="py-12 text-center text-slate-400 text-sm">표시할 거래처가 없습니다</td></tr>
                    )}
                  </tbody>
                  {sorted.length > 0 && (
                    <tfoot className="bg-slate-100 font-semibold">
                      <tr>
                        <td className="px-4 py-3">합 계 (외상·미수)</td>
                        <td className="px-4 py-3 text-right">{filtered.reduce((s, b) => s + Math.max(0, b.owe || 0), 0).toLocaleString()}</td>
                        <td className="px-4 py-3 text-right text-blue-700">{filtered.reduce((s, b) => s + Math.max(0, b.due || 0), 0).toLocaleString()}</td>
                        <td colSpan={2}></td>
                      </tr>
                      {(() => {
                        const overpaid = filtered.reduce((s, b) => s + Math.max(0, -(b.owe || 0)), 0);
                        const advance  = filtered.reduce((s, b) => s + Math.max(0, -(b.due || 0)), 0);
                        if (overpaid <= 0 && advance <= 0) return null;
                        return (
                          <tr className="text-[11px] font-normal text-slate-500 border-t border-slate-200">
                            <td className="px-4 py-1.5">└ 점검 대상 (별도)</td>
                            <td className="px-4 py-1.5 text-right text-rose-600">{overpaid > 0 ? '과지급 −' + overpaid.toLocaleString() : ''}</td>
                            <td className="px-4 py-1.5 text-right text-violet-600">{advance > 0 ? '선수금 −' + advance.toLocaleString() : ''}</td>
                            <td colSpan={2}></td>
                          </tr>
                        );
                      })()}
                    </tfoot>
                  )}
                </table>
              </div>
              <div className="px-4 py-3 border-t border-slate-100 bg-amber-50/40 text-[11px] text-slate-500 leading-relaxed">
                💡 잔액이 <span className="text-rose-600 font-semibold">(−)</span>인 곳은 점검 대상입니다 —
                <b className="text-rose-700"> 줄 돈 (−)</b> = 매입보다 더 보냄 → 거래처에서 <b>세금계산서를 못 받았는지</b> 확인 ·
                <b className="text-violet-700"> 받을 돈 (−)</b>(선수금) = 판 것보다 더 받음 → 우리가 <b>세금계산서를 안 발행했는지</b> 확인
              </div>
            </div>
          ) : tab === 'entry' ? (
            <TransactionEntryTab balances={balances} cashCurrent={cashCurrent} hospitals={hospitals} contracts={contracts} expectedRev={expectedRev} onReload={reload} showToast={showToast} />
          ) : tab === 'cashflow' ? (
            <CashflowTab contracts={contracts} hospitals={hospitals} manufacturers={manufacturers} />
          ) : tab === 'taxinv' ? (
            <TaxInvoiceTab onChanged={reload} />
          ) : tab === 'report' ? (
            <PayableReportTab transactions={transactions} balances={balances} cashLogs={cashLogs} arBalances={arBalances} arTransactions={arTransactions} expectedRev={expectedRev} manufacturers={manufacturers} saleTax={saleTax} cashCurrent={cashCurrent} />
          ) : (
            <CashBalanceTable logs={cashLogs} onReload={reload} showToast={showToast} />
          )}
        </div>

      </div>

      {purchaseModal && (
        <PurchaseAddModal
          balances={balances}
          onClose={() => setPurchaseModal(false)}
          onSaved={() => { setPurchaseModal(false); reload(); showToast('매입(발주) 1건 등록됨'); }}
        />
      )}
      {paymentModal && (
        <PaymentBatchModal
          balances={balances}
          cashCurrent={cashCurrent}
          poByMfr={poByMfr}
          onClose={() => setPaymentModal(false)}
          onSaved={(info) => { setPaymentModal(false); reload(); showToast(`일괄 입금 ${info.count}건 / ${info.total.toLocaleString()}원 처리됨`); }}
        />
      )}
      {historyModal && (historyModal.kind === 'hospital' ? (
        <HospitalLedgerModal
          hospitalId={historyModal.id}
          name={historyModal.name}
          onClose={() => setHistoryModal(null)}
          onChanged={reload}
          showToast={showToast}
        />
      ) : (
        <VendorHistoryModal
          manufacturerId={historyModal.id}
          name={historyModal.name}
          vendorCode={historyModal.code}
          onClose={() => setHistoryModal(null)}
          onChanged={reload}
          showToast={showToast}
        />
      ))}
      {cashAddOpen && (
        <CashAddModal
          currentBalance={cashCurrent}
          onClose={() => setCashAddOpen(false)}
          onSaved={() => { setCashAddOpen(false); reload(); showToast('통장 기록 추가됨'); }}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50">
          <div className={`px-4 py-3 rounded-lg shadow-lg text-sm text-white ${toast.type === 'error' ? 'bg-red-600' : 'bg-slate-800'}`}>
            {toast.msg}
          </div>
        </div>
      )}
    </div>
  );
}

// 통장 메모 prefix → 유형 배지 스타일 (거래입력 8유형과 일치)
const CASH_TAG_STYLE = {
  '병원 입금':       { bg:'bg-emerald-100', text:'text-emerald-700' },
  '광고 매출':       { bg:'bg-teal-100',    text:'text-teal-700' },
  '수수료':          { bg:'bg-cyan-100',    text:'text-cyan-700' },
  '수수료·광고 입금': { bg:'bg-teal-100',   text:'text-teal-700' },
  '잡수입':          { bg:'bg-lime-100',    text:'text-lime-700' },
  '거래처 송금':     { bg:'bg-blue-100',    text:'text-blue-700' },
  '운영비':          { bg:'bg-amber-100',   text:'text-amber-700' },
  '선지급':          { bg:'bg-violet-100',  text:'text-violet-700' },
  '잡지출':          { bg:'bg-rose-100',    text:'text-rose-700' },
};
const parseCashTag = (memo) => {
  const m = (memo || '').match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!m) return { tag: null, body: memo || '' };
  return { tag: m[1].trim(), body: m[2].trim().replace(/^—\s*/, '') };
};
// counterparty/entry_type/memo 컬럼이 있으면 그걸, 없으면 옛 memo 파싱 — 통합 행 표시용
const cashRowDisplay = (l) => {
  if (l.counterparty || l.entry_type) {
    // 새 입력: 분리 저장됨
    return { tag: l.entry_type || '', counterparty: l.counterparty || '', body: l.memo || '' };
  }
  // 옛 입력: memo에 합쳐짐 → 정규식 파싱
  const { tag, body } = parseCashTag(l.memo);
  // "거래처 — 메모" 형태에서 — 기준 분리
  const dashIdx = body.indexOf(' — ');
  if (dashIdx > 0) {
    return { tag: tag || '', counterparty: body.slice(0, dashIdx), body: body.slice(dashIdx + 3) };
  }
  return { tag: tag || '', counterparty: body, body: '' };
};

function CashBalanceTable({ logs, onReload, showToast }) {
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('all'); // all | tag명
  const [viewMode, setViewMode] = useState('time'); // time | group
  const [collapsed, setCollapsed] = useState({}); // 그룹별 접힘 상태
  // 시간순 누적 잔액 계산 (balance_after 명시 행은 그 값으로 리셋) — 전체 logs 기준
  const runningById = useMemo(() => {
    const asc = [...logs].sort((a, b) =>
      (a.log_date < b.log_date ? -1 : a.log_date > b.log_date ? 1 : (a.created_at || '') < (b.created_at || '') ? -1 : 1));
    let running = 0;
    const map = new Map();
    asc.forEach(r => {
      if (r.balance_after != null) running = r.balance_after;
      else running += (r.delta || 0);
      map.set(r.id, running);
    });
    return map;
  }, [logs]);

  // 사용 가능한 유형 목록 (실제 데이터에 있는 것만)
  const availableTags = useMemo(() => {
    const set = new Set();
    logs.forEach(l => { const { tag } = parseCashTag(l.memo); if (tag) set.add(tag); });
    return Array.from(set).sort();
  }, [logs]);

  // 메모 검색 + 유형 필터 (잔액은 전체 누적 기준으로 유지, 표시만 필터)
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter(l => {
      if (q && !((l.memo || '').toLowerCase().includes(q) || (l.counterparty || '').toLowerCase().includes(q))) return false;
      if (tagFilter !== 'all') {
        const { tag } = parseCashTag(l.memo);
        if (tag !== tagFilter) return false;
      }
      return true;
    });
  }, [logs, search, tagFilter]);

  // 유형별 그룹화 (group mode 용)
  const grouped = useMemo(() => {
    const g = new Map();
    filtered.forEach(l => {
      const { tag } = parseCashTag(l.memo);
      const key = tag || '(미분류)';
      if (!g.has(key)) g.set(key, { tag: key, rows: [], inSum: 0, outSum: 0 });
      const grp = g.get(key);
      grp.rows.push(l);
      if (l.delta > 0) grp.inSum += l.delta;
      else grp.outSum += -l.delta;
    });
    // 정렬: 입금성(+) 먼저 → 출금성(−), 그 안에서 합계 큰 순
    const ORDER = ['병원 입금','수수료·광고 입금','잡수입','거래처 송금','운영비','선지급','잡지출','(미분류)'];
    return Array.from(g.values()).sort((a,b) => {
      const oa = ORDER.indexOf(a.tag); const ob = ORDER.indexOf(b.tag);
      if (oa !== ob) return (oa === -1 ? 99 : oa) - (ob === -1 ? 99 : ob);
      return (b.inSum + b.outSum) - (a.inSum + a.outSum);
    });
  }, [filtered]);

  const handleDelete = async (row) => {
    if (row.payment_batch_id) {
      alert('이 기록은 일괄지급에 연결되어 있습니다. 외상 거래원장 탭에서 해당 지급을 삭제하세요.');
      return;
    }
    if (!confirm('이 통장 기록을 삭제하시겠습니까? (연결된 거래처 송금·병원 수금 내역도 함께 삭제됩니다)')) return;
    try {
      // cash_log_id로 연결된 송금(payable)·수금(receivable) 둘 다 삭제 — 거래처 원장과 어긋남 방지
      await sb.from('payable_transactions').delete().eq('cash_log_id', row.id);
      await sb.from('receivable_transactions').delete().eq('cash_log_id', row.id);
      await dbDeleteCashBalance(row.id);
      showToast('통장 기록 삭제됨');
      onReload();
    } catch (e) {
      showToast('삭제 실패: ' + (e.message || e), 'error');
    }
  };
  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-2 bg-slate-50 border-b border-slate-100 text-xs text-slate-500 flex-wrap">
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="메모 검색 (예: 운영비, 거래처명, 임대 등)"
          className="flex-1 max-w-sm bg-white border border-slate-200 rounded px-3 py-1.5 text-xs focus:outline-none focus:border-blue-400" />
        <select value={tagFilter} onChange={e => setTagFilter(e.target.value)}
          className="bg-white border border-slate-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-400">
          <option value="all">유형 전체</option>
          {availableTags.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="flex items-center gap-0.5 border border-slate-200 rounded p-0.5 bg-white">
          <button onClick={() => setViewMode('time')}
            className={`px-2.5 py-1 text-xs rounded transition-colors ${viewMode === 'time' ? 'bg-slate-800 text-white font-semibold' : 'text-slate-500 hover:bg-slate-50'}`}
            title="시간순">시간순</button>
          <button onClick={() => setViewMode('group')}
            className={`px-2.5 py-1 text-xs rounded transition-colors ${viewMode === 'group' ? 'bg-slate-800 text-white font-semibold' : 'text-slate-500 hover:bg-slate-50'}`}
            title="유형별 그룹">유형별</button>
        </div>
        <span>{(search || tagFilter !== 'all') ? `${filtered.length}건 / 전체 ${logs.length}` : `전체 ${logs.length}건`}</span>
      </div>
      <div className="overflow-auto" style={{maxHeight:'calc(100vh - 280px)'}}>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
          <tr>
            <th className="px-4 py-2.5 text-left w-28">날짜</th>
            <th className="px-4 py-2.5 text-left w-24">유형</th>
            <th className="px-4 py-2.5 text-right w-32">출금</th>
            <th className="px-4 py-2.5 text-right w-32">입금</th>
            <th className="px-4 py-2.5 text-right w-32">잔액</th>
            <th className="px-4 py-2.5 text-left w-44">거래처</th>
            <th className="px-4 py-2.5 text-left">메모</th>
            <th className="px-4 py-2.5 text-center w-16"></th>
          </tr>
        </thead>
        <tbody>
          {viewMode === 'time' ? (
            <>
              {filtered.map(l => {
                const { tag, counterparty, body } = cashRowDisplay(l);
                const style = tag ? (CASH_TAG_STYLE[tag] || { bg:'bg-slate-100', text:'text-slate-600' }) : null;
                return (
                  <tr key={l.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-2 text-slate-700 text-xs whitespace-nowrap">{l.log_date}</td>
                    <td className="px-4 py-2">
                      {tag ? (
                        <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${style.bg} ${style.text}`}>{tag}</span>
                      ) : <span className="text-[11px] text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-red-600">
                      {l.delta < 0 ? Math.abs(l.delta).toLocaleString() : ''}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-emerald-600">
                      {l.delta > 0 ? l.delta.toLocaleString() : ''}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-800">
                      {runningById.has(l.id) ? runningById.get(l.id).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2 text-slate-800 text-xs">{counterparty || <span className="text-slate-300">—</span>}</td>
                    <td className="px-4 py-2 text-slate-600 text-xs">
                      {body || <span className="text-slate-300">—</span>}
                      {l.payment_batch_id && <span className="ml-2 text-[10px] text-slate-400">[일괄지급]</span>}
                    </td>
                    <td className="px-4 py-2 text-center">
                      <button onClick={() => handleDelete(l)} className="text-xs text-red-500 hover:text-red-700">삭제</button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="py-12 text-center text-slate-400 text-sm">{(search || tagFilter !== 'all') ? '검색 결과 없음' : '통장 기록이 없습니다'}</td></tr>
              )}
            </>
          ) : (
            <>
              {grouped.map(g => {
                const style = CASH_TAG_STYLE[g.tag] || { bg:'bg-slate-100', text:'text-slate-600' };
                const isCollapsed = !!collapsed[g.tag];
                const net = g.inSum - g.outSum;
                return (
                  <React.Fragment key={g.tag}>
                    <tr className="bg-slate-50 border-t-2 border-slate-300 cursor-pointer hover:bg-slate-100"
                      onClick={() => setCollapsed(p => ({...p, [g.tag]: !p[g.tag]}))}>
                      <td colSpan={8} className="px-4 py-2">
                        <div className="flex items-center gap-3">
                          <span className="text-slate-500 text-xs w-3 select-none">{isCollapsed ? '▶' : '▼'}</span>
                          <span className={`inline-block px-2.5 py-0.5 rounded text-xs font-semibold ${style.bg} ${style.text}`}>{g.tag}</span>
                          <span className="text-xs text-slate-500">{g.rows.length}건</span>
                          <span className="ml-auto font-mono text-sm flex items-center gap-3">
                            {g.inSum > 0 && <span className="text-emerald-700">+{g.inSum.toLocaleString()}</span>}
                            {g.outSum > 0 && <span className="text-red-700">−{g.outSum.toLocaleString()}</span>}
                            <span className={`font-semibold ${net>=0?'text-emerald-700':'text-red-700'}`}>
                              {net>=0?'순 +':'순 −'}{Math.abs(net).toLocaleString()}
                            </span>
                          </span>
                        </div>
                      </td>
                    </tr>
                    {!isCollapsed && g.rows.map(l => {
                      const { counterparty, body } = cashRowDisplay(l);
                      return (
                        <tr key={l.id} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-2 text-slate-700 text-xs whitespace-nowrap">{l.log_date}</td>
                          <td className="px-4 py-2"><span className="text-[10px] text-slate-300">└</span></td>
                          <td className="px-4 py-2 text-right font-mono text-red-600">
                            {l.delta < 0 ? Math.abs(l.delta).toLocaleString() : ''}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-emerald-600">
                            {l.delta > 0 ? l.delta.toLocaleString() : ''}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-slate-400 text-xs">
                            {runningById.has(l.id) ? runningById.get(l.id).toLocaleString() : '—'}
                          </td>
                          <td className="px-4 py-2 text-slate-800 text-xs">{counterparty || <span className="text-slate-300">—</span>}</td>
                          <td className="px-4 py-2 text-slate-600 text-xs">
                            {body || <span className="text-slate-300">—</span>}
                            {l.payment_batch_id && <span className="ml-2 text-[10px] text-slate-400">[일괄지급]</span>}
                          </td>
                          <td className="px-4 py-2 text-center">
                            <button onClick={() => handleDelete(l)} className="text-xs text-red-500 hover:text-red-700">삭제</button>
                          </td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
              {grouped.length === 0 && (
                <tr><td colSpan={8} className="py-12 text-center text-slate-400 text-sm">{(search || tagFilter !== 'all') ? '검색 결과 없음' : '통장 기록이 없습니다'}</td></tr>
              )}
            </>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function TypeBadge({ type }) {
  const map = {
    opening:      { l: '이월',     c: 'bg-slate-100 text-slate-600' },
    purchase:     { l: '매입',     c: 'bg-amber-100 text-amber-700' },
    tax_purchase: { l: '매입계산서', c: 'bg-amber-100 text-amber-700' },
    adjustment:   { l: '조정',     c: 'bg-blue-100 text-blue-700' },
    cancel:       { l: '취소',     c: 'bg-rose-100 text-rose-700' },
    payment:      { l: '지급',     c: 'bg-emerald-100 text-emerald-700' },
  };
  const s = map[type] || { l: type, c: 'bg-slate-100' };
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${s.c}`}>{s.l}</span>;
}
function typeLabel(t) {
  return ({ opening: '이월', purchase: '매입', adjustment: '조정', cancel: '취소', payment: '지급', tax_purchase: '매입계산서' })[t] || t;
}

function PurchaseAddModal({ balances, onClose, onSaved }) {
  const [vendorId, setVendorId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);
  const [vendorSearch, setVendorSearch] = useState('');

  const filtered = useMemo(() => {
    const q = vendorSearch.trim().toLowerCase();
    if (!q) return balances;
    return balances.filter(b =>
      vendorMatch(b.manufacturer_name, q) ||
      (b.vendor_code || '').toLowerCase().includes(q));
  }, [balances, vendorSearch]);

  const submit = async () => {
    if (!vendorId) return alert('거래처를 선택하세요');
    const amt = Number((amount || '').toString().replace(/[,\s]/g, ''));
    if (!amt || amt <= 0) return alert('금액을 입력하세요');
    setSaving(true);
    try {
      await dbInsertPayableTransaction({
        manufacturer_id: vendorId,
        tx_date: date,
        tx_type: 'purchase',
        amount: amt,
        memo: memo || null,
      });
      onSaved();
    } catch (e) {
      alert('저장 실패: ' + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="발주(매입) 추가" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">거래처</label>
          <input type="text" placeholder="거래처 검색..." value={vendorSearch}
            onChange={e => setVendorSearch(e.target.value)}
            className="w-full mb-2 bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
          <select value={vendorId} onChange={e => setVendorId(e.target.value)} size={6}
            className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400">
            <option value="">— 거래처 선택 —</option>
            {filtered.map(b => (
              <option key={b.manufacturer_id} value={b.manufacturer_id}>
                {b.manufacturer_name} (잔액 {(b.balance || 0).toLocaleString()})
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-500 mb-1 block">날짜</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1 block">금액 (원)</label>
            <input type="text" value={amount} onChange={e => setAmount(e.target.value)} placeholder="예: 1500000"
              className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-400" />
          </div>
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">메모 (선택)</label>
          <input type="text" value={memo} onChange={e => setMemo(e.target.value)} placeholder="예: 5월 정기 매입"
            className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded">취소</button>
          <button onClick={submit} disabled={saving}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50">
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

const PAY_PURPOSE = { existing: '기존 외상금', advance: '선수금', other: '기타' };

function PaymentBatchModal({ balances, cashCurrent, poByMfr = {}, onClose, onSaved }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [items, setItems] = useState({}); // { manufacturerId: { amount, purpose, memo } }
  const [vendorSearch, setVendorSearch] = useState('');
  const [hideZero, setHideZero] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState({}); // { mid: bool }
  const toggleExpand = (mid) => setExpanded(p => ({ ...p, [mid]: !p[mid] }));

  const filtered = useMemo(() => {
    const q = vendorSearch.trim().toLowerCase();
    return balances.filter(b => {
      if (hideZero && (!b.balance || b.balance <= 0)) return false;
      if (!q) return true;
      return vendorMatch(b.manufacturer_name, q) ||
             (b.vendor_code || '').toLowerCase().includes(q);
    });
  }, [balances, vendorSearch, hideZero]);

  const parseAmt = (v) => Number(((v ?? '').toString()).replace(/[,\s]/g, '')) || 0;

  const totalAmt = useMemo(() => {
    return Object.values(items).reduce((s, it) => s + parseAmt(it?.amount), 0);
  }, [items]);
  const selectedCount = useMemo(() => {
    return Object.values(items).filter(it => parseAmt(it?.amount) > 0).length;
  }, [items]);

  const balanceAfter = cashCurrent != null ? cashCurrent - totalAmt : null;

  const updateItem = (mid, patch) => setItems(p => ({
    ...p,
    [mid]: { amount: '', purpose: 'existing', memo: '', ...(p[mid] || {}), ...patch },
  }));
  const fillFullBalance = (b) => updateItem(b.manufacturer_id, { amount: String(b.balance || 0) });

  const submit = async () => {
    if (selectedCount === 0) return alert('지급할 거래처를 1개 이상 입력하세요');
    if (!confirm(`${selectedCount}개 거래처에 총 ${totalAmt.toLocaleString()}원을 ${date}일자로 지급 처리합니다. 진행하시겠습니까?`)) return;
    setSaving(true);
    try {
      const itemList = Object.entries(items)
        .map(([mid, it]) => {
          const amt = parseAmt(it?.amount);
          if (amt <= 0) return null;
          const purposeKey = it?.purpose || 'existing';
          const purposeLabel = PAY_PURPOSE[purposeKey] || PAY_PURPOSE.existing;
          const userMemo = (it?.memo || '').trim();
          const memo = userMemo ? `[${purposeLabel}] ${userMemo}` : `[${purposeLabel}]`;
          return { manufacturerId: mid, amount: amt, memo };
        })
        .filter(Boolean);
      const result = await dbInsertPaymentBatch({
        txDate: date,
        items: itemList,
        batchMemo: null,
        cashBalanceAfter: balanceAfter,
      });
      onSaved(result);
    } catch (e) {
      alert('저장 실패: ' + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="일괄 입금 (지급 처리)" onClose={onClose} wide>
      <div className="space-y-3">
        {/* 상단 — 날짜 + 통장잔액 실시간 패널 */}
        <div className="grid grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-slate-500 mb-1 block">지급일</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
          </div>
          <div className="bg-slate-50 rounded p-2.5 border border-slate-200">
            <div className="text-[10px] text-slate-500 mb-0.5">현재 통장잔액</div>
            <div className="text-base font-mono font-semibold text-slate-700">
              {cashCurrent != null ? cashCurrent.toLocaleString() : '—'}
            </div>
          </div>
          <div className="bg-blue-50 rounded p-2.5 border border-blue-200">
            <div className="text-[10px] text-blue-600 mb-0.5">지급 합계</div>
            <div className="text-base font-mono font-semibold text-blue-700">
              -{totalAmt.toLocaleString()}
            </div>
          </div>
          <div className={`rounded p-2.5 border ${balanceAfter != null && balanceAfter < 0 ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
            <div className={`text-[10px] mb-0.5 ${balanceAfter != null && balanceAfter < 0 ? 'text-red-600' : 'text-emerald-700'}`}>지급 후 잔액</div>
            <div className={`text-base font-mono font-semibold ${balanceAfter != null && balanceAfter < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
              {balanceAfter != null ? balanceAfter.toLocaleString() : '—'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <input type="text" placeholder="거래처 검색..." value={vendorSearch} onChange={e => setVendorSearch(e.target.value)}
            className="flex-1 bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
          <button type="button" onClick={() => setHideZero(p => !p)}
            className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded border transition-colors ${hideZero ? 'bg-blue-100 text-blue-700 border-blue-300' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'}`}>
            <span className="text-sm leading-none">{hideZero ? '☑' : '☐'}</span>
            잔액 0원 제외
          </button>
        </div>

        <div className="border border-slate-200 rounded-lg max-h-[55vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
              <tr>
                <th className="px-3 py-2 text-left w-8"></th>
                <th className="px-3 py-2 text-left">거래처명</th>
                <th className="px-3 py-2 text-right w-28">현재잔액</th>
                <th className="px-3 py-2 text-right w-44">지급금액</th>
                <th className="px-3 py-2 text-left w-32">목적</th>
                <th className="px-3 py-2 text-left w-48">메모</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(b => {
                const item = items[b.manufacturer_id] || {};
                const amt = parseAmt(item.amount);
                const remain = (b.balance || 0) - amt;
                const pos = poByMfr[b.manufacturer_id] || [];
                const isOpen = !!expanded[b.manufacturer_id];
                const poTotal = pos.reduce((s, p) => s + (p.amount || 0), 0);
                return (
                  <React.Fragment key={b.manufacturer_id}>
                    <tr className={`border-t border-slate-100 ${amt > 0 ? 'bg-blue-50/40' : ''}`}>
                      <td className="px-3 py-1.5 text-center">
                        {pos.length > 0 ? (
                          <button type="button" onClick={() => toggleExpand(b.manufacturer_id)}
                            className="text-blue-500 hover:text-blue-700 text-xs font-mono" title="미정산 발주 보기">
                            {isOpen ? '▼' : '▶'}
                          </button>
                        ) : <span className="text-slate-300 text-xs">·</span>}
                      </td>
                      <td className="px-3 py-1.5 text-slate-800">
                        {b.manufacturer_name}
                        {pos.length > 0 && (
                          <span className="ml-2 inline-block px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-[10px] font-medium">
                            발주 {pos.length}건
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right text-slate-600 font-mono text-xs">{(b.balance || 0).toLocaleString()}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-1">
                          <input type="text" value={item.amount || ''} onChange={e => updateItem(b.manufacturer_id, { amount: e.target.value })}
                            placeholder="0"
                            className={`flex-1 min-w-0 bg-white border rounded px-2 py-1 text-sm font-mono text-right focus:outline-none focus:border-blue-400 ${remain < 0 ? 'border-red-300' : 'border-slate-200'}`} />
                          <button type="button" onClick={() => fillFullBalance(b)}
                            className="text-[11px] text-blue-500 hover:text-blue-700 px-1 shrink-0">전액</button>
                        </div>
                      </td>
                      <td className="px-3 py-1.5">
                        <select value={item.purpose || 'existing'} onChange={e => updateItem(b.manufacturer_id, { purpose: e.target.value })}
                          className="w-full bg-white border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-400">
                          <option value="existing">기존 외상금</option>
                          <option value="advance">선수금</option>
                          <option value="other">기타</option>
                        </select>
                      </td>
                      <td className="px-3 py-1.5">
                        <input type="text" value={item.memo || ''} onChange={e => updateItem(b.manufacturer_id, { memo: e.target.value })}
                          placeholder="(선택)"
                          className="w-full bg-white border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-400" />
                      </td>
                    </tr>
                    {isOpen && pos.length > 0 && (
                      <tr className="bg-amber-50/40 border-t border-amber-100">
                        <td></td>
                        <td colSpan={5} className="px-3 py-2">
                          <div className="text-[11px] text-amber-700 mb-1.5 font-medium">
                            미정산 발주 ({pos.length}건, 합계 {poTotal.toLocaleString()}원) — 지급액 결정 참고
                          </div>
                          <div className="space-y-1">
                            {pos.map(p => (
                              <div key={p.id} className="flex items-center gap-3 text-xs bg-white rounded px-2 py-1.5 border border-amber-100">
                                <span className="text-slate-500 font-mono shrink-0 w-20">{p.tx_date}</span>
                                <span className="font-mono font-semibold text-slate-700 shrink-0 w-28 text-right">{(p.amount || 0).toLocaleString()}원</span>
                                <span className="text-slate-600 truncate flex-1">{p.memo || '—'}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="py-8 text-center text-slate-400 text-xs">표시할 거래처가 없습니다</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between pt-2 px-1">
          <div className="text-sm text-slate-600">
            선택 <span className="font-semibold text-slate-900">{selectedCount}</span>개 ·
            지급 합계 <span className="font-semibold text-blue-700 font-mono">{totalAmt.toLocaleString()}원</span>
            {balanceAfter != null && (
              <span className="ml-3 text-xs text-slate-500">지급 후 잔액 <span className={`font-mono ${balanceAfter < 0 ? 'text-red-600 font-semibold' : 'text-emerald-700'}`}>{balanceAfter.toLocaleString()}</span></span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded">취소</button>
            <button onClick={submit} disabled={saving || selectedCount === 0}
              className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50">
              {saving ? '처리 중...' : '일괄 지급 실행'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

function VendorHistoryModal({ manufacturerId, name, vendorCode, onClose, onChanged, showToast }) {
  const [rows, setRows] = useState([]);
  const [saleRows, setSaleRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState('asc'); // 원장 기본 = 시간순(오래된→최신)
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pt, ti, rt, sti] = await Promise.all([
        dbLoadPayableTransactions({ manufacturerId }),
        sb.from('tax_invoices').select('id, issue_date, amount, party_name, created_at')
          .eq('kind', 'purchase').eq('manufacturer_id', manufacturerId)
          .order('issue_date', { ascending: false })
          .then(r => r.data || []),
        sb.from('receivable_transactions').select('*').eq('manufacturer_id', manufacturerId).then(r => r.data || []),
        sb.from('tax_invoices').select('id, issue_date, amount, party_name, created_at')
          .eq('kind', 'sale').eq('manufacturer_id', manufacturerId).then(r => r.data || []),
      ]);
      // tax_invoices 행을 payable과 같은 형태로 통합 (tx_type='tax_purchase')
      const taxRows = ti.map(t => ({
        id: 'ti-' + t.id,
        _isTax: true,
        manufacturer_id: manufacturerId,
        tx_date: t.issue_date,
        tx_type: 'tax_purchase',
        amount: Number(t.amount) || 0,
        memo: t.party_name || '세금계산서',
        created_at: t.created_at,
      }));
      setRows([...pt, ...taxRows]);
      // 매출 세금계산서 6/1 이후만 집계(목록 recvByMfr와 동일 기준 — 5/29 이전은 이월 포함)
      const saleTaxRows = sti.filter(t => (t.issue_date || '') > '2026-05-29').map(t => ({ id: 'sti-' + t.id, tx_date: t.issue_date, tx_type: 'tax_sale', amount: Number(t.amount) || 0, memo: t.party_name || '매출 세금계산서', created_at: t.created_at }));
      setSaleRows([...rt, ...saleTaxRows]);
    } finally {
      setLoading(false);
    }
  }, [manufacturerId]);

  useEffect(() => { load(); }, [load]);

  // 원장: 시간순 정렬 + 증가/감소/잔액 누적
  const ledgerAsc = useMemo(() => {
    const asc = [...rows].sort((a, b) =>
      (a.tx_date < b.tx_date ? -1 : a.tx_date > b.tx_date ? 1 : (a.created_at || '') < (b.created_at || '') ? -1 : 1));
    let running = 0;
    return asc.map(r => {
      const signed = r.tx_type === 'payment' ? -r.amount : r.amount; // 잔액 영향(외상매입 기준)
      running += signed;
      return { ...r, inc: signed > 0 ? signed : 0, dec: signed < 0 ? -signed : 0, running };
    });
  }, [rows]);

  // 기간 필터
  const filtered = useMemo(() => ledgerAsc.filter(r => {
    if (from && r.tx_date < from) return false;
    if (to && r.tx_date > to) return false;
    return true;
  }), [ledgerAsc, from, to]);

  const display = order === 'asc' ? filtered : [...filtered].reverse();

  const summary = useMemo(() => {
    let totalIn = 0, totalPay = 0;
    rows.forEach(r => { if (r.tx_type === 'payment') totalPay += r.amount; else totalIn += r.amount; });
    return { totalIn, totalPay, balance: totalIn - totalPay, count: rows.length };
  }, [rows]);
  const saleSummary = useMemo(() => {
    let inv = 0, col = 0;
    saleRows.forEach(r => { const a = Number(r.amount) || 0; if (r.tx_type === 'collect' || r.tx_type === 'cancel') col += a; else inv += a; });
    return { inv, col, balance: inv - col, count: saleRows.length };
  }, [saleRows]);

  const handleDelete = async (tx) => {
    if (!confirm(`이 거래를 삭제하시겠습니까?\n${tx.tx_date} / ${typeLabel(tx.tx_type)} / ${tx.amount.toLocaleString()}원`)) return;
    try {
      if (tx._isTax) {
        // tax_invoices 행 삭제 — id에 'ti-' prefix 있음
        const realId = String(tx.id).replace(/^ti-/, '');
        const { error } = await sb.from('tax_invoices').delete().eq('id', realId);
        if (error) throw error;
      } else {
        await dbDeletePayableTransaction(tx.id);
      }
      showToast && showToast('거래 삭제됨');
      load();
      onChanged && onChanged();
    } catch (e) {
      alert('삭제 실패: ' + (e.message || e));
    }
  };

  const handlePrint = () => {
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { alert('팝업이 차단되었습니다.'); return; }
    const today = new Date().toISOString().slice(0, 10);
    const periodLabel = (from || to) ? `${from || '~'} ~ ${to || '~'}` : '전체 기간';
    const bodyRows = filtered.map(r => `
      <tr>
        <td class="c">${r.tx_date}</td>
        <td class="c">${typeLabel(r.tx_type)}</td>
        <td>${(r.memo || '').replace(/</g, '&lt;')}</td>
        <td class="r">${r.inc ? r.inc.toLocaleString() : ''}</td>
        <td class="r">${r.dec ? r.dec.toLocaleString() : ''}</td>
        <td class="r">${r.running.toLocaleString()}</td>
      </tr>`).join('');
    win.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>거래처 원장 - ${name}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Noto Sans KR',sans-serif;font-size:12px;color:#000;padding:30px 36px}
        h1{font-size:22px;font-weight:700;margin-bottom:4px}
        .meta{color:#555;font-size:11px;margin-bottom:16px}
        .sum{display:flex;gap:24px;margin-bottom:14px;padding:12px 16px;background:#f5f5f5;border-radius:8px}
        .sum div span{display:block}
        .sum .lbl{font-size:10px;color:#777}
        .sum .val{font-size:15px;font-weight:700;font-family:monospace}
        table{width:100%;border-collapse:collapse}
        th,td{border:1px solid #ccc;padding:6px 8px;font-size:11px}
        th{background:#e8e8e8;font-weight:700}
        td.c{text-align:center}td.r{text-align:right;font-family:monospace}
        tfoot td{font-weight:700;background:#f5f5f5}
        @media print{body{padding:0}}
      </style></head><body>
      <h1>거래처 원장</h1>
      <div class="meta">거래처: <strong>${name}</strong>${vendorCode ? ` (코드 ${vendorCode})` : ''} · 기간: ${periodLabel} · 출력일: ${today}</div>
      <div class="sum">
        <div><span class="lbl">총 매입(증가)</span><span class="val">${summary.totalIn.toLocaleString()}</span></div>
        <div><span class="lbl">총 지급(감소)</span><span class="val">${summary.totalPay.toLocaleString()}</span></div>
        <div><span class="lbl">현재 잔액</span><span class="val">${summary.balance.toLocaleString()}</span></div>
      </div>
      <table>
        <thead><tr><th style="width:90px">날짜</th><th style="width:60px">유형</th><th>적요</th><th style="width:110px">증가</th><th style="width:110px">감소</th><th style="width:120px">잔액</th></tr></thead>
        <tbody>${bodyRows || '<tr><td colspan="6" class="c">내역 없음</td></tr>'}</tbody>
        <tfoot><tr><td colspan="3" class="c">합계</td><td class="r">${summary.totalIn.toLocaleString()}</td><td class="r">${summary.totalPay.toLocaleString()}</td><td class="r">${summary.balance.toLocaleString()}</td></tr></tfoot>
      </table>
      <script>window.onload=function(){window.print()}<\/script>
      </body></html>`);
    win.document.close();
  };

  return (
    <ModalShell title={`거래처 원장 — ${name}`} subtitle={vendorCode ? `코드 ${vendorCode}` : ''} onClose={onClose} wide>
      {/* 요약 카드 */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="bg-amber-50 border border-amber-200 rounded p-3">
          <div className="text-[10px] text-amber-700 mb-0.5">총 매입 (증가)</div>
          <div className="text-base font-bold font-mono text-amber-800">{summary.totalIn.toLocaleString()}</div>
        </div>
        <div className="bg-emerald-50 border border-emerald-200 rounded p-3">
          <div className="text-[10px] text-emerald-700 mb-0.5">총 지급 (감소)</div>
          <div className="text-base font-bold font-mono text-emerald-800">{summary.totalPay.toLocaleString()}</div>
        </div>
        <div className="bg-slate-100 border border-slate-300 rounded p-3">
          <div className="text-[10px] text-slate-500 mb-0.5">현재 외상잔액</div>
          <div className={`text-base font-bold font-mono ${summary.balance < 0 ? 'text-red-600' : 'text-slate-900'}`}>{summary.balance.toLocaleString()}</div>
        </div>
      </div>

      {saleSummary.count > 0 && (
        <div className="mb-3 border border-blue-200 rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-blue-50 text-xs font-semibold text-blue-800 flex items-center gap-3 flex-wrap">
            <span>매출 (이 거래처에 판매)</span>
            <span className="ml-auto font-mono">매출 {saleSummary.inv.toLocaleString()} · 수금 {saleSummary.col.toLocaleString()} · 미수 {saleSummary.balance.toLocaleString()}</span>
          </div>
          <table className="w-full text-xs">
            <tbody>
              {[...saleRows].sort((a, b) => (a.tx_date < b.tx_date ? 1 : -1)).map(r => (
                <tr key={r.id} className="border-t border-blue-50">
                  <td className="px-3 py-1.5 text-slate-600 whitespace-nowrap">{r.tx_date}</td>
                  <td className="px-3 py-1.5 text-center text-slate-500">{r.tx_type === 'collect' ? '수금' : r.tx_type === 'tax_sale' ? '매출계산서' : r.tx_type === 'cancel' ? '취소' : '매출'}</td>
                  <td className="px-3 py-1.5 text-slate-600 break-words">{r.memo || '—'}</td>
                  <td className="px-3 py-1.5 text-right tnum">{(Number(r.amount) || 0).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 필터 + 정렬 + 인쇄 */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="bg-white border border-slate-200 rounded px-2 py-1 text-xs" title="시작일" />
        <span className="text-xs text-slate-400">~</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} className="bg-white border border-slate-200 rounded px-2 py-1 text-xs" title="종료일" />
        {(from || to) && <button onClick={() => { setFrom(''); setTo(''); }} className="text-xs text-slate-500 hover:text-slate-700">초기화</button>}
        <button onClick={() => setOrder(o => o === 'asc' ? 'desc' : 'asc')} className="text-xs text-slate-600 border border-slate-200 rounded px-2 py-1 hover:bg-slate-50">
          {order === 'asc' ? '오래된순 ↓' : '최신순 ↑'}
        </button>
        <button onClick={handlePrint} className="ml-auto px-3 py-1 text-xs bg-slate-700 text-white rounded hover:bg-slate-600">🖨 원장 인쇄</button>
      </div>

      <div className="border border-slate-200 rounded-lg max-h-[55vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left w-28">날짜</th>
              <th className="px-3 py-2 text-left w-24">유형</th>
              <th className="px-3 py-2 text-left">적요</th>
              <th className="px-3 py-2 text-right w-28">증가</th>
              <th className="px-3 py-2 text-right w-28">감소</th>
              <th className="px-3 py-2 text-right w-32">잔액</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="py-8 text-center text-slate-400 text-sm">로딩 중...</td></tr>
            ) : display.length === 0 ? (
              <tr><td colSpan={7} className="py-8 text-center text-slate-400 text-sm">거래 내역이 없습니다</td></tr>
            ) : display.map(r => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-1.5 text-xs text-slate-700">{r.tx_date}</td>
                <td className="px-3 py-1.5"><TypeBadge type={r.tx_type} /></td>
                <td className="px-3 py-1.5 text-slate-600 text-xs">{r.memo || '—'}</td>
                <td className="px-3 py-1.5 text-right font-mono text-amber-700 text-xs">{r.inc ? r.inc.toLocaleString() : ''}</td>
                <td className="px-3 py-1.5 text-right font-mono text-emerald-600 text-xs">{r.dec ? r.dec.toLocaleString() : ''}</td>
                <td className="px-3 py-1.5 text-right font-mono text-slate-700 text-xs font-semibold">{r.running.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ModalShell>
  );
}

/* ========== 병원 원장 (AR) — 매출/수금/미수금 ========== */
function HospitalLedgerModal({ hospitalId, hospitalName, contracts = [], onClose, onChanged, showToast }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await dbLoadReceivableTransactions({ hospitalId });
      setRows(data);
    } finally { setLoading(false); }
  }, [hospitalId]);

  useEffect(() => { load(); }, [load]);

  const hospContracts = useMemo(() =>
    contracts.filter(c => c.hospital_id === hospitalId && (c.status == null || c.status !== '취소')),
    [contracts, hospitalId]);
  const contractMap = useMemo(() => {
    const m = new Map();
    hospContracts.forEach(c => m.set(c.id, c));
    return m;
  }, [hospContracts]);

  const summary = useMemo(() => {
    const totalInvoice = hospContracts.reduce((s, c) => s + (c.amount || 0), 0);
    let totalCollect = 0, totalAdjust = 0, totalCancel = 0;
    rows.forEach(r => {
      if (r.tx_type === 'collect') totalCollect += r.amount;
      else if (r.tx_type === 'adjustment') totalAdjust += r.amount;
      else if (r.tx_type === 'cancel') totalCancel += r.amount;
    });
    const balance = totalInvoice + totalAdjust - totalCollect - totalCancel;
    return { totalInvoice, totalCollect, totalAdjust, totalCancel, balance };
  }, [rows, hospContracts]);

  const handleDelete = async (tx) => {
    if (!confirm(`이 거래를 삭제하시겠습니까?\n${tx.tx_date} / ${tx.amount.toLocaleString()}원`)) return;
    try {
      await dbDeleteReceivableTransaction(tx.id);
      if (tx.cash_log_id) { try { await dbDeleteCashBalance(tx.cash_log_id); } catch(_){} }
      showToast && showToast('거래 삭제됨');
      load();
      onChanged && onChanged();
    } catch (e) { alert('삭제 실패: ' + (e.message || e)); }
  };

  const arLabel = (t) => ({ collect:'병원 입금', adjustment:'조정', cancel:'취소' }[t] || t);
  const arColor = (t) => ({
    collect:'bg-emerald-100 text-emerald-700',
    adjustment:'bg-amber-100 text-amber-700',
    cancel:'bg-rose-100 text-rose-700',
  }[t] || 'bg-slate-100 text-slate-600');

  return (
    <ModalShell title={`병원 원장 — ${hospitalName}`} subtitle={`계약 ${hospContracts.length}건`} onClose={onClose} wide>
      <div className="grid grid-cols-4 gap-3 mb-3">
        <div className="bg-blue-50 border border-blue-200 rounded p-3">
          <div className="text-[10px] text-blue-700 mb-0.5">총 청구 (계약합계)</div>
          <div className="text-base font-bold font-mono text-blue-800">{summary.totalInvoice.toLocaleString()}</div>
        </div>
        <div className="bg-emerald-50 border border-emerald-200 rounded p-3">
          <div className="text-[10px] text-emerald-700 mb-0.5">총 수금</div>
          <div className="text-base font-bold font-mono text-emerald-800">{summary.totalCollect.toLocaleString()}</div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded p-3">
          <div className="text-[10px] text-amber-700 mb-0.5">조정 − 취소</div>
          <div className="text-base font-bold font-mono text-amber-800">{(summary.totalAdjust - summary.totalCancel).toLocaleString()}</div>
        </div>
        <div className={`border rounded p-3 ${summary.balance > 0 ? 'bg-rose-50 border-rose-200' : 'bg-slate-100 border-slate-300'}`}>
          <div className={`text-[10px] mb-0.5 ${summary.balance > 0 ? 'text-rose-700' : 'text-slate-500'}`}>현재 미수금</div>
          <div className={`text-base font-bold font-mono ${summary.balance > 0 ? 'text-rose-800' : 'text-slate-900'}`}>{summary.balance.toLocaleString()}</div>
        </div>
      </div>

      {hospContracts.length > 0 && (
        <div className="mb-3 border border-slate-200 rounded overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 text-xs font-semibold text-slate-600 border-b border-slate-100">청구 계약 ({hospContracts.length}건)</div>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-1.5 text-left w-32">계약일</th>
                <th className="px-3 py-1.5 text-left">견적번호</th>
                <th className="px-3 py-1.5 text-right w-32">청구액</th>
              </tr>
            </thead>
            <tbody>
              {hospContracts.map(c => (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-600">{c.contract_date || '—'}</td>
                  <td className="px-3 py-1.5 text-slate-700">{c.quote_name || '—'}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{(c.amount || 0).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="border border-slate-200 rounded overflow-hidden">
        <div className="px-3 py-2 bg-slate-50 text-xs font-semibold text-slate-600 border-b border-slate-100">거래 내역 ({rows.length}건)</div>
        <div className="overflow-auto" style={{maxHeight:'320px'}}>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left w-28">날짜</th>
                <th className="px-3 py-2 text-left w-20">유형</th>
                <th className="px-3 py-2 text-left">계약</th>
                <th className="px-3 py-2 text-right w-32">금액</th>
                <th className="px-3 py-2 text-left">메모</th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="p-6 text-center text-slate-400 text-xs">불러오는 중...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="p-6 text-center text-slate-400 text-xs">거래 내역 없음 — 거래 입력 탭에서 '수금'으로 추가하세요</td></tr>
              ) : rows.map(r => {
                const ctr = r.contract_id ? contractMap.get(r.contract_id) : null;
                return (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 text-xs text-slate-600">{r.tx_date}</td>
                    <td className="px-3 py-1.5">
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${arColor(r.tx_type)}`}>{arLabel(r.tx_type)}</span>
                    </td>
                    <td className="px-3 py-1.5 text-xs text-slate-500">{ctr ? (ctr.quote_name || ctr.contract_date) : <span className="text-slate-300">전체</span>}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-sm">{r.amount.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-xs text-slate-600">{r.memo || '—'}</td>
                    <td className="px-3 py-1.5 text-center">
                      <button onClick={() => handleDelete(r)} className="text-xs text-rose-400 hover:text-rose-600" title="삭제">✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </ModalShell>
  );
}

function ReceivableBalanceTab({ arBalances = [], arTransactions = [], contracts = [], onReload, showToast }) {
  const [search, setSearch] = useState('');
  const [hideZero, setHideZero] = useState(true);
  const [historyModal, setHistoryModal] = useState(null);
  const [sortKey, setSortKey] = useState('balance');
  const [sortDir, setSortDir] = useState('desc');

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(key); setSortDir('desc'); }
  };
  const sortIcon = (key) => sortKey === key ? (sortDir === 'desc' ? '▼' : '▲') : '↕';

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return arBalances.filter(b => {
      // 활성 데이터만 (계약 또는 수금 거래가 있는 병원)
      const hasActivity = (b.contract_count || 0) > 0 || (b.total_collected || 0) > 0;
      if (!hasActivity) return false;
      if (hideZero && (!b.balance || b.balance <= 0)) return false;
      if (!q) return true;
      return vendorMatch(b.hospital_name, q);
    });
  }, [arBalances, search, hideZero]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let va, vb;
      if (sortKey === 'balance') { va = a.balance || 0; vb = b.balance || 0; }
      else if (sortKey === 'invoice') { va = a.total_invoice || 0; vb = b.total_invoice || 0; }
      else if (sortKey === 'collect') { va = a.total_collected || 0; vb = b.total_collected || 0; }
      else { va = a.last_tx_date || ''; vb = b.last_tx_date || ''; }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const today = new Date().toISOString().slice(0, 10);

  // 병원별 가장 최근 거래
  const lastTxByHosp = useMemo(() => {
    const m = new Map();
    arTransactions.forEach(t => { if (!m.has(t.hospital_id)) m.set(t.hospital_id, t); });
    return m;
  }, [arTransactions]);

  const arLabel = (t) => ({ collect:'병원 입금', adjustment:'조정', cancel:'취소' }[t] || t);
  const arColor = (t) => ({
    collect:'bg-emerald-100 text-emerald-700',
    adjustment:'bg-amber-100 text-amber-700',
    cancel:'bg-rose-100 text-rose-700',
  }[t] || 'bg-slate-100 text-slate-600');

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 bg-slate-50">
        <input type="text" placeholder="병원명 검색" value={search} onChange={e => setSearch(e.target.value)}
          className="flex-1 max-w-sm bg-white border border-slate-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
        <button type="button" onClick={() => setHideZero(p => !p)}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border transition-colors ${hideZero ? 'bg-blue-100 text-blue-700 border-blue-300' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'}`}>
          <span className="text-sm leading-none">{hideZero ? '☑' : '☐'}</span>
          미수금 0원 제외
        </button>
        <div className="ml-auto text-xs text-slate-500">
          {filtered.length}개 표시 / 활성 {arBalances.filter(b => (b.contract_count||0)>0 || (b.total_collected||0)>0).length}
        </div>
      </div>
      <div className="overflow-auto" style={{maxHeight:'calc(100vh - 360px)'}}>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
            <tr>
              <th className="px-4 py-2.5 text-left">병원명</th>
              <th onClick={() => toggleSort('invoice')} className={`px-4 py-2.5 text-right w-36 cursor-pointer select-none hover:bg-slate-100 ${sortKey === 'invoice' ? 'text-blue-600' : ''}`}>
                총 청구 <span className="ml-1">{sortIcon('invoice')}</span>
              </th>
              <th onClick={() => toggleSort('collect')} className={`px-4 py-2.5 text-right w-36 cursor-pointer select-none hover:bg-slate-100 ${sortKey === 'collect' ? 'text-blue-600' : ''}`}>
                누적 수금 <span className="ml-1">{sortIcon('collect')}</span>
              </th>
              <th onClick={() => toggleSort('balance')} className={`px-4 py-2.5 text-right w-40 cursor-pointer select-none hover:bg-slate-100 ${sortKey === 'balance' ? 'text-blue-600' : ''}`}>
                <div>미수금 <span className="ml-1">{sortIcon('balance')}</span></div>
                <div className="text-[10px] text-slate-400 font-normal normal-case mt-0.5">{today} 기준</div>
              </th>
              <th onClick={() => toggleSort('lastTx')} className={`px-4 py-2.5 text-center w-28 cursor-pointer select-none hover:bg-slate-100 ${sortKey === 'lastTx' ? 'text-blue-600' : ''}`}>
                최근 수금 <span className="ml-1">{sortIcon('lastTx')}</span>
              </th>
              <th className="px-4 py-2.5 text-left">최근 거래 내용</th>
              <th className="px-4 py-2.5 text-center w-20"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(b => {
              const lt = lastTxByHosp.get(b.hospital_id);
              return (
                <tr key={b.hospital_id} className="border-t border-slate-100 hover:bg-blue-50/40 cursor-pointer"
                  onClick={() => setHistoryModal({ hospitalId: b.hospital_id, name: b.hospital_name })}>
                  <td className="px-4 py-2.5 text-slate-800 font-medium">
                    {b.hospital_name}
                    {(b.contract_count || 0) > 0 && <span className="ml-1.5 text-[10px] text-slate-400">({b.contract_count}건)</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-700">{(b.total_invoice || 0).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-emerald-700">{(b.total_collected || 0).toLocaleString()}</td>
                  <td className={`px-4 py-2.5 text-right font-semibold font-mono ${(b.balance || 0) > 0 ? 'text-rose-700' : 'text-slate-400'}`}>
                    {(b.balance || 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-center text-xs text-slate-500">{b.last_tx_date || '—'}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">
                    {lt ? (
                      <span className="flex items-center gap-1.5">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${arColor(lt.tx_type)}`}>{arLabel(lt.tx_type)}</span>
                        <span className="truncate max-w-[240px]" title={lt.memo || ''}>{lt.memo || '—'}</span>
                      </span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <span className="text-xs text-blue-500">상세 →</span>
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={7} className="py-12 text-center text-slate-400 text-sm">표시할 병원이 없습니다 (계약 또는 수금 데이터 없음)</td></tr>
            )}
          </tbody>
          {sorted.length > 0 && (
            <tfoot className="bg-slate-100 font-semibold">
              <tr>
                <td className="px-4 py-3">합 계</td>
                <td className="px-4 py-3 text-right font-mono">{filtered.reduce((s, b) => s + (b.total_invoice || 0), 0).toLocaleString()}</td>
                <td className="px-4 py-3 text-right font-mono text-emerald-700">{filtered.reduce((s, b) => s + (b.total_collected || 0), 0).toLocaleString()}</td>
                <td className="px-4 py-3 text-right font-mono text-rose-700">{filtered.reduce((s, b) => s + (b.balance || 0), 0).toLocaleString()}</td>
                <td colSpan={3}></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {historyModal && (
        <HospitalLedgerModal
          hospitalId={historyModal.hospitalId}
          hospitalName={historyModal.name}
          contracts={contracts}
          onClose={() => setHistoryModal(null)}
          onChanged={onReload}
          showToast={showToast}
        />
      )}
    </div>
  );
}

/* ========== 예상 매출 (Expected Revenue) ========== */
const REVENUE_KIND_META = {
  hospital: { label:'병원 매출',   color:'bg-emerald-100 text-emerald-700', dot:'bg-emerald-500' },
  platform: { label:'플랫폼 매출', color:'bg-teal-100 text-teal-700',       dot:'bg-teal-500' },
  referral: { label:'소개 수수료', color:'bg-amber-100 text-amber-700',     dot:'bg-amber-500' },
};

function ExpectedRevenueModal({ hospitals = [], editingRow = null, onClose, onSaved }) {
  const isEdit = !!editingRow;
  const [kind, setKind] = useState(editingRow?.kind || 'hospital');
  const [targetName, setTargetName] = useState(editingRow?.target_name || '');
  const [targetHospitalId, setTargetHospitalId] = useState(editingRow?.target_hospital_id || '');
  const [title, setTitle] = useState(editingRow?.title || '');
  const [memo, setMemo] = useState(editingRow?.memo || '');
  const [mode, setMode] = useState(editingRow?.group_id ? 'split' : 'single');
  // 일시불
  const [single, setSingle] = useState({
    amount: editingRow ? Number(editingRow.amount || 0).toLocaleString('ko-KR') : '',
    due_date: editingRow?.due_date || '',
    installment_label: editingRow?.installment_label || '일시불',
    invoice_issued: !!editingRow?.invoice_issued,
  });
  // 분할 — 신규 등록 시만 (편집은 한 행만)
  const [splits, setSplits] = useState([
    { label:'계약금', amount:'', due_date:'', invoice_issued: false },
    { label:'중도금', amount:'', due_date:'', invoice_issued: false },
    { label:'잔금',   amount:'', due_date:'', invoice_issued: false },
  ]);

  const hospOpts = useMemo(() => [...hospitals].sort((a,b)=>(a.name||'').localeCompare(b.name||'')), [hospitals]);
  const [hospSearch, setHospSearch] = useState('');
  const [hospOpen, setHospOpen] = useState(false);
  const hospRef = useRef(null);
  useEffect(() => {
    const h = (e) => { if (hospRef.current && !hospRef.current.contains(e.target)) setHospOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const filteredHosp = useMemo(() => {
    const q = hospSearch.trim().toLowerCase();
    if (!q) return hospOpts;
    return hospOpts.filter(h => vendorMatch(h.name, q));
  }, [hospOpts, hospSearch]);
  const selectedHosp = hospitals.find(h => h.id === targetHospitalId);
  // 병원 선택 시 targetName 자동 채움
  useEffect(() => {
    if (kind === 'hospital' && selectedHosp && !targetName) setTargetName(selectedHosp.name);
  }, [selectedHosp, kind]);

  const parseAmt = v => Number((v||'').toString().replace(/[,\s]/g,'')) || 0;
  const fmtInput = v => { const d = (v||'').toString().replace(/[^\d]/g,''); return d ? Number(d).toLocaleString('ko-KR') : ''; };

  const totalSplit = splits.reduce((s,r) => s + parseAmt(r.amount), 0);

  const handleSave = async () => {
    if (!targetName.trim()) return alert('대상명을 입력하세요.');
    if (mode === 'single' && parseAmt(single.amount) <= 0) return alert('금액을 입력하세요.');
    if (mode === 'split' && totalSplit <= 0) return alert('분할 금액을 1개 이상 입력하세요.');

    try {
      if (isEdit) {
        // 편집 — 한 행만 (group_id 그대로 유지)
        await dbUpdateExpectedRevenue(editingRow.id, {
          kind, target_name: targetName.trim(),
          target_hospital_id: kind==='hospital' ? (targetHospitalId || null) : null,
          title: title.trim() || null,
          installment_label: single.installment_label || null,
          amount: parseAmt(single.amount),
          due_date: single.due_date || null,
          invoice_issued: !!single.invoice_issued,
          memo: memo.trim() || null,
        });
      } else if (mode === 'single') {
        await dbInsertExpectedRevenue({
          kind, target_name: targetName.trim(),
          target_hospital_id: kind==='hospital' ? (targetHospitalId || null) : null,
          title: title.trim() || null,
          installment_label: single.installment_label || '일시불',
          amount: parseAmt(single.amount),
          due_date: single.due_date || null,
          invoice_issued: !!single.invoice_issued,
          memo: memo.trim() || null,
        });
      } else {
        // 분할 — group_id 공유, 빈 행은 제외
        const gid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const rows = splits
          .filter(s => parseAmt(s.amount) > 0)
          .map(s => ({
            kind, target_name: targetName.trim(),
            target_hospital_id: kind==='hospital' ? (targetHospitalId || null) : null,
            title: title.trim() || null,
            installment_label: s.label || null,
            group_id: gid,
            amount: parseAmt(s.amount),
            due_date: s.due_date || null,
            invoice_issued: !!s.invoice_issued,
            memo: memo.trim() || null,
          }));
        await dbInsertExpectedRevenueBatch(rows);
      }
      onSaved && onSaved();
      onClose();
    } catch (e) { alert('저장 실패: ' + (e.message || e)); }
  };

  const inputCls = "bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400";

  return (
    <ModalShell title={isEdit ? '예상 매출 수정' : '예상 매출 등록'} onClose={onClose} wide>
      {/* 종류 */}
      {!isEdit && (
        <div className="mb-3">
          <label className="text-xs text-slate-500 mb-1 block">유형</label>
          <div className="flex gap-2">
            {Object.entries(REVENUE_KIND_META).map(([k, m]) => (
              <button key={k} onClick={() => setKind(k)}
                className={`flex-1 px-3 py-2 text-sm rounded border-2 transition-colors ${kind===k ? 'border-blue-500 bg-blue-50 font-semibold' : 'border-slate-200 hover:border-slate-300'}`}>
                <span className={`inline-block w-2 h-2 rounded-full ${m.dot} mr-1.5`}></span>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 대상 */}
      <div className="mb-3">
        <label className="text-xs text-slate-500 mb-1 block">대상명 <span className="text-red-400">*</span></label>
        {kind === 'hospital' ? (
          <div className="relative" ref={hospRef}>
            <input type="text"
              value={hospOpen ? hospSearch : (selectedHosp ? selectedHosp.name : targetName)}
              onChange={e => { if (hospOpen) setHospSearch(e.target.value); else { setTargetName(e.target.value); setTargetHospitalId(''); } }}
              onFocus={() => { setHospOpen(true); setHospSearch(''); }}
              placeholder="병원 선택 또는 자유 입력 (초성 ㅇㄹ 가능)"
              className={`w-full ${inputCls}`} />
            {hospOpen && (
              <div className="absolute z-30 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-xl">
                {filteredHosp.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-slate-400">검색 결과 없음 — 위 칸에 직접 입력</div>
                ) : filteredHosp.slice(0,50).map(h => (
                  <div key={h.id}
                    onClick={() => { setTargetHospitalId(h.id); setTargetName(h.name); setHospOpen(false); setHospSearch(''); }}
                    className={`px-3 py-1.5 text-sm cursor-pointer hover:bg-blue-50 ${h.id===targetHospitalId ? 'bg-blue-50 font-medium' : ''}`}>
                    {h.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <input type="text" value={targetName} onChange={e => setTargetName(e.target.value)}
            placeholder={kind==='platform' ? '예: 네이버 파트너스 / 카카오 비즈 / 메디게이트' : '예: 도렉스 (소개자명 또는 회사명)'}
            className={`w-full ${inputCls}`} />
        )}
      </div>

      {/* 제목 */}
      <div className="mb-3">
        <label className="text-xs text-slate-500 mb-1 block">제목 (선택)</label>
        <input type="text" value={title} onChange={e => setTitle(e.target.value)}
          placeholder={kind==='hospital' ? '예: 당산리더스 6월 계약' : kind==='platform' ? '예: 5월 파트너스 정산' : '예: ○○병원 소개 수수료'}
          className={`w-full ${inputCls}`} />
      </div>

      {/* 일시불 / 분할 */}
      {!isEdit && (
        <div className="mb-3">
          <label className="text-xs text-slate-500 mb-1 block">구분</label>
          <div className="flex gap-2">
            <button onClick={() => setMode('single')}
              className={`flex-1 px-3 py-2 text-sm rounded border-2 ${mode==='single' ? 'border-blue-500 bg-blue-50 font-semibold' : 'border-slate-200'}`}>일시불</button>
            <button onClick={() => setMode('split')}
              className={`flex-1 px-3 py-2 text-sm rounded border-2 ${mode==='split' ? 'border-blue-500 bg-blue-50 font-semibold' : 'border-slate-200'}`}>분할 청구</button>
          </div>
        </div>
      )}

      {/* 금액 입력 */}
      {(mode === 'single' || isEdit) ? (
        <div className="grid grid-cols-12 gap-2 mb-3 items-end">
          <div className="col-span-3">
            <label className="text-xs text-slate-500 mb-1 block">회차/구분</label>
            <input type="text" value={single.installment_label} onChange={e => setSingle(s => ({...s, installment_label: e.target.value}))}
              placeholder="일시불" className={`w-full ${inputCls}`} />
          </div>
          <div className="col-span-4">
            <label className="text-xs text-slate-500 mb-1 block">금액 (원) <span className="text-red-400">*</span></label>
            <input type="text" value={single.amount}
              onChange={e => setSingle(s => ({...s, amount: fmtInput(e.target.value)}))}
              placeholder="0" className={`w-full ${inputCls} font-mono text-right`} />
          </div>
          <div className="col-span-3">
            <label className="text-xs text-slate-500 mb-1 block">예정일</label>
            <input type="date" value={single.due_date} onChange={e => setSingle(s => ({...s, due_date: e.target.value}))} className={`w-full ${inputCls}`} />
          </div>
          <div className="col-span-2 flex items-center gap-1.5 pb-2">
            <input type="checkbox" id="single-tax" checked={single.invoice_issued} onChange={e => setSingle(s => ({...s, invoice_issued: e.target.checked}))} />
            <label htmlFor="single-tax" className="text-xs text-slate-600 select-none">세금계산서</label>
          </div>
        </div>
      ) : (
        <div className="mb-3 border border-slate-200 rounded p-3 bg-slate-50">
          <div className="text-xs text-slate-500 mb-2">분할 청구 — 빈 줄은 저장 시 제외</div>
          {splits.map((s, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 mb-2 items-center">
              <div className="col-span-2 text-xs text-slate-500 text-center">{i+1}차</div>
              <input type="text" value={s.label}
                onChange={e => setSplits(arr => arr.map((x,j) => j===i ? {...x, label:e.target.value} : x))}
                className={`col-span-2 ${inputCls}`} placeholder="라벨" />
              <input type="text" value={s.amount}
                onChange={e => setSplits(arr => arr.map((x,j) => j===i ? {...x, amount: fmtInput(e.target.value)} : x))}
                placeholder="금액" className={`col-span-3 ${inputCls} font-mono text-right`} />
              <input type="date" value={s.due_date}
                onChange={e => setSplits(arr => arr.map((x,j) => j===i ? {...x, due_date: e.target.value} : x))}
                className={`col-span-3 ${inputCls}`} />
              <label className="col-span-2 flex items-center gap-1 text-xs cursor-pointer">
                <input type="checkbox" checked={s.invoice_issued}
                  onChange={e => setSplits(arr => arr.map((x,j) => j===i ? {...x, invoice_issued: e.target.checked} : x))} />
                세금
              </label>
            </div>
          ))}
          <div className="flex items-center justify-between mt-2">
            <button onClick={() => setSplits(arr => [...arr, {label:`${arr.length+1}차`, amount:'', due_date:'', invoice_issued:false}])}
              className="text-xs text-blue-600 hover:underline">+ 회차 추가</button>
            <div className="text-xs text-slate-600">합계 <span className="font-mono font-semibold">{totalSplit.toLocaleString()}</span>원</div>
          </div>
        </div>
      )}

      <div className="mb-4">
        <label className="text-xs text-slate-500 mb-1 block">메모 (선택)</label>
        <textarea value={memo} onChange={e => setMemo(e.target.value)} rows={2}
          className={`w-full ${inputCls}`} />
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500 hover:bg-slate-100 rounded">취소</button>
        <button onClick={handleSave} className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded font-semibold">
          {isEdit ? '수정 저장' : (mode==='split' ? `${splits.filter(s=>parseAmt(s.amount)>0).length}건 일괄 저장` : '저장')}
        </button>
      </div>
    </ModalShell>
  );
}

function ExpectedRevenueTab({ rows = [], hospitals = [], cashLogs = [], onReload, showToast }) {
  const [kindFilter, setKindFilter] = useState('all');
  const [showOutstandingOnly, setShowOutstandingOnly] = useState(false);
  const [showPendingInvoiceOnly, setShowPendingInvoiceOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);  // row | null
  const [modalOpen, setModalOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false;
      if (showOutstandingOnly && r.collected) return false;
      if (showPendingInvoiceOnly && r.invoice_issued) return false;
      if (q && !`${r.target_name||''} ${r.title||''} ${r.memo||''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, kindFilter, showOutstandingOnly, showPendingInvoiceOnly, search]);

  // 정렬: 종류 → group_id → due_date asc → 회차 순
  const sorted = useMemo(() => {
    const KIND_ORDER = { hospital:0, platform:1, referral:2 };
    return [...filtered].sort((a,b) => {
      if (a.kind !== b.kind) return (KIND_ORDER[a.kind]||9) - (KIND_ORDER[b.kind]||9);
      if (a.target_name !== b.target_name) return (a.target_name||'').localeCompare(b.target_name||'');
      if ((a.group_id||'') !== (b.group_id||'')) return (a.group_id||'').localeCompare(b.group_id||'');
      return (a.due_date||'9999').localeCompare(b.due_date||'9999');
    });
  }, [filtered]);

  // 종류별 요약 (전체 rows 기준)
  const summary = useMemo(() => {
    const s = { hospital:{inv:0,col:0,out:0,cnt:0}, platform:{inv:0,col:0,out:0,cnt:0}, referral:{inv:0,col:0,out:0,cnt:0} };
    rows.forEach(r => {
      const g = s[r.kind] || (s[r.kind] = {inv:0,col:0,out:0,cnt:0});
      g.inv += r.amount || 0;
      if (r.collected) g.col += r.amount || 0;
      else g.out += r.amount || 0;
      g.cnt++;
    });
    return s;
  }, [rows]);

  const toggleField = async (row, field) => {
    const today = new Date().toISOString().slice(0,10);
    const patch = { [field]: !row[field] };
    if (field === 'invoice_issued') patch.invoice_issued_date = !row[field] ? today : null;
    if (field === 'collected') { patch.collected_date = !row[field] ? today : null; if (row[field]) patch.collected_cash_log_id = null; }
    try { await dbUpdateExpectedRevenue(row.id, patch); onReload(); }
    catch (e) { alert('업데이트 실패: ' + (e.message || e)); }
  };

  const handleDelete = async (row) => {
    if (!confirm(`이 행을 삭제하시겠습니까?\n${row.target_name} / ${(row.amount||0).toLocaleString()}원`)) return;
    try { await dbDeleteExpectedRevenue(row.id); onReload(); showToast && showToast('삭제됨'); }
    catch (e) { alert('삭제 실패: ' + (e.message || e)); }
  };

  return (
    <div>
      {/* 종류별 요약 카드 */}
      <div className="grid grid-cols-3 gap-3 p-4 pb-2">
        {(['hospital','platform','referral']).map(k => {
          const m = REVENUE_KIND_META[k];
          const g = summary[k] || {inv:0,col:0,out:0,cnt:0};
          return (
            <div key={k} className={`rounded-lg border p-3 ${m.color.replace('text-','border-').split(' ')[0]}/40 ${m.color.split(' ')[0]}/30`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block w-2 h-2 rounded-full ${m.dot}`}></span>
                  <span className="text-xs font-semibold text-slate-700">{m.label}</span>
                </div>
                <span className="text-[10px] text-slate-400">{g.cnt}건</span>
              </div>
              <div className="text-xs text-slate-500">청구 <span className="font-mono text-slate-800">{g.inv.toLocaleString()}</span></div>
              <div className="text-xs text-slate-500">수금 <span className="font-mono text-emerald-700">{g.col.toLocaleString()}</span></div>
              <div className="text-xs text-slate-500">미수 <span className="font-mono text-rose-700 font-semibold">{g.out.toLocaleString()}</span></div>
            </div>
          );
        })}
      </div>

      {/* 컨트롤 바 */}
      <div className="flex items-center gap-2 px-4 py-2 bg-slate-50 border-y border-slate-100 text-xs text-slate-500 flex-wrap">
        <select value={kindFilter} onChange={e => setKindFilter(e.target.value)}
          className="bg-white border border-slate-200 rounded px-2 py-1.5 text-xs">
          <option value="all">전체 유형</option>
          <option value="hospital">병원 매출</option>
          <option value="platform">플랫폼 매출</option>
          <option value="referral">소개 수수료</option>
        </select>
        <input type="text" placeholder="대상·제목·메모 검색" value={search} onChange={e => setSearch(e.target.value)}
          className="flex-1 max-w-xs bg-white border border-slate-200 rounded px-3 py-1.5 text-xs focus:outline-none focus:border-blue-400" />
        <button onClick={() => setShowOutstandingOnly(v => !v)}
          className={`px-2.5 py-1.5 rounded border text-xs ${showOutstandingOnly ? 'bg-rose-100 text-rose-700 border-rose-300' : 'bg-white border-slate-200'}`}>
          {showOutstandingOnly ? '☑' : '☐'} 미수금만
        </button>
        <button onClick={() => setShowPendingInvoiceOnly(v => !v)}
          className={`px-2.5 py-1.5 rounded border text-xs ${showPendingInvoiceOnly ? 'bg-amber-100 text-amber-700 border-amber-300' : 'bg-white border-slate-200'}`}>
          {showPendingInvoiceOnly ? '☑' : '☐'} 세금계산서 미발행만
        </button>
        <span className="ml-auto">{filtered.length}건 / 전체 {rows.length}</span>
        <button onClick={() => { setEditing(null); setModalOpen(true); }}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-semibold">+ 매출 등록</button>
      </div>

      {/* 표 */}
      <div className="overflow-auto" style={{maxHeight:'calc(100vh - 460px)'}}>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
            <tr>
              <th className="px-3 py-2 text-left w-24">유형</th>
              <th className="px-3 py-2 text-left">대상 / 제목</th>
              <th className="px-3 py-2 text-left w-24">회차</th>
              <th className="px-3 py-2 text-right w-32">금액</th>
              <th className="px-3 py-2 text-center w-28">예정일</th>
              <th className="px-3 py-2 text-center w-24">세금계산서</th>
              <th className="px-3 py-2 text-center w-24">수금</th>
              <th className="px-3 py-2 text-center w-20"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, idx) => {
              const m = REVENUE_KIND_META[r.kind] || { label:r.kind, color:'bg-slate-100 text-slate-600' };
              const prev = idx > 0 ? sorted[idx-1] : null;
              const isFirstOfGroup = !prev || prev.group_id !== r.group_id || !r.group_id;
              return (
                <tr key={r.id} className={`border-t border-slate-100 hover:bg-slate-50 ${r.group_id && !isFirstOfGroup ? 'bg-slate-50/30' : ''}`}>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${m.color}`}>{m.label}</span>
                  </td>
                  <td className="px-3 py-2 text-slate-800">
                    {r.group_id && !isFirstOfGroup && <span className="text-slate-300 mr-1">└</span>}
                    <div className="font-medium">{r.target_name}</div>
                    {r.title && <div className="text-[11px] text-slate-400">{r.title}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">{r.installment_label || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{(r.amount||0).toLocaleString()}</td>
                  <td className="px-3 py-2 text-center text-xs text-slate-500">{r.due_date || '—'}</td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => toggleField(r, 'invoice_issued')}
                      className={`text-sm ${r.invoice_issued ? 'text-emerald-600' : 'text-slate-300 hover:text-slate-500'}`}
                      title={r.invoice_issued ? `발행: ${r.invoice_issued_date || ''}` : '발행으로 표시'}>
                      {r.invoice_issued ? '✅' : '⬜'}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => toggleField(r, 'collected')}
                      className={`text-sm ${r.collected ? 'text-emerald-600' : 'text-slate-300 hover:text-slate-500'}`}
                      title={r.collected ? `수금: ${r.collected_date || ''}` : '수금 완료로 표시'}>
                      {r.collected ? '✅' : '⬜'}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-center text-xs">
                    <button onClick={() => { setEditing(r); setModalOpen(true); }} className="text-blue-500 hover:text-blue-700 mr-1.5">수정</button>
                    <button onClick={() => handleDelete(r)} className="text-rose-400 hover:text-rose-600">삭제</button>
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={8} className="py-12 text-center text-slate-400 text-sm">
                예상 매출이 없습니다. 우측 상단 <b>[+ 매출 등록]</b> 으로 추가하세요.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <ExpectedRevenueModal hospitals={hospitals} editingRow={editing}
          onClose={() => { setModalOpen(false); setEditing(null); }}
          onSaved={() => { onReload(); showToast && showToast(editing ? '수정됨' : '등록됨'); }} />
      )}
    </div>
  );
}

function CashAddModal({ currentBalance, onClose, onSaved }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [delta, setDelta] = useState('');
  const [balanceAfter, setBalanceAfter] = useState('');
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const d = Number((delta || '').toString().replace(/[,\s]/g, ''));
    if (!d) return alert('증감 금액을 입력하세요 (출금은 음수)');
    setSaving(true);
    try {
      const ba = (balanceAfter || '').toString().replace(/[,\s]/g, '');
      await dbInsertCashBalance({
        log_date: date,
        delta: d,
        balance_after: ba === '' ? null : Number(ba),
        memo: memo || null,
      });
      onSaved();
    } catch (e) {
      alert('저장 실패: ' + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="통장 입출금 기록" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-500 mb-1 block">날짜</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1 block">증감 (출금은 -)</label>
            <input type="text" value={delta} onChange={e => setDelta(e.target.value)} placeholder="예: -500000 또는 1000000"
              className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-400" />
          </div>
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">기록 후 잔액 <span className="text-slate-400">(선택)</span></label>
          <input type="text" value={balanceAfter} onChange={e => setBalanceAfter(e.target.value)}
            placeholder={currentBalance != null ? `현재 ${currentBalance.toLocaleString()}` : ''}
            className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-400" />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">메모</label>
          <input type="text" value={memo} onChange={e => setMemo(e.target.value)} placeholder="예: 수금 / 카드대금 등"
            className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded">취소</button>
          <button onClick={submit} disabled={saving}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50">
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ============================================================
   VENDOR/HOSPITAL PICKER MODAL — 검색창 + 필터 (전체/업체/병원)
   ============================================================ */
function VendorPickerModal({ onClose, onSelect, defaultFilter = 'vendor', allowedKinds = 'both' }) {
  const [vendors, setVendors] = useState([]);
  const [hospitals, setHospitals] = useState([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  useEffect(() => {
    (async () => {
      if (allowedKinds === 'vendor' || allowedKinds === 'both') {
        const { data } = await sb.from('manufacturers').select('id, vendor_code, name, contact_name, contact_phone, category').order('vendor_code');
        setVendors(data || []);
      }
      if (allowedKinds === 'hospital' || allowedKinds === 'both') {
        const { data } = await sb.from('hospitals').select('id, name, hospital_code').order('hospital_code');
        setHospitals(data || []);
      }
    })();
  }, [allowedKinds]);
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    let items = [];
    if (allowedKinds === 'vendor' || allowedKinds === 'both') {
      vendors.forEach(v => items.push({ kind: 'vendor', id: v.id, code: v.vendor_code, name: v.name, contact: v.contact_name, phone: v.contact_phone, category: v.category || '일반업체' }));
    }
    if (allowedKinds === 'hospital' || allowedKinds === 'both') {
      hospitals.forEach(h => items.push({ kind: 'hospital', id: h.id, code: h.hospital_code, name: h.name, category: '병원' }));
    }
    if (allowedKinds === 'both' && filter !== 'all') items = items.filter(it => it.category === filter);
    if (q) items = items.filter(it =>
      (it.name||'').toLowerCase().includes(q) ||
      (it.code||'').toLowerCase().includes(q) ||
      (it.contact||'').toLowerCase().includes(q)
    );
    return items.slice(0, 200);
  }, [vendors, hospitals, search, filter, allowedKinds]);
  return (
    <ModalShell title="거래처/병원 선택" onClose={onClose} wide z={60}>
      <div className="flex flex-col" style={{height:'520px'}}>
        <div className="flex gap-2 items-center mb-3 shrink-0">
          <input autoFocus type="text" value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="V코드·이름·담당자 검색"
            className="flex-1 border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"/>
          {allowedKinds === 'both' && (
            <div className="flex gap-1 border border-slate-200 rounded-lg p-0.5 shrink-0">
              {[{k:'all', l:'전체'}, {k:'병원', l:'병원'}, {k:'일반업체', l:'일반업체'}, {k:'기타', l:'기타'}].map(t => (
                <button key={t.k} onClick={()=>setFilter(t.k)}
                  className={`px-2.5 py-1 text-xs rounded ${filter===t.k ? 'bg-slate-900 text-white font-semibold' : 'text-slate-600 hover:bg-slate-50'}`}>{t.l}</button>
              ))}
            </div>
          )}
        </div>
        <div className="text-xs text-slate-500 mb-2 shrink-0">{list.length}건 (최대 200 표시)</div>
        <div className="flex-1 overflow-y-auto -mx-2 border border-slate-100 rounded">
          {list.length === 0 ? (
            <div className="text-center text-sm text-slate-400 py-12">
              검색 결과가 없습니다.
              {(filter === 'vendor' || filter === 'all') && (
                <div className="mt-3 text-xs">거래처가 없으면 <b>장비 및 거래처 관리</b>에서 먼저 등록하세요.</div>
              )}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {list.map((it) => (
                <li key={it.kind + ':' + it.id}>
                  <button onClick={() => { onSelect(it); onClose(); }}
                    className="w-full text-left px-3 py-2 hover:bg-blue-50 rounded text-sm flex items-center gap-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${it.category==='병원' ? 'bg-emerald-100 text-emerald-700' : it.category==='기타' ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600'}`}>{it.category}</span>
                    {it.code && <span className="text-[10px] font-mono bg-slate-50 text-slate-400 px-1.5 py-0.5 rounded shrink-0">{it.code}</span>}
                    <span className="text-slate-800">{it.name}</span>
                    {(it.contact || it.phone) && (
                      <span className="text-xs text-slate-500 ml-auto truncate max-w-[180px]">{it.contact || ''}{it.contact && it.phone ? ' · ' : ''}{it.phone || ''}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

/* ============================================================
   병원 매출 원장 모달 (매출계산서 + 수금) — 거래처 원장 양방향
   ============================================================ */
function HospitalLedgerModal({ hospitalId, name, onClose, onChanged, showToast }) {
  const [recv, setRecv] = useState([]);
  const [tax, setTax] = useState([]);
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState('asc');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, t] = await Promise.all([
        sb.from('receivable_transactions').select('*').eq('hospital_id', hospitalId).then(x => x.data || []),
        sb.from('tax_invoices').select('id, issue_date, amount, party_name, created_at').eq('kind', 'sale').eq('hospital_id', hospitalId).then(x => x.data || []),
      ]);
      setRecv(r); setTax(t);
    } finally { setLoading(false); }
  }, [hospitalId]);
  useEffect(() => { load(); }, [load]);

  const sign = (ty) => (ty === 'collect' || ty === 'cancel') ? -1 : 1; // 매출/조정 +, 수금/취소 -
  const fmtT = (ty) => ({ invoice: '매출', collect: '수금', adjustment: '조정', cancel: '취소' }[ty] || ty);
  const CUT = '2026-05-29'; // 5/29 이전 매출계산서는 이월에 포함 → 집계 제외(아카이브)
  // 원장 = receivable_transactions + 매출 세금계산서(6/1 이후) — 목록 받을돈과 동일 기준
  const ledgerAsc = useMemo(() => {
    const items = [
      ...recv.map(r => ({ id: r.id, tx_date: r.tx_date, type: fmtT(r.tx_type), s: sign(r.tx_type) * (Number(r.amount) || 0), memo: r.memo, created_at: r.created_at })),
      ...tax.filter(t => (t.issue_date || '') > CUT).map(t => ({ id: 'tax-' + t.id, tx_date: t.issue_date, type: '매출(계산서)', s: (Number(t.amount) || 0), memo: t.party_name || '매출 세금계산서', created_at: t.created_at })),
    ];
    items.sort((a, b) => (a.tx_date < b.tx_date ? -1 : a.tx_date > b.tx_date ? 1 : (a.created_at || '') < (b.created_at || '') ? -1 : 1));
    let running = 0;
    return items.map(r => { running += r.s; return { ...r, inc: r.s > 0 ? r.s : 0, dec: r.s < 0 ? -r.s : 0, running }; });
  }, [recv, tax]);
  const display = order === 'asc' ? ledgerAsc : [...ledgerAsc].reverse();
  const summary = useMemo(() => {
    let inv = 0, col = 0;
    ledgerAsc.forEach(r => { if (r.s > 0) inv += r.s; else col += -r.s; });
    return { inv, col, balance: inv - col };
  }, [ledgerAsc]);
  const archiveTax = useMemo(() => tax.filter(t => (t.issue_date || '') <= CUT), [tax]);
  const archiveSum = useMemo(() => archiveTax.reduce((s, t) => s + (Number(t.amount) || 0), 0), [archiveTax]);

  return (
    <ModalShell title={`거래처 원장 — ${name}`} subtitle="병원 · 매출" onClose={onClose} wide>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="bg-blue-50 border border-blue-200 rounded p-3"><div className="text-[10px] text-blue-700 mb-0.5">총 매출 (증가)</div><div className="text-base font-bold font-mono text-blue-800">{summary.inv.toLocaleString()}</div></div>
        <div className="bg-emerald-50 border border-emerald-200 rounded p-3"><div className="text-[10px] text-emerald-700 mb-0.5">총 수금 (감소)</div><div className="text-base font-bold font-mono text-emerald-800">{summary.col.toLocaleString()}</div></div>
        <div className="bg-slate-100 border border-slate-300 rounded p-3"><div className="text-[10px] text-slate-500 mb-0.5">현재 미수금</div><div className={`text-base font-bold font-mono ${summary.balance < 0 ? 'text-red-600' : 'text-slate-900'}`}>{summary.balance.toLocaleString()}</div></div>
      </div>
      {archiveSum > 0 && <div className="text-[11px] text-slate-400 mb-2">※ 5/29 이전 매출계산서 {archiveTax.length}건 · {archiveSum.toLocaleString()}원은 이월에 포함(집계 제외, 아카이브)</div>}
      <div className="flex items-center gap-2 mb-2">
        <button onClick={() => setOrder(o => o === 'asc' ? 'desc' : 'asc')} className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50">{order === 'asc' ? '오래된순' : '최신순'}</button>
      </div>
      <div className="border border-slate-100 rounded overflow-auto" style={{ maxHeight: '420px' }}>
        {loading ? <div className="p-8 text-center text-slate-400 text-sm">불러오는 중...</div> :
          display.length === 0 ? <div className="p-8 text-center text-slate-400 text-sm">매출/수금 내역이 없습니다.</div> : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-[10px] text-slate-500 sticky top-0"><tr>
                <th className="px-2 py-1.5 text-left">날짜</th><th className="px-2 py-1.5 text-center">유형</th><th className="px-2 py-1.5 text-left">적요</th>
                <th className="px-2 py-1.5 text-right">증가</th><th className="px-2 py-1.5 text-right">감소</th><th className="px-2 py-1.5 text-right">미수금</th>
              </tr></thead>
              <tbody>
                {display.map(r => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-2 py-1.5 whitespace-nowrap text-slate-600">{r.tx_date}</td>
                    <td className="px-2 py-1.5 text-center">{r.type}</td>
                    <td className="px-2 py-1.5 text-slate-600 break-words">{r.memo || '—'}</td>
                    <td className="px-2 py-1.5 text-right tnum text-blue-700">{r.inc ? r.inc.toLocaleString() : ''}</td>
                    <td className="px-2 py-1.5 text-right tnum text-emerald-700">{r.dec ? r.dec.toLocaleString() : ''}</td>
                    <td className="px-2 py-1.5 text-right tnum font-semibold">{r.running.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </ModalShell>
  );
}

function ModalShell({ title, subtitle, onClose, children, wide, z = 50 }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-slate-900/50 p-4" style={{zIndex: z}} onClick={onClose}>
      <div className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} max-h-[92vh] overflow-y-auto`}
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <div>
            <h3 className="font-semibold text-slate-900">{title}</h3>
            {subtitle && <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">&times;</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/* ============================================================
   거래 입력 탭 — 한 줄씩 입력 → 누적 → 일괄 저장
   ============================================================ */
const ENTRY_TYPES = [
  // '매입 (외상 등록)' 유형 제거 — 매입(줄 돈)은 「매입매출 관리 > 세금계산서」 탭으로 일원화(이중계상 방지).
  // dbSaveManualEntry의 purchase 분기·표시 코드는 과거 호환용으로 남겨둠(신규 입력은 불가).
  { key: 'payment',  label: '거래처 송금',       needVendor: true,  cashDir: -1, desc: '거래처에 외상 갚기 — 외상 차감 + 통장 출금' },
  { key: 'collect',  label: '병원 입금',         needVendor: false, cashDir: +1, needHospital: 'optional', desc: '병원 선택 시 미수금 차감 + 통장 입금. 미선택 시 통장만 (잡수입)' },
  { key: 'sale',     label: '매출 (외상 발생)',   needParty: true, cashDir: 0,  desc: '거래처/병원에 매출 — 미수금 증가, 통장 무관' },
  { key: 'sale_collect', label: '매출 수금',      needParty: true, cashDir: +1, desc: '거래처/병원에서 수금 — 미수금 차감 + 통장 입금' },
  { key: 'ad',  label: '광고 매출', needVendor: false, cashDir: +1, freeForm: true, desc: '광고 수익 입금 (발주 외 매출). 출처는 직접 입력' },
  { key: 'fee', label: '수수료',    needVendor: false, cashDir: +1, freeForm: true, desc: '플랫폼·소개·판매 수수료 입금 (발주 외 매출). 출처는 직접 입력' },
  { key: 'opex',     label: '운영비 (임대료·인건비·광고비·세금)', shortLabel: '운영비', needVendor: false, cashDir: -1, freeForm: true, desc: '임대료·인건비·광고비·세금·통신·카드·공과금 등 모든 운영 지출' },
  { key: 'advance',  label: '선지급',            needVendor: false, cashDir: -1, freeForm: true, desc: '미리 보내는 돈 (예치/보증금 등)' },
  { key: 'etc_in',   label: '잡수입',            needVendor: false, cashDir: +1, freeForm: true, desc: '환불·세금환급·기타 비분류 입금' },
  { key: 'etc_out',  label: '잡지출',            needVendor: false, cashDir: -1, freeForm: true, desc: '기타 비분류 출금' },
];
const ENTRY_TYPE_BY_KEY = Object.fromEntries(ENTRY_TYPES.map(t => [t.key, t]));

// 거래 1건을 유형에 따라 DB에 반영
async function dbSaveManualEntry(e) {
  // e = { date, typeKey, manufacturerId, vendorName, amount, memo }
  const t = ENTRY_TYPE_BY_KEY[e.typeKey];
  if (!t) throw new Error('알 수 없는 유형: ' + e.typeKey);
  const amount = e.amount;
  if (t.key === 'purchase') {
    await dbInsertPayableTransaction({
      manufacturer_id: e.manufacturerId, tx_date: e.date, tx_type: 'purchase',
      amount, memo: e.memo || null,
    });
  } else if (t.key === 'payment') {
    // 통장 먼저 기록 → 그 id를 cash_log_id로 송금(payable)과 연결.
    // (통장 삭제 시 연동 삭제 + 송금내역 모달과 어긋남 방지)
    const cashId = await dbInsertCashBalance({
      log_date: e.date, delta: -amount,
      counterparty: e.vendorName || null,
      entry_type: '지급',
      memo: e.memo || null,
    });
    await dbInsertPayableTransaction({
      manufacturer_id: e.manufacturerId, tx_date: e.date, tx_type: 'payment',
      amount, memo: e.memo || null,
      cash_log_id: cashId,
    });
  } else if (t.key === 'collect' && (e.expectedId || e.hospitalId)) {
    // 병원 매출 수금 — 통장 입금 + (예상매출 수금완료 또는 legacy receivable)
    const tag = t.shortLabel || t.label;
    const cashId = await dbInsertCashBalance({
      log_date: e.date, delta: amount,
      counterparty: e.hospitalName || null,
      entry_type: tag,
      memo: e.memo || null,
    });
    if (e.expectedId) {
      // 신규: 예상매출 행 수금완료 처리
      await dbUpdateExpectedRevenue(e.expectedId, {
        collected: true,
        collected_date: e.date,
        collected_cash_log_id: cashId,
      });
    } else if (e.hospitalId) {
      // legacy: receivable_transactions 기록 (마이그레이션 전 호환)
      try {
        await dbInsertReceivableTransaction({
          hospital_id: e.hospitalId,
          contract_id: e.contractId || null,
          tx_date: e.date, tx_type: 'collect',
          amount, memo: e.memo || null,
          cash_log_id: cashId,
        });
      } catch (_) { /* receivable_transactions 미존재 시 무시 */ }
    }
  } else if (t.key === 'sale') {
    // 거래처/병원에 매출 — 미수금 증가 (통장 무관)
    // receivable_transactions의 tx_type CHECK는 collect/adjustment/cancel만 허용,
    // 라이브 v_receivable_balance가 adjustment(+)로 미수를 집계하므로 매출 발생 = 'adjustment'
    await dbInsertReceivableTransaction({
      [e.partyKind === 'hospital' ? 'hospital_id' : 'manufacturer_id']: e.partyId,
      tx_date: e.date, tx_type: 'adjustment', amount, memo: e.memo ? ('[매출] ' + e.memo) : '[매출]',
    });
  } else if (t.key === 'sale_collect') {
    // 거래처/병원 수금 — 통장 입금 + 미수금 차감
    const cashId = await dbInsertCashBalance({
      log_date: e.date, delta: amount, counterparty: e.partyName || null,
      entry_type: '수금', memo: e.memo || null,
    });
    await dbInsertReceivableTransaction({
      [e.partyKind === 'hospital' ? 'hospital_id' : 'manufacturer_id']: e.partyId,
      tx_date: e.date, tx_type: 'collect', amount, memo: e.memo || null, cash_log_id: cashId,
    });
  } else {
    // collect(잡수입) / opex / advance / etc_in / etc_out / platform / payment(vendor없을때) — 통장만
    const tag = t.shortLabel || t.label;
    const delta = t.cashDir * amount;
    await dbInsertCashBalance({
      log_date: e.date, delta,
      counterparty: e.vendorName || null,
      entry_type: tag,
      memo: e.memo || null,
    });
  }
}

function TransactionEntryTab({ balances, cashCurrent, hospitals = [], contracts = [], expectedRev = [], onReload, showToast }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [typeKey, setTypeKey] = useState('payment');
  const [vendorId, setVendorId] = useState('');
  const [vendorSearch, setVendorSearch] = useState('');
  const [vendorOpen, setVendorOpen] = useState(false);
  const [vendorPickOpen, setVendorPickOpen] = useState(false);
  const [vendorFreeText, setVendorFreeText] = useState(''); // 기타 유형 — 거래처 직접 입력
  const vendorBoxRef = useRef(null);
  // 수금 — 병원/계약 (optional)
  const [hospitalId, setHospitalId] = useState('');
  const [hospitalSearch, setHospitalSearch] = useState('');
  const [hospitalOpen, setHospitalOpen] = useState(false);
  const hospitalBoxRef = useRef(null);
  const [contractId, setContractId] = useState('');
  // 수금 — 예상매출 행 연결 (우선)
  const [expectedId, setExpectedId] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  // 매출(any party) — 거래처/병원 통합 선택
  const [partyKind, setPartyKind] = useState('');
  const [partyId, setPartyId] = useState('');
  const [partyName, setPartyName] = useState('');
  const [partyPickOpen, setPartyPickOpen] = useState(false);

  // 콤보박스 외부 클릭 시 닫기 (거래처/병원 둘 다)
  useEffect(() => {
    const h = (e) => {
      if (vendorBoxRef.current && !vendorBoxRef.current.contains(e.target)) setVendorOpen(false);
      if (hospitalBoxRef.current && !hospitalBoxRef.current.contains(e.target)) setHospitalOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const [pending, setPending] = useState([]);
  const [saving, setSaving] = useState(false);

  const curType = ENTRY_TYPE_BY_KEY[typeKey];
  const needVendor = curType.needVendor;
  const needHospital = curType.needHospital === 'optional'; // 'collect' 유형만 true
  const needParty = !!curType.needParty; // 매출/매출수금 — 거래처/병원 아무나

  const vendorOptions = useMemo(() => {
    const q = vendorSearch.trim().toLowerCase();
    const arr = [...balances].sort((a, b) => (a.manufacturer_name || '').localeCompare(b.manufacturer_name || ''));
    if (!q) return arr;
    return arr.filter(b => vendorMatch(b.manufacturer_name, q) || (b.vendor_code || '').toLowerCase().includes(q));
  }, [balances, vendorSearch]);

  const selectedVendor = balances.find(b => b.manufacturer_id === vendorId);

  // 병원 검색/옵션 (수금 유형)
  const hospitalOptions = useMemo(() => {
    const q = hospitalSearch.trim().toLowerCase();
    const arr = [...hospitals].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!q) return arr;
    return arr.filter(h => vendorMatch(h.name, q));
  }, [hospitals, hospitalSearch]);
  const selectedHospital = hospitals.find(h => h.id === hospitalId);
  // 선택된 병원에 묶인 계약(취소 제외)
  const hospitalContracts = useMemo(() => {
    if (!hospitalId) return [];
    return contracts.filter(c => c.hospital_id === hospitalId && (c.status == null || c.status !== '취소'));
  }, [contracts, hospitalId]);

  // 미수 상태 예상매출 (collect 유형에서 선택 가능)
  const outstandingExpected = useMemo(() => {
    return (expectedRev || [])
      .filter(r => !r.collected)
      .sort((a,b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
  }, [expectedRev]);
  const selectedExpected = expectedRev.find(r => r.id === expectedId);
  const parseAmt = (v) => Number((v || '').toString().replace(/[,\s]/g, '')) || 0;

  const addRow = () => {
    const amt = parseAmt(amount);
    if (!amt || amt <= 0) return alert('금액을 입력하세요.');
    if (needVendor && !vendorId) return alert(`${curType.label}은(는) 거래처를 선택해야 합니다.`);
    if (needParty && !partyId) return alert(`${curType.label}은(는) 거래처/병원을 선택해야 합니다.`);
    const vendor = balances.find(b => b.manufacturer_id === vendorId);
    const vendorName = needVendor
      ? (vendor?.manufacturer_name || '')
      : needParty ? partyName
      : (curType.freeForm ? vendorFreeText.trim() : '');
    // 중복 입력 방지 — 같은 날짜·유형·거래처·금액이 이미 입력대기에 있으면 확인
    const dupKey = `${date}|${typeKey}|${needVendor ? vendorId : ''}|${amt}`;
    const dupExists = pending.some(r =>
      `${r.date}|${r.typeKey}|${r.manufacturerId||''}|${r.amount}` === dupKey
    );
    if (dupExists && !confirm('같은 날짜·거래처·금액이 이미 입력대기 중입니다.\n한 번 더 추가하시겠습니까?')) return;
    setPending(p => {
      const row = {
        id: `${Date.now()}-${p.length}`,
        date, typeKey,
        manufacturerId: needVendor ? vendorId : null,
        vendorName,
        amount: amt, memo: memo.trim(),
      };
      if (needParty) { row.partyKind = partyKind; row.partyId = partyId; row.partyName = partyName; }
      // 수금 + 예상매출 선택 시 우선 사용 (자동으로 hospitalId/병원명 동기화됨)
      if (needHospital && expectedId) {
        row.expectedId = expectedId;
        row.hospitalName = selectedExpected?.target_name || '';
        row.hospitalId = selectedExpected?.target_hospital_id || hospitalId || null;
      } else if (needHospital && hospitalId) {
        row.hospitalId = hospitalId;
        row.hospitalName = selectedHospital?.name || '';
        row.contractId = contractId || null;
      }
      return [...p, row];
    });
    // 금액·메모만 초기화 (날짜/유형/거래처/병원은 유지 — 연속 입력 편의)
    setAmount(''); setMemo('');
  };

  const removeRow = (id) => setPending(p => p.filter(r => r.id !== id));

  const saveAll = async () => {
    if (pending.length === 0) return;
    if (!confirm(`${pending.length}건을 저장합니다. 진행할까요?`)) return;
    setSaving(true);
    try {
      for (const e of pending) {
        await dbSaveManualEntry(e);
      }
      const cnt = pending.length;
      setPending([]);
      onReload();
      showToast(`${cnt}건 저장 완료`);
    } catch (err) {
      console.error(err);
      showToast('저장 실패: ' + (err.message || err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const totals = useMemo(() => {
    let inAmt = 0, outAmt = 0, purchaseAmt = 0;
    pending.forEach(e => {
      const t = ENTRY_TYPE_BY_KEY[e.typeKey];
      if (t.key === 'purchase') purchaseAmt += e.amount;
      else if (t.cashDir > 0) inAmt += e.amount;
      else if (t.cashDir < 0) outAmt += e.amount;
    });
    return { inAmt, outAmt, purchaseAmt };
  }, [pending]);

  const inputCls = "bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400";

  return (
    <div className="p-4">
      {/* 입력 폼 */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mb-4">
        <div className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-2">
            <label className="text-xs text-slate-500 mb-1 block">날짜</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className={`w-full ${inputCls}`} />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-slate-500 mb-1 block">유형</label>
            <select value={typeKey} onChange={e => { setTypeKey(e.target.value); }} className={`w-full ${inputCls}`}>
              {ENTRY_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}{t.cashDir > 0 ? ' (+)' : t.cashDir < 0 ? ' (−)' : ''}</option>)}
            </select>
          </div>
          <div className="col-span-3">
            <label className="text-xs text-slate-500 mb-1 block">
              {needVendor ? <>거래처 <span className="text-red-400">*</span></>
                : needParty ? <>거래처/병원 <span className="text-red-400">*</span></>
                : needHospital ? <>병원 <span className="text-slate-300">(선택)</span></>
                : <>거래처 <span className="text-slate-300">(불필요)</span></>}
            </label>
            {needVendor ? (
              <button type="button" onClick={()=>setVendorPickOpen(true)}
                className={`w-full ${inputCls} text-left bg-white hover:bg-slate-50 truncate`}>
                {selectedVendor ? `${selectedVendor.manufacturer_name} (잔액 ${(selectedVendor.balance || 0).toLocaleString()})` : <span className="text-slate-400">거래처 선택 (클릭)</span>}
              </button>
            ) : needParty ? (
              <button type="button" onClick={()=>setPartyPickOpen(true)}
                className={`w-full ${inputCls} text-left bg-white hover:bg-slate-50 truncate`}>
                {partyName ? partyName : <span className="text-slate-400">거래처/병원 선택 (클릭)</span>}
              </button>
            ) : needHospital ? (
              <div className="space-y-1">
                {/* 예상매출 행 선택 (우선) — 선택 시 자동으로 병원/금액 연동 */}
                <select value={expectedId}
                  onChange={e => {
                    setExpectedId(e.target.value);
                    const r = expectedRev.find(x => x.id === e.target.value);
                    if (r) {
                      if (r.target_hospital_id) setHospitalId(r.target_hospital_id);
                      if (r.amount && !amount) setAmount(Number(r.amount).toLocaleString('ko-KR'));
                    }
                  }}
                  className={`w-full ${inputCls} text-xs`}>
                  <option value="">— 받을 돈 선택 (또는 아래에서 병원만 선택) —</option>
                  {outstandingExpected.map(r => {
                    const m = REVENUE_KIND_META[r.kind] || {label:r.kind};
                    return <option key={r.id} value={r.id}>
                      [{m.label}] {r.target_name}{r.installment_label ? ' · '+r.installment_label : ''} · {(r.amount||0).toLocaleString()}원{r.due_date ? ' · '+r.due_date : ''}
                    </option>;
                  })}
                </select>
                <div className="relative" ref={hospitalBoxRef}>
                  <input type="text"
                    value={hospitalOpen ? hospitalSearch : (selectedHospital ? selectedHospital.name : '')}
                    onChange={e => { setHospitalSearch(e.target.value); setHospitalOpen(true); }}
                    onFocus={() => { setHospitalOpen(true); setHospitalSearch(''); }}
                    placeholder="병원 선택 (미선택: 잡수입으로 통장만 기록)"
                    className={`w-full ${inputCls}`} />
                  {hospitalOpen && (
                    <div className="absolute z-30 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-xl">
                      <div onClick={() => { setHospitalId(''); setContractId(''); setHospitalOpen(false); setHospitalSearch(''); }}
                        className="px-3 py-1.5 text-sm cursor-pointer hover:bg-slate-100 text-slate-400 border-b border-slate-100">— 미선택 (잡수입) —</div>
                      {hospitalOptions.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-slate-400">검색 결과 없음</div>
                      ) : hospitalOptions.slice(0, 50).map(h => (
                        <div key={h.id}
                          onClick={() => { setHospitalId(h.id); setContractId(''); setHospitalOpen(false); setHospitalSearch(''); }}
                          className={`px-3 py-1.5 text-sm cursor-pointer hover:bg-blue-50 ${h.id === hospitalId ? 'bg-blue-50 font-medium' : ''}`}>
                          {h.name}
                        </div>
                      ))}
                      {hospitalOptions.length > 50 && (
                        <div className="px-3 py-1.5 text-[11px] text-slate-400 border-t border-slate-100">상위 50개만 표시 — 더 입력해 좁히세요</div>
                      )}
                    </div>
                  )}
                </div>
                {hospitalId && hospitalContracts.length > 0 && (
                  <select value={contractId} onChange={e => setContractId(e.target.value)}
                    className={`w-full ${inputCls} text-xs`}>
                    <option value="">계약 선택 (생략 시 병원 전체에서 차감)</option>
                    {hospitalContracts.map(c => (
                      <option key={c.id} value={c.id}>
                        {(c.quote_name || c.contract_date || '계약')} — {(c.amount || 0).toLocaleString()}원
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ) : curType.freeForm ? (
              <input type="text" value={vendorFreeText} onChange={e => setVendorFreeText(e.target.value)}
                placeholder="거래처/상대방 직접 입력 (선택)"
                className={`w-full ${inputCls}`} />
            ) : (
              <input type="text" value="—" disabled className={`w-full ${inputCls} bg-slate-100 text-slate-400`} />
            )}
          </div>
          <div className="col-span-2">
            <label className="text-xs text-slate-500 mb-1 block">금액 (원)</label>
            <input type="text" value={amount}
              onChange={e => {
                const digits = (e.target.value || '').replace(/[^\d]/g, '');
                setAmount(digits ? Number(digits).toLocaleString('ko-KR') : '');
              }}
              placeholder="0"
              onKeyDown={e => { if (e.key === 'Enter') addRow(); }}
              className={`w-full ${inputCls} font-mono text-right`} />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-slate-500 mb-1 block">메모</label>
            <input type="text" value={memo} onChange={e => setMemo(e.target.value)} placeholder="(선택)"
              onKeyDown={e => { if (e.key === 'Enter') addRow(); }}
              className={`w-full ${inputCls}`} />
          </div>
          <div className="col-span-1">
            <button onClick={addRow} className="w-full px-2 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-white rounded">추가</button>
          </div>
        </div>
        <div className="text-xs text-slate-400 mt-2">{curType.label} — {curType.desc}. 거래처는 칸 클릭 후 이름·초성(예: ㅇㄹ)으로 검색, 금액/메모 입력 후 Enter로 빠르게 추가됩니다.</div>
      </div>

      {/* 누적 목록 */}
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <div className="flex items-center px-4 py-2 bg-slate-50 border-b border-slate-100 text-xs text-slate-500">
          <span>입력 대기 {pending.length}건</span>
          {pending.length > 0 && (
            <span className="ml-auto flex gap-4">
              {totals.purchaseAmt > 0 && <span>매입 +{totals.purchaseAmt.toLocaleString()}</span>}
              {totals.inAmt > 0 && <span className="text-emerald-600">입금 +{totals.inAmt.toLocaleString()}</span>}
              {totals.outAmt > 0 && <span className="text-red-600">출금 -{totals.outAmt.toLocaleString()}</span>}
            </span>
          )}
        </div>
        <div className="overflow-auto" style={{minHeight: '220px', maxHeight: '380px'}}>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
            <tr>
              <th className="px-3 py-2 text-left w-28">날짜</th>
              <th className="px-3 py-2 text-left w-20">유형</th>
              <th className="px-3 py-2 text-left">거래처</th>
              <th className="px-3 py-2 text-right w-32">금액</th>
              <th className="px-3 py-2 text-left">메모</th>
              <th className="px-3 py-2 text-center w-16"></th>
            </tr>
          </thead>
          <tbody>
            {pending.map(r => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2 text-xs text-slate-600">{r.date}</td>
                <td className="px-3 py-2"><TypeBadge type={r.typeKey === 'purchase' ? 'purchase' : (r.typeKey === 'payment' ? 'payment' : 'adjustment')} /> <span className="text-xs text-slate-500">{ENTRY_TYPE_BY_KEY[r.typeKey].label}</span></td>
                <td className="px-3 py-2 text-slate-800">{r.vendorName || '—'}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-700">{r.amount.toLocaleString()}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{r.memo || '—'}</td>
                <td className="px-3 py-2 text-center">
                  <button onClick={() => removeRow(r.id)} className="text-xs text-red-500 hover:text-red-700">삭제</button>
                </td>
              </tr>
            ))}
            {pending.length === 0 && (
              <tr><td colSpan={6} className="py-10 text-center text-slate-400 text-sm">위에서 거래를 입력하고 [추가] 하세요. 모은 뒤 한 번에 저장합니다.</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* 저장 */}
      <div className="flex items-center justify-end gap-2 mt-4">
        {pending.length > 0 && (
          <button onClick={() => setPending([])} className="px-4 py-2 text-sm text-slate-500 hover:bg-slate-100 rounded">전체 비우기</button>
        )}
        <button onClick={saveAll} disabled={saving || pending.length === 0}
          className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-40">
          {saving ? '저장 중...' : `${pending.length}건 일괄 저장`}
        </button>
      </div>
      {vendorPickOpen && (
        <VendorPickerModal
          allowedKinds="vendor"
          defaultFilter="vendor"
          onClose={()=>setVendorPickOpen(false)}
          onSelect={(it)=>setVendorId(it.id)}
        />
      )}
      {partyPickOpen && (
        <VendorPickerModal
          allowedKinds="both"
          onClose={()=>setPartyPickOpen(false)}
          onSelect={(it)=>{ setPartyKind(it.kind); setPartyId(it.id); setPartyName(it.name); }}
        />
      )}
    </div>
  );
}

/* ============================================================
   매입매출 리포트 탭 (Phase 3) — 이미 로드된 데이터로 집계만 (추가 Egress 0)
   ============================================================ */
function PayableReportTab({ transactions = [], balances = [], cashLogs = [], arBalances = [], arTransactions = [], expectedRev = [], manufacturers = [], saleTax = [], cashCurrent = null }) {
  // 기본: 오늘부터 최근 한 달
  const defaultRange = useMemo(() => {
    const today = new Date();
    const monthAgo = new Date(today.getTime() - 30 * 86400000);
    const fmt = d => d.toISOString().slice(0, 10);
    return { from: fmt(monthAgo), to: fmt(today) };
  }, []);
  const [from, setFrom] = useState(defaultRange.from);
  const [to, setTo] = useState(defaultRange.to);

  const inRange = (d) => {
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };
  const fTx = useMemo(() => transactions.filter(t => (!from && !to) ? true : inRange(t.tx_date)), [transactions, from, to]);
  const fCash = useMemo(() => cashLogs.filter(c => (!from && !to) ? true : inRange(c.log_date)), [cashLogs, from, to]);

  // 매입성(매입/이월/조정/취소) vs 지급(payment)
  const summary = useMemo(() => {
    let purchase = 0, payment = 0;
    fTx.forEach(t => {
      if (t.tx_type === 'payment') payment += t.amount;
      else purchase += t.amount; // 부호 그대로 (조정/취소 음수 포함)
    });
    const cashIn = fCash.filter(c => c.delta > 0).reduce((s, c) => s + c.delta, 0);
    const cashOut = fCash.filter(c => c.delta < 0).reduce((s, c) => s + (-c.delta), 0);
    // 줄 돈(양수만) + 과지급(음수만 절댓값) 분리 — 거래처 원장과 일치
    const totalBalance     = balances.reduce((s, b) => s + Math.max(0,  (b.balance || 0)), 0);
    const totalOverpaidAp  = balances.reduce((s, b) => s + Math.max(0, -(b.balance || 0)), 0);
    // AR (예상 매출 기반 — 미수=collected=false 합)
    const totalReceivable = expectedRev
      .filter(r => !r.collected)
      .reduce((s, r) => s + (r.amount || 0), 0);
    const totalInvoice    = expectedRev.reduce((s, r) => s + (r.amount || 0), 0);
    const totalCollected  = expectedRev
      .filter(r => r.collected)
      .reduce((s, r) => s + (r.amount || 0), 0);
    const arCollectInRange = expectedRev
      .filter(r => r.collected && r.collected_date && ((!from && !to) ? true : inRange(r.collected_date)))
      .reduce((s, r) => s + (r.amount || 0), 0);
    const netPosition = totalReceivable - totalBalance; // 받을 - 줄
    return { purchase, payment, cashIn, cashOut, totalBalance, totalOverpaidAp,
             totalReceivable, totalInvoice, totalCollected, arCollectInRange, netPosition };
  }, [fTx, fCash, balances, expectedRev, from, to]);

  // 실제 미수금 — 거래처 원장 탭과 동일 기준(실제 입력한 매출·수금). 병원(arBalances) + 거래처(arTransactions)
  const arReal = useMemo(() => {
    const mfrName = new Map(manufacturers.map(m => [m.id, m.name]));
    const parties = [];
    arBalances.forEach(a => {
      const bal = a.balance || 0;
      if (bal !== 0) parties.push({ kind: '병원', name: a.hospital_name || '(병원)', balance: bal });
    });
    const byMfr = new Map();
    arTransactions.forEach(t => {
      if (!t.manufacturer_id) return;
      const a = Number(t.amount) || 0;
      const s = (t.tx_type === 'collect' || t.tx_type === 'cancel') ? -a : a;
      byMfr.set(t.manufacturer_id, (byMfr.get(t.manufacturer_id) || 0) + s);
    });
    // 거래처 매출 세금계산서(6/1 이후)도 포함 — 거래처원장과 동일 기준
    saleTax.forEach(t => {
      if (!t.manufacturer_id || (t.issue_date || '') <= '2026-05-29') return;
      byMfr.set(t.manufacturer_id, (byMfr.get(t.manufacturer_id) || 0) + (Number(t.amount) || 0));
    });
    byMfr.forEach((bal, id) => {
      if (bal !== 0) parties.push({ kind: '거래처', name: mfrName.get(id) || '(거래처)', balance: bal });
    });
    const realReceivable = parties.reduce((s, p) => s + Math.max(0,  p.balance), 0); // 받을 돈(양수만)
    const realAdvance    = parties.reduce((s, p) => s + Math.max(0, -p.balance), 0); // 선수금(미리 받음)
    const rank = parties.filter(p => p.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 12);
    return { realReceivable, realAdvance, rank };
  }, [arBalances, arTransactions, manufacturers, saleTax]);
  // 예상 매출(참고용) — 별도 지표
  const expectedTotal = useMemo(() => expectedRev.reduce((s, r) => s + (r.amount || 0), 0), [expectedRev]);
  const netPositionReal = arReal.realReceivable - summary.totalBalance;

  // 유형별 요약 (cash 메모 prefix 파싱 → 12유형 분류)
  const byType = useMemo(() => {
    const TAGS = {
      '거래처 송금': 'payment',
      '병원 입금': 'collect',
      '광고 매출': 'ad',
      '수수료': 'fee',
      '수수료·광고 입금': 'platform',
      '운영비': 'opex',
      '선지급': 'advance',
      '잡수입': 'etc_in',
      '잡지출': 'etc_out',
    };
    const sum = {};
    fCash.forEach(c => {
      const m = (c.memo || '').match(/^\[([^\]]+)\]/);
      const tag = m ? (TAGS[m[1].trim()] || 'misc') : 'misc';
      if (!sum[tag]) sum[tag] = { in: 0, out: 0, count: 0 };
      if (c.delta > 0) sum[tag].in += c.delta;
      else sum[tag].out += -c.delta;
      sum[tag].count++;
    });
    return sum;
  }, [fCash]);

  // 월별 매입/지급
  const monthly = useMemo(() => {
    const m = {};
    fTx.forEach(t => {
      const key = (t.tx_date || '').slice(0, 7);
      if (!key) return;
      if (!m[key]) m[key] = { purchase: 0, payment: 0 };
      if (t.tx_type === 'payment') m[key].payment += t.amount;
      else m[key].purchase += t.amount;
    });
    return Object.entries(m).map(([month, v]) => ({ month, ...v })).sort((a, b) => b.month.localeCompare(a.month));
  }, [fTx]);
  const monthlyMax = useMemo(() => Math.max(1, ...monthly.flatMap(r => [r.purchase, r.payment])), [monthly]);

  // 거래처별 순위 (잔액 내림차순, 상위 12)
  const vendorRank = useMemo(() => {
    return [...balances]
      .filter(b => (b.total_purchase || 0) > 0 || (b.total_payment || 0) > 0)
      .sort((a, b) => (b.balance || 0) - (a.balance || 0))
      .slice(0, 12);
  }, [balances]);

  // 미수금 순위 (예상매출 collected=false, 대상별 합산, 상위 12)
  const outstandingRank = useMemo(() => {
    const m = new Map();
    expectedRev.filter(r => !r.collected).forEach(r => {
      const key = `${r.kind}|${r.target_name}`;
      if (!m.has(key)) m.set(key, { kind: r.kind, target_name: r.target_name, amount: 0, count: 0 });
      const g = m.get(key);
      g.amount += r.amount || 0;
      g.count++;
    });
    return Array.from(m.values()).sort((a, b) => b.amount - a.amount).slice(0, 12);
  }, [expectedRev]);

  const Card = ({ label, value, color }) => (
    <div className={`rounded-xl border p-4 ${color}`}>
      <div className="text-xs mb-1 opacity-80">{label}</div>
      <div className="text-xl font-bold font-mono">{value.toLocaleString()}<span className="text-xs font-normal ml-1">원</span></div>
    </div>
  );

  return (
    <div className="p-4 space-y-5 overflow-auto" style={{maxHeight: 'calc(100vh - 260px)'}}>
      {/* 통장잔액 (현재 시점) */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500 mb-1">통장잔액 <span className="text-[10px] text-slate-400">(최근 기록)</span></div>
          <div className={`text-2xl font-bold ${cashCurrent != null && cashCurrent < 0 ? 'text-red-600' : 'text-slate-900'}`}>
            {cashCurrent != null ? cashCurrent.toLocaleString() + '원' : '—'}
          </div>
        </div>
        {cashLogs[0] && <div className="text-xs text-slate-400">{cashLogs[0].log_date}</div>}
      </div>

      {/* 기간 */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">기간</span>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="bg-white border border-slate-200 rounded px-2 py-1 text-sm" />
        <span className="text-xs text-slate-400">~</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} className="bg-white border border-slate-200 rounded px-2 py-1 text-sm" />
        {(from || to) && <button onClick={() => { setFrom(''); setTo(''); }} className="text-xs text-slate-500 hover:text-slate-700">전체</button>}
        <span className="ml-auto text-xs text-slate-400">{(from || to) ? '선택 기간' : '전체 기간'} 기준</span>
      </div>

      {/* 통장·외상 요약 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card label="통장 입금" value={summary.cashIn} color="bg-emerald-50 border-emerald-200 text-emerald-800" />
        <Card label="통장 출금" value={summary.cashOut} color="bg-rose-50 border-rose-200 text-rose-800" />
        <Card label="줄 돈 (거래처 외상잔액 +)" value={summary.totalBalance} color="bg-slate-100 border-slate-300 text-slate-900" />
      </div>

      {/* 유형별 요약 (기간 기준) */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-100 font-semibold text-sm text-slate-700">유형별 요약 (기간 기준 통장 흐름)</div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="px-4 py-2 text-left">유형</th>
              <th className="px-4 py-2 text-right w-20">건수</th>
              <th className="px-4 py-2 text-right w-36">입금 (+)</th>
              <th className="px-4 py-2 text-right w-36">출금 (−)</th>
              <th className="px-4 py-2 text-right w-36">순 증감</th>
            </tr>
          </thead>
          <tbody>
            {[
              { key:'collect',  label:'병원 입금',           color:'text-emerald-700' },
              { key:'ad',       label:'광고 매출',           color:'text-teal-700' },
              { key:'fee',      label:'수수료',              color:'text-cyan-700' },
              { key:'platform', label:'수수료·광고 입금(구)', color:'text-teal-700' },
              { key:'etc_in',   label:'잡수입',              color:'text-emerald-600' },
              { key:'payment',  label:'거래처 송금',         color:'text-blue-700' },
              { key:'opex',     label:'운영비 (임대·인건·광고·세금)', color:'text-amber-700' },
              { key:'advance',  label:'선지급',              color:'text-violet-700' },
              { key:'etc_out',  label:'잡지출',              color:'text-rose-600' },
              { key:'misc',     label:'기타 (기초잔액 등)',   color:'text-slate-500' },
            ].map(row => {
              const s = byType[row.key];
              if (!s || s.count === 0) return null;
              const net = s.in - s.out;
              return (
                <tr key={row.key} className="border-t border-slate-100">
                  <td className={`px-4 py-2 font-medium ${row.color}`}>{row.label}</td>
                  <td className="px-4 py-2 text-right text-xs text-slate-500">{s.count}</td>
                  <td className="px-4 py-2 text-right font-mono text-emerald-600">{s.in ? '+'+s.in.toLocaleString() : <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2 text-right font-mono text-red-600">{s.out ? '−'+s.out.toLocaleString() : <span className="text-slate-300">—</span>}</td>
                  <td className={`px-4 py-2 text-right font-mono font-semibold ${net>=0?'text-emerald-700':'text-red-700'}`}>
                    {net>0?'+':net<0?'−':''}{Math.abs(net).toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-slate-50 font-semibold">
            <tr>
              <td className="px-4 py-2.5">합계</td>
              <td className="px-4 py-2.5 text-right text-xs text-slate-500">{Object.values(byType).reduce((s,v)=>s+v.count,0)}</td>
              <td className="px-4 py-2.5 text-right font-mono text-emerald-700">+{summary.cashIn.toLocaleString()}</td>
              <td className="px-4 py-2.5 text-right font-mono text-red-700">−{summary.cashOut.toLocaleString()}</td>
              <td className={`px-4 py-2.5 text-right font-mono ${summary.cashIn-summary.cashOut>=0?'text-emerald-700':'text-red-700'}`}>
                {summary.cashIn-summary.cashOut>=0?'+':'−'}{Math.abs(summary.cashIn-summary.cashOut).toLocaleString()}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>


      {/* 순 자금 포지션 — 받을 돈 − 줄 돈 (거래처 원장 탭과 동일 기준) */}
      <div className={`rounded-xl border p-5 ${netPositionReal >= 0 ? 'bg-emerald-50 border-emerald-300' : 'bg-rose-50 border-rose-300'}`}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="text-xs text-slate-500 mb-1">순 자금 포지션 (받을 − 줄)</div>
            <div className={`text-2xl font-bold font-mono ${netPositionReal >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {netPositionReal >= 0 ? '+' : ''}{netPositionReal.toLocaleString()}원
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              받을 돈 {arReal.realReceivable.toLocaleString()} − 외상매입 {summary.totalBalance.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              선수금(미리 받음) {arReal.realAdvance.toLocaleString()} · 예상 매출(참고) {expectedTotal.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* 거래처별 순위 */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 font-semibold text-sm text-slate-700">거래처별 외상잔액 순위 (상위 12)</div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="px-3 py-2 text-left w-8">#</th>
                <th className="px-3 py-2 text-left">거래처</th>
                <th className="px-3 py-2 text-right w-28">누적매입</th>
                <th className="px-3 py-2 text-right w-28">잔액</th>
              </tr>
            </thead>
            <tbody>
              {vendorRank.length === 0 ? (
                <tr><td colSpan={4} className="py-6 text-center text-slate-400 text-sm">데이터 없음</td></tr>
              ) : vendorRank.map((b, i) => (
                <tr key={b.manufacturer_id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-400 text-xs">{i + 1}</td>
                  <td className="px-3 py-1.5 text-slate-800">{b.manufacturer_name}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-500 text-xs">{(b.total_purchase || 0).toLocaleString()}</td>
                  <td className={`px-3 py-1.5 text-right font-mono text-xs font-semibold ${(b.balance || 0) < 0 ? 'text-red-600' : 'text-slate-800'}`}>{(b.balance || 0).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 미수금 순위 — 실제 받을 돈(병원+거래처), 양수만 상위 12 */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 font-semibold text-sm text-slate-700">미수금 순위 (상위 12)</div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="px-3 py-2 text-left w-8">#</th>
                <th className="px-3 py-2 text-left">대상</th>
                <th className="px-3 py-2 text-right w-32">미수금</th>
              </tr>
            </thead>
            <tbody>
              {arReal.rank.length === 0 ? (
                <tr><td colSpan={3} className="py-6 text-center text-slate-400 text-sm">미수금 없음 (모두 수금 완료)</td></tr>
              ) : arReal.rank.map((r, i) => (
                <tr key={`${r.kind}-${r.name}-${i}`} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-400 text-xs">{i + 1}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${r.kind === '병원' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{r.kind}</span>
                      <span className="text-slate-800">{r.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs font-semibold text-rose-700">{r.balance.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-slate-400 text-center">
        ※ 매입 = 이월·매입·조정·취소 합산(부호 반영) · 지급 = 입금(payment) · 통장 입출금은 cash 로그 기준
      </div>
    </div>
  );
}

/* ============================================================
   PURCHASE ORDER TRACKING — 발주 진행 (메인 메뉴 항목)
   병원별 카드 + 상태 매트릭스 + 품목 도착 체크 + 메모/이슈 로그
   ============================================================ */
// 발주 진행 — 모바일용 카드 (공유 URL을 폰에서 보기 편하게)
function PoTrackingCard({ p, groupBy, setPos, reload, showToast, onChecklist }) {
  const toggleTrackingDelivered = async () => {
    const newVal = !p.trackingDone;
    const today = new Date().toISOString().slice(0, 10);
    setPos(prev => prev.map(po => po.id === p.id ? {
      ...po, tracking_delivered: newVal, tracking_delivered_at: newVal ? (po.tracking_delivered_at || today) : null,
    } : po));
    try {
      await dbUpdatePurchaseOrder(p.id, { tracking_delivered: newVal, tracking_delivered_at: newVal ? today : null });
    } catch (e) { showToast('저장 실패: ' + (e.message || e), 'error'); reload(); }
  };
  const vi = p.vendorInfo;
  const fmtDate = (s) => s ? s.slice(5).replace('-', '/') : '—';
  return (
    <div className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-800">
            {groupBy === 'vendor' ? p.hospName : (p.manufacturer_name || p.vendor_name || '—')}
          </div>
          {groupBy !== 'vendor' && vi && (vi.contact_name || vi.contact_phone) && (
            <div className="text-xs text-slate-500 mt-0.5">
              {vi.contact_name && <span>{vi.contact_name}</span>}
              {vi.contact_name && vi.contact_phone && <span className="mx-1 text-slate-300">·</span>}
              {vi.contact_phone && <a href={`tel:${vi.contact_phone}`} className="font-mono text-blue-600">{vi.contact_phone}</a>}
            </div>
          )}
          <div className="text-[11px] font-mono text-slate-400 mt-0.5">{p.po_no || '—'}</div>
        </div>
        <button onClick={toggleTrackingDelivered}
          className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-semibold transition-colors ${p.trackingDone ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
          {p.trackingDone ? '납품완료' : '납품대기'}
        </button>
      </div>
      <div className="mt-2 text-sm text-slate-700">
        <span className="font-medium">{p.firstModel || '—'}</span>
        {p.total > 1 && <span className="text-slate-400 text-xs"> 외 {p.total - 1}건</span>}
        <span className="text-slate-400 text-xs ml-1">({p.totalQty}개)</span>
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-slate-500 flex-wrap">
        <span>발주 {fmtDate(p.orderedDate)}</span>
        <span className="text-slate-300">·</span>
        <span className="flex items-center gap-1">예상납품 <EditableDeliveryDate po={p} setPos={setPos} reload={reload} showToast={showToast} /></span>
        <button onClick={onChecklist}
          className={`ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${p.chkOpen > 0 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
          메모{p.chkOpen > 0 && <span className="bg-rose-500 text-white rounded-full px-1.5 text-[10px] font-bold">{p.chkOpen}</span>}
        </button>
      </div>
    </div>
  );
}

function PurchaseOrderTrackingPage({ onBack, user, onLogout, nav, viewer = false, appHospitals = null, appManufacturers = null }) {
  const [pos, setPos] = useState([]);
  const [notes, setNotes] = useState([]);
  const [checklists, setChecklists] = useState([]);
  const [hospitals, setHospitals] = useState(appHospitals || []);
  const [contracts, setContracts] = useState([]);
  const [vendors, setVendors] = useState(appManufacturers || []);
  const [loading, setLoading] = useState(true);
  // App 캐시 변동 시 동기화
  useEffect(() => { if (appHospitals) setHospitals(appHospitals); }, [appHospitals]);
  useEffect(() => { if (appManufacturers) setVendors(appManufacturers); }, [appManufacturers]);
  const [filter, setFilter] = useState('all'); // all | ongoing | done
  const [groupBy, setGroupBy] = useState('hospital'); // hospital | vendor
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState({}); // poId → bool
  const [expandedGroups, setExpandedGroups] = useState({}); // groupName → bool (디폴트: 접힘)
  const [toast, setToast] = useState(null);
  const [checklistModal, setChecklistModal] = useState(null); // po object
  const showToast = (msg, type='success') => { setToast({msg,type}); setTimeout(()=>setToast(null),2500); };

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      // App 캐시 있으면 hospitals/manufacturers fetch 생략 (네트워크 절감)
      const fetches = [
        sb.from('purchase_orders').select('*, purchase_order_items(*)').eq('is_active', true).order('created_at',{ascending:false}).then(r => r.data || []),
        dbLoadAllContracts(),
      ];
      if (!appHospitals) fetches.push(dbLoadHospitals());
      if (!appManufacturers) fetches.push(dbLoadManufacturers());
      const out = await Promise.all(fetches);
      const allPos = out[0];
      const ctr = out[1];
      let idx = 2;
      const hosps = appHospitals || out[idx++];
      const mfrs = appManufacturers || out[idx++];
      const poIds = allPos.map(p => p.id);
      const [ns, cks] = await Promise.all([
        poIds.length > 0 ? dbLoadPoNotes(poIds) : Promise.resolve([]),
        poIds.length > 0 ? dbLoadChecklists(poIds) : Promise.resolve([]),
      ]);
      setPos(allPos);
      setHospitals(hosps);
      setContracts(ctr);
      setVendors(mfrs);
      setNotes(ns);
      setChecklists(cks);
    } finally { if (!silent) setLoading(false); }
  }, [appHospitals, appManufacturers]);
  useEffect(() => { reload(); }, [reload]);
  const silentReload = useCallback(() => reload(true), [reload]);

  // PO별 그룹된 메모/체크리스트
  const notesByPo = useMemo(() => {
    const m = new Map();
    notes.forEach(n => { if (!m.has(n.po_id)) m.set(n.po_id, []); m.get(n.po_id).push(n); });
    return m;
  }, [notes]);
  const checklistByPo = useMemo(() => {
    const m = new Map();
    checklists.forEach(c => { if (!m.has(c.po_id)) m.set(c.po_id, []); m.get(c.po_id).push(c); });
    return m;
  }, [checklists]);

  // 거래처 lookup
  const vendorByName = useMemo(() => {
    const m = new Map();
    vendors.forEach(v => m.set(v.name, v));
    return m;
  }, [vendors]);

  // PO별 진행도 계산
  const enriched = useMemo(() => pos.map(p => {
    const items = p.purchase_order_items || [];
    const total = items.length;
    const orderedN = items.filter(it => it.ordered).length;
    const paidN = items.filter(it => it.paid).length;
    const taxN = items.filter(it => it.tax_invoiced).length;
    const deliveredN = items.filter(it => it.delivered).length;
    const ns = notesByPo.get(p.id) || [];
    const issues = ns.filter(n => n.category === 'issue' && !n.resolved).length;
    const chks = checklistByPo.get(p.id) || [];
    const chkTotal = chks.length;
    const chkOpen = chks.filter(c => !c.done).length;
    const trackingDone = !!p.tracking_delivered;
    const allDone = trackingDone; // 발주 진행 = 별도 납품 체크 단일 기준
    const ctr = contracts.find(c => c.id === p.contract_id);
    const hospName = ctr?.hospital_name || p.hospital_name || '(병원 미지정)';
    const firstModel = items[0]?.model_name || items[0]?.item_name || '';
    const totalQty = items.reduce((s, it) => s + (Number(it.quantity)||0), 0);
    // 발주일자 = items 중 가장 이른 ordered_at
    const orderedDates = items.map(it => it.ordered_at).filter(Boolean).sort();
    const orderedDate = orderedDates[0] || null;
    // 예상납품일 = po.delivery_date
    const deliveryDate = p.delivery_date || null;
    // 거래처 정보
    const vendorInfo = vendorByName.get(p.manufacturer_name) || vendorByName.get(p.vendor_name) || null;
    return { ...p, items, total, orderedN, paidN, taxN, deliveredN, issues, chkTotal, chkOpen, trackingDone, allDone, ctr, hospName, firstModel, totalQty, orderedDate, deliveryDate, vendorInfo, notes: ns, checklist: chks };
  }), [pos, contracts, notesByPo, checklistByPo, vendorByName]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched.filter(p => {
      if (filter === 'done' && !p.allDone) return false;
      if (filter === 'ongoing' && p.allDone) return false;
      if (q) {
        const hay = `${p.po_no} ${p.hospName} ${p.manufacturer_name || ''} ${p.vendor_name || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [enriched, filter, search]);

  // 그룹화 (병원 또는 거래처)
  const groupedByHosp = useMemo(() => {
    const keyFn = groupBy === 'vendor'
      ? p => p.manufacturer_name || p.vendor_name || '(거래처 미정)'
      : p => p.hospName;
    const m = new Map();
    filtered.forEach(p => {
      const k = keyFn(p);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    });
    // 그룹 안에서 po_no 최신순
    return Array.from(m.entries()).map(([name, list]) => ({
      hospName: name,
      list: list.sort((a,b) => (b.po_no || '').localeCompare(a.po_no || '')),
      total: list.length,
      issues: list.reduce((s,p)=>s+p.issues, 0),
      lastUpdated: list.map(p => p.updated_at).filter(Boolean).sort().pop() || null,
      // 병원별 그룹일 때만 contract.delivery_target_date 추출 — 가장 가까운 미래 또는 첫 번째
      deliveryTargetDate: groupBy === 'hospital'
        ? (list.map(p => p.ctr?.delivery_target_date).filter(Boolean).sort()[0] || null)
        : null,
    })).sort((a,b) => (b.issues - a.issues) || a.hospName.localeCompare(b.hospName));
  }, [filtered, groupBy]);

  // 통계
  const stats = useMemo(() => ({
    ongoing:  enriched.filter(p => !p.allDone).length,
    done:     enriched.filter(p => p.allDone).length,
  }), [enriched]);

  // 진행중 PO 요약 (병원/거래처 unique 카운트)
  const activeSummary = useMemo(() => {
    const active = enriched.filter(p => !p.allDone);
    const hosps = new Set(active.map(p => p.hospName).filter(Boolean));
    const vends = new Set(active.map(p => p.manufacturer_name || p.vendor_name).filter(Boolean));
    return { hospCount: hosps.size, vendCount: vends.size, poCount: active.length };
  }, [enriched]);

  // 오늘 날짜 (예: 2026년 6월 11일 목요일)
  const todayLabel = useMemo(() => {
    const d = new Date();
    const dow = ['일','월','화','수','목','금','토'][d.getDay()];
    return `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일 ${dow}요일`;
  }, []);

  // yyyy.mm.dd hh:mm
  const fmtRelative = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2,'0');
    return `${d.getFullYear()}.${p(d.getMonth()+1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // 액션
  const toggleItem = async (item, field) => {
    const today = new Date().toISOString().slice(0,10);
    const patch = { [field]: !item[field] };
    if (field === 'delivered') patch.delivered_at = !item.delivered ? today : null;
    if (field === 'tax_invoiced') patch.tax_invoiced_at = !item.tax_invoiced ? today : null;
    if (field === 'ordered') patch.ordered_at = !item.ordered ? today : null;
    try { await dbUpdatePoItem(item.id, patch); reload(); }
    catch (e) { alert('업데이트 실패: ' + (e.message||e)); }
  };

  const [noteModal, setNoteModal] = useState(null); // { po }
  const [editModal, setEditModal] = useState(null); // { po }
  const [kakaoModal, setKakaoModal] = useState(null); // { vendor, text }

  const handleCancel = async (p) => {
    if (!confirm(`발주 [${p.po_no}] 를 취소할까요?\n거래처: ${p.manufacturer_name}\n금액: ${(p.total_amount||0).toLocaleString()}원\n\n발주서만 비활성화됩니다. 매입(줄 돈)은 「매입매출 관리 > 세금계산서」 탭에서 관리하세요.`)) return;
    try {
      const today = new Date().toISOString().slice(0,10);
      if (p.manufacturer_id) {
        try { await dbCancelPayableForPo({ poId: p.id, manufacturerId: p.manufacturer_id, txDate: today, reason: '발주 진행 화면에서 취소' }); } catch (_) {}
      }
      await dbUpdatePurchaseOrder(p.id, { status: '취소', is_active: false });
      await dbInsertPoNote({ po_id: p.id, category: 'change', body: '발주 취소 처리', author: user?.email || user?.name || null });
      reload();
      showToast('발주 취소됨');
    } catch (e) { alert('취소 실패: '+(e.message||e)); }
  };

  const handleResend = (p) => {
    const lines = (p.purchase_order_items || []).map(it => `· ${it.item_name || '-'}${it.model_name ? ' ('+it.model_name+')':''} × ${it.quantity || 1}`);
    const text = [
      `[변경 발주서] ${p.po_no || ''}`,
      `${p.hospital_name ? '병원: ' + p.hospital_name : ''}`,
      '',
      lines.join('\n'),
      '',
      `합계: ${(p.total_amount||0).toLocaleString()}원`,
      '',
      '변경 사항 반영된 발주서입니다. 확인 부탁드립니다.',
    ].filter(Boolean).join('\n');
    setKakaoModal({ vendor: p.manufacturer_name || '거래처', text });
  };
  return (
    <div style={{height:'100vh', background:'#f1f5f9', display:'flex', flexDirection:'column', overflow:'hidden'}}>
      <AppHeader
        title={viewer ? "발주 진행 (공유 보기)" : "발주 진행"}
        onLogoClick={viewer ? undefined : onBack}
        user={viewer ? null : user}
        onLogout={viewer ? null : onLogout}
        nav={viewer ? null : nav}
      />
      {toast && <div className={`fixed top-6 right-6 z-50 px-4 py-2 rounded-lg shadow-lg text-sm text-white ${toast.type==='error'?'bg-red-500':'bg-emerald-500'}`}>{toast.msg}</div>}

      <div className="px-3 py-4 md:px-6 md:py-6" style={{maxWidth:'1400px', margin:'0 auto', width:'100%', flex:1, overflowY:'auto'}}>
        {/* 상단 요약 strip — 오늘 날짜 + 진행중 요약 */}
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3 px-1">
          <div className="text-sm text-slate-600 whitespace-nowrap">📅 <span className="font-medium text-slate-800">{todayLabel}</span></div>
          <div className="text-sm text-slate-600 flex items-center gap-x-3 gap-y-1 flex-wrap">
            <span className="whitespace-nowrap">진행중 <span className="font-semibold text-slate-900">{activeSummary.poCount}</span>건</span>
            <span className="text-slate-300">·</span>
            <span className="whitespace-nowrap">병원 <span className="font-semibold text-slate-900">{activeSummary.hospCount}</span></span>
            <span className="text-slate-300">·</span>
            <span className="whitespace-nowrap">거래처 <span className="font-semibold text-slate-900">{activeSummary.vendCount}</span></span>
          </div>
        </div>
        {/* 통계 카드 — 진행중 / 납품완료 */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          {[
            { k:'ongoing', label:'진행중',     n:stats.ongoing, ring:'border-blue-500 ring-blue-200',       iconColor:'text-blue-600' },
            { k:'done',    label:'납품완료',   n:stats.done,    ring:'border-emerald-500 ring-emerald-200', iconColor:'text-emerald-600' },
          ].map(c => (
            <button key={c.k} onClick={()=>setFilter(c.k)}
              className={`text-left bg-white rounded-xl border p-4 transition-colors ${filter===c.k ? c.ring + ' ring-2' : 'border-slate-200 hover:border-slate-300'}`}>
              <div className="text-xs text-slate-500 mb-1">{c.label}</div>
              <div className={`text-2xl font-bold ${c.iconColor}`}>{c.n}<span className="text-sm font-normal text-slate-500 ml-1">건</span></div>
            </button>
          ))}
        </div>

        {/* 필터 바 */}
        <div className="bg-white rounded-xl border border-slate-200 px-4 py-3 mb-4 flex items-center gap-3 flex-wrap">
          <div className="flex gap-1 border border-slate-200 rounded-lg p-0.5">
            {[{k:'all',l:'전체'},{k:'ongoing',l:'진행중'},{k:'done',l:'납품완료'}].map(t => (
              <button key={t.k} onClick={()=>setFilter(t.k)}
                className={`px-3 py-1.5 text-sm rounded transition-colors ${filter===t.k?'bg-slate-900 text-white font-semibold':'text-slate-600 hover:bg-slate-50'}`}>{t.l}</button>
            ))}
          </div>
          <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="발주번호·병원·거래처 검색"
            className="flex-1 max-w-sm bg-white border border-slate-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
          <div className="flex gap-1 border border-slate-200 rounded-lg p-0.5">
            <button onClick={()=>setGroupBy('hospital')}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${groupBy==='hospital'?'bg-slate-900 text-white font-semibold':'text-slate-600 hover:bg-slate-50'}`}>병원별</button>
            <button onClick={()=>setGroupBy('vendor')}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${groupBy==='vendor'?'bg-slate-900 text-white font-semibold':'text-slate-600 hover:bg-slate-50'}`}>거래처별</button>
          </div>
          <span className="text-xs text-slate-500">{filtered.length}건 / 전체 {enriched.length}</span>
          {!viewer && (
            <button
              onClick={async () => {
                const url = `https://mediquote-ecru.vercel.app/?share=tracking&token=${SHARE_TOKEN}`;
                try {
                  await navigator.clipboard.writeText(url);
                  showToast('공유 URL이 복사되었습니다 (팀원에게 카톡으로 보내세요)');
                } catch (_) {
                  prompt('아래 URL을 복사해서 공유하세요:', url);
                }
              }}
              title="팀원에게 공유 (읽기 전용 링크)"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors font-medium"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/>
              </svg>
              공유 URL 복사
            </button>
          )}
        </div>

        {/* 병원별 그룹 */}
        {loading ? (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400">불러오는 중...</div>
        ) : groupedByHosp.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400 text-sm">표시할 발주가 없습니다.</div>
        ) : (
          <div className="space-y-4">
            {groupedByHosp.map(g => {
              const isOpen = !!expandedGroups[g.hospName];
              return (
              <div key={g.hospName} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <button
                  onClick={()=>setExpandedGroups(p => ({ ...p, [g.hospName]: !p[g.hospName] }))}
                  className="w-full px-4 py-2.5 bg-slate-50 hover:bg-slate-100 border-b border-slate-100 flex items-center gap-2 transition-colors text-left"
                >
                  <span className="font-semibold text-slate-800">{g.hospName}</span>
                  {g.deliveryTargetDate && (
                    <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded font-semibold" title="납기일">📅 {g.deliveryTargetDate}</span>
                  )}
                  <span className="text-xs text-slate-500">{g.total}개 발주</span>
                  {g.lastUpdated && <span className="text-xs text-slate-400">· 마지막 변경 {fmtRelative(g.lastUpdated)}</span>}
                  {g.issues > 0 && <span className="text-xs bg-rose-100 text-rose-700 px-2 py-0.5 rounded font-semibold">⚠ 이슈 {g.issues}</span>}
                  <span className="ml-auto text-slate-400 text-xs select-none">{isOpen ? '▼' : '▶'}</span>
                </button>
                {isOpen && (
                <>
                  <div className="md:hidden divide-y divide-slate-100">
                    {g.list.map(p => (
                      <PoTrackingCard key={p.id} p={p} groupBy={groupBy} setPos={setPos} reload={reload} showToast={showToast} onChecklist={() => setChecklistModal(p)} />
                    ))}
                  </div>
                <table className="w-full text-sm hidden md:table">
                  <thead className="bg-slate-50 text-slate-500 text-xs uppercase border-b border-slate-100">
                    <tr>
                      <th className="px-3 py-2 text-left w-28">발주번호</th>
                      <th className="px-3 py-2 text-left w-48">{groupBy === 'vendor' ? '병원' : '거래처 / 담당자'}</th>
                      <th className="px-3 py-2 text-left">모델 / 수량</th>
                      <th className="px-3 py-2 text-center w-24">발주일자</th>
                      <th className="px-3 py-2 text-center w-24">예상납품일</th>
                      <th className="px-3 py-2 text-center w-16">메모</th>
                      <th className="px-3 py-2 text-center w-20">납품</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.list.map(p => {
                      const toggleTrackingDelivered = async () => {
                        const newVal = !p.trackingDone;
                        const today = new Date().toISOString().slice(0,10);
                        // 낙관적 UI
                        setPos(prev => prev.map(po => po.id === p.id ? {
                          ...po,
                          tracking_delivered: newVal,
                          tracking_delivered_at: newVal ? (po.tracking_delivered_at || today) : null,
                        } : po));
                        try {
                          await dbUpdatePurchaseOrder(p.id, {
                            tracking_delivered: newVal,
                            tracking_delivered_at: newVal ? today : null,
                          });
                        } catch (e) {
                          showToast('저장 실패: '+(e.message||e), 'error');
                          reload();
                        }
                      };
                      const vi = p.vendorInfo;
                      const fmtDate = (s) => s ? s.slice(5).replace('-','/') : '—';
                      return (
                        <tr key={p.id} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-3 py-2 text-xs font-mono text-slate-600 align-top">{p.po_no || '—'}</td>
                          <td className="px-3 py-2 align-top">
                            {groupBy === 'vendor' ? (
                              <span className="text-slate-800">{p.hospName}</span>
                            ) : (
                              <div>
                                <div className="text-slate-800">{p.manufacturer_name || p.vendor_name || '—'}</div>
                                {vi && (vi.contact_name || vi.contact_phone) && (
                                  <div className="text-[11px] text-slate-500 mt-0.5">
                                    {vi.contact_name && <span>{vi.contact_name}</span>}
                                    {vi.contact_name && vi.contact_phone && <span className="mx-1 text-slate-300">·</span>}
                                    {vi.contact_phone && <span className="font-mono">{vi.contact_phone}</span>}
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-slate-700 align-top">
                            <span className="font-medium">{p.firstModel || '—'}</span>
                            {p.total > 1 && <span className="text-slate-400 text-xs"> 외 {p.total - 1}건</span>}
                            <span className="text-slate-400 text-xs ml-2">({p.totalQty}개)</span>
                          </td>
                          <td className="px-3 py-2 text-center text-xs text-slate-600 font-mono align-top">{fmtDate(p.orderedDate)}</td>
                          <td className="px-3 py-2 text-center align-top">
                            <EditableDeliveryDate po={p} setPos={setPos} reload={reload} showToast={showToast} />
                          </td>
                          <td className="px-3 py-2 text-center align-top">
                            <button onClick={()=>setChecklistModal(p)} title="메모/체크리스트"
                              className={`relative inline-flex items-center justify-center w-8 h-7 rounded transition-colors ${
                                p.chkOpen > 0 ? 'bg-amber-100 text-amber-700 hover:bg-amber-200 ring-1 ring-amber-300'
                                : p.chkTotal > 0 ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                                : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                              }`}>
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>
                              {p.chkOpen > 0 && (
                                <span className="absolute -top-1 -right-1 bg-rose-500 text-white text-[10px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">{p.chkOpen}</span>
                              )}
                            </button>
                          </td>
                          <td className="px-3 py-2 text-center align-top">
                            <button onClick={toggleTrackingDelivered} title={p.trackingDone ? '납품완료 (클릭=해제)' : '납품 체크'}
                              className={`inline-flex items-center justify-center w-8 h-7 rounded transition-colors ${
                                p.trackingDone ? 'bg-emerald-500 text-white hover:bg-emerald-600' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                              }`}>
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {checklistModal && (
        <PoChecklistModal
          po={checklistModal}
          items={checklistByPo.get(checklistModal.id) || []}
          author={user?.email || (viewer ? 'shared' : null)}
          readOnly={false}
          onClose={() => setChecklistModal(null)}
          onChanged={silentReload}
        />
      )}
    </div>
  );
}

function EditableDeliveryDate({ po, setPos, reload, showToast }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(po.delivery_date || '');
  useEffect(() => { setVal(po.delivery_date || ''); }, [po.delivery_date]);
  const fmtDate = (s) => s ? s.slice(5).replace('-','/') : '—';
  const save = async () => {
    const newDate = val || null;
    if (newDate === (po.delivery_date || null)) { setEditing(false); return; }
    setPos(prev => prev.map(x => x.id === po.id ? { ...x, delivery_date: newDate } : x));
    setEditing(false);
    try {
      await dbUpdatePurchaseOrder(po.id, { delivery_date: newDate });
    } catch (e) {
      showToast('저장 실패: ' + (e.message || e), 'error');
      reload();
    }
  };
  if (editing) {
    return (
      <input
        type="date"
        autoFocus
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') { setVal(po.delivery_date || ''); setEditing(false); }
        }}
        className="w-28 border border-blue-400 rounded px-1.5 py-0.5 text-xs font-mono text-center focus:outline-none"
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      title="클릭하여 예상납품일 수정"
      className="text-xs text-slate-600 font-mono hover:bg-blue-50 rounded px-2 py-0.5 transition-colors"
    >
      {fmtDate(po.delivery_date)}
    </button>
  );
}

function PoChecklistModal({ po, items = [], author, readOnly = false, onClose, onChanged }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  const handleAdd = async () => {
    if (readOnly) return;
    const content = text.trim();
    if (!content) return;
    setSaving(true);
    try {
      await dbInsertChecklist({ po_id: po.id, content, author });
      setText('');
      onChanged?.();
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (e) { alert('추가 실패: '+(e.message||e)); }
    finally { setSaving(false); }
  };

  const handleToggle = async (it) => {
    if (readOnly) return;
    try {
      await dbUpdateChecklist(it.id, {
        done: !it.done,
        done_at: !it.done ? new Date().toISOString() : null,
      });
      onChanged?.();
    } catch (e) { alert('변경 실패: '+(e.message||e)); }
  };

  const handleDelete = async (id) => {
    if (readOnly) return;
    if (!confirm('이 항목을 삭제할까요?')) return;
    try {
      await dbDeleteChecklist(id);
      onChanged?.();
    } catch (e) { alert('삭제 실패: '+(e.message||e)); }
  };

  const openCount = items.filter(i => !i.done).length;
  const doneCount = items.length - openCount;

  return (
    <ModalShell onClose={onClose} title={`체크리스트 — ${po.po_no || ''}`}>
      <div className="flex items-center gap-3 text-sm pb-3 border-b border-slate-100">
        <span className="text-slate-600">{po.manufacturer_name || po.vendor_name || ''}</span>
        <span className="ml-auto text-xs text-slate-500">
          미완료 <span className="font-semibold text-rose-600">{openCount}</span> · 완료 <span className="font-semibold text-emerald-600">{doneCount}</span>
        </span>
      </div>
      <div className="py-3 max-h-[50vh] overflow-y-auto">
        {items.length === 0 ? (
          <div className="text-center text-sm text-slate-400 py-8">아직 등록된 체크리스트가 없습니다.</div>
        ) : (
          <ul className="space-y-1.5">
            {items.map(it => (
              <li key={it.id} className={`flex items-start gap-2 px-2 py-1.5 rounded hover:bg-slate-50 ${it.done ? 'opacity-60' : ''}`}>
                <input type="checkbox" checked={!!it.done} onChange={()=>handleToggle(it)}
                  disabled={readOnly}
                  className={`mt-1 w-4 h-4 rounded border-slate-300 ${readOnly ? 'cursor-default' : 'cursor-pointer'}`}/>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm ${it.done ? 'line-through text-slate-500' : 'text-slate-800'}`}>{it.content}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {it.author && <span>by {it.author} · </span>}
                    {new Date(it.created_at).toLocaleDateString('ko-KR')}
                    {it.done && it.done_at && <span> · 완료 {new Date(it.done_at).toLocaleDateString('ko-KR')}</span>}
                  </div>
                </div>
                {!readOnly && (
                  <button onClick={()=>handleDelete(it.id)} title="삭제"
                    className="text-slate-400 hover:text-rose-500 text-xs px-1 shrink-0">✕</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {readOnly ? (
        <div className="pt-3 border-t border-slate-100 text-xs text-slate-400 text-center">읽기 전용 모드 — 편집은 관리자만 가능합니다.</div>
      ) : (
        <div className="pt-3 border-t border-slate-100 flex gap-2">
          <input ref={inputRef} type="text" value={text} onChange={e=>setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !saving) handleAdd(); }}
            placeholder="새 체크리스트 항목 (Enter로 추가)"
            className="flex-1 border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400" autoFocus/>
          <button onClick={handleAdd} disabled={saving || !text.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded font-semibold">추가</button>
        </div>
      )}
    </ModalShell>
  );
}

function PoNoteModal({ po, user, notes = [], onClose, onChanged }) {
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('general');
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await dbInsertPoNote({
        po_id: po.id,
        category,
        body: body.trim(),
        author: user?.email || user?.name || null,
      });
      setBody(''); setCategory('general');
      onChanged && onChanged();
    } catch (e) { alert('추가 실패: '+(e.message||e)); }
    setSaving(false);
  };
  const toggleResolved = async (n) => {
    try {
      await dbUpdatePoNote(n.id, { resolved: !n.resolved, resolved_at: !n.resolved ? new Date().toISOString() : null });
      onChanged && onChanged();
    } catch (e) { alert('업데이트 실패: '+(e.message||e)); }
  };
  const handleDelete = async (n) => {
    if (!confirm('이 메모를 삭제할까요?')) return;
    try { await dbDeletePoNote(n.id); onChanged && onChanged(); }
    catch (e) { alert('삭제 실패: '+(e.message||e)); }
  };

  return (
    <ModalShell title={`메모 / 이슈 — ${po.po_no || '발주'}`} subtitle={`${po.manufacturer_name || ''} · ${po.hospital_name || ''}`} onClose={onClose} wide>
      {/* 신규 추가 */}
      <div className="bg-slate-50 border border-slate-200 rounded p-3 mb-4">
        <div className="flex gap-2 mb-2">
          {[{k:'general',l:'메모'},{k:'issue',l:'이슈'},{k:'change',l:'변경'}].map(t => (
            <button key={t.k} onClick={()=>setCategory(t.k)}
              className={`px-3 py-1 text-xs rounded border-2 ${category===t.k?(t.k==='issue'?'border-rose-500 bg-rose-50':t.k==='change'?'border-amber-500 bg-amber-50':'border-blue-500 bg-blue-50')+' font-semibold':'border-slate-200'}`}>
              {t.l}
            </button>
          ))}
        </div>
        <textarea value={body} onChange={e=>setBody(e.target.value)} rows={2}
          placeholder="예: 원장이 모델 X로 변경 요청 / 거래처에서 5/10 도착 약속 / 세금계산서 5/15 발행 예정"
          className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400 mb-2" />
        <div className="flex justify-end">
          <button onClick={handleAdd} disabled={saving || !body.trim()}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-semibold disabled:opacity-40">
            {saving ? '저장 중...' : '+ 추가'}
          </button>
        </div>
      </div>

      {/* 기존 메모 리스트 */}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {notes.length === 0 && <div className="text-center text-slate-400 text-sm py-8">메모가 없습니다.</div>}
        {notes.map(n => (
          <div key={n.id} className="flex items-start gap-2 p-2.5 border border-slate-100 rounded hover:bg-slate-50">
            <span className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-semibold ${n.category==='issue'?(n.resolved?'bg-emerald-100 text-emerald-700':'bg-rose-100 text-rose-700'):n.category==='change'?'bg-amber-100 text-amber-700':'bg-slate-100 text-slate-600'}`}>
              {n.category==='issue' ? (n.resolved?'해결됨':'이슈') : n.category==='change' ? '변경' : '메모'}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-slate-800 whitespace-pre-wrap">{n.body}</div>
              <div className="text-[10px] text-slate-400 mt-1">
                {n.author || '익명'} · {n.created_at?.slice(0,16).replace('T',' ')}
              </div>
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              {n.category==='issue' && (
                <button onClick={()=>toggleResolved(n)} className={`text-[11px] px-2 py-0.5 rounded ${n.resolved?'bg-slate-100 text-slate-600':'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'}`}>
                  {n.resolved ? '다시 열기' : '해결'}
                </button>
              )}
              <button onClick={()=>handleDelete(n)} className="text-[11px] text-rose-400 hover:text-rose-600">삭제</button>
            </div>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

/* ========== 발주 빠른 수정 모달 — 매입가·수량만 (외상매입은 세금계산서 탭으로 일원화) ========== */
function PoQuickEditModal({ po, user, onClose, onSaved }) {
  const [vendor, setVendor] = useState(po.manufacturer_name || '');
  const [items, setItems] = useState((po.purchase_order_items || []).map(it => ({
    ...it,
    _quantity: String(it.quantity ?? 1),
    _unit_price: Number(it.unit_price || 0).toLocaleString('ko-KR'),
  })));
  const [saving, setSaving] = useState(false);

  const parseAmt = v => Number((v||'').toString().replace(/[,\s]/g,'')) || 0;
  const fmtInput = v => { const d = (v||'').toString().replace(/[^\d]/g,''); return d ? Number(d).toLocaleString('ko-KR') : ''; };

  const updateItem = (id, patch) => setItems(arr => arr.map(it => it.id === id ? {...it, ...patch} : it));

  const newTotal = items.reduce((s, it) => s + parseAmt(it._unit_price) * (Number(it._quantity) || 0), 0);
  const oldTotal = po.total_amount || 0;
  const diff = newTotal - oldTotal;

  // 세금계산서 ✅ 품목만 합산 (외상매입 조정 기준)
  const taxedNewTotal = items.filter(it => it.tax_invoiced).reduce((s, it) => s + parseAmt(it._unit_price) * (Number(it._quantity) || 0), 0);

  const handleSave = async () => {
    setSaving(true);
    try {
      const changes = [];
      // 1. 각 item 업데이트
      for (const it of items) {
        const oldQty = (po.purchase_order_items || []).find(x => x.id === it.id)?.quantity || 1;
        const oldUnit = (po.purchase_order_items || []).find(x => x.id === it.id)?.unit_price || 0;
        const newQty = Number(it._quantity) || 1;
        const newUnit = parseAmt(it._unit_price);
        if (oldQty !== newQty || oldUnit !== newUnit) {
          await dbUpdatePoItem(it.id, { quantity: newQty, unit_price: newUnit, amount: newQty * newUnit });
          if (oldUnit !== newUnit) changes.push(`${it.item_name || it.model_name || '품목'}: 매입가 ${oldUnit.toLocaleString()} → ${newUnit.toLocaleString()}`);
          if (oldQty !== newQty) changes.push(`${it.item_name || it.model_name || '품목'}: 수량 ${oldQty} → ${newQty}`);
        }
      }
      // 2. PO 헤더 업데이트 (거래처명·총액)
      const headerPatch = { total_amount: newTotal };
      if (vendor !== po.manufacturer_name) {
        headerPatch.manufacturer_name = vendor;
        headerPatch.vendor_name = vendor;
        changes.push(`거래처: ${po.manufacturer_name} → ${vendor}`);
      }
      await dbUpdatePurchaseOrder(po.id, headerPatch);

      // 3. (제거됨) 외상매입은 「매입매출 관리 > 세금계산서」 탭으로 일원화 —
      //    발주 수정은 줄 돈(payable)에 반영하지 않는다 (이중계상 방지).

      // 4. 변경 사항 메모 자동 추가
      if (changes.length > 0) {
        await dbInsertPoNote({
          po_id: po.id,
          category: 'change',
          body: '발주 수정\n' + changes.map(c => '· ' + c).join('\n'),
          author: user?.email || user?.name || null,
        });
      }
      onSaved && onSaved();
      onClose();
    } catch (e) { alert('저장 실패: ' + (e.message||e)); }
    setSaving(false);
  };

  const inputCls = "bg-white border border-slate-200 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-400";

  return (
    <ModalShell title={`발주 수정 — ${po.po_no || ''}`} subtitle={po.hospital_name || ''} onClose={onClose} wide>
      <div className="mb-3">
        <label className="text-xs text-slate-500 mb-1 block">거래처</label>
        <input type="text" value={vendor} onChange={e=>setVendor(e.target.value)} className={`w-full ${inputCls}`} />
      </div>

      <div className="border border-slate-200 rounded overflow-hidden mb-3">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs">
            <tr>
              <th className="px-2 py-1.5 text-left">품명 / 모델</th>
              <th className="px-2 py-1.5 text-center w-20">수량</th>
              <th className="px-2 py-1.5 text-right w-32">매입가</th>
              <th className="px-2 py-1.5 text-right w-32">소계</th>
              <th className="px-2 py-1.5 text-center w-16">세금</th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => {
              const sub = (Number(it._quantity)||0) * parseAmt(it._unit_price);
              return (
                <tr key={it.id} className="border-t border-slate-100">
                  <td className="px-2 py-1.5">
                    <div className="text-slate-800">{it.item_name || '—'}</div>
                    <div className="text-[11px] text-slate-500">{it.model_name || ''}</div>
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <input type="text" value={it._quantity}
                      onChange={e => updateItem(it.id, { _quantity: e.target.value.replace(/[^\d]/g,'') })}
                      className={`w-16 ${inputCls} text-center`} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <input type="text" value={it._unit_price}
                      onChange={e => updateItem(it.id, { _unit_price: fmtInput(e.target.value) })}
                      className={`w-28 ${inputCls} font-mono text-right`} />
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-slate-700">{sub.toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-center">
                    <span className={`text-sm ${it.tax_invoiced ? 'text-emerald-600' : 'text-slate-300'}`}>{it.tax_invoiced ? '✅' : '⬜'}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-slate-50 font-semibold">
            <tr>
              <td colSpan={3} className="px-2 py-2 text-right text-slate-700">합계</td>
              <td className="px-2 py-2 text-right font-mono">{newTotal.toLocaleString()}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="bg-slate-50 border border-slate-200 rounded p-3 mb-4 text-xs text-slate-600">
        <div className="flex justify-between">
          <span>기존 총액</span>
          <span className="font-mono">{oldTotal.toLocaleString()}</span>
        </div>
        <div className="flex justify-between">
          <span>변경 후 총액</span>
          <span className="font-mono">{newTotal.toLocaleString()}</span>
        </div>
        <div className={`flex justify-between font-semibold pt-1 mt-1 border-t border-slate-200 ${diff > 0 ? 'text-amber-700' : diff < 0 ? 'text-emerald-700' : 'text-slate-600'}`}>
          <span>차액</span>
          <span className="font-mono">{diff > 0 ? '+' : ''}{diff.toLocaleString()}</span>
        </div>
        {taxedNewTotal > 0 && (
          <div className="text-[10px] text-slate-400 mt-2">
            * 세금계산서 ✅ 품목 합계 {taxedNewTotal.toLocaleString()}원. 매입(줄 돈)은 「매입매출 관리 &gt; 세금계산서」 탭에서 입력하세요. (발주 화면은 외상에 반영하지 않음)
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500 hover:bg-slate-100 rounded">취소</button>
        <button onClick={handleSave} disabled={saving} className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded font-semibold disabled:opacity-40">
          {saving ? '저장 중...' : '저장'}
        </button>
      </div>
    </ModalShell>
  );
}

/* ============================================================
   HOME 대시보드 — 출근 첫 화면
   ============================================================ */
function HomePage({ user, onLogout, nav }) {
  const [loading, setLoading] = useState(true);
  const [pos, setPos] = useState([]);
  const [leads, setLeads] = useState([]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [poData, ldData] = await Promise.all([
        sb.from('purchase_orders').select('*, purchase_order_items(*)').eq('is_active', true).order('created_at',{ascending:false}).then(r => r.data || []),
        dbLoadLeads(),
      ]);
      setPos(poData);
      setLeads(ldData);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // 발주 4단계 미완료 카운트
  const poStats = useMemo(() => {
    let notOrdered=0, notPaid=0, notTax=0, notDelivered=0, done=0;
    pos.forEach(p => {
      const items = p.purchase_order_items || [];
      const total = items.length;
      if (total === 0) return;
      const o = items.filter(it=>it.ordered).length;
      const pd = items.filter(it=>it.paid).length;
      const t = items.filter(it=>it.tax_invoiced).length;
      const d = items.filter(it=>it.delivered).length;
      const all = o===total && pd===total && t===total && d===total;
      if (all) { done++; return; }
      if (o<total) notOrdered++;
      if (pd<total) notPaid++;
      if (t<total) notTax++;
      if (d<total) notDelivered++;
    });
    return { notOrdered, notPaid, notTax, notDelivered, done, total: pos.length };
  }, [pos]);

  // 신규 문의 lead (영업관리 신규문의 단계)
  const newInquiries = useMemo(() => leads.filter(l => (l.stage || '신규문의') === '신규문의')
    .sort((a,b) => (b.created_at||'').localeCompare(a.created_at||'')), [leads]);


  const greeting = (() => { const h = new Date().getHours(); return h<11?'좋은 아침이에요':h<14?'점심 잘 챙기세요':h<18?'좋은 오후예요':'고생하셨어요'; })();

  // 영업관리에서 lead 열기
  const openLead = (lead) => {
    // 영업관리 페이지로 점프 (lead 클릭은 LeadsPage에서 자동 처리되도록 lead.id 전달 어려움 → 일단 leads로 이동)
    nav?.leads?.();
  };

  return (
    <div style={{height:'100vh', background:'#f1f5f9', display:'flex', flexDirection:'column', overflow:'hidden'}}>
      <AppHeader title="홈 대시보드" user={user} onLogout={onLogout} nav={nav} />

      <div style={{maxWidth:'1400px', margin:'0 auto', padding:'24px', width:'100%', flex:1, overflowY:'auto'}}>
        {/* 인사 */}
        <div className="mb-4">
          <div className="text-sm text-slate-500">{greeting}, {user?.email?.split('@')[0] || ''}님</div>
          <div className="text-lg font-bold text-slate-800">{new Date().toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'long'})}</div>
        </div>

        {/* 1행 — 발주 4단계 미완료 (클릭 시 발주 진행으로 점프) */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-slate-700">📦 발주 진행</h3>
            <button onClick={() => nav?.poTracking?.()} className="text-xs text-blue-500 hover:text-blue-700">전체 보기 →</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label:'발주 미완료',     n:poStats.notOrdered,   c:'text-blue-600',     k:'ordered' },
              { label:'입금 미완료',     n:poStats.notPaid,      c:'text-violet-600',   k:'paid' },
              { label:'세금계산서 미수령', n:poStats.notTax,       c:'text-amber-600',    k:'tax' },
              { label:'납품 미완료',     n:poStats.notDelivered, c:'text-emerald-600',  k:'delivered' },
              { label:'완료',           n:poStats.done,         c:'text-slate-500',    k:'done' },
            ].map(card => (
              <button key={card.k} onClick={() => nav?.poTracking?.()}
                className="bg-white rounded-xl border border-slate-200 p-4 text-left hover:border-blue-300 transition-colors">
                <div className="text-xs text-slate-500 mb-1">{card.label}</div>
                <div className={`text-2xl font-bold ${card.c}`}>{card.n}<span className="text-sm font-normal text-slate-500 ml-1">건</span></div>
              </button>
            ))}
          </div>
        </div>

        {/* 2행 — 신규 문의 + 캘린더 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 신규 문의 (영업관리 신규문의 단계) */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 font-semibold text-sm text-slate-700 flex items-center justify-between">
              <span>🆕 신규 문의</span>
              <button onClick={() => nav?.leads?.()} className="text-xs text-blue-500 hover:text-blue-700">영업관리 →</button>
            </div>
            <div className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
              {newInquiries.length === 0 ? (
                <div className="px-4 py-8 text-center text-slate-400 text-sm">신규 문의가 없습니다</div>
              ) : newInquiries.map(l => (
                <button key={l.id} onClick={() => openLead(l)} className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 truncate">{l.hospital_name || '(병원 미정)'}</div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {l.contact_name || ''}{l.contact_phone ? ' · ' + l.contact_phone : ''}
                      {l.source ? ' · ' + l.source : ''}
                    </div>
                    {l.memo && <div className="text-[11px] text-slate-400 truncate mt-0.5">{l.memo}</div>}
                  </div>
                  <span className="text-[10px] text-slate-400 shrink-0">{(l.created_at || '').slice(0,10)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 영업관리 캘린더 */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 font-semibold text-sm text-slate-700 flex items-center justify-between">
              <span>📅 캘린더</span>
              <button onClick={() => nav?.leads?.()} className="text-xs text-blue-500 hover:text-blue-700">영업관리 →</button>
            </div>
            <div className="p-2">
              <LeadsCalendar leads={leads} onEdit={openLead} onNewLead={() => nav?.leads?.()} onLoadQuote={() => nav?.leads?.()} />
            </div>
          </div>
        </div>

        {loading && <div className="text-center text-slate-400 text-xs mt-3">불러오는 중...</div>}
      </div>
    </div>
  );
}

/* ============================================================
   MAIN APP
   ============================================================ */
// 발주 진행 공유 모드 — URL ?share=tracking&token=XXX 로 진입 시 viewer 활성화
// 토큰 변경/회전: 아래 상수만 바꾸고 재배포 → 기존 링크 무효화
const SHARE_TOKEN = 'dwm-2026-team-tracking';

function detectShareMode() {
  try {
    // tracking.* 서브도메인 → 토큰 없이 자동 viewer 진입
    if (window.location.hostname.startsWith('tracking.')) return true;
    // ?share=tracking&token=XXX
    const p = new URLSearchParams(window.location.search);
    if (p.get('share') === 'tracking' && p.get('token') === SHARE_TOKEN) return true;
  } catch (_) {}
  return false;
}

function App() {
  const [shareMode] = useState(() => detectShareMode());
  const [quoteInfo, setQuoteInfo] = useState({
    hospital: '',
    doctor: '',
    dept: '',
    quoteNo: '',
    date: getToday(),
    validity: getValidity(),
  });
  const [categories, setCategories] = useState([]);
  const [globalDiscount, setGlobalDiscount] = useState({ type:'rate', value:0 });
  const [vatIncluded, setVatIncluded] = useState(false);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState({});
  const [addEquipOpen, setAddEquipOpen] = useState(false);
  const [altModal, setAltModal] = useState(null);
  const [pdfModal, setPdfModal] = useState(false);
  const [productModal, setProductModal] = useState(null);   // { modelId, modelName, manufacturer, catName, catColorKey }
  const [mfrModal, setMfrModal] = useState(null);           // manufacturerName string
  const [toasts, setToasts] = useState([]);
  const [view, setView] = useState('home'); // 'home' | 'editor' | 'list' | 'manage' | 'leads' | 'po-plan' | 'po-tracking' | 'payables' | 'hospitals' | 'service'
  const [poPlanLead, setPoPlanLead] = useState(null);
  const [leadsStageFilter, setLeadsStageFilter] = useState(null); // 영업관리 진입 시 초기 단계 필터 (발주계획서 뒤로가기 → '발주진행중')
  const [listInitialTab, setListInitialTab] = useState('saved');
  const [listInitialDept, setListInitialDept] = useState(null);
  const [hospitalsInitialHospId, setHospitalsInitialHospId] = useState(null);
  const [hospitalsInitialTab, setHospitalsInitialTab] = useState('info');
  const [currentLead, setCurrentLead] = useState(null);
  const [quoteSaving, setQuoteSaving] = useState(false);

  // ── 앱 레벨 캐시 ──────────────────────────────────────────
  const [appLeads, setAppLeads] = useState([]);
  const [appLeadsLoading, setAppLeadsLoading] = useState(true);
  const [appQuotes, setAppQuotes] = useState([]);
  const [appQuotesLoading, setAppQuotesLoading] = useState(true);
  const [appManufacturers, setAppManufacturers] = useState([]);
  const [appHospitals, setAppHospitals] = useState([]);

  const goToHospital = (hospId, tab = 'info') => {
    setHospitalsInitialHospId(hospId);
    setHospitalsInitialTab(tab);
    setView('hospitals');
  };
  const [customEquips, setCustomEquips] = useState([]);
  const [dynCats, setDynCats] = useState([]);
  const [dynItems, setDynItems] = useState([]);
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  // 인증 초기화
  useEffect(() => {
    sb.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
    const { data: { subscription } } = sb.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleLogout = useCallback(async () => {
    await sb.auth.signOut();
  }, []);

  // 인증 완료 후 모든 데이터 프리로드 (user가 설정된 후 실행)
  useEffect(() => {
    if (!user) return;
    dbLoadLeads()
      .then(data => { setAppLeads(data); setAppLeadsLoading(false); })
      .catch(e => { console.error(e); setAppLeadsLoading(false); });
    dbLoadQuotes()
      .then(data => { setAppQuotes(data); setAppQuotesLoading(false); })
      .catch(e => { console.error(e); setAppQuotesLoading(false); });
    dbLoadManufacturers().then(setAppManufacturers).catch(console.error);
    dbLoadHospitals().then(setAppHospitals).catch(console.error);
    dbLoadEquip().then(setCustomEquips).catch(console.error);
    dbLoadDynCats().then(setDynCats).catch(console.error);
    dbLoadDynItems().then(setDynItems).catch(console.error);
  }, [user]);

  const addToast = useCallback((msg, type='success') => {
    const id = Date.now();
    setToasts(p => [...p, {id, msg, type}]);
    setTimeout(() => setToasts(p => p.filter(t=>t.id!==id)), 3000);
  }, []);

  const handleSave = useCallback(async () => {
    if (quoteSaving) return;
    setQuoteSaving(true);
    try {
      const quoteNo = await dbGenerateQuoteNo();
      const s = calcSummary(categories, globalDiscount);
      const supplyAmt = vatIncluded ? Math.floor(s.finalAmt / 1.1) : s.finalAmt;
      const entry = {
        quoteNo,
        finalAmt: supplyAmt,
        quoteInfo: { ...quoteInfo, quoteNo },
        categories: JSON.parse(JSON.stringify(categories)),
        globalDiscount: { ...globalDiscount },
        vatIncluded,
        author: user?.email || null,
        lead_id: currentLead?.id || null,
      };
      const savedQuoteNo = await dbSaveQuote(entry);
      setQuoteInfo(p => ({ ...p, quoteNo: savedQuoteNo }));
      // 연결된 리드가 있으면 quote_no 자동 업데이트
      if (currentLead?.id) {
        await dbUpdateLead(currentLead.id, { quote_no: savedQuoteNo });
        setCurrentLead(p => p ? { ...p, quote_no: savedQuoteNo } : p);
        setAppLeads(p => p.map(l => l.id === currentLead.id ? { ...l, quote_no: savedQuoteNo } : l));
      }
      // 앱 캐시 갱신
      dbLoadQuotes().then(setAppQuotes).catch(console.error);
      addToast(`견적이 저장되었습니다. (${savedQuoteNo})`, 'success');
    } catch(e) {
      console.error('견적 저장 오류:', e);
      addToast('저장 중 오류가 발생했습니다.', 'error');
    } finally {
      setQuoteSaving(false);
    }
  }, [quoteSaving, quoteInfo, categories, globalDiscount, vatIncluded, currentLead, addToast]);

  const handleRevisionSave = useCallback(async () => {
    if (quoteSaving) return;
    if (!quoteInfo.quoteNo) { addToast('먼저 견적을 저장한 후 수정 저장하세요.', 'error'); return; }
    setQuoteSaving(true);
    try {
      const revNo = await dbGenerateRevisionNo(quoteInfo.quoteNo);
      const s = calcSummary(categories, globalDiscount);
      const supplyAmt = vatIncluded ? Math.floor(s.finalAmt / 1.1) : s.finalAmt;
      const entry = {
        quoteNo: revNo,
        finalAmt: supplyAmt,
        quoteInfo: { ...quoteInfo, quoteNo: revNo },
        categories: JSON.parse(JSON.stringify(categories)),
        globalDiscount: { ...globalDiscount },
        vatIncluded,
        author: user?.email || null,
        lead_id: currentLead?.id || null,
      };
      const savedRevNo = await dbSaveQuote(entry);
      setQuoteInfo(p => ({ ...p, quoteNo: savedRevNo }));
      // 연결된 리드가 있으면 quote_no 자동 업데이트
      if (currentLead?.id) {
        await dbUpdateLead(currentLead.id, { quote_no: savedRevNo });
        setCurrentLead(p => p ? { ...p, quote_no: savedRevNo } : p);
        setAppLeads(p => p.map(l => l.id === currentLead.id ? { ...l, quote_no: savedRevNo } : l));
      }
      // 앱 캐시 갱신
      dbLoadQuotes().then(setAppQuotes).catch(console.error);
      addToast(`수정 견적이 저장되었습니다. (${savedRevNo})`, 'success');
    } catch(e) {
      console.error('수정 저장 오류:', e);
      addToast('저장 중 오류가 발생했습니다.', 'error');
    } finally {
      setQuoteSaving(false);
    }
  }, [quoteSaving, quoteInfo, categories, globalDiscount, vatIncluded, currentLead, addToast]);

  const handleLoadEntry = useCallback((entry) => {
    setQuoteInfo(entry.quoteInfo);
    setCategories(JSON.parse(JSON.stringify(entry.categories)));
    setGlobalDiscount(entry.globalDiscount);
    setVatIncluded(entry.vatIncluded);
    setView('editor');
    addToast(entry.quoteNo ? `견적 ${entry.quoteNo} 불러왔습니다.` : '견적 내용을 불러왔습니다.', 'success');
  }, [addToast]);

  const updateItem = useCallback((catId, updatedItem) => {
    setCategories(prev => prev.map(cat =>
      cat.id !== catId ? cat : { ...cat, items: cat.items.map(i => i.id !== updatedItem.id ? i : updatedItem) }
    ));
  }, []);

  const deleteItem = useCallback((catId, itemId) => {
    setCategories(prev => prev
      .map(cat => cat.id !== catId ? cat : { ...cat, items: cat.items.filter(i => i.id !== itemId) })
      .filter(cat => cat.items.length > 0)
    );
  }, []);

  const handleAddEquip = useCallback(({ catId, itemName, modelName, manufacturer, price, notes, image, altModels = [] }) => {
    const rand = () => Math.random().toString(36).slice(2, 7);
    const mid = 'custom-model-' + Date.now() + '-' + rand();
    // image는 저장하지 않음 → 표시 시 항상 equipment 테이블 최신 image_url 조회 (live reference)
    const primaryModel = { id: mid, name: modelName, manufacturer: manufacturer || '', price: price ?? null, notes: notes || '' };
    const altModelObjs = altModels.map((am, i) => ({
      id: 'alt-model-' + Date.now() + '-' + i + '-' + rand(),
      name: am.name || '',
      manufacturer: am.manufacturer || '',
      price: am.price ?? null,
      notes: am.notes || '',
    }));
    const newItem = {
      id: 'custom-' + Date.now() + '-' + rand(),
      name: itemName,
      selectedModelId: mid,
      quantity: 1,
      itemDiscount: 0,
      excluded: false,
      memo: '',
      models: [primaryModel, ...altModelObjs],
    };
    setCategories(prev => {
      const exists = prev.some(cat => cat.id === catId);
      if (exists) {
        return prev.map(cat => cat.id !== catId ? cat : { ...cat, items: [...cat.items, newItem] });
      }
      // catId가 현재 에디터에 없으면 새 카테고리 행으로 추가
      const catName = dynCats.find(c => c.id === catId)?.name ||
                      customEquips.find(e => e.catId === catId)?.catName || catId;
      return [...prev, { id: catId, name: catName, colorKey: 'neutral', items: [newItem] }];
    });
    addToast(`${itemName} — ${modelName} 추가됨`, 'success');
  }, [addToast, dynCats, customEquips]);

  const selectAltModel = useCallback((item, modelId) => {
    const cat = categories.find(c => c.items.some(i => i.id === item.id));
    if (!cat) return;
    const model = item.models.find(m=>m.id===modelId);
    updateItem(cat.id, { ...item, selectedModelId: modelId, itemDiscount: 0 });
    addToast(`${item.name}: ${model?.name} 선택됨`, 'success');
  }, [categories, updateItem, addToast]);

  // row offset for each category (for sequential numbering)
  const catOffsets = useMemo(() => {
    const offsets = {};
    let offset = 0;
    categories.forEach(cat => {
      offsets[cat.id] = offset;
      offset += cat.items.length;
    });
    return offsets;
  }, [categories]);

  // 공유 viewer 모드 — 로그인 우회, 발주 진행 페이지만 노출
  if (shareMode) {
    return <PurchaseOrderTrackingPage viewer={true} />;
  }

  // 인증 로딩 중
  if (authLoading) {
    return (
      <div style={{minHeight:'100vh', background:'#0f172a', display:'flex', alignItems:'center', justifyContent:'center'}}>
        <div className="text-slate-400 text-sm">로딩 중...</div>
      </div>
    );
  }

  // 미인증 → 로그인 페이지
  if (!user) {
    return <LoginPage onLogin={setUser} />;
  }

  const nav = {
    leads:     () => { setListInitialTab('saved'); setListInitialDept(null); setLeadsStageFilter(null); setView('leads'); },
    editor:    () => setView('editor'),
    list:      () => { setListInitialTab('saved'); setListInitialDept(null); setView('list'); },
    standard:  () => { setListInitialTab('standard'); setListInitialDept(null); setView('list'); },
    hospitals: () => setView('hospitals'),
    goToHospital: (hospId, tab = 'info') => goToHospital(hospId, tab),
    service:   () => { setListInitialTab('saved'); setListInitialDept(null); setView('service'); },
    manage:    () => setView('manage'),
    home:       () => setView('home'),
    payables:  () => setView('payables'),
    orderRequests: () => setView('order-requests'),
    poTracking: () => setView('po-tracking'),
    poPlan:    (lead) => { setPoPlanLead(lead); setView('po-plan'); },
  };

  if (view === 'home') {
    return <HomePage user={user} onLogout={handleLogout} nav={nav} />;
  }
  if (view === 'po-tracking') {
    return <PurchaseOrderTrackingPage
      onBack={() => setView('home')}
      user={user}
      onLogout={handleLogout}
      nav={nav}
      appHospitals={appHospitals}
      appManufacturers={appManufacturers}
    />;
  }

  if (view === 'order-requests') {
    return <OrderRequestsPage onBack={() => setView('home')} user={user} onLogout={handleLogout} nav={nav} />;
  }
  if (view === 'payables') {
    return <PayablesPage
      onBack={() => setView('editor')}
      user={user}
      onLogout={handleLogout}
      nav={nav}
      manufacturers={appManufacturers}
      setManufacturers={setAppManufacturers}
    />;
  }

  if (view === 'po-plan' && poPlanLead) {
    return <PurchaseOrderPlanPage
      lead={poPlanLead}
      equipments={customEquips}
      manufacturers={appManufacturers}
      setManufacturers={setAppManufacturers}
      onBack={() => { setPoPlanLead(null); setLeadsStageFilter('발주진행중'); setListInitialTab('saved'); setListInitialDept(null); setView('leads'); }}
      backLabel={'발주진행중 목록으로'}
      onLeadUpdate={(id, fields) => setAppLeads(p => p.map(l => l.id === id ? { ...l, ...fields } : l))}
      user={user}
      onLogout={handleLogout}
      nav={nav}
    />;
  }

  if (view === 'manage') {
    return <EquipmentManagePage
      onBack={() => setView('editor')}
      onEquipChange={() => dbLoadEquip().then(setCustomEquips).catch(console.error)}
      dynCats={dynCats}
      dynItems={dynItems}
      onCatsChange={setDynCats}
      onItemsChange={setDynItems}
      user={user}
      onLogout={handleLogout}
      nav={nav}
      manufacturers={appManufacturers}
      setManufacturers={setAppManufacturers}
      customEquips={customEquips}
    />;
  }

  if (view === 'hospitals') {
    return <HospitalsPage
      onBack={() => { setListInitialTab('saved'); setListInitialDept(null); setView('list'); }}
      initialHospId={hospitalsInitialHospId}
      initialTab={hospitalsInitialTab}
      onNavigated={() => { setHospitalsInitialHospId(null); setHospitalsInitialTab('info'); }}
      user={user}
      onLogout={handleLogout}
      nav={nav}
    />;
  }

  if (view === 'service') {
    return <ServiceRequestsPage
      onBack={() => { setListInitialTab('saved'); setListInitialDept(null); setView('list'); }}
      user={user}
      onLogout={handleLogout}
      nav={nav}
    />;
  }

  if (view === 'leads') {
    return <LeadsPage
      onBack={() => { setListInitialTab('saved'); setListInitialDept(null); setView('list'); }}
      initialStage={leadsStageFilter}
      user={user}
      onLogout={handleLogout}
      nav={nav}
      leads={appLeads}
      setLeads={setAppLeads}
      leadsLoading={appLeadsLoading}
      quotes={appQuotes}
      equipments={customEquips}
      manufacturers={appManufacturers}
      hospitals={appHospitals}
      setHospitals={setAppHospitals}
      onCreateQuote={async (lead, type, quoteNo) => {
        if (type === 'load' && quoteNo) {
          addToast('견적서 불러오는 중...', 'info');
          const entry = await dbLoadQuoteByNo(quoteNo);
          if (entry) {
            setCurrentLead(lead);
            handleLoadEntry(entry);
          } else {
            addToast(`견적번호 ${quoteNo}를 찾을 수 없습니다.`, 'error');
          }
        } else if (type === 'standard') {
          setListInitialTab('standard');
          setListInitialDept(lead.dept || null);
          setCurrentLead(lead);
          setView('list');
          addToast(`${lead.contact_name || '리드'} — 진료과별 표준견적서에서 선택해주세요.`, 'info');
        } else {
          setListInitialTab('saved');
          setListInitialDept(null);
          setCurrentLead(lead);
          setQuoteInfo(p => ({ ...p, hospital: lead.hospital_name || '', doctor: lead.contact_name || '', dept: lead.dept || '' }));
          setView('editor');
          addToast(`${lead.contact_name || '리드'} 견적서를 작성합니다.`, 'success');
        }
      }}
    />;
  }

  if (view === 'list') {
    return (
      <SavedQuotesList
        onLoad={handleLoadEntry}
        onBack={() => setView('editor')}
        onLeads={() => setView('leads')}
        onHospitals={() => setView('hospitals')}
        onService={() => setView('service')}
        customEquips={customEquips}
        dynCats={dynCats}
        initialTab={listInitialTab}
        initialDept={listInitialDept}
        user={user}
        onLogout={handleLogout}
        nav={nav}
        saves={appQuotes}
        setSaves={setAppQuotes}
        quotesLoading={appQuotesLoading}
        allLeads={appLeads}
      />
    );
  }

  return (
    <div style={{height:'100vh', display:'flex', flexDirection:'column', overflow:'hidden'}}>
      <Header quoteInfo={quoteInfo} setQuoteInfo={setQuoteInfo} onSave={handleSave} onLoad={() => { setListInitialTab('saved'); setListInitialDept(null); setView('list'); }} onLoadStandard={() => { setListInitialTab('standard'); setListInitialDept(null); setView('list'); }} onManage={() => setView('manage')} onHome={() => setView('editor')} onLeads={() => setView('leads')} onHospitals={() => setView('hospitals')} onService={() => setView('service')} onPayables={() => setView('payables')} onPoTracking={() => setView('po-tracking')} onOrderRequests={() => setView('order-requests')} onDashboard={() => setView('home')} user={user} onLogout={handleLogout}/>
      <ControlsBar search={search} setSearch={setSearch} onAddEquip={()=>setAddEquipOpen(true)}/>

      <div style={{flex:1, display:'flex', overflow:'hidden', minHeight:0}}>
        {/* Main table area */}
        <div style={{flex:1, overflowY:'auto', overflowX:'auto'}}>
          <table style={{width:'100%', borderCollapse:'collapse', minWidth:'900px'}}>
            {/* Sticky header */}
            <thead className="sticky top-0 z-10">
              <tr className="bg-slate-100 border-b-2 border-slate-300">
                <th className="px-2 py-2.5 w-10 text-slate-500 font-semibold text-xs"></th>
                <th className="px-2 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wide w-36">품목명</th>
                <th className="px-2 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wide w-44">모델명</th>
                <th className="px-2 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wide w-36">제조사</th>
                <th className="px-2 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wide w-28">단가</th>
                <th className="px-2 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wide w-24">수량</th>
                <th className="px-2 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wide w-28">공급가액</th>
                <th className="px-2 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wide w-28">할인금액</th>
                <th className="px-2 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wide w-32">할인 후 금액</th>
                <th className="px-2 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wide w-20">대체품</th>
                <th className="px-2 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">메모</th>
              </tr>
            </thead>

            {categories.map(cat => (
              <CategorySection
                key={cat.id}
                category={cat}
                collapsed={!!collapsed[cat.id]}
                onToggle={() => setCollapsed(p => ({...p, [cat.id]: !p[cat.id]}))}
                onUpdateItem={updateItem}
                onDeleteItem={deleteItem}
                onOpenAlt={(item) => setAltModal({item, catColorKey: cat.colorKey})}
                search={search}
                rowOffset={catOffsets[cat.id] || 0}
                onViewProduct={(modelId, modelName, manufacturer, catName, catColorKey) => setProductModal({modelId, modelName, manufacturer, catName, catColorKey})}
                onViewManufacturer={(mfr) => setMfrModal(mfr)}
                customEquips={customEquips}
              />
            ))}

            {/* Empty state */}
            {search && categories.every(cat =>
              !cat.items.some(i =>
                i.name.toLowerCase().includes(search.toLowerCase()) ||
                getModel(i)?.name.toLowerCase().includes(search.toLowerCase()) ||
                getModel(i)?.manufacturer.toLowerCase().includes(search.toLowerCase())
              )
            ) && (
              <tbody>
                <tr>
                  <td colSpan={11} className="py-16 text-center text-slate-400">
                    <div className="text-2xl mb-2">🔍</div>
                    <div className="font-medium">"{search}" 검색 결과가 없습니다</div>
                  </td>
                </tr>
              </tbody>
            )}
          </table>

          {/* Bottom padding */}
          <div className="h-8"/>
        </div>

        {/* Summary panel */}
        <SummaryPanel
          categories={categories}
          globalDiscount={globalDiscount}
          setGlobalDiscount={setGlobalDiscount}
          vatIncluded={vatIncluded}
          setVatIncluded={setVatIncluded}
          onPdfPreview={() => setPdfModal(true)}
          onSave={handleSave}
          onRevisionSave={handleRevisionSave}
          saving={quoteSaving}
          currentQuoteNo={quoteInfo.quoteNo}
        />
      </div>

      {/* Alt modal */}
      {altModal && (
        <AltModal
          item={altModal.item}
          catColorKey={altModal.catColorKey}
          onSelect={selectAltModel}
          onClose={() => setAltModal(null)}
        />
      )}

      {/* PDF modal */}
      {pdfModal && (
        <PdfPreviewModal
          quoteInfo={quoteInfo}
          categories={categories}
          globalDiscount={globalDiscount}
          vatIncluded={vatIncluded}
          onClose={() => setPdfModal(false)}
          customEquips={customEquips}
        />
      )}

      {/* Add Equipment Modal */}
      {addEquipOpen && (
        <AddEquipmentModal
          categories={categories}
          customEquips={customEquips}
          dynCats={dynCats}
          dynItems={dynItems}
          onAdd={(data) => { handleAddEquip(data); }}
          onClose={() => setAddEquipOpen(false)}
          onViewProduct={(modelId, modelName, manufacturer, catName, catColorKey) => { setAddEquipOpen(false); setProductModal({modelId, modelName, manufacturer, catName, catColorKey}); }}
          onViewManufacturer={(mfr) => { setAddEquipOpen(false); setMfrModal(mfr); }}
        />
      )}

      {/* Product Detail Modal */}
      {productModal && (
        <ProductDetailModal
          modelId={productModal.modelId}
          modelName={productModal.modelName}
          manufacturer={productModal.manufacturer}
          catName={productModal.catName}
          catColorKey={productModal.catColorKey}
          onClose={() => setProductModal(null)}
          onViewManufacturer={(mfr) => { setProductModal(null); setMfrModal(mfr); }}
          customEquips={customEquips}
        />
      )}

      {/* Manufacturer Modal */}
      {mfrModal && (
        <ManufacturerModal
          manufacturer={mfrModal}
          allCategories={categories}
          onClose={() => setMfrModal(null)}
          onViewProduct={(modelId, modelName, manufacturer, catName, catColorKey) => { setMfrModal(null); setProductModal({modelId, modelName, manufacturer, catName, catColorKey}); }}
        />
      )}

      {/* Toasts */}
      <Toast toasts={toasts}/>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
