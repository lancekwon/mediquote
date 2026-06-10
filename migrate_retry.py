# -*- coding: utf-8 -*-
"""실패한 테이블만 재시도"""
import urllib.request
import json
import time

OLD_URL = 'https://dmqzixpappullrnyospj.supabase.co'
OLD_KEY = 'sb_publishable_UcusGk4UNMVEp82y_2jSdA_dQGjd1bH'
NEW_URL = 'https://nbgubiywavozgigiwkpr.supabase.co'
NEW_KEY = 'sb_publishable_L4FVvZBPaNF9BQtoadoPRw_3HeNlPRL'

RETRY_TABLES = ['leads']

def api_get(base_url, key, table, offset=0, limit=1000):
    url = f'{base_url}/rest/v1/{table}?select=*&offset={offset}&limit={limit}'
    req = urllib.request.Request(url, headers={
        'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json',
    })
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f'  [ERROR] GET {table}: {e}')
        return None

def api_post(base_url, key, table, rows):
    url = f'{base_url}/rest/v1/{table}'
    data = json.dumps(rows, ensure_ascii=False, default=str).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST', headers={
        'apikey': key, 'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
    })
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        return resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        print(f'  [ERROR] POST {table}: {e.code} {body[:300]}')
        return None
    except Exception as e:
        print(f'  [ERROR] POST {table}: {e}')
        return None

for table in RETRY_TABLES:
    print(f'\n--- {table} ---')
    all_rows = []
    offset = 0
    while True:
        rows = api_get(OLD_URL, OLD_KEY, table, offset, 500)
        if rows is None or len(rows) == 0:
            break
        all_rows.extend(rows)
        offset += len(rows)
        if len(rows) < 500:
            break
    print(f'  Read {len(all_rows)} rows')
    if not all_rows:
        continue

    inserted = 0
    for i in range(0, len(all_rows), 50):
        batch = all_rows[i:i+50]
        status = api_post(NEW_URL, NEW_KEY, table, batch)
        if status and 200 <= status < 300:
            inserted += len(batch)
        else:
            for row in batch:
                s = api_post(NEW_URL, NEW_KEY, table, [row])
                if s and 200 <= s < 300:
                    inserted += 1
        time.sleep(0.2)
    print(f'  Inserted {inserted}/{len(all_rows)}')

print('\nDone!')
