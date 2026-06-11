-- ============================================================
-- purchase_orders.updated_at — 마지막 변경 시점
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
-- ============================================================

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 기존 행은 created_at을 일단 그대로 복사 (NULL 방지)
UPDATE purchase_orders SET updated_at = COALESCE(updated_at, created_at, now()) WHERE updated_at IS NULL;
