-- ============================================================
-- 발주 독립화 (1단계) — 발주 품목에 매출가 보존
-- 발주가 견적에서 독립하면 품목별 매출가도 발주 시점 값으로 보존해야 함
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
-- ============================================================

ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS sale_price bigint DEFAULT 0;
