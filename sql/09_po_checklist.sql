-- ============================================================
-- 발주별 체크리스트 (po_checklist_items)
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
--
-- 발주(PO)마다 자유 체크리스트 항목 누적
-- 완료/미완료 토글, 미완료 카운트로 화면에 배지 표시
-- ============================================================

CREATE TABLE IF NOT EXISTS po_checklist_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  content text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  done_at timestamptz,
  author text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS po_checklist_po_idx ON po_checklist_items (po_id, created_at);
CREATE INDEX IF NOT EXISTS po_checklist_open_idx ON po_checklist_items (po_id) WHERE done = false;

ALTER TABLE po_checklist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "po_checklist_all" ON po_checklist_items;
CREATE POLICY "po_checklist_all" ON po_checklist_items FOR ALL USING (true) WITH CHECK (true);
