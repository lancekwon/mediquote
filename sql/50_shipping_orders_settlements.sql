-- 50. 출고지시서 + 매출정산서 (2026-11-20 사용자 요청)
-- 흐름: 영업사원 견적서(quotes_ai_draft) → 출고지시서 요청 → 관리자가 거래처·매입가 넣고 승인(=서명)
--       → 거래처별 발주(purchase_orders) 자동 생성 → 납품완료 → 영업사원이 매출정산서(세금계산서 발행 요청)
--       → 관리자가 발행 → 업데이트 때 계산서 연결
-- 영업사원은 api/sales.mjs로만 읽고 씀. 매입가·거래처(shipping_order_items.manufacturer_id, purchase_price)는 그 서버가 아예 안 읽음.
-- 정책은 다른 테이블과 같게 열어두고, DB 잠그기(49)에서 전체를 한 번에 닫음.

create table if not exists public.shipping_orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique,                       -- 출고-2026-001
  rep_id uuid references public.sales_reps(id) on delete set null,
  rep_name text not null,                              -- 판매 담당 이름 → 발주 owner (명단에서 빠져도 남음)
  draft_id uuid references public.quotes_ai_draft(id) on delete set null,
  hospital_id uuid not null references public.hospitals(id),
  hospital_name text not null,
  delivery_date date,                                  -- 납품 희망일
  delivery_place text,                                 -- 설치 장소
  memo text,                                           -- 영업사원 메모
  sale_total bigint not null,                          -- 매출 합계 (부가세 포함, 할인 줄 포함)
  status text not null default '요청' check (status in ('요청', '승인', '반려', '취소')),
  admin_memo text,
  reject_reason text,
  approved_by text,                                    -- 승인한 관리자 (이름 또는 이메일)
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shipping_orders_rep_idx on public.shipping_orders(rep_id, created_at desc);
create index if not exists shipping_orders_status_idx on public.shipping_orders(status);
-- 같은 견적서로 진행 중인 출고지시서는 하나만
create unique index if not exists shipping_orders_draft_open_idx on public.shipping_orders(draft_id) where status in ('요청', '승인');

create table if not exists public.shipping_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.shipping_orders(id) on delete cascade,
  sort int not null default 0,
  equipment_id uuid references public.equipment(id) on delete set null,
  item_name text not null,
  model_name text,
  quantity int not null default 1,
  sale_price bigint not null,                          -- 매출 단가 (부가세 포함). 할인 줄은 음수
  is_discount boolean not null default false,
  -- 여기부터 관리자만 (영업사원 서버는 안 읽음)
  manufacturer_id uuid references public.manufacturers(id) on delete set null,  -- 할인 줄은 "어느 거래처 발주에 넣을지"
  purchase_price bigint,                               -- 매입 단가 (부가세 포함). 비우면 발주도 빈칸 (계산서 오면 채움)
  po_id uuid references public.purchase_orders(id) on delete set null,
  po_item_id uuid references public.purchase_order_items(id) on delete set null
);
create index if not exists shipping_order_items_order_idx on public.shipping_order_items(order_id, sort);
create index if not exists shipping_order_items_po_idx on public.shipping_order_items(po_id);

-- 매출정산서 = 세금계산서 발행 요청 (요청 당시 받는 쪽 정보·품목 그대로 보관)
create table if not exists public.sales_settlements (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.shipping_orders(id) on delete set null,
  rep_id uuid references public.sales_reps(id) on delete set null,
  rep_name text,
  hospital_id uuid not null references public.hospitals(id),
  buyer_name text not null,                            -- 상호 (병원 이름)
  buyer_address text not null,
  buyer_reg_no text not null,                          -- 사업자번호 10자리
  buyer_ceo text not null,                             -- 대표자 (원장)
  buyer_email text not null,
  issue_date date not null,                            -- 발행(작성)일자
  supply_amount bigint not null,
  tax_amount bigint not null,
  total_amount bigint not null,                        -- 발행금액 (부가세 포함)
  items jsonb not null,                                -- [{name, spec, qty, unit_price(공급가 단가), supply, tax}]
  memo text,
  status text not null default '요청' check (status in ('요청', '발행완료', '반려', '취소')),
  reject_reason text,
  tax_invoice_id uuid references public.tax_invoices(id) on delete set null,
  handled_by text,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sales_settlements_status_idx on public.sales_settlements(status);
create index if not exists sales_settlements_hospital_idx on public.sales_settlements(hospital_id);
-- 출고지시서 하나에 살아 있는 정산서는 하나만
create unique index if not exists sales_settlements_order_open_idx on public.sales_settlements(order_id) where status in ('요청', '발행완료');

-- 병원: 세금계산서용 대표자·이메일 (정산서 낼 때 채우면 다음부터 자동)
alter table public.hospitals add column if not exists ceo_name text;
alter table public.hospitals add column if not exists tax_email text;

alter table public.shipping_orders enable row level security;
drop policy if exists "all" on public.shipping_orders;
create policy "all" on public.shipping_orders for all using (true) with check (true);

alter table public.shipping_order_items enable row level security;
drop policy if exists "all" on public.shipping_order_items;
create policy "all" on public.shipping_order_items for all using (true) with check (true);

alter table public.sales_settlements enable row level security;
drop policy if exists "all" on public.sales_settlements;
create policy "all" on public.sales_settlements for all using (true) with check (true);
