"""
엑셀 → Supabase equipment 테이블 일괄 등록 스크립트
- 이미 동일한 model_name + item_name 조합이 있으면 건너뜀
- 빈칸은 null로 저장
"""
import pandas as pd
import json, urllib.request, urllib.parse, time

SUPABASE_URL = 'https://dmqzixpappullrnyospj.supabase.co'
SUPABASE_KEY = 'sb_publishable_UcusGk4UNMVEp82y_2jSdA_dQGjd1bH'
EXCEL_PATH   = 'C:/Users/jojo/mediquote/장비_정보_입력양식_updated.xlsx'

def sb_get(table, params=''):
    url = f'{SUPABASE_URL}/rest/v1/{table}?{params}'
    req = urllib.request.Request(url, headers={
        'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def sb_post(table, rows):
    data = json.dumps(rows).encode()
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/{table}',
        data=data,
        headers={
            'apikey': SUPABASE_KEY,
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req) as r:
            return True
    except urllib.error.HTTPError as e:
        print(f'  ❌ 오류: {e.read().decode()}')
        return False

def val(v):
    """NaN → None, 그 외 strip"""
    if v is None: return None
    if isinstance(v, float) and pd.isna(v): return None
    s = str(v).strip()
    return None if s in ('', 'nan', 'NaN', 'None') else s

def build_specs(row):
    specs = []
    for i in range(1, 6):
        l = val(row.get(f'스펙{i} 항목'))
        v = val(row.get(f'스펙{i} 값'))
        if l and v:
            specs.append({'l': l, 'v': v})
    return specs if specs else None

# ── 1. 엑셀 읽기 ──────────────────────────────────────────────────
print('📖 엑셀 읽는 중...')
df = pd.read_excel(EXCEL_PATH, sheet_name='장비 입력', header=1)
df = df.drop(index=0).reset_index(drop=True)
df.columns = [str(c).strip() for c in df.columns]

# 필수 3개 컬럼 확인
col0, col1, col2 = df.columns[0], df.columns[1], df.columns[2]
mask = (df[col0].notna() & df[col1].notna() & df[col2].notna() &
        df[col0].astype(str).str.strip().ne('nan') &
        df[col1].astype(str).str.strip().ne('nan') &
        df[col2].astype(str).str.strip().ne('nan'))
data = df[mask].reset_index(drop=True)
print(f'  총 {len(data)}행 유효 데이터')

# ── 2. 기존 카테고리 로드 ────────────────────────────────────────
print('🗂️  기존 카테고리 로드 중...')
cats = sb_get('categories', 'select=cat_id,name')
cat_map = {c['name']: c['cat_id'] for c in cats}
print(f'  기존 카테고리 {len(cat_map)}개: {list(cat_map.keys())}')

# ── 3. 기존 장비 로드 (중복 체크용) ─────────────────────────────
print('🔍 기존 장비 로드 중...')
existing = sb_get('equipment', 'select=item_name,model_name')
existing_set = {(e['item_name'], e['model_name']) for e in existing}
print(f'  기존 장비 {len(existing_set)}개')

# ── 4. 삽입할 행 구성 ─────────────────────────────────────────────
rows_to_insert = []
skipped = 0
new_cats = {}

for _, row in data.iterrows():
    cat_name = val(row[col0])
    item_name = val(row[col1])
    model_name = val(row[col2])

    if not cat_name or not item_name or not model_name:
        continue

    # 중복 체크
    if (item_name, model_name) in existing_set:
        skipped += 1
        continue

    # cat_id 조회 또는 임시 생성
    if cat_name in cat_map:
        cat_id = cat_map[cat_name]
    elif cat_name in new_cats:
        cat_id = new_cats[cat_name]
    else:
        # 새 카테고리 생성
        new_cat_id = 'cat-' + str(int(time.time() * 1000))
        time.sleep(0.001)
        res = sb_post('categories', [{'cat_id': new_cat_id, 'name': cat_name, 'color_key': 'blue', 'sort_order': 99}])
        if res:
            cat_map[cat_name] = new_cat_id
            new_cats[cat_name] = new_cat_id
            cat_id = new_cat_id
            print(f'  ✨ 새 카테고리 생성: {cat_name}')
        else:
            cat_id = 'cat-unknown'

    price_raw = val(row.get('가격 (원)') or row.get('가격(원)'))
    try:
        price = int(float(price_raw)) if price_raw else None
    except:
        price = None

    specs = build_specs(row)
    model_id = f'model-{int(time.time()*1000)}-{len(rows_to_insert)}'

    rows_to_insert.append({
        'cat_id':      cat_id,
        'cat_name':    cat_name,
        'category':    cat_name,
        'item_name':   item_name,
        'model_name':  model_name,
        'model_id':    model_id,
        'manufacturer':val(row.get('제조사')) or '',
        'price':       price,
        'origin':      val(row.get('원산지')),
        'cert':        val(row.get('인증')),
        'as_period':   val(row.get('A/S 기간') or row.get('A/S기간')),
        'warranty':    val(row.get('보증기간')),
        'description': val(row.get('제품 소개') or row.get('제품소개')),
        'specs':       specs,
        'model_notes': val(row.get('특이사항')),
        'alt_text':    '',
        'memo':        val(row.get('특이사항')),
    })

print(f'\n📊 결과 요약:')
print(f'  삽입 예정: {len(rows_to_insert)}개')
print(f'  중복 건너뜀: {skipped}개')

if not rows_to_insert:
    print('  삽입할 새 데이터가 없습니다.')
    exit(0)

# ── 5. 배치 삽입 (50개씩) ─────────────────────────────────────────
print(f'\n⬆️  Supabase 업로드 중...')
BATCH = 50
success = 0
for i in range(0, len(rows_to_insert), BATCH):
    batch = rows_to_insert[i:i+BATCH]
    ok = sb_post('equipment', batch)
    if ok:
        success += len(batch)
        print(f'  [{i+len(batch)}/{len(rows_to_insert)}] ✅ 완료')
    else:
        print(f'  [{i+len(batch)}/{len(rows_to_insert)}] ❌ 실패')
    time.sleep(0.2)

print(f'\n🎉 완료! 총 {success}개 등록, {skipped}개 건너뜀')
