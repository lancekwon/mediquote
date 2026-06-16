-- ============================================================
-- 거래처 카테고리 (병원 / 일반업체 / 기타)
-- 실행: Supabase Dashboard > SQL Editor
--
-- manufacturers(거래처)에 category 추가. 기본 '일반업체'.
-- 병원은 hospitals 테이블에서 오므로 거래처 선택 시 '병원'으로 합쳐 표시(가상 통합).
-- ============================================================

ALTER TABLE manufacturers ADD COLUMN IF NOT EXISTS category text DEFAULT '일반업체';
UPDATE manufacturers SET category = '일반업체' WHERE category IS NULL;
