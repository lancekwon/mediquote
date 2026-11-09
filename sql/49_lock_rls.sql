-- 49. DB 잠그기 — 직접 접근은 어드민 로그인만. 나머지는 서버(비밀 키)를 거침.
-- 실행 전 조건: Vercel SUPABASE_KEY와 .env.local SB_KEY가 비밀 키(sb_secret_...)일 것, "발주 공유 보기" 처리 완료.
-- 되돌리기: sql/49_lock_rls_revert.sql

create or replace function public.is_admin() returns boolean
language sql stable
set search_path = ''
as $$ select coalesce(auth.jwt() ->> 'email', '') = 'wooheock2@gmail.com' $$;

do $$
declare
  t text;
  p record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- 요약 뷰는 기본이 "만든 사람 권한"이라 위 규칙을 건너뜀 → 조회하는 사람 권한으로
alter view public.v_activity_feed set (security_invoker = true);
alter view public.v_expected_revenue_summary set (security_invoker = true);
alter view public.v_payable_balance set (security_invoker = true);
alter view public.v_receivable_balance set (security_invoker = true);
alter view public.v_unmatched_purchase_ti set (security_invoker = true);

-- 장비 사진: 보기는 공개 그대로, 올리기·고치기·지우기는 어드민만
drop policy if exists public_insert_equipment on storage.objects;
drop policy if exists public_update_equipment on storage.objects;
drop policy if exists public_delete_equipment on storage.objects;
create policy admin_insert_equipment on storage.objects for insert to authenticated with check (bucket_id = 'equipment' and public.is_admin());
create policy admin_update_equipment on storage.objects for update to authenticated using (bucket_id = 'equipment' and public.is_admin()) with check (bucket_id = 'equipment' and public.is_admin());
create policy admin_delete_equipment on storage.objects for delete to authenticated using (bucket_id = 'equipment' and public.is_admin());
