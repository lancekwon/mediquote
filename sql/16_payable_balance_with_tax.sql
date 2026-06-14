-- ============================================================
-- v_payable_balance 재정의 — payable_transactions + tax_invoices(매입) 합산
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
--
-- 변경 이유: 세금계산서 탭에서 입력한 매입(kind='purchase')도
--   거래처 외상 잔액에 포함되어야 함. 거래입력 탭의 "매입 외상등록" 유형은
--   세금계산서 탭으로 일원화됨.
--
-- balance = (payable.purchase + tax_invoices.purchase) - payable.payment
-- ============================================================

CREATE OR REPLACE VIEW v_payable_balance AS
WITH pt_agg AS (
  SELECT
    manufacturer_id,
    COALESCE(SUM(CASE WHEN tx_type IN ('opening','purchase','adjustment','cancel') THEN amount ELSE 0 END), 0) AS pt_purchase,
    COALESCE(SUM(CASE WHEN tx_type = 'payment' THEN amount ELSE 0 END), 0) AS pt_payment,
    MAX(tx_date) AS pt_last_date
  FROM payable_transactions
  WHERE manufacturer_id IS NOT NULL
  GROUP BY manufacturer_id
),
ti_agg AS (
  SELECT
    manufacturer_id,
    COALESCE(SUM(amount), 0) AS ti_purchase,
    MAX(issue_date) AS ti_last_date
  FROM tax_invoices
  WHERE kind = 'purchase' AND manufacturer_id IS NOT NULL
  GROUP BY manufacturer_id
)
SELECT
  m.id AS manufacturer_id,
  m.name AS manufacturer_name,
  m.vendor_code,
  (COALESCE(p.pt_purchase, 0) + COALESCE(t.ti_purchase, 0) - COALESCE(p.pt_payment, 0)) AS balance,
  (COALESCE(p.pt_purchase, 0) + COALESCE(t.ti_purchase, 0)) AS total_purchase,
  COALESCE(p.pt_payment, 0) AS total_payment,
  GREATEST(p.pt_last_date, t.ti_last_date) AS last_tx_date
FROM manufacturers m
LEFT JOIN pt_agg p ON p.manufacturer_id = m.id
LEFT JOIN ti_agg t ON t.manufacturer_id = m.id;

-- 확인용
-- SELECT * FROM v_payable_balance WHERE balance <> 0 ORDER BY balance DESC LIMIT 20;
