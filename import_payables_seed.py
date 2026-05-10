"""
mediquote — 외상매입금 시드 데이터 임포트

엑셀 (대원 외상매입금_잔액.xlsx) → Supabase
1) manufacturers upsert (vendor_code 포함)
2) opening 트랜잭션 (2026-04-30, 기존 잔액)
3) 5/8 payment 트랜잭션 + payment_batch_id 묶음 + cash_balance_log 1행

선행: sql/01_payables_schema.sql 가 Supabase에서 실행되어 있어야 함.
"""
import urllib.request
import urllib.error
import json
import sys
import io
import os
import uuid
from datetime import date

sys.stdout.reconfigure(encoding='utf-8')

SUPABASE_URL = 'https://nbgubiywavozgigiwkpr.supabase.co'
SUPABASE_KEY = 'sb_publishable_L4FVvZBPaNF9BQtoadoPRw_3HeNlPRL'

HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
}

EXCEL_PATH = r'C:\Users\jojo\Documents\카카오톡 받은 파일\대원 외상매입금_잔액.xlsx'

OPENING_DATE = '2026-04-30'
PAYMENT_5_8_DATE = '2026-05-08'


def http(method, path, body=None, prefer=None, params=None):
    url = f'{SUPABASE_URL}/rest/v1/{path}'
    if params:
        from urllib.parse import urlencode
        url += '?' + urlencode(params)
    headers = dict(HEADERS)
    if prefer:
        headers['Prefer'] = prefer
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode('utf-8')
            return json.loads(txt) if txt else None
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='replace')
        print(f'  ERROR {method} {path}: {e.code} — {err_body}')
        raise


def read_excel():
    import openpyxl
    wb = openpyxl.load_workbook(EXCEL_PATH, data_only=True)

    summary = wb['외상매입금 잔액 요약']
    vendors = []
    for row in summary.iter_rows(min_row=4, values_only=True):
        code, name, final_bal, prev_bal, pay_5_8, pay_5_13, _ = row
        if not code or not name or code == '합  계':
            continue
        vendors.append({
            'code': str(code).strip(),
            'name': str(name).strip(),
            'final_balance': int(final_bal or 0),
            'prev_balance': int(prev_bal or 0),
            'pay_5_8': int(pay_5_8 or 0),
            'pay_5_13': int(pay_5_13 or 0),
        })

    return vendors


def upsert_manufacturers(vendors):
    print(f'\n[1/3] manufacturers upsert ({len(vendors)}개)...')
    existing = http('GET', 'manufacturers', params={'select': 'id,name,vendor_code'})
    by_name = {m['name']: m for m in existing}
    by_code = {m['vendor_code']: m for m in existing if m.get('vendor_code')}

    name_to_id = {}
    inserted = updated = 0

    for v in vendors:
        m = by_code.get(v['code']) or by_name.get(v['name'])
        if m:
            patch = {}
            if not m.get('vendor_code'):
                patch['vendor_code'] = v['code']
            if patch:
                http('PATCH', f"manufacturers?id=eq.{m['id']}", body=patch)
                updated += 1
            name_to_id[v['name']] = m['id']
        else:
            row = http('POST', 'manufacturers',
                       body={'name': v['name'], 'vendor_code': v['code']},
                       prefer='return=representation')
            name_to_id[v['name']] = row[0]['id']
            inserted += 1

    print(f'    신규 {inserted}, 업데이트 {updated}, 기존매칭 {len(vendors) - inserted - updated}')
    return name_to_id


