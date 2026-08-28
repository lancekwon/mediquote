-- ============================================================
-- 통장(계좌) 여러 개 지원
--   1) accounts 테이블 신설 (계좌 마스터)
--   2) cash_balance_log.account_id 컬럼 추가 (FK)
--   3) 기존 로그는 '주계좌'로 배정
-- ============================================================

-- 1. accounts 테이블
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  bank TEXT,                       -- 은행명 (선택)
  account_no TEXT,                 -- 계좌번호 (선택)
  opening_balance NUMERIC DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE accounts IS '통장(계좌) 마스터 · cash_balance_log가 참조';
COMMENT ON COLUMN accounts.opening_balance IS '이월 시작 잔액 (선택)';

-- 2. 주계좌 시드 (기존 데이터 배정용)
INSERT INTO accounts (name, sort_order)
VALUES ('주계좌', 0)
ON CONFLICT (name) DO NOTHING;

-- 3. cash_balance_log에 account_id 추가
ALTER TABLE cash_balance_log
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cash_balance_log_account_id
  ON cash_balance_log(account_id);

-- 4. 기존 로그(account_id NULL)를 주계좌로 배정
UPDATE cash_balance_log
   SET account_id = (SELECT id FROM accounts WHERE name = '주계좌')
 WHERE account_id IS NULL;

-- 5. (선택) 앞으로 신규 입력은 반드시 계좌 지정하도록. 데이터 정합성 원하면 실행.
--    지금은 코드 변경 후 별도 실행 권장 (안 그러면 코드 변경 안 된 옛 코드가 insert 실패)
-- ALTER TABLE cash_balance_log ALTER COLUMN account_id SET NOT NULL;

COMMENT ON COLUMN cash_balance_log.account_id IS '어느 통장에서 발생한 거래인지 · accounts.id 참조';
