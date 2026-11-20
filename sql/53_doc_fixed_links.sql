-- 53. 서류 고정 링크 + 거래명세서 발행일자 (2026-11-20 사용자)
--   "영업사원이 카톡으로 보내는 계산서 링크와 my. 문서함의 계산서가 같은 주소" → 서류마다 링크 하나
--   quote_shares.doc_ref = 'tax_invoice:<tax_invoices.id>' | 'statement:<hospital_statements.id>' (견적서는 비어 있음)
--   이 행은 화면 사본(html)을 안 담고, 열 때마다 api/quote.mjs가 DB에서 그 서류를 그려 줌 (PDF를 바꿔 올려도 같은 링크에 새 내용)
--   "세금계산서 발행날짜랑 거래명세서 날짜를 같은 날로" → 명세서 발행일자를 고를 수 있게 (기본 = 연결된 계산서 작성일자)

alter table public.quote_shares add column if not exists doc_ref text;
create unique index if not exists quote_shares_doc_ref_key on public.quote_shares(doc_ref);  -- null은 여러 개 가능

alter table public.hospital_statements add column if not exists issue_date date;  -- 명세서 왼쪽 위 발행일자 (없으면 뽑은 날)
