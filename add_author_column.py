"""
quotes 테이블에 author 컬럼 추가 마이그레이션
실행: python add_author_column.py

Supabase Dashboard > SQL Editor에서 직접 실행해도 됩니다:
  ALTER TABLE quotes ADD COLUMN IF NOT EXISTS author TEXT;
"""
import urllib.request, urllib.error, json

SUPABASE_URL = 'https://dmqzixpappullrnyospj.supabase.co'
# ⚠️ service_role key가 필요합니다 (Supabase Dashboard > Settings > API에서 확인)
SERVICE_ROLE_KEY = input('Service Role Key를 입력하세요: ').strip()

def run_sql(sql):
    url = f'{SUPABASE_URL}/rest/v1/rpc/exec_sql'
    # Supabase는 기본적으로 exec_sql RPC를 제공하지 않으므로
    # management API를 사용합니다.
    # 대신 Supabase Dashboard SQL Editor에서 아래 SQL을 실행해 주세요.
    print('\n아래 SQL을 Supabase Dashboard > SQL Editor에서 실행해 주세요:')
    print('─' * 60)
    print(sql)
    print('─' * 60)

sql = """
-- quotes 테이블에 author 컬럼 추가
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS author TEXT;

-- 기존 quotes에는 NULL이 들어갑니다 (정상)
-- 이후 저장되는 견적서부터 작성자 이메일이 자동 기록됩니다.
"""

run_sql(sql)
print('\n위 SQL 실행 후 앱을 새로고침 하세요.')
