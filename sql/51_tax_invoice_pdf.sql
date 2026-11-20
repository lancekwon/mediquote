-- 51. 세금계산서 PDF (2026-11-20 사용자): 관리자가 홈택스에서 받은 매출 세금계산서 PDF를 계산서마다 올림
--     → 영업사원 앱 병원 화면에 원장님이 받는 것과 같은 PDF가 뜨고, 카톡으로 PDF 파일 공유
-- 파일: storage 버킷 tax-invoices (비공개), 경로 = <tax_invoices.id>.pdf
--   영업사원은 api/sales.mjs가 담당 병원 계산서만 잠깐 쓰는 서명 링크(10분)를 만들어 줌
--   정책은 지금 다른 표처럼 열어 둠 → DB 잠그기(49) 때 관리자만으로 (49 파일 끝에 추가해 둠)

alter table public.tax_invoices add column if not exists pdf_path text;          -- tax-invoices 버킷 안 경로
alter table public.tax_invoices add column if not exists pdf_uploaded_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tax-invoices', 'tax-invoices', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists tax_invoices_pdf_select on storage.objects;
drop policy if exists tax_invoices_pdf_insert on storage.objects;
drop policy if exists tax_invoices_pdf_update on storage.objects;
drop policy if exists tax_invoices_pdf_delete on storage.objects;
create policy tax_invoices_pdf_select on storage.objects for select using (bucket_id = 'tax-invoices');
create policy tax_invoices_pdf_insert on storage.objects for insert with check (bucket_id = 'tax-invoices');
create policy tax_invoices_pdf_update on storage.objects for update using (bucket_id = 'tax-invoices') with check (bucket_id = 'tax-invoices');
create policy tax_invoices_pdf_delete on storage.objects for delete using (bucket_id = 'tax-invoices');
