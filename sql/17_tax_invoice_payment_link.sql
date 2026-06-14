-- ============================================================
-- tax_invoices.matched_payment_id — 세금계산서와 송금 1:N 매칭
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
--
-- 한 세금계산서 → 한 송금 (또는 NULL)
-- 한 송금 ← 여러 세금계산서 가능 (N:1)
-- 자금흐름 거래처별 매칭 모달에서 사용자가 직접 묶음.
-- ============================================================

ALTER TABLE tax_invoices ADD COLUMN IF NOT EXISTS matched_payment_id uuid REFERENCES payable_transactions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tax_invoices_matched_payment_idx ON tax_invoices(matched_payment_id) WHERE matched_payment_id IS NOT NULL;
