-- 2026-11-05: 병원별 이익의 월 = 매출 세금계산서 발행월
--
-- 상황: 병원별 이익이 "발주일(없으면 등록일)"로 월을 나눠서, 같은 병원 납품이 10월·11월로 갈라졌음 (바루다).
--       사용자 결정: 매출 세금계산서 발행월 기준으로 합친다.
--
-- 규칙 (품목마다):  ① 📅 이동으로 옮긴 달(purchase_orders.report_month)
--                   ② 이 품목에 연결된 매출 세금계산서 발행월 (purchase_order_items.sale_ti_id)
--                   ③ 발주일 (purchase_orders.ordered_at)
--                   ④ 등록일 (purchase_orders.created_at, 한국 시간)
--   - ①이 ②보다 앞 = 사용자 결정 (손으로 옮긴 달 우선)
--   - 계산서 전(②가 없음) 품목은 ③·④ 달에 보이고, 화면에 "계산서 전" 표시. 계산서가 연결되면 그 달로 옮겨감
--   - 품목 단위인 이유: 한 발주 안에 계산서가 다른 품목이 섞임 (예: 삼성에제르 PO-202 = 케이씨엘 계산서 품목 + 병원 계산서 품목)
--   - 매입도 같은 품목을 따라감 → 이익이 한 달 안에서 맞음
--   - 직거래(commission) 발주: 품목 대신 발주 단위 — ① → 연결된 수수료 계산서(tax_invoices.po_id) 첫 발행월 → ③ → ④
--
-- 바뀐 곳:
--   a) purchase_order_items.sale_ti_id  (매출 세금계산서 연결, 계산서 지워지면 자동으로 비워짐)
--   b) v_activity_feed PO 줄: items jsonb에 sale_ti_id · sale_ti_date · profit_month 추가
--      새 컬럼 맨 뒤 profit_months text[] = 이 발주 품목들이 걸친 월 목록 ('YYYY-MM')
--      → 병원별 이익은 profit_months=cs.{2026-11} 로 불러와서 그 달 품목만 합산
--   (나머지는 42번과 동일. 다른 줄(계산서·통장·지급·수금)은 profit_months = null)
--
-- 실행: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 다시 실행해도 안전함.

-- ============================================================
-- purchase_order_items.sale_ti_id
-- ============================================================
alter table purchase_order_items add column if not exists sale_ti_id uuid;
alter table purchase_order_items drop constraint if exists purchase_order_items_sale_ti_id_fkey;
alter table purchase_order_items add constraint purchase_order_items_sale_ti_id_fkey
  foreign key (sale_ti_id) references tax_invoices(id) on delete set null;
create index if not exists idx_poi_sale_ti on purchase_order_items(sale_ti_id) where sale_ti_id is not null;
comment on column purchase_order_items.sale_ti_id is '이 품목이 들어간 매출 세금계산서. 병원별 이익의 월 = 이 계산서 발행월 (📅 이동한 달이 있으면 그게 먼저)';

-- ============================================================
-- v_activity_feed (42번 + profit_months)
-- ============================================================
create or replace view v_activity_feed as

-- 1. 세금계산서
select
  ('t:' || t.id::text)::text                                  as feed_id,
  t.id::uuid                                                   as source_id,
  'tax_invoices'::text                                         as source_table,
  (case when t.kind = 'sale' then 'ti_sale' else 'ti_purchase' end)::text as kind,
  t.issue_date::timestamp                                      as happened_at,
  t.created_at::timestamp                                      as recorded_at,
  'clobe_sync'::text                                           as actor,
  null::text                                                   as owner,
  t.memo::text                                                 as memo,
  (case when t.hospital_id is not null then 'hospital'
        when t.manufacturer_id is not null then 'manufacturer'
        else 'other' end)::text                                as party_kind,
  coalesce(t.hospital_id, t.manufacturer_id)::uuid             as party_id,
  t.party_name::text                                           as party_name,
  null::text                                                   as party_reg_no,
  null::text                                                   as counterparty_raw,
  (case when t.kind = 'sale' then t.amount else -t.amount end)::numeric as amount,
  'KRW'::text                                                  as currency,
  t.po_id::uuid                                                as po_id,
  null::text                                                   as po_no,
  t.hospital_id::uuid                                          as hospital_id,
  t.manufacturer_id::uuid                                      as manufacturer_id,
  null::uuid                                                   as related_ti_id,
  null::text                                                   as parent_feed_id,
  null::jsonb                                                  as items,
  null::text                                                   as rep_item,
  null::integer                                                as item_count,
  null::uuid                                                   as account_id,
  null::text                                                   as account_name,
  null::numeric                                                as balance_after,
  null::bigint                                                 as clobe_tx_id,
  null::text                                                   as transaction_description,
  null::text                                                   as entry_type,
  t.kind::text                                                 as ti_kind,
  null::text                                                   as modification_reason,
  null::uuid                                                   as original_ti_id,
  null::text                                                   as settlement_status,
  t.clobe_ti_id::text                                          as clobe_ti_id,
  null::text                                                   as po_status,
  null::numeric                                                as sale_amount,
  null::numeric                                                as margin,
  coalesce(t.confirmed, false)::boolean                        as confirmed,
  null::date                                                   as report_month,
  null::text                                                   as hospital_name,
  null::text                                                   as vendor_name,
  null::text                                                   as deal_type,
  null::numeric                                                as commission_amount,
  null::numeric                                                as commission,
  null::text[]                                                 as profit_months
