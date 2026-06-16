-- ============================================================
-- 발주 요청함 필드 변경 — 연락처 제거 + 모델명/수량/견적가격 추가
-- 실행: Supabase Dashboard > SQL Editor
-- ============================================================

ALTER TABLE order_requests DROP COLUMN IF EXISTS contact;
ALTER TABLE order_requests ADD COLUMN IF NOT EXISTS model_name text;
ALTER TABLE order_requests ADD COLUMN IF NOT EXISTS quantity integer;
ALTER TABLE order_requests ADD COLUMN IF NOT EXISTS quote_price bigint;
