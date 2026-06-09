-- ============================================================
-- 발주 품목별 '입금' 컬럼 추가 (거래처 송금 완료 여부)
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
-- ============================================================

ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS paid boolean DEFAULT false;
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS paid_at date;
