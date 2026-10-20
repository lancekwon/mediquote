-- ============================================================
-- 거래처 사업자번호 전용 컬럼
--   manufacturers, hospitals에 business_reg_no 추가
--   UNIQUE 인덱스로 중복 등록 방지
--   저장은 하이픈 없는 10자리 숫자 (예: "1028142945")
--   NULL 허용 (사업자번호 모르는 거래처 OK)
-- ============================================================

ALTER TABLE manufacturers
  ADD COLUMN IF NOT EXISTS business_reg_no VARCHAR(10);

ALTER TABLE hospitals
  ADD COLUMN IF NOT EXISTS business_reg_no VARCHAR(10);

COMMENT ON COLUMN manufacturers.business_reg_no IS '사업자번호 10자리 (하이픈 제외). Clobe 매칭 1차 키';
COMMENT ON COLUMN hospitals.business_reg_no     IS '사업자번호 10자리 (하이픈 제외). Clobe 매칭 1차 키';

-- UNIQUE 인덱스 (NULL은 중복 허용)
CREATE UNIQUE INDEX IF NOT EXISTS idx_mfr_biz
  ON manufacturers(business_reg_no) WHERE business_reg_no IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hosp_biz
  ON hospitals(business_reg_no) WHERE business_reg_no IS NOT NULL;
