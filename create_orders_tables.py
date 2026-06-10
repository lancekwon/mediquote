"""
mediquote — 발주 관리 테이블 생성 스크립트
Supabase REST API를 사용하여 테이블 생성 (RPC 호출)
"""
import urllib.request
import json

SUPABASE_URL = 'https://dmqzixpappullrnyospj.supabase.co'
SUPABASE_KEY = 'sb_publishable_UcusGk4UNMVEp82y_2jSdA_dQGjd1bH'

# Supabase anon key로는 DDL 실행 불가 → 대신 REST API로 테이블 존재 확인 후 안내
# 실제 테이블 생성은 Supabase Dashboard SQL Editor에서 실행

SQL = """
-- ============================================================
-- 1. manufacturers (제조사 마스터)
-- ============================================================
CREATE TABLE IF NOT EXISTS manufacturers (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text UNIQUE NOT NULL,
  contact_name text,
  contact_phone text,
  contact_email text,
  lead_time_days int DEFAULT 14,
  payment_terms text,
  bank_info text,
  notes text,
  created_at timestamptz DEFAULT now()
);

-- RLS 정책
ALTER TABLE manufacturers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "manufacturers_all" ON manufacturers FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 2. purchase_orders (발주서)
-- ============================================================
CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id uuid REFERENCES contracts(id),
  po_no text UNIQUE NOT NULL,
  manufacturer_id uuid REFERENCES manufacturers(id),
  manufacturer_name text,
  hospital_name text,
  status text DEFAULT '준비중',
  ordered_at date,
  delivery_date date,
  delivered boolean DEFAULT false,
  delivered_at date,
  total_amount int DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "purchase_orders_all" ON purchase_orders FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 3. purchase_order_items (발주 품목)
-- ============================================================
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  po_id uuid REFERENCES purchase_orders(id) ON DELETE CASCADE,
  equipment_id uuid,
  item_name text,
  model_name text,
  manufacturer text,
  quantity int DEFAULT 1,
  unit_price int DEFAULT 0,
  amount int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "purchase_order_items_all" ON purchase_order_items FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 4. contracts 테이블 컬럼 추가
-- ============================================================
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS delivery_target_date date;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS list_fixed boolean DEFAULT false;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS statement_issued boolean DEFAULT false;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS statement_issued_at date;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS invoice_issued boolean DEFAULT false;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS invoice_issued_at date;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS invoice_amount int;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS collected boolean DEFAULT false;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS collected_at date;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS collected_amount int;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS all_paid boolean DEFAULT false;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS margin int;

-- ============================================================
-- 5. 기존 equipment에서 제조사 자동 추출하여 manufacturers 초기 데이터 삽입
-- ============================================================
INSERT INTO manufacturers (name)
SELECT DISTINCT manufacturer
FROM equipment
WHERE manufacturer IS NOT NULL AND manufacturer != ''
ON CONFLICT (name) DO NOTHING;
"""

print("=" * 60)
print("  mediquote 발주 관리 테이블 생성 SQL")
print("=" * 60)
print()
print("아래 SQL을 Supabase Dashboard > SQL Editor에서 실행하세요:")
print("  https://supabase.com/dashboard/project/dmqzixpappullrnyospj/sql")
print()
print("-" * 60)
print(SQL)
print("-" * 60)
print()

# 테이블 존재 여부 확인
def check_table(table_name):
    try:
        req = urllib.request.Request(
            f'{SUPABASE_URL}/rest/v1/{table_name}?select=id&limit=1',
            headers={
                'apikey': SUPABASE_KEY,
                'Authorization': f'Bearer {SUPABASE_KEY}',
            }
        )
        resp = urllib.request.urlopen(req)
        return resp.status == 200
    except Exception:
        return False

print("현재 테이블 상태:")
for t in ['manufacturers', 'purchase_orders', 'purchase_order_items', 'contracts']:
    exists = check_table(t)
    print(f"  {'[OK]' if exists else '[NO]'} {t}")
print()
