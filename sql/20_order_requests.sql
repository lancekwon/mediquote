-- ============================================================
-- 발주 요청함 (order_requests) — 현장/영업 요청을 빠르게 캡처
-- 실행: Supabase Dashboard > SQL Editor
--
-- 자유 텍스트로 막 던져넣는 inbox. 거래처/마스터 검증 없이 캡처만.
-- 나중에 발주계획서에 정식 등록 후 status='완료' 처리.
-- ============================================================

CREATE TABLE IF NOT EXISTS order_requests (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  requester text,                       -- 요청자 (영업사원 등)
  site text,                            -- 현장 / 병원
  content text NOT NULL,                -- 요청 내용 (자유 텍스트: 장비/수량/거래처 등)
  contact text,                         -- 연락처
  status text NOT NULL DEFAULT '대기' CHECK (status IN ('대기','완료','보류')),
  memo text,                            -- 처리 메모
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS order_requests_status_idx ON order_requests (status, created_at DESC);

ALTER TABLE order_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "order_requests_all" ON order_requests;
CREATE POLICY "order_requests_all" ON order_requests FOR ALL USING (true) WITH CHECK (true);
