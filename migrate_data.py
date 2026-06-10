# -*- coding: utf-8 -*-
"""
mediquote DB Migration: Mumbai -> Seoul
기존 DWDB Project에서 데이터를 읽어 새 DWDB(Seoul)로 복사
"""
import urllib.request
import json
import sys
import time

OLD_URL = 'https://dmqzixpappullrnyospj.supabase.co'
OLD_KEY = 'sb_publishable_UcusGk4UNMVEp82y_2jSdA_dQGjd1bH'

NEW_URL = 'https://nbgubiywavozgigiwkpr.supabase.co'
NEW_KEY = 'sb_publishable_L4FVvZBPaNF9BQtoadoPRw_3HeNlPRL'

# FK 의존 관계 순서대로 테이블 나열 (부모 먼저)
TABLES = [
    'categories',
    'cat_items',
    'equipment',
    'hospitals',
    'leads',
    'quotes',
    'contracts',
    'deliveries',
    'delivery_items',
    'service_requests',
    'manufacturers',
    'purchase_orders',
    'purchase_order_items',
]

def api_get(base_url, key, table, offset=0, limit=1000):
    """Supabase REST API로 데이터 읽기 (페이지네이션)"""
    url = f'{base_url}/rest/v1/{table}?select=*&offset={offset}&limit={limit}'
    req = urllib.request.Request(url, headers={
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json',
    })
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f'  [ERROR] GET {table} offset={offset}: {e}')
        return None

def api_post(base_url, key, table, rows):
    """Supabase REST API로 데이터 삽입 (upsert 없이 insert)"""
    url = f'{base_url}/rest/v1/{table}'
    data = json.dumps(rows, ensure_ascii=False, default=str).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST', headers={
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
    })
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        return resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        print(f'  [ERROR] POST {table}: {e.code} {body[:200]}')
        return None
    except Exception as e:
        print(f'  [ERROR] POST {table}: {e}')
        return None

def migrate_table(table):
    """한 테이블의 모든 데이터를 기존 DB -> 새 DB로 복사"""
    print(f'\n--- {table} ---')
    all_rows = []
    offset = 0
    batch_size = 500

    while True:
        rows = api_get(OLD_URL, OLD_KEY, table, offset, batch_size)
        if rows is None:
            print(f'  FAILED to read from old DB (Egress limit?)')
            return False
        if len(rows) == 0:
            break
        all_rows.extend(rows)
        offset += len(rows)
        if len(rows) < batch_size:
            break

    print(f'  Read {len(all_rows)} rows from old DB')

    if len(all_rows) == 0:
        print(f'  (empty table, skip)')
        return True

    # 배치로 삽입 (50개씩)
    insert_batch = 50
    inserted = 0
    for i in range(0, len(all_rows), insert_batch):
        batch = all_rows[i:i+insert_batch]
        status = api_post(NEW_URL, NEW_KEY, table, batch)
        if status and 200 <= status < 300:
            inserted += len(batch)
        else:
            print(f'  FAILED at batch {i}-{i+len(batch)}')
            # 1건씩 재시도
            for row in batch:
                s = api_post(NEW_URL, NEW_KEY, table, [row])
                if s and 200 <= s < 300:
                    inserted += 1
                else:
                    print(f'    Skip row id={row.get("id","?")}')

    print(f'  Inserted {inserted}/{len(all_rows)} rows into new DB')
    return inserted == len(all_rows)

if __name__ == '__main__':
    print('='*50)
    print('  mediquote DB Migration: Mumbai -> Seoul')
    print('='*50)

    # 먼저 연결 테스트
    print('\nTesting old DB connection...')
    test = api_get(OLD_URL, OLD_KEY, 'categories', 0, 1)
    if test is None:
        print('OLD DB connection failed! Egress limit may be blocking.')
        print('Try again after 4/15 when billing cycle resets.')
        sys.exit(1)
    print(f'  OK - old DB accessible')

    print('\nTesting new DB connection...')
    test = api_get(NEW_URL, NEW_KEY, 'categories', 0, 1)
    if test is None:
        print('NEW DB connection failed!')
        sys.exit(1)
    print(f'  OK - new DB accessible')

    results = {}
    for table in TABLES:
        success = migrate_table(table)
        results[table] = success
        time.sleep(0.5)  # rate limit 방지

    print('\n' + '='*50)
    print('  Migration Results')
    print('='*50)
    for table, ok in results.items():
        status = 'OK' if ok else 'FAIL'
        print(f'  [{status}] {table}')

    failed = [t for t, ok in results.items() if not ok]
    if failed:
        print(f'\nFailed tables: {", ".join(failed)}')
        print('These can be retried later when Egress resets.')
    else:
        print('\nAll tables migrated successfully!')
