"""
mediquote — 외상매입금 관리 테이블 생성 스크립트

실행: Supabase Dashboard > SQL Editor 에서 아래 출력된 SQL을 복사 후 실행
"""

SQL = """
-- ============================================================
-- 1. manufacturers 에 vendor_code (거래처 코드) 컬럼 추가
-- ============================================================
ALTER TABLE manufacturers ADD COLUMN IF NOT EXISTS vendor_code text;
CREATE UNIQUE INDEX IF NOT EXISTS manufacturers_vendor_code_uidx
  ON manufacturers (vendor_code) WHERE vendor_code IS NOT NULL;

-- ============================================================
-- 2. payable_transactions (외상매입금 거래원장)
--    - tx_type: opening(이월잔액) | purchase(매입) | payment(지급)
--    - amount: 항상 양수
--    - 잔액 = SUM(opening + purchase) - SUM(payment)
-- ============================================================
CREATE TABLE IF NOT EXISTS payable_transactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  manufacturer_id uuid NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
  tx_date date NOT NULL,
  tx_type text NOT NULL CHECK (tx_type IN ('opening','purchase','payment')),
  amount bigint NOT NULL CHECK (amount >= 0),
  memo text,
  po_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  payment_batch_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payable_tx_mfr_idx
  ON payable_transactions (manufacturer_id, tx_date);
CREATE INDEX IF NOT EXISTS payable_tx_batch_idx
  ON payable_transactions (payment_batch_id) WHERE payment_batch_id IS NOT NULL;

ALTER TABLE payable_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payable_tx_all" ON payable_transactions;
CREATE POLICY "payable_tx_all" ON payable_transactions FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 3. cash_balance_log (통장잔액 추적 — 외상매입금과 분리)
--    - 일괄지급 시 자동 1행 기록 (출금 합계, 잔액)
--    - 수동 입력도 가능 (수금/이체 등)
-- ============================================================
CREATE TABLE IF NOT EXISTS cash_balance_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  log_date date NOT NULL,
  delta bigint NOT NULL,
  balance_after bigint,
  memo text,
  payment_batch_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cash_balance_date_idx ON cash_balance_log (log_date DESC);

ALTER TABLE cash_balance_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cash_balance_all" ON cash_balance_log;
CREATE POLICY "cash_balance_all" ON cash_balance_log FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 4. 거래처별 외상잔액 뷰 (조회 편의)
-- ============================================================
CREATE OR REPLACE VIEW v_payable_balance AS
SELECT
  m.id AS manufacturer_id,
  m.name AS manufacturer_name,
  m.vendor_code,
  COALESCE(SUM(CASE WHEN pt.tx_type IN ('opening','purchase') THEN pt.amount ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN pt.tx_type = 'payment' THEN pt.amount ELSE 0 END), 0) AS balance,
  COALESCE(SUM(CASE WHEN pt.tx_type IN ('opening','purchase') THEN pt.amount ELSE 0 END), 0) AS total_purchase,
  COALESCE(SUM(CASE WHEN pt.tx_type = 'payment' THEN pt.amount ELSE 0 END), 0) AS total_payment,
  MAX(pt.tx_date) AS last_tx_date
FROM manufacturers m
LEFT JOIN payable_transactions pt ON pt.manufacturer_id = m.id
GROUP BY m.id, m.name, m.vendor_code;
"""

print("=" * 70)
print("  mediquote 외상매입금 테이블 생성 SQL")
print("=" * 70)
print()
print("아래 SQL을 Supabase Dashboard > SQL Editor 에서 실행하세요:")
print("  https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql")
print()
print("-" * 70)
print(SQL)
print("-" * 70)
