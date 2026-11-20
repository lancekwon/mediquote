-- 52. 세금계산서·거래명세서 카톡 링크 보내기 (2026-11-20 사용자: 견적서처럼 링크로)
--     quote_shares(/q/<token>)를 같이 씀: 서류 화면 사본(html) + "PDF 저장"용 파일 위치
--     세금계산서 = tax-invoices 버킷의 원본 PDF, 거래명세서 = 휴대폰에서 만든 PDF를 doc-shares 버킷에 올림
--     /q/<token>/pdf → api/quote.mjs가 서버 키로 파일을 꺼내 내려줌 (링크 아는 사람만)

alter table public.quote_shares add column if not exists kind text not null default 'quote';  -- quote | statement | tax_invoice
alter table public.quote_shares add column if not exists file_bucket text;
alter table public.quote_shares add column if not exists file_path text;
alter table public.quote_shares add column if not exists file_name text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('doc-shares', 'doc-shares', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 지금은 다른 표처럼 열어 둠 → DB 잠그기(49) 때 관리자만 (서버는 비밀 키라 정책과 무관)
drop policy if exists doc_shares_select on storage.objects;
drop policy if exists doc_shares_insert on storage.objects;
create policy doc_shares_select on storage.objects for select using (bucket_id = 'doc-shares');
create policy doc_shares_insert on storage.objects for insert with check (bucket_id = 'doc-shares');
