-- ============================================================
-- mediquote 매출/수금(AR) 관리 모듈 — 스키마 생성
-- 실행 위치: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
--
-- 설계: 거래처 외상매입(AP)의 거울 구조
--   AP                    | AR
--   payable_transactions  | receivable_transactions
--   v_payable_balance     | v_receivable_balance
--   manufacturer_id       | hospital_id
--   purchase tx(매입)     | (별도 없음 — contracts.amount = 청구액으로 가정)
--   payment tx(지급)      | collect tx(수금)
-- ============================================================

-- 1. receivable_transactions (매출/수금 거래원장)
--    tx_type:
--      collect    — 수금 (병원→우리, 통장 입금과 cash_log_id 로 연결)
--      adjustment — 조정 (추가 청구 등)
--      cancel     — 미수금 소멸 (계약 취소 반영 등)
--    amount: 항상 양수. 부호는 tx_type 으로 결정.
--    미수금 = 청구합계(contracts.amount) + adjustment − collect − cancel
CREATE TABLE IF NOT EXISTS receivable_transactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  hospital_id uuid NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  contract_id uuid REFERENCES contracts(id) ON DELETE SET NULL,
  tx_date date NOT NULL,
  tx_type text NOT NULL CHECK (tx_type IN ('collect','adjustment','cancel')),
  amount bigint NOT NULL CHECK (amount >= 0),
  memo text,
  cash_log_id uuid REFERENCES cash_balance_log(id) ON DELETE SET NULL,
  collect_batch_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS receivable_tx_hosp_idx
  ON receivable_transactions (hospital_id, tx_date);
CREATE INDEX IF NOT EXISTS receivable_tx_contract_idx
  ON receivable_transactions (contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS receivable_tx_batch_idx
  ON receivable_transactions (collect_batch_id) WHERE collect_batch_id IS NOT NULL;

ALTER TABLE receivable_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "receivable_tx_all" ON receivable_transactions;
CREATE POLICY "receivable_tx_all" ON receivable_transactions FOR ALL USING (true) WITH CHECK (true);

-- 2. v_receivable_balance — 병원별 매출/수금/미수금 집계 뷰
--    청구합계는 contracts.amount 에서 직접 (status='취소' 제외)
--    누적 수금/조정/취소는 receivable_transactions 에서 집계
CREATE OR REPLACE VIEW v_receivable_balance AS
SELECT
  h.id AS hospital_id,
  h.name AS hospital_name,
  COALESCE(c.total_invoice, 0) AS total_invoice,
  COALESCE(c.contract_count, 0) AS contract_count,
  COALESCE(r.total_collected, 0) AS total_collected,
  COALESCE(r.total_adjustment, 0) AS total_adjustment,
  COALESCE(r.total_cancel, 0) AS total_cancel,
  (COALESCE(c.total_invoice, 0)
    + COALESCE(r.total_adjustment, 0)
    - COALESCE(r.total_collected, 0)
    - COALESCE(r.total_cancel, 0)) AS balance,
  r.last_tx_date
FROM hospitals h
LEFT JOIN (
  SELECT
    hospital_id,
    SUM(amount) AS total_invoice,
    COUNT(*)    AS contract_count
  FROM contracts
  WHERE hospital_id IS NOT NULL
    AND amount IS NOT NULL
    AND (status IS NULL OR status <> '취소')
  GROUP BY hospital_id
) c ON c.hospital_id = h.id
LEFT JOIN (
  SELECT
    hospital_id,
    SUM(CASE WHEN tx_type = 'collect'    THEN amount ELSE 0 END) AS total_collected,
    SUM(CASE WHEN tx_type = 'adjustment' THEN amount ELSE 0 END) AS total_adjustment,
    SUM(CASE WHEN tx_type = 'cancel'     THEN amount ELSE 0 END) AS total_cancel,
    MAX(tx_date) AS last_tx_date
  FROM receivable_transactions
  GROUP BY hospital_id
) r ON r.hospital_id = h.id;
