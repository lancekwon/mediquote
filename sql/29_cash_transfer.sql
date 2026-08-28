-- ============================================================
-- 계좌간 이체 지원
-- cash_balance_log 두 행을 transfer_id로 페어링:
--   출발 계좌: delta = -amount, entry_type = '이체(출금)'
--   도착 계좌: delta = +amount, entry_type = '이체(입금)'
-- 삭제 시 페어 함께 삭제 → 잔액·리포트 정합성 유지
-- ============================================================

ALTER TABLE cash_balance_log
  ADD COLUMN IF NOT EXISTS transfer_id UUID;

CREATE INDEX IF NOT EXISTS idx_cash_balance_log_transfer_id
  ON cash_balance_log(transfer_id);

COMMENT ON COLUMN cash_balance_log.transfer_id IS '계좌간 이체 페어링 · 같은 값을 가진 두 행이 한 쌍';
