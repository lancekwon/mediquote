-- ============================================================
-- 발주 품목에 세금계산서 상태 추가
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
-- ============================================================

-- purchase_order_items: 품목별 세금계산서 수령 여부
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS tax_invoiced boolean DEFAULT false;
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS tax_invoiced_at date;
