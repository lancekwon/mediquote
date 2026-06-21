-- 24. 거래처 계좌주명/별칭 컬럼 추가 (#5)
-- 목적: 매달 통장 import 시 은행이 사람이름/약칭으로 찍혀(오명근=엠케이베드, 여정희=케이엔티)
--       거래처 자동매칭률이 ~30%뿐. 거래처별 계좌주명·약칭을 저장해두고 통장 매칭 시 대조.
-- 형식: 쉼표로 구분한 별칭 목록 (예: "오명근, 엠케이, MK베드")
--       단일 text 컬럼 — 프론트 입력칸 1개로 단순 관리, JS/Python 양쪽에서 split 처리.

ALTER TABLE manufacturers ADD COLUMN IF NOT EXISTS aliases text;

COMMENT ON COLUMN manufacturers.aliases IS '통장 계좌주명/별칭 (쉼표 구분). 통장 import 자동매칭에 사용.';
