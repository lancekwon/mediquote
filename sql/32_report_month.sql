-- ============================================================
-- 리포트 전용 월 이동 컬럼
--   원본 created_at / delivered_date는 그대로 유지 (등록·납품 이력 보존)
--   report_month가 있으면 병원별 이익 화면 등에서 그 값을 우선 사용
--   NULL이면 기존 created_at / delivered_date 기준
--   값은 해당 월의 1일 (예: 2026-10-01)
-- ============================================================

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS report_month DATE;

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS report_month DATE;

COMMENT ON COLUMN purchase_orders.report_month IS '리포트 전용 이월 월 (YYYY-MM-01) · 원본 created_at 유지';
COMMENT ON COLUMN deliveries.report_month IS '리포트 전용 이월 월 (YYYY-MM-01) · 원본 delivered_date 유지';

CREATE INDEX IF NOT EXISTS idx_purchase_orders_report_month
  ON purchase_orders(hospital_id, report_month) WHERE report_month IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deliveries_report_month
  ON deliveries(hospital_id, report_month) WHERE report_month IS NOT NULL;
