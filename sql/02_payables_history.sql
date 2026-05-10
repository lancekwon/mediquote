-- ============================================================
-- 매입매출 관리 모듈 — 히스토리 기반 audit trail 지원
-- 실행 위치: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
--
-- 변경 사항:
--   1. tx_type에 'adjustment', 'cancel' 추가
--   2. amount 음수 허용 (취소/조정 트랜잭션은 음수 금액 가능)
--   3. v_payable_balance 뷰: amount 부호 그대로 합산 (payment만 차감)
-- ============================================================

-- 1. tx_type CHECK 제약 확장
ALTER TABLE payable_transactions DROP CONSTRAINT IF EXISTS payable_transactions_tx_type_check;
ALTER TABLE payable_transactions ADD CONSTRAINT payable_transactions_tx_type_check
  CHECK (tx_type IN ('opening','purchase','payment','adjustment','cancel'));

-- 2. amount 음수 허용 (CHECK >= 0 제약 제거)
ALTER TABLE payable_transactions DROP CONSTRAINT IF EXISTS payable_transactions_amount_check;

-- 3. v_payable_balance 뷰 재정의
--    매입 합계 = opening + purchase + adjustment + cancel (모두 amount 부호 그대로)
--    지급 합계 = payment (항상 양수, balance에서는 빼기)
CREATE OR REPLACE VIEW v_payable_balance AS
SELECT
  m.id AS manufacturer_id,
  m.name AS manufacturer_name,
  m.vendor_code,
  COALESCE(SUM(CASE
    WHEN pt.tx_type IN ('opening','purchase','adjustment','cancel') THEN pt.amount
    WHEN pt.tx_type = 'payment' THEN -pt.amount
    ELSE 0 END), 0) AS balance,
  COALESCE(SUM(CASE
    WHEN pt.tx_type IN ('opening','purchase','adjustment','cancel') THEN pt.amount
    ELSE 0 END), 0) AS total_purchase,
  COALESCE(SUM(CASE WHEN pt.tx_type = 'payment' THEN pt.amount ELSE 0 END), 0) AS total_payment,
  MAX(pt.tx_date) AS last_tx_date
FROM manufacturers m
LEFT JOIN payable_transactions pt ON pt.manufacturer_id = m.id
GROUP BY m.id, m.name, m.vendor_code;