def insert_opening_balances(vendors, name_to_id):
    print(f'\n[2/3] opening balance 트랜잭션 ({OPENING_DATE})...')
    existing = http('GET', 'payable_transactions',
                    params={'select': 'manufacturer_id', 'tx_type': 'eq.opening'})
    skip_ids = {r['manufacturer_id'] for r in existing}

    rows = []
    for v in vendors:
        mid = name_to_id[v['name']]
        if mid in skip_ids:
            continue
        if v['prev_balance'] <= 0:
            continue
        rows.append({
            'manufacturer_id': mid,
            'tx_date': OPENING_DATE,
            'tx_type': 'opening',
            'amount': v['prev_balance'],
            'memo': '엑셀 임포트 — 기존 외상매입금 이월',
        })

    if not rows:
        print('    이미 존재 — 스킵')
        return

    http('POST', 'payable_transactions', body=rows)
    total = sum(r['amount'] for r in rows)
    print(f'    {len(rows)}건, 합계 {total:,}원')


def insert_5_8_payments(vendors, name_to_id):
    print(f'\n[3/3] 5/8 지급 트랜잭션 ({PAYMENT_5_8_DATE})...')

    existing = http('GET', 'payable_transactions',
                    params={'select': 'id', 'tx_type': 'eq.payment',
                            'tx_date': f'eq.{PAYMENT_5_8_DATE}'})
    if existing:
        print(f'    이미 {len(existing)}건 존재 — 스킵')
        return

    batch_id = str(uuid.uuid4())
    rows = []
    for v in vendors:
        if v['pay_5_8'] <= 0:
            continue
        rows.append({
            'manufacturer_id': name_to_id[v['name']],
            'tx_date': PAYMENT_5_8_DATE,
            'tx_type': 'payment',
            'amount': v['pay_5_8'],
            'memo': '5/8 일괄지급 (엑셀 임포트)',
            'payment_batch_id': batch_id,
        })

    if not rows:
        print('    지급 건 없음')
        return

    http('POST', 'payable_transactions', body=rows)
    total = sum(r['amount'] for r in rows)
    print(f'    {len(rows)}건, 합계 {total:,}원, batch={batch_id[:8]}')

    cash_existing = http('GET', 'cash_balance_log',
                         params={'select': 'id', 'log_date': f'eq.{PAYMENT_5_8_DATE}'})
    if not cash_existing:
        # 엑셀 5월지급내역 시트 첫 줄 통장잔액 = 1,000,000 (출금 직후 잔액)
        http('POST', 'cash_balance_log', body={
            'log_date': PAYMENT_5_8_DATE,
            'delta': -total,
            'balance_after': 1000000,
            'memo': '5/8 일괄지급 (엑셀 임포트)',
            'payment_batch_id': batch_id,
        })
        print(f'    cash_balance_log: -{total:,}, 잔액 1,000,000')


def verify(vendors, name_to_id):
    print('\n[검증] v_payable_balance 조회...')
    bal = http('GET', 'v_payable_balance',
               params={'select': 'manufacturer_id,manufacturer_name,balance,vendor_code',
                       'order': 'balance.desc'})
    by_id = {b['manufacturer_id']: b for b in bal}

    mismatches = 0
    total_actual = total_expected = 0
    for v in vendors:
        mid = name_to_id[v['name']]
        actual = int(by_id.get(mid, {}).get('balance') or 0)
        expected = v['final_balance']
        total_actual += actual
        total_expected += expected
        if actual != expected:
            mismatches += 1
            print(f'    [불일치] {v["code"]} {v["name"]}: 계산={actual:,} 엑셀={expected:,}')

    print(f'\n    합계 — 계산: {total_actual:,}원 / 엑셀: {total_expected:,}원')
    print(f'    {"OK — 전부 일치" if mismatches == 0 else f"{mismatches}건 불일치"}')


def main():
    print('=' * 60)
    print('  mediquote 외상매입금 시드 임포트')
    print('=' * 60)

    vendors = read_excel()
    print(f'엑셀에서 거래처 {len(vendors)}개 로드')

    name_to_id = upsert_manufacturers(vendors)
    insert_opening_balances(vendors, name_to_id)
    insert_5_8_payments(vendors, name_to_id)
    verify(vendors, name_to_id)


if __name__ == '__main__':
    main()
