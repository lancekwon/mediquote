-- ============================================================
-- tax_invoices에 manufacturer_id / hospital_id FK 추가
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
--
-- 목적: 세금계산서를 거래처/병원 마스터와 연결해서
--   자금흐름 화면에서 거래처별 외상매입 잔액 = 받은 세금계산서 누적 - 송금 누적
--   을 정확히 계산할 수 있게 한다. (기존 party_name 텍스트는 백업 용도로 유지)
--
-- party_name은 그대로 두고 FK만 추가. UI는 모달 선택으로 FK 자동 채움.
-- ============================================================

ALTER TABLE tax_invoices ADD COLUMN IF NOT EXISTS manufacturer_id uuid REFERENCES manufacturers(id) ON DELETE SET NULL;
ALTER TABLE tax_invoices ADD COLUMN IF NOT EXISTS hospital_id uuid REFERENCES hospitals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tax_invoices_mfr_idx ON tax_invoices(manufacturer_id) WHERE manufacturer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tax_invoices_hosp_idx ON tax_invoices(hospital_id) WHERE hospital_id IS NOT NULL;

-- 기존 302건 일괄 매핑 (이름 정확 매칭)
-- 매입: party_name → manufacturers.name
UPDATE tax_invoices ti
SET manufacturer_id = m.id
FROM manufacturers m
WHERE ti.kind = 'purchase'
  AND ti.manufacturer_id IS NULL
  AND TRIM(ti.party_name) = TRIM(m.name);

-- 매출: party_name → hospitals.name
UPDATE tax_invoices ti
SET hospital_id = h.id
FROM hospitals h
WHERE ti.kind = 'sale'
  AND ti.hospital_id IS NULL
  AND TRIM(ti.party_name) = TRIM(h.name);

-- 확인용
-- SELECT kind, COUNT(*) AS total,
--   COUNT(CASE WHEN manufacturer_id IS NOT NULL OR hospital_id IS NOT NULL THEN 1 END) AS matched
-- FROM tax_invoices GROUP BY kind;
