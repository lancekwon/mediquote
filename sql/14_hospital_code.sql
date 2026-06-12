-- ============================================================
-- hospitals.hospital_code (H001~) — 거래처 V코드와 동일한 패턴
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
-- ============================================================

ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS hospital_code text;

-- 생성순으로 H001 ~ Hxxx 부여 (한 번만 실행)
WITH numbered AS (
  SELECT id, 'H' || LPAD(ROW_NUMBER() OVER (ORDER BY created_at ASC NULLS LAST, id)::text, 3, '0') AS code
  FROM hospitals
)
UPDATE hospitals h
SET hospital_code = n.code
FROM numbered n
WHERE h.id = n.id;

CREATE INDEX IF NOT EXISTS hospitals_code_idx ON hospitals(hospital_code);
