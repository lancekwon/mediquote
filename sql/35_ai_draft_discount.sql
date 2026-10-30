-- AI 견적 draft에 전체 할인(globalDiscount) 저장용 컬럼 추가
-- 2026-10-30
--
-- global_discount 포맷: {"type": "rate" | "amount", "value": number}
--   - type='rate'   : value는 % (예: 5 → 5% 할인)
--   - type='amount' : value는 원화 금액 (예: 1000000 → 100만원 할인)

ALTER TABLE quotes_ai_draft
  ADD COLUMN IF NOT EXISTS global_discount jsonb;

COMMENT ON COLUMN quotes_ai_draft.global_discount IS
  '전체 할인 {type:"rate"|"amount", value:number}. AI 챗에서 할인 요청 받으면 품목 추가 대신 이 필드로 저장. UI의 PdfPreviewModal.globalDiscount로 그대로 주입됨.';
