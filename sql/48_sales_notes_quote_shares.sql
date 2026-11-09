-- 48. 영업사원 앱: 방문 메모·다음 연락일, 견적서 카톡 공유
-- 메모는 담당 병원 또는 내 견적서에 붙음 (담당 지정은 납품·수금 후라, 영업 중인 곳은 견적서에 메모).
-- 정책은 다른 테이블과 같게 열어두고, DB 잠그기 단계에서 전체를 한 번에 닫음.

create table if not exists public.sales_notes (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid references public.sales_reps(id) on delete set null, -- 담당자가 빠져도 병원 메모는 다음 담당자가 봄
  hospital_id uuid references public.hospitals(id) on delete cascade,
  draft_id uuid references public.quotes_ai_draft(id) on delete cascade,
  body text not null,
  next_contact_date date,
  contacted_at timestamptz,
  created_at timestamptz not null default now(),
  check (hospital_id is not null or draft_id is not null)
);
create index if not exists sales_notes_hospital_idx on public.sales_notes(hospital_id);
create index if not exists sales_notes_draft_idx on public.sales_notes(draft_id);
create index if not exists sales_notes_followup_idx on public.sales_notes(rep_id, next_contact_date) where contacted_at is null;

alter table public.sales_notes enable row level security;
drop policy if exists "all" on public.sales_notes;
create policy "all" on public.sales_notes for all using (true) with check (true);

-- 카톡으로 보낸 견적서 사본 (보낼 당시 모습 그대로, /q/<token>으로 열림)
create table if not exists public.quote_shares (
  token text primary key,
  rep_id uuid references public.sales_reps(id) on delete set null,
  draft_id uuid references public.quotes_ai_draft(id) on delete set null,
  title text,
  html text not null,
  created_at timestamptz not null default now()
);

alter table public.quote_shares enable row level security;
drop policy if exists "all" on public.quote_shares;
create policy "all" on public.quote_shares for all using (true) with check (true);
