-- ============================================================
-- equipment.vendor_id — manufacturers FK (정석 구조)
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
--
-- 기존 equipment.vendor 텍스트 컬럼은 보존 (백업 용도).
-- 화면 표시·발주 등 모든 곳은 vendor_id 기반으로 manufacturers join.
-- ============================================================

ALTER TABLE equipment ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES manufacturers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS equipment_vendor_id_idx ON equipment(vendor_id);
