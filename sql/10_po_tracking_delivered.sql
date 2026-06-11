-- ============================================================
-- 발주 진행 페이지 전용 납품 체크박스 (발주계획서 4단계와 별개)
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
--
-- 발주계획서의 purchase_order_items.delivered 와 별도로,
-- 발주 진행 페이지에서만 토글하는 PO 단위 납품 체크.
-- ============================================================

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS tracking_delivered boolean DEFAULT false;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS tracking_delivered_at date;
