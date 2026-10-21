-- 2026-10-21: equipment 테이블에 사람이 식별 가능한 코드 추가
-- E001, E002, ... (등록순 자동 부여)

-- 1. 컬럼 + UNIQUE 인덱스
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS equip_code VARCHAR(10);
CREATE UNIQUE INDEX IF NOT EXISTS idx_equip_code
  ON equipment(equip_code) WHERE equip_code IS NOT NULL;

-- 2. 기존 데이터 일괄 부여 (created_at 오름차순)
--    E001 = 가장 먼저 등록된 품목
UPDATE equipment AS e
SET equip_code = 'E' || LPAD(sub.rn::text, 3, '0')
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC NULLS LAST, id ASC) AS rn
  FROM equipment
) AS sub
WHERE e.id = sub.id
  AND e.equip_code IS NULL;

-- 3. 확인용
-- SELECT equip_code, item_name, model_name, manufacturer, price
--   FROM equipment WHERE equip_code IS NOT NULL
--   ORDER BY equip_code LIMIT 20;
