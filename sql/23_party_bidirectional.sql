-- ============================================================
-- 거래처 양방향 거래 — Phase 2b
-- 실행: Supabase Dashboard > SQL Editor
--
-- 거래처(manufacturer)에게 매출/수금(receivable), 병원(hospital)에게 매입/지급(payable)을
-- 기록할 수 있도록 양쪽 테이블에 반대편 참조 컬럼 추가.
-- ============================================================

ALTER TABLE receivable_transactions ADD COLUMN IF NOT EXISTS manufacturer_id uuid;
ALTER TABLE payable_transactions    ADD COLUMN IF NOT EXISTS hospital_id uuid;

-- 한쪽 참조만 채워지므로 기존 NOT NULL 제약 해제
-- (receivable는 manufacturer_id만, payable는 hospital_id만 채워지는 경우 허용)
ALTER TABLE receivable_transactions ALTER COLUMN hospital_id DROP NOT NULL;
ALTER TABLE payable_transactions    ALTER COLUMN manufacturer_id DROP NOT NULL;
