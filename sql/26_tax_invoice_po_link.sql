-- ============================================================
-- 세금계산서 → 발주 연결 (매입계산서에 한함)
-- 목표: 거래처 원장에서 세금계산서 행 → 어떤 발주에 대한 건지 병기
-- ============================================================

-- 1. 매칭된 발주 참조
ALTER TABLE tax_invoices
  ADD COLUMN IF NOT EXISTS po_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL;

-- 2. "발주 없음(기타 매입)" 확정 플래그 (세무사비, 소모품 잡비 등)
ALTER TABLE tax_invoices
  ADD COLUMN IF NOT EXISTS no_po BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. 원장 로드 시 발주 조인이 잦으므로 인덱스
CREATE INDEX IF NOT EXISTS idx_tax_invoices_po_id ON tax_invoices(po_id);

-- 4. 설명
COMMENT ON COLUMN tax_invoices.po_id IS '연결된 발주. NULL + no_po=FALSE → 미매칭 (원장에 노란 뱃지). NULL + no_po=TRUE → 발주 없음(기타 매입) 확정.';
COMMENT ON COLUMN tax_invoices.no_po IS 'TRUE면 사용자가 명시적으로 "발주 없음(기타)"으로 확정. 미매칭 카운터에서 제외.';
