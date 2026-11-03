-- 2026-11-03: 통합 활동 피드 뷰 (feed-first architecture Phase 1)
-- 모든 거래 활동을 단일 뷰로 집약 → 다른 탭이 공통 소스로 참조.
-- 금액은 VAT 포함, 수금+/지급-. 세액 분리 없음.

drop view if exists v_activity_feed;

create view v_activity_feed as

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
  null::date                                                   as report_month
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
  null::date
from cash_balance_log c

union all

-- 3. 발주 (품목 jsonb 포함)
select
  ('po:' || p.id::text)::text,
  p.id::uuid,
  'purchase_orders'::text,
  'po_create'::text,
  coalesce(p.ordered_at::timestamp, p.created_at::timestamp) as happened_at,
  p.created_at::timestamp as recorded_at,
  coalesce('user:' || p.owner, 'user')::text,
  p.owner::text,
  null::text,
  (case when p.hospital_id is not null then 'hospital' else 'manufacturer' end)::text,
  coalesce(p.hospital_id, p.manufacturer_id)::uuid,
  coalesce(p.hospital_name, p.manufacturer_name, p.vendor_name)::text,
  null::text, null::text,
  (-coalesce(p.total_amount, 0))::numeric,
  'KRW'::text,
  p.id::uuid,
  p.po_no::text,
  p.hospital_id::uuid,
  p.manufacturer_id::uuid,
  null::uuid, null::text,
  (select jsonb_agg(jsonb_build_object(
    'equipment_id', poi.equipment_id,
    'item_name', poi.item_name,
    'model_name', poi.model_name,
    'quantity', poi.quantity,
    'unit_price', poi.unit_price,
    'sale_price', poi.sale_price
  )) from purchase_order_items poi where poi.po_id = p.id)::jsonb,
  null::text,
  (select count(*)::integer from purchase_order_items poi where poi.po_id = p.id),
  null::uuid, null::text, null::numeric, null::bigint, null::text, null::text,
  null::text, null::text, null::uuid, null::text, null::text,
  p.status::text,
  p.sale_amount::numeric,
  (coalesce(p.sale_amount, 0) - coalesce(p.total_amount, 0))::numeric,
  true::boolean,
  p.report_month::date
from purchase_orders p
where coalesce(p.is_active, true)

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
  null::date
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
  null::date
from receivable_transactions rt
;

grant select on v_activity_feed to anon, authenticated, service_role;

notify pgrst, 'reload schema';
