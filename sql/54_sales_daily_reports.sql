-- 54. 영업사원 일일보고 (2026-11-20 사용자: "영업사원들이 일일보고 할 수 있게")
--   글 한 칸(body) + 그날 활동 자동 기록(activity: 견적서·방문 메모·출고지시서·계산서 요청·카톡 보낸 것, 저장할 때 사본)
--   영업사원당 하루 한 장 (report_date = 한국 날짜), 그날 안엔 고침. 영업사원은 api/sales.mjs로만, 관리자는 앱(폰 화면·PC 메뉴)에서 읽음
create table if not exists public.sales_daily_reports (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references public.sales_reps(id) on delete cascade,
  report_date date not null,
  body text not null,
  activity jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rep_id, report_date)
);
create index if not exists sales_daily_reports_date_idx on public.sales_daily_reports(report_date desc);

alter table public.sales_daily_reports enable row level security;
drop policy if exists "all" on public.sales_daily_reports;
create policy "all" on public.sales_daily_reports for all using (true) with check (true);
