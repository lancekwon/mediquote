-- ============================================================
-- 발주(purchase_order) 담당자 지정
--   권 / 성 / 최 중 하나. NULL 허용(과거 발주엔 없어도 됨)
-- ============================================================

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS owner TEXT;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_owner
  ON purchase_orders(owner);

COMMENT ON COLUMN purchase_orders.owner IS '영업 담당자 (권/성/최 · 자유 텍스트)';
