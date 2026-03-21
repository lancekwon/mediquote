# -*- coding: utf-8 -*-
import pandas as pd
import urllib.request
import urllib.error
import json
import sys

SUPABASE_URL = 'https://dmqzixpappullrnyospj.supabase.co'
SUPABASE_KEY = 'sb_publishable_UcusGk4UNMVEp82y_2jSdA_dQGjd1bH'

HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
}

def supabase_get(path):
    req = urllib.request.Request(f'{SUPABASE_URL}/rest/v1/{path}', headers=HEADERS)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode('utf-8'))

def supabase_post(path, data):
    body = json.dumps(data, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(f'{SUPABASE_URL}/rest/v1/{path}', data=body, headers=HEADERS, method='POST')
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        err = e.read().decode('utf-8')
        raise Exception(f'HTTP {e.code}: {err}')

# ── 1. Excel 읽기 ──
print('Excel 읽는 중...')
path = r'C:\Users\jojo\Desktop\납품이력_입력양식.xlsx'
df = pd.read_excel(path, sheet_name='납품이력_입력', header=3, dtype=str)
df.columns = ['hosp_name','delivered_date','doc_no','supply_amount','vat','total_amount','notes',
              'item_code','item_name','model_name','spec','unit','quantity','unit_price']

# 빈 행 제거 (병원명 + 품목명 둘 다 없는 행)
df = df[df['hosp_name'].notna() | df['item_name'].notna()].copy()

# 납품 건 식별용 컬럼만 ffill (병원명·날짜·문서번호는 병합셀 → ffill 필요)
# 금액(supply/vat/total)과 notes는 ffill 하지 않음 - 품목별 개별 금액이므로
df['hosp_name']      = df['hosp_name'].ffill()
df['delivered_date'] = df['delivered_date'].ffill()
df['doc_no']         = df['doc_no'].ffill()
df['notes']          = df['notes'].ffill()
# supply_amount, vat, total_amount: ffill 제거 → 단가 없는 품목은 NULL 유지

df = df[df['item_name'].notna() & (df['item_name'].str.strip() != '')].copy()
df = df[df['hosp_name'].notna() & (df['hosp_name'].str.strip() != '')].copy()
df['hosp_name'] = df['hosp_name'].str.strip()

print(f'총 {len(df)}개 품목 행 읽음')

# ── 2. 병원 목록 가져오기 ──
print('\n병원 목록 조회 중...')
hospitals = supabase_get('hospitals?select=id,name')
hosp_map = {h['name'].strip(): h['id'] for h in hospitals}
print(f'{len(hosp_map)}개 병원 확인')

# ── 3. 없는 병원 자동 등록 ──
excel_hosps = df['hosp_name'].unique()
missing = [h for h in excel_hosps if h not in hosp_map]
print(f'\n[병원 매핑]')
print(f'  DB 기존: {len(hosp_map)}개')
print(f'  신규 등록 필요: {len(missing)}개')

for hosp_name in missing:
    try:
        result = supabase_post('hospitals', {'name': hosp_name})
        new_id = result[0]['id']
        hosp_map[hosp_name] = new_id
        print(f'  + 등록: {hosp_name}')
    except Exception as e:
        print(f'  ! 등록 실패: {hosp_name} -> {e}')

matched = [h for h in excel_hosps if h in hosp_map]
still_missing = [h for h in excel_hosps if h not in hosp_map]
print(f'\n  최종 매핑 성공: {len(matched)}개')
if still_missing:
    print(f'  최종 실패: {len(still_missing)}개')
    for m in still_missing:
        print(f'    - {m}')

# ── 4. deliveries 그룹핑 ──
df_matched = df[df['hosp_name'].isin(matched)].copy()
group_keys = ['hosp_name', 'delivered_date', 'doc_no']
groups = df_matched.groupby(group_keys, dropna=False)

print(f'\n납품 건수: {len(groups)}건')
print(f'품목 건수: {len(df_matched)}개')
print('\nImport 시작...')

success_d = 0
success_i = 0
errors = []

def to_int(val):
    try:
        return int(float(str(val).replace(',', ''))) if pd.notna(val) and str(val).strip() not in ('', 'nan') else None
    except:
        return None

for (hosp_name, delivered_date, doc_no), group in groups:
    hospital_id = hosp_map.get(str(hosp_name).strip())
    if not hospital_id:
        continue

    first = group.iloc[0]

    # delivery 합계: 단가 있는 품목의 금액만 합산 (ffill 제거로 단가없는 품목은 None)
    def row_total(row):
        # 엑셀 D열(supply_amount)에 값이 있으면 그대로, 없으면 unit_price*qty 계산
        s = to_int(row['supply_amount'])
        if s is not None:
            return to_int(row['vat']), s, to_int(row['total_amount'])
        up = to_int(row['unit_price'])
        qty = to_int(row['quantity']) or 1
        if up is not None:
            total = up * qty
            supply = round(total / 1.1)
            vat = total - supply
            return vat, supply, total
        return None, None, None

    total_supply, total_vat, total_total = 0, 0, 0
    for _, row in group.iterrows():
        vv, ss, tt = row_total(row)
        if ss: total_supply += ss
        if vv: total_vat    += vv
        if tt: total_total  += tt

    delivery = {
        'hospital_id': hospital_id,
        'delivered_date': str(delivered_date).strip() if pd.notna(delivered_date) else None,
        'doc_no': str(doc_no).strip() if pd.notna(doc_no) and str(doc_no).strip() != 'nan' else None,
        'supply_amount': total_supply or None,
        'vat':           total_vat    or None,
        'total_amount':  total_total  or None,
        'notes': str(first['notes']).strip() if pd.notna(first['notes']) and str(first['notes']).strip() != 'nan' else None,
    }

    try:
        result = supabase_post('deliveries', delivery)
        delivery_id = result[0]['id']
        success_d += 1
    except Exception as e:
        errors.append(f'delivery 저장 실패 ({hosp_name} / {delivered_date}): {e}')
        continue

    # delivery_items: 단가 없는 품목은 금액 NULL로 저장
    items = []
    for _, row in group.iterrows():
        item_name = str(row['item_name']).strip() if pd.notna(row['item_name']) else ''
        if not item_name or item_name == 'nan':
            continue

        unit_price = to_int(row['unit_price'])

        # 금액: 엑셀 D열 값 있으면 사용, 없으면 단가×수량 계산, 단가도 없으면 NULL
        raw_supply = to_int(row['supply_amount'])
        raw_vat    = to_int(row['vat'])
        raw_total  = to_int(row['total_amount'])

        if raw_supply is not None:
            item_supply = raw_supply
            item_vat    = raw_vat
            item_total  = raw_total
        elif unit_price is not None:
            qty = to_int(row['quantity']) or 1
            item_total  = unit_price * qty
            item_supply = round(item_total / 1.1)
            item_vat    = item_total - item_supply
        else:
            item_supply = None
            item_vat    = None
            item_total  = None

        item = {
            'delivery_id': delivery_id,
            'item_code':   str(row['item_code']).strip()   if pd.notna(row['item_code'])   and str(row['item_code']).strip()   != 'nan' else None,
            'item_name':   item_name,
            'model_name':  str(row['model_name']).strip()  if pd.notna(row['model_name'])  and str(row['model_name']).strip()  != 'nan' else None,
            'spec':        str(row['spec']).strip()        if pd.notna(row['spec'])        and str(row['spec']).strip()        != 'nan' else None,
            'unit':        str(row['unit']).strip()        if pd.notna(row['unit'])        and str(row['unit']).strip()        != 'nan' else None,
            'quantity':    to_int(row['quantity']),
            'unit_price':  unit_price,
            'supply_amount': item_supply,
            'vat':           item_vat,
            'total_amount':  item_total,
        }
        items.append(item)

    if items:
        try:
            supabase_post('delivery_items', items)
            success_i += len(items)
        except Exception as e:
            errors.append(f'items 저장 실패 ({hosp_name} / {delivered_date}): {e}')

print(f'\n[완료]')
print(f'  납품 건: {success_d}건 저장')
print(f'  품목:    {success_i}개 저장')
if errors:
    print(f'\n[오류 {len(errors)}건]')
    for e in errors:
        print(f'  - {e}')
if still_missing:
    print(f'\n[skip된 병원 {len(still_missing)}개]')
    for m in still_missing:
        cnt = len(df[df['hosp_name'] == m])
        print(f'  - "{m}" ({cnt}개 품목)')
