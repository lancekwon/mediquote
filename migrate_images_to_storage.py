# -*- coding: utf-8 -*-
"""
mediquote — 장비 이미지를 DB(image_data) → Supabase Storage(image_url)로 전환
4/15 Egress 리셋 후 실행

순서:
1. Storage 버킷 'equipment' 생성
2. equipment 테이블에서 image_data가 있는 행 조회
3. base64 디코딩 → Storage에 업로드
4. image_url 컬럼 업데이트
"""
import urllib.request
import json
import base64
import time
import sys

SUPABASE_URL = 'https://nbgubiywavozgigiwkpr.supabase.co'
SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iZ3ViaXl3YXZvemdpZ2l3a3ByIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTc2MzEyOCwiZXhwIjoyMDkxMzM5MTI4fQ.wBkjI2Pko4y-Te23AhHy3Wqjjr2nKGRRWjoe6AeRVRQ'
BUCKET = 'equipment'

def api_get(table, select='*', offset=0, limit=100, extra=''):
    url = f'{SUPABASE_URL}/rest/v1/{table}?select={select}&offset={offset}&limit={limit}{extra}'
    req = urllib.request.Request(url, headers={
        'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}',
    })
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f'  [ERROR] GET: {e}')
        return None

def api_patch(table, id, fields):
    url = f'{SUPABASE_URL}/rest/v1/{table}?id=eq.{id}'
    data = json.dumps(fields).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='PATCH', headers={
        'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
    })
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return resp.status
    except Exception as e:
        print(f'  [ERROR] PATCH: {e}')
        return None

def storage_upload(file_path, file_bytes, content_type='image/png'):
    url = f'{SUPABASE_URL}/storage/v1/object/{BUCKET}/{file_path}'
    req = urllib.request.Request(url, data=file_bytes, method='POST', headers={
        'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': content_type,
        'x-upsert': 'true',
    })
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        return True
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        print(f'  [ERROR] Upload {file_path}: {e.code} {body[:200]}')
        return False
    except Exception as e:
        print(f'  [ERROR] Upload {file_path}: {e}')
        return False

def create_bucket():
    """Storage 버킷 생성 (이미 있으면 무시)"""
    url = f'{SUPABASE_URL}/storage/v1/bucket'
    data = json.dumps({'id': BUCKET, 'name': BUCKET, 'public': True}).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST', headers={
        'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json',
    })
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        print(f'  Bucket "{BUCKET}" created')
        return True
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        if 'already exists' in body.lower() or '409' in str(e.code):
            print(f'  Bucket "{BUCKET}" already exists')
            return True
        print(f'  [ERROR] Create bucket: {e.code} {body[:200]}')
        print(f'  -> Bucket 생성은 Supabase Dashboard > Storage에서 수동으로 해주세요')
        print(f'     이름: equipment, Public: ON')
        return False

def get_public_url(file_path):
    return f'{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{file_path}'

def migrate():
    print('=' * 50)
    print('  이미지 Storage 전환 (image_data -> Storage)')
    print('=' * 50)

    # 1. 버킷 생성
    print('\n1. Storage 버킷 생성...')
    create_bucket()

    # 2. image_data가 있는 장비 조회 (image_url이 없는 것만)
    print('\n2. image_data가 있는 장비 조회...')
    all_equips = []
    offset = 0
    while True:
        rows = api_get('equipment', 'id,model_id,model_name,image_data,image_url', offset, 50,
                       '&image_data=not.is.null&image_url=is.null')
        if rows is None:
            print('  DB 조회 실패 - Egress 제한일 수 있습니다')
            sys.exit(1)
        if len(rows) == 0:
            break
        all_equips.extend(rows)
        offset += len(rows)
        if len(rows) < 50:
            break

    print(f'  {len(all_equips)}개 장비에 이미지 있음 (image_url 미설정)')

    if len(all_equips) == 0:
        print('\n  이미 전환 완료되었거나, image_data가 없습니다.')
        return

    # 3. 각 장비의 image_data를 Storage에 업로드
    print(f'\n3. Storage 업로드 시작...')
    success = 0
    failed = 0

    for i, eq in enumerate(all_equips):
        img_data = eq.get('image_data', '')
        if not img_data:
            continue

        # base64 디코딩
        try:
            # data:image/png;base64,xxxxx 형식 처리
            if ',' in img_data:
                header, b64 = img_data.split(',', 1)
                content_type = header.split(':')[1].split(';')[0] if ':' in header else 'image/png'
            else:
                b64 = img_data
                content_type = 'image/png'

            file_bytes = base64.b64decode(b64)
        except Exception as e:
            print(f'  [{i+1}/{len(all_equips)}] Skip {eq["id"][:8]}... (decode error: {e})')
            failed += 1
            continue

        # 파일 확장자
        ext = 'png'
        if 'jpeg' in content_type or 'jpg' in content_type:
            ext = 'jpg'
        elif 'webp' in content_type:
            ext = 'webp'

        # 파일명: model_id 또는 id
        file_name = (eq.get('model_id') or eq['id']).replace('/', '_').replace(' ', '_')
        file_path = f'{file_name}.{ext}'

        # 업로드
        ok = storage_upload(file_path, file_bytes, content_type)
        if ok:
            public_url = get_public_url(file_path)
            # image_url 업데이트
            status = api_patch('equipment', eq['id'], {'image_url': public_url})
            if status and 200 <= status < 300:
                success += 1
                print(f'  [{i+1}/{len(all_equips)}] OK {file_path} ({len(file_bytes)} bytes)')
            else:
                failed += 1
                print(f'  [{i+1}/{len(all_equips)}] Upload OK but URL update failed')
        else:
            failed += 1

        # rate limit 방지
        if (i + 1) % 10 == 0:
            time.sleep(1)

    print(f'\n' + '=' * 50)
    print(f'  완료: {success} 성공, {failed} 실패 / 총 {len(all_equips)}')
    print(f'=' * 50)

    print("""
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 [필수] Supabase Dashboard > SQL Editor에서 실행:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 브라우저에서 신규 이미지 업로드(anon 키)를 허용하려면
 아래 SQL을 Supabase SQL Editor에서 한 번 실행하세요.
 https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql

-- Storage equipment 버킷 write 정책 (anon 허용)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='storage' AND tablename='objects'
    AND policyname='anon_insert_equipment'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "anon_insert_equipment" ON storage.objects
      FOR INSERT TO anon
      WITH CHECK (bucket_id = 'equipment');
    $p$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='storage' AND tablename='objects'
    AND policyname='anon_update_equipment'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "anon_update_equipment" ON storage.objects
      FOR UPDATE TO anon
      USING (bucket_id = 'equipment')
      WITH CHECK (bucket_id = 'equipment');
    $p$;
  END IF;
END
$$;
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
""")

if __name__ == '__main__':
    migrate()
