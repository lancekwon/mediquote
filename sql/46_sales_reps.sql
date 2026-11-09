-- 46. 영업사원 명단 + 병원 담당자
-- 영업사원 앱은 본인 담당 병원만 보여줌. 담당은 어드민의 "영업사원 관리"에서 지정.
-- 발주 owner(최/권/성)는 성이 같은 사람을 구분 못 해서(성현기·성정윤) 담당 기준으로 쓰지 않음.

create table if not exists public.sales_reps (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique check (email = lower(email)),
  created_at timestamptz not null default now()
);

alter table public.sales_reps enable row level security;
drop policy if exists "all" on public.sales_reps;
create policy "all" on public.sales_reps for all using (true) with check (true);

alter table public.hospitals
  add column if not exists assigned_rep_id uuid references public.sales_reps(id) on delete set null;
create index if not exists hospitals_assigned_rep_idx on public.hospitals(assigned_rep_id);

insert into public.sales_reps (name, email) values
  ('최윤철', 'cycdp@naver.com'),
  ('성현기', 'daewonmedical89@gmail.com'),
  ('성정윤', 'lapiscine55@gmail.com'),
  ('권우혁(테스트)', 'wooheock13@gmail.com')
on conflict (email) do nothing;
