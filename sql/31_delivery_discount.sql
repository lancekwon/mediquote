-- ============================================================
-- 거래명세서(deliveries)에 할인 정보 추가
--   discount_items: [{memo, amount}, ...]  — 할인 이력 (여러 개)
--   discount_total: 총 할인 금액 (조회 편의를 위한 컬럼)
--
-- 리포트에서 병원 순이익 = 거래처별 이익 합 - 할인 총액
-- ============================================================

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS discount_items JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS discount_total NUMERIC DEFAULT 0;

COMMENT ON COLUMN deliveries.discount_items IS '할인 이력 [{memo:string, amount:number}, ...]';
COMMENT ON COLUMN deliveries.discount_total IS '할인 총 금액 (discount_items 합계와 일치)';

CREATE INDEX IF NOT EXISTS idx_deliveries_discount_total
  ON deliveries(hospital_id, delivered_date) WHERE discount_total > 0;
