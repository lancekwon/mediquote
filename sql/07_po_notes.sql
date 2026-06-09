-- ============================================================
-- 발주별 메모·이슈 로그 (po_notes)
-- 실행: Supabase Dashboard > SQL Editor
--   https://supabase.com/dashboard/project/nbgubiywavozgigiwkpr/sql
--
-- 발주(PO)마다 자유 메모를 시간순으로 누적
-- 카테고리: general(일반) / issue(이슈) / change(변경)
-- ============================================================

CREATE TABLE IF NOT EXISTS po_notes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'general' CHECK (category IN ('general','issue','change')),
  body text NOT NULL,
  author text,                       -- 작성자 이메일/이름 (현재 로그인 사용자)
  resolved boolean NOT NULL DEFAULT false,  -- 이슈 해결 여부
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS po_notes_po_idx ON po_notes (po_id, created_at DESC);
CREATE INDEX IF NOT EXISTS po_notes_unresolved_idx ON po_notes (po_id) WHERE category = 'issue' AND resolved = false;

ALTER TABLE po_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "po_notes_all" ON po_notes;
CREATE POLICY "po_notes_all" ON po_notes FOR ALL USING (true) WITH CHECK (true);
