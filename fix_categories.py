import urllib.request, urllib.parse, json

SUPABASE_URL = 'https://dmqzixpappullrnyospj.supabase.co'
KEY = 'sb_publishable_UcusGk4UNMVEp82y_2jSdA_dQGjd1bH'
H = {'apikey':KEY,'Authorization':f'Bearer {KEY}','Content-Type':'application/json'}

def get(path):
    req = urllib.request.Request(f'{SUPABASE_URL}/rest/v1/{path}', headers=H)
    with urllib.request.urlopen(req) as r: return json.loads(r.read())

def patch(path, data):
    h = {**H,'Prefer':'return=representation'}
    req = urllib.request.Request(f'{SUPABASE_URL}/rest/v1/{path}',
        data=json.dumps(data).encode(), headers=h, method='PATCH')
    try:
        with urllib.request.urlopen(req) as r:
            b = r.read(); return json.loads(b) if b.strip() else True
    except urllib.error.HTTPError as e:
        print(f'  PATCH ERROR {e.code}: {e.read().decode()}'); return None

def delete(path):
    req = urllib.request.Request(f'{SUPABASE_URL}/rest/v1/{path}', headers=H, method='DELETE')
    try:
        with urllib.request.urlopen(req) as r: return True
    except urllib.error.HTTPError as e:
        print(f'  DELETE ERROR {e.code}: {e.read().decode()}'); return None

# ── 1. 구 카테고리 장비 → 새 카테고리로 마이그레이션
print('=== 구 카테고리 → 새 카테고리 마이그레이션 ===')
MIGRATE = [
    ('imaging', '영상진단장비', '영상진단장비'),
    ('pt',      '물리치료재활장비', '물리치료/재활장비'),
    ('manual',  '물리치료재활장비', '물리치료/재활장비'),
    ('cat-1773568817692', '수술기구소모품', '수술기구/소모품'),
]
for old_cat_id, new_cat_id, new_cat_name in MIGRATE:
    result = patch(
        f'equipment?cat_id=eq.{urllib.parse.quote(old_cat_id)}',
        {'cat_id': new_cat_id, 'cat_name': new_cat_name, 'category': new_cat_name}
    )
    equips = get(f'equipment?select=id&cat_id=eq.{urllib.parse.quote(new_cat_id)}&limit=1')
    print(f'  {old_cat_id} → {new_cat_id} 마이그레이션 완료')

# ── 2. 구 카테고리 & 중복 카테고리 삭제
print('\n=== 불필요한 카테고리 삭제 ===')
TO_DELETE = [
    'imaging',              # 구: 영상진단 장비 → 영상진단장비로 통합
    'pt',                   # 구: 물리치료기기 → 물리치료재활장비로 통합
    'manual',               # 구: 도수치료 장비 → 물리치료재활장비로 통합
    'cat-1773568817692',    # 구: 소모품 → 수술기구소모품으로 통합
    'cat-1773572548258',    # 중복: 검사/측정장비
    'cat-1773572515514',    # 중복: 내시경장비
]
for cat_id in TO_DELETE:
    result = delete(f'categories?cat_id=eq.{urllib.parse.quote(cat_id)}')
    print(f'  [{cat_id}] 삭제 완료')

# ── 3. 최종 카테고리 목록 확인
print('\n=== 최종 카테고리 목록 ===')
cats = get('categories?select=cat_id,name&order=name')
for c in cats:
    equip_count = get(f'equipment?select=id&cat_id=eq.{urllib.parse.quote(c["cat_id"])}&limit=1000')
    print(f'  {c["name"]} ({c["cat_id"]}): {len(equip_count)}개 장비')

print('\n=== 완료 ===')
