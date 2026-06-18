-- ============================================================
-- 세금계산서 음수 허용 (수정·취소 세금계산서)
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavospj... → nbgubiywavozgigiwkpr
--
-- 기존 amount > 0 제약이 수정세금계산서(마이너스 금액) 입력을 막음.
-- amount <> 0 으로 완화 (0원만 금지, 음수 허용).
-- ============================================================

ALTER TABLE tax_invoices DROP CONSTRAINT IF EXISTS tax_invoices_amount_check;
ALTER TABLE tax_invoices ADD CONSTRAINT tax_invoices_amount_check CHECK (amount <> 0);
