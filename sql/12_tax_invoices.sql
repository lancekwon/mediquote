-- ============================================================
-- 세금계산서 (tax_invoices)
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
--
-- 매출(sale)·매입(purchase) 세금계산서 통합 기록
-- ============================================================

CREATE TABLE IF NOT EXISTS tax_invoices (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('sale','purchase')),
  issue_date date NOT NULL,
  party_name text NOT NULL,                 -- 상호 (병원명 or 거래처명)
  amount bigint NOT NULL CHECK (amount > 0),
  memo text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tax_invoices_kind_date_idx ON tax_invoices (kind, issue_date DESC);

ALTER TABLE tax_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tax_invoices_all" ON tax_invoices;
CREATE POLICY "tax_invoices_all" ON tax_invoices FOR ALL USING (true) WITH CHECK (true);
