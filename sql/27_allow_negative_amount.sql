-- ============================================================
-- receivable / payable 테이블의 amount CHECK constraint 제거
-- 목적: 통장 거래 입력에서 -(마이너스) 금액으로 환불/취소를 자연스럽게 표현
--
-- 예) 병원 선수금 환불:
--   collect + amount=-32,000,000 → 원장 signOf에서 부호 반영되어 자동으로
--   "증가" 열(받을돈 회복)에 표시됨. 회계 정합성 유지.
--
-- amount>=0 제약이 있으면 dbInsertReceivableTransaction이 조용히 실패하고
-- (try/catch로 감싸져 있음), cash_log에만 저장되어 원장에 반영 안 됨.
-- ============================================================

ALTER TABLE receivable_transactions
  DROP CONSTRAINT IF EXISTS receivable_transactions_amount_check;

ALTER TABLE payable_transactions
  DROP CONSTRAINT IF EXISTS payable_transactions_amount_check;

-- 안전 장치: amount=0은 여전히 무의미하므로 금지 (양수/음수만 허용)
ALTER TABLE receivable_transactions
  ADD CONSTRAINT receivable_transactions_amount_nonzero CHECK (amount <> 0);

ALTER TABLE payable_transactions
  ADD CONSTRAINT payable_transactions_amount_nonzero CHECK (amount <> 0);
