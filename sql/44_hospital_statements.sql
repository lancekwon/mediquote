-- 2026-11-05: 거래명세서 사본 — 병원 포털(my.) 문서함 > 납품 내역에서 병원이 다시 볼 수 있게
--
-- 관리자 앱 발주관리 → 병원 그룹 "📄 거래명세서"(PDF 저장 / PDF + 병원관리 저장)로 명세서를 만들 때
-- 찍힌 내용 그대로(품목·수량·단가·할인·공급자 정보) 한 장씩 저장한다.
-- 나중에 발주 단가를 고쳐도 이미 발행한 명세서는 그대로 (발행 당시 사본).
--
-- 같은 병원 + 같은 납품일자 + 같은 발주 묶음(po_key)으로 다시 뽑으면 새로 쌓지 않고 덮어씀 (재출력·수정 반영).
-- shared = false 면 병원 포털에서 안 보임 (관리자 명세서 창의 "포털에 올린 명세서" 목록에서 숨기기).
--
-- 금액: 병원 포털은 원래 금액 비공개지만, 거래명세서만은 병원에 드린 서류 그대로 금액 포함해서 보여줌 (사용자 결정 2026-11-05)
-- unit_price = 부가세 포함 단가 (발주 품목 sale_price, 명세서 PDF와 같은 기준)
--
-- 쓰는 곳: app.jsx handleHospitalStatementForGroup (저장), api/portal.mjs loadBundle (병원 화면)
-- 실행: apply_migration (hospital_statements_44). 다시 실행해도 안전함.

create table if not exists hospital_statements (
  id             uuid primary key default gen_random_uuid(),
  hospital_id    uuid not null references hospitals(id) on delete cascade,
  statement_date date not null,                       -- 명세서의 납품일자
  issued_at      timestamptz not null default now(),  -- 발행(마지막 출력) 시각
  po_ids         uuid[] not null default '{}',
  po_key         text not null,                       -- po_ids 정렬해서 이은 값 (같은 묶음 재출력 판별)
  hospital_name  text,
  hospital_address text,
  supplier       jsonb not null default '{}'::jsonb,  -- {name, business_no, representative, address, phone, fax}
  items          jsonb not null default '[]'::jsonb,  -- [{item_name, model_name, qty, unit_price}]
  subtotal       numeric not null default 0,          -- 품목 합계 (부가세 포함)
  discount_total numeric not null default 0,
  total          numeric not null default 0,          -- 총 합계 = subtotal - discount_total
  shared         boolean not null default true,       -- 병원 포털에 보이기
  created_by     text,
  unique (hospital_id, statement_date, po_key)
);

create index if not exists hospital_statements_hospital_idx on hospital_statements (hospital_id, statement_date desc);

comment on table hospital_statements is '거래명세서 발행 사본 — 병원 포털 문서함에서 병원이 다시 봄. 발행 당시 품목·단가 그대로';

alter table hospital_statements enable row level security;
drop policy if exists "hospital_statements_all" on hospital_statements;
create policy "hospital_statements_all" on hospital_statements for all using (true) with check (true);
grant select, insert, update, delete on hospital_statements to anon, authenticated, service_role;

notify pgrst, 'reload schema';
