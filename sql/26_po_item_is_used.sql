-- 26. purchase_order_items에 is_used 컬럼 추가 (중고 여부)
-- 발주 행(품목) 단위로 신품/중고 구분 → 매입가 현황 통계에서 신품/중고 분리 집계
-- 기존 행은 신품(false)로 백필

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS is_used boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN purchase_order_items.is_used IS '중고 여부 — 매입가 현황에서 신품/중고 통계 분리';