from tax_invoices t

union all

-- 2. 통장
select
  ('c:' || c.id::text)::text,
  c.id::uuid,
  'cash_balance_log'::text,
  (case when c.delta >= 0 then 'cash_in' else 'cash_out' end)::text,
  c.log_date::timestamp,
  c.created_at::timestamp,
  (case when c.clobe_tx_id is not null then 'clobe_sync' else 'user' end)::text,
  null::text,
  c.memo::text,
  'other'::text,
  null::uuid,
  c.counterparty::text,
  null::text,
  c.counterparty::text,
  c.delta::numeric,
  'KRW'::text,
  null::uuid, null::text, null::uuid, null::uuid, null::uuid, null::text,
  null::jsonb, null::text, null::integer,
  c.account_id::uuid,
  null::text,
  c.balance_after::numeric,
  c.clobe_tx_id::bigint,
  null::text,
  c.entry_type::text,
  null::text, null::text, null::uuid, null::text, null::text,
  null::text, null::numeric, null::numeric,
  true::boolean,
  null::date,
  null::text, null::text,
  null::text, null::numeric, null::numeric,
  null::text[]
from cash_balance_log c

union all

-- 3. 발주 — 매입 = 품목 매입합계, 취소만 제외 (납품완료 포함)
--    commission(제조사 직거래) 발주: 매입·매출 0, 이익 = 수수료 (확정 계산서 합계 → 없으면 예상 수수료)
--    profit_months: 병원별 이익에서 이 발주 품목이 잡히는 월들 (맨 위 규칙)
select
  ('po:' || p.id::text)::text,
  p.id::uuid,
  'purchase_orders'::text,
  'po_create'::text,
  coalesce(p.ordered_at::timestamp, p.created_at::timestamp),
  p.created_at::timestamp,
  coalesce('user:' || p.owner, 'user')::text,
  p.owner::text,
  null::text,
  (case when p.hospital_id is not null then 'hospital' else 'manufacturer' end)::text,
  coalesce(p.hospital_id, p.manufacturer_id)::uuid,
  coalesce(p.hospital_name, p.manufacturer_name, p.vendor_name)::text,
  null::text, null::text,
  (case when p.deal_type = 'commission' then 0
        else -(case when s.item_count > 0 then s.purchase_sum else coalesce(p.total_amount, 0) end) end)::numeric,
  'KRW'::text,
  p.id::uuid,
  p.po_no::text,
  p.hospital_id::uuid,
  p.manufacturer_id::uuid,
  null::uuid, null::text,
  s.items::jsonb,
  null::text,
  s.item_count::integer,
  null::uuid, null::text, null::numeric, null::bigint, null::text, null::text,
  null::text, null::text, null::uuid, null::text, null::text,
  p.status::text,
  (case when p.deal_type = 'commission' then 0 else coalesce(p.sale_amount, s.sale_sum) end)::numeric,
  (case when p.deal_type = 'commission' then coalesce(c.ti_sum, p.commission_amount, 0)
        else coalesce(p.sale_amount, s.sale_sum, 0)
             - (case when s.item_count > 0 then s.purchase_sum else coalesce(p.total_amount, 0) end) end)::numeric,
  (case when p.deal_type = 'commission' then c.ti_sum is not null
        else exists (select 1 from tax_invoices t2 where t2.po_id = p.id and t2.kind = 'purchase' and t2.amount > 0) end)::boolean,
  p.report_month::date,
  p.hospital_name::text,
  coalesce(p.manufacturer_name, p.vendor_name)::text,
  coalesce(p.deal_type, 'normal')::text,
  p.commission_amount::numeric,
  (case when p.deal_type = 'commission' then coalesce(c.ti_sum, p.commission_amount) end)::numeric,
  (case
     when p.deal_type = 'commission'
       then array[to_char(coalesce(p.report_month, c.ti_first, p.ordered_at, (p.created_at at time zone 'Asia/Seoul')::date), 'YYYY-MM')]
     when s.item_count > 0 then s.item_months
     else array[to_char(coalesce(p.report_month, p.ordered_at, (p.created_at at time zone 'Asia/Seoul')::date), 'YYYY-MM')]
   end)::text[]
