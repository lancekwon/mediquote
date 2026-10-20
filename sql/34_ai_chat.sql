-- Phase 1: AI 챗 + 견적 draft 전용 신규 테이블
-- 기존 테이블(hospitals, manufacturers, equipment, quotes, purchase_orders 등) 일체 변경 없음
-- 2026-10-20

-- =========================================================
-- 1. chat_sessions : 딜러별 챗 세션
-- =========================================================
CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner text NOT NULL,                      -- 딜러 식별자 (이름 or 이메일)
  title text,                               -- 세션 제목 (첫 메시지 요약 자동 생성)
  last_message_at timestamptz DEFAULT now(),
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_sessions_owner_idx
  ON chat_sessions (owner, last_message_at DESC) WHERE archived = false;

ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_sessions_all" ON chat_sessions;
CREATE POLICY "chat_sessions_all" ON chat_sessions FOR ALL USING (true) WITH CHECK (true);


-- =========================================================
-- 2. chat_messages : 세션별 메시지 (user / assistant / tool)
-- =========================================================
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content text,                             -- 텍스트 본문
  tool_calls jsonb,                         -- assistant: [{name, input}]
  tool_result jsonb,                        -- tool: {tool_use_id, content}
  input_tokens int,
  output_tokens int,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_session_idx
  ON chat_messages (session_id, created_at);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_messages_all" ON chat_messages;
CREATE POLICY "chat_messages_all" ON chat_messages FOR ALL USING (true) WITH CHECK (true);


-- =========================================================
-- 3. quotes_ai_draft : AI가 작성한 견적 draft (기존 quotes 와 분리)
-- =========================================================
-- status 플로우: draft (AI 작성) → confirmed (사용자가 기존 quotes 로 복제)
--             → archived (사용자 삭제 or 폐기)
-- 기존 quotes 테이블은 **절대 안 건드림**. 복제 로직은 Phase 2에서.
CREATE TABLE IF NOT EXISTS quotes_ai_draft (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  owner text NOT NULL,
  hospital_id uuid REFERENCES hospitals(id) ON DELETE SET NULL,
  hospital_name text,                       -- 신규 병원일 수 있어 snapshot 보관
  items jsonb NOT NULL,                     -- [{equipment_id, name, qty, unit_price, total}]
  subtotal bigint,
  vat bigint,
  total_amount bigint,
  memo text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','confirmed','archived')),
  confirmed_quote_id uuid,                  -- 기존 quotes 로 복제됐을 때의 id (Phase 2)
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quotes_ai_draft_owner_idx
  ON quotes_ai_draft (owner, created_at DESC) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS quotes_ai_draft_session_idx
  ON quotes_ai_draft (session_id);

ALTER TABLE quotes_ai_draft ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "quotes_ai_draft_all" ON quotes_ai_draft;
CREATE POLICY "quotes_ai_draft_all" ON quotes_ai_draft FOR ALL USING (true) WITH CHECK (true);
