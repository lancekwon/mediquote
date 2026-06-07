-- ============================================================
-- mediquote 예상 매출 (expected_revenue) — 영업관리 의존성 0
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
--
-- 한 줄 = 청구 1건 (분할이면 같은 group_id로 N행)
-- 매출 종류 3가지: hospital(병원) / platform(플랫폼·파트너스) / referral(소개수수료)
-- ============================================================

CREATE TABLE IF NOT EXISTS expected_revenue (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 매출 종류
  kind text NOT NULL CHECK (kind IN ('hospital','platform','referral')),

  -- 대상 (병원/파트너/소개자)
  target_name text NOT NULL,                              -- 표시용 이름
  target_hospital_id uuid REFERENCES hospitals(id) ON DELETE SET NULL,  -- kind='hospital'일 때만

  -- 청구 정보
  title text,                                             -- 예: "당산리더스 6월 계약" / "5월 네이버 파트너스"
  installment_label text,                                 -- 선금/중도금/잔금/일시불/정기정산 등
  group_id uuid,                                          -- 같은 거래의 분할 묶음 (단건이면 null)
  amount bigint NOT NULL CHECK (amount > 0),              -- 청구 금액
  due_date date,                                          -- 수금 예정일

  -- 세금계산서
  invoice_issued boolean NOT NULL DEFAULT false,
  invoice_issued_date date,

  -- 수금
  collected boolean NOT NULL DEFAULT false,
  collected_date date,
  collected_cash_log_id uuid REFERENCES cash_balance_log(id) ON DELETE SET NULL,

  memo text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expected_revenue_kind_idx ON expected_revenue (kind);
CREATE INDEX IF NOT EXISTS expected_revenue_hosp_idx ON expected_revenue (target_hospital_id) WHERE target_hospital_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expected_revenue_group_idx ON expected_revenue (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expected_revenue_due_idx ON expected_revenue (due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS expected_revenue_cash_idx ON expected_revenue (collected_cash_log_id) WHERE collected_cash_log_id IS NOT NULL;

ALTER TABLE expected_revenue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "expected_revenue_all" ON expected_revenue;
CREATE POLICY "expected_revenue_all" ON expected_revenue FOR ALL USING (true) WITH CHECK (true);

-- 종류별 요약 뷰 (리포트/카드용)
CREATE OR REPLACE VIEW v_expected_revenue_summary AS
SELECT
  kind,
  COUNT(*)                                                              AS total_count,
  SUM(amount)                                                           AS total_invoice,
  SUM(CASE WHEN collected THEN amount ELSE 0 END)                       AS total_collected,
  SUM(CASE WHEN NOT collected THEN amount ELSE 0 END)                   AS total_outstanding,
  SUM(CASE WHEN invoice_issued THEN amount ELSE 0 END)                  AS total_invoiced,
  SUM(CASE WHEN NOT invoice_issued THEN amount ELSE 0 END)              AS total_pending_invoice
FROM expected_revenue
GROUP BY kind;