from purchase_orders p
cross join lateral (
  select
    count(poi.id)::integer as item_count,
    coalesce(sum(coalesce(poi.unit_price, 0) * coalesce(poi.quantity, 0)), 0) as purchase_sum,
    sum(coalesce(poi.sale_price, 0) * coalesce(poi.quantity, 0)) as sale_sum,
    jsonb_agg(jsonb_build_object(
      'id', poi.id,
      'equipment_id', poi.equipment_id,
      'item_name', poi.item_name,
      'model_name', poi.model_name,
      'quantity', poi.quantity,
      'unit_price', poi.unit_price,
      'sale_price', poi.sale_price,
      'sale_ti_id', poi.sale_ti_id,
      'sale_ti_date', st.issue_date,
      'profit_month', to_char(coalesce(p.report_month, st.issue_date, p.ordered_at, (p.created_at at time zone 'Asia/Seoul')::date), 'YYYY-MM')
    )) filter (where poi.id is not null) as items,
    array_agg(distinct to_char(coalesce(p.report_month, st.issue_date, p.ordered_at, (p.created_at at time zone 'Asia/Seoul')::date), 'YYYY-MM'))
      filter (where poi.id is not null) as item_months
  from purchase_order_items poi
  left join tax_invoices st on st.id = poi.sale_ti_id
  where poi.po_id = p.id
) s
-- 확정 수수료 = 이 발주에 연결된 매출 세금계산서(제조사에 끊은 수수료 계산서) 합계. 없으면 null
left join lateral (
  select sum(t3.amount)::numeric as ti_sum, min(t3.issue_date) as ti_first
  from tax_invoices t3
  where t3.po_id = p.id and t3.kind = 'sale'
) c on true
where coalesce(p.status, '') <> '취소'

union all

-- 4. 지급 (payable_transactions)
select
  ('pay:' || pt.id::text)::text,
  pt.id::uuid,
  'payable_transactions'::text,
  (case when pt.tx_type = 'payment' then 'payable_pay'
        else 'payable_' || coalesce(pt.tx_type, 'other') end)::text,
  pt.tx_date::timestamp,
  pt.created_at::timestamp,
  'clobe_sync'::text,
  null::text,
  pt.memo::text,
  (case when pt.manufacturer_id is not null then 'manufacturer' else 'hospital' end)::text,
  coalesce(pt.manufacturer_id, pt.hospital_id)::uuid,
  null::text, null::text, null::text,
  (case when pt.tx_type = 'payment' then -pt.amount else pt.amount end)::numeric,
  'KRW'::text,
  pt.po_id::uuid, null::text,
  pt.hospital_id::uuid, pt.manufacturer_id::uuid,
  null::uuid,
  (case when pt.cash_log_id is not null then 'c:' || pt.cash_log_id::text else null end)::text,
  null::jsonb, null::text, null::integer,
  null::uuid, null::text, null::numeric, null::bigint, null::text,
  pt.tx_type::text,
  null::text, null::text, null::uuid, null::text, null::text,
  null::text, null::numeric, null::numeric,
  coalesce(pt.confirmed, false)::boolean,
  null::date,
  null::text, null::text,
  null::text, null::numeric, null::numeric,
  null::text[]
from payable_transactions pt

union all

-- 5. 수금 (receivable_transactions)
select
  ('rec:' || rt.id::text)::text,
  rt.id::uuid,
  'receivable_transactions'::text,
  (case when rt.tx_type = 'collect' then 'receivable_collect'
        else 'receivable_' || coalesce(rt.tx_type, 'other') end)::text,
  rt.tx_date::timestamp,
  rt.created_at::timestamp,
  'clobe_sync'::text,
  null::text,
  rt.memo::text,
  (case when rt.hospital_id is not null then 'hospital' else 'manufacturer' end)::text,
  coalesce(rt.hospital_id, rt.manufacturer_id)::uuid,
  null::text, null::text, null::text,
  rt.amount::numeric,
  'KRW'::text,
  null::uuid, null::text,
  rt.hospital_id::uuid, rt.manufacturer_id::uuid,
  null::uuid,
  (case when rt.cash_log_id is not null then 'c:' || rt.cash_log_id::text else null end)::text,
  null::jsonb, null::text, null::integer,
  null::uuid, null::text, null::numeric, null::bigint, null::text,
  rt.tx_type::text,
  null::text, null::text, null::uuid, null::text, null::text,
  null::text, null::numeric, null::numeric,
  true::boolean,
  null::date,
  null::text, null::text,
  null::text, null::numeric, null::numeric,
  null::text[]
from receivable_transactions rt
;

grant select on v_activity_feed to anon, authenticated, service_role;

notify pgrst, 'reload schema';
