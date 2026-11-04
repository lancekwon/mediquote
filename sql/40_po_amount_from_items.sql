-- 2026-11-03: PO 금액 기준 정리 + 납품완료 PO 누락 수정
--
-- 1) 납품완료 PO가 is_active=false라서 v_activity_feed에서 빠지던 문제 수정
--    (리포트·병원별 이익 탭이 이 뷰를 쓰므로 납품완료 발주가 집계에서 누락됐었음)
--    → 필터를 is_active 대신 status <> '취소'로.
-- 2) PO 매입 금액 = 품목 매입합계 sum(unit_price × quantity)
--    (purchase_orders.total_amount에 일부 매출합계가 섞여 있어 신뢰 불가)
-- 3) PO confirmed = 매입 세금계산서가 연결됐는지 (false면 매입단가는 예상값/미입력)
-- 4) 매칭 큐 추천 PO: 납품완료 포함, 금액 정확 일치 우선 → 날짜 가까운 순
-- 5) PO items jsonb에 품목 id 포함 (리포트의 "매입가 입력" 모달이 품목 id로 저장함)
-- 6) hospital_name / vendor_name 컬럼 추가 (리포트 거래처 줄에 병원명이 찍히던 문제)
-- 7) 매칭 큐: 기존 "발주 없음" 체크(tax_invoices.no_po)도 제외 — no_po가 원래 컬럼, no_po_needed는 호환용

-- ============================================================
-- v_activity_feed
-- ============================================================
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
  null::date                                                   as report_month,
  null::text                                                   as hospital_name,
  null::text                                                   as vendor_name
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
  null::text, null::text
from cash_balance_log c

union all

-- 3. 발주 — 매입 = 품목 매입합계, 취소만 제외 (납품완료 포함)
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
  (-(case when s.item_count > 0 then s.purchase_sum else coalesce(p.total_amount, 0) end))::numeric,
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
  coalesce(p.sale_amount, s.sale_sum)::numeric,
  (coalesce(p.sale_amount, s.sale_sum, 0)
   - (case when s.item_count > 0 then s.purchase_sum else coalesce(p.total_amount, 0) end))::numeric,
  (exists (select 1 from tax_invoices t2 where t2.po_id = p.id and t2.kind = 'purchase'))::boolean,
  p.report_month::date,
  p.hospital_name::text,
  coalesce(p.manufacturer_name, p.vendor_name)::text
from purchase_orders p
cross join lateral (
  select
    count(*)::integer as item_count,
    coalesce(sum(coalesce(poi.unit_price, 0) * coalesce(poi.quantity, 0)), 0) as purchase_sum,
    sum(coalesce(poi.sale_price, 0) * coalesce(poi.quantity, 0)) as sale_sum,
    jsonb_agg(jsonb_build_object(
      'id', poi.id,
      'equipment_id', poi.equipment_id,
      'item_name', poi.item_name,
      'model_name', poi.model_name,
      'quantity', poi.quantity,
      'unit_price', poi.unit_price,
      'sale_price', poi.sale_price
    )) as items
  from purchase_order_items poi
  where poi.po_id = p.id
) s
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
  null::text, null::text
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
  null::text, null::text
from receivable_transactions rt
;

grant select on v_activity_feed to anon, authenticated, service_role;


-- ============================================================
-- v_unmatched_purchase_ti — 추천 PO: 납품완료 포함, 정확 일치 우선 → 날짜 가까운 순
-- ============================================================
drop view if exists v_unmatched_purchase_ti;

create view v_unmatched_purchase_ti as
select
  t.id,
  t.issue_date,
  t.manufacturer_id,
  t.party_name,
  t.amount,
  t.memo,
  t.clobe_ti_id,
  t.created_at,
  coalesce(m.default_no_po, false) as vendor_default_no_po,
  (
    select coalesce(jsonb_agg(x order by x.exact_rank, x.date_gap nulls last), '[]'::jsonb)
    from (
      select
        p.id,
        p.po_no,
        p.hospital_name,
        p.status,
        coalesce(p.ordered_at::date, p.created_at::date) as po_date,
        s.item_count,
        s.purchase_sum,
        coalesce(p.sale_amount, s.sale_sum) as sale_sum,
        (case when s.purchase_sum > 0 then s.purchase_sum - t.amount end) as diff,
        abs(t.issue_date::date - coalesce(p.ordered_at::date, p.created_at::date)) as date_gap,
        (case when s.purchase_sum > 0 and abs(s.purchase_sum - t.amount) <= 1 then 0 else 1 end) as exact_rank
      from purchase_orders p
      cross join lateral (
        select
          count(*)::integer as item_count,
          coalesce(sum(coalesce(poi.unit_price, 0) * coalesce(poi.quantity, 0)), 0) as purchase_sum,
          sum(coalesce(poi.sale_price, 0) * coalesce(poi.quantity, 0)) as sale_sum
        from purchase_order_items poi
        where poi.po_id = p.id
      ) s
      where p.manufacturer_id = t.manufacturer_id
        and coalesce(p.status, '') <> '취소'
        and not exists (
          select 1 from tax_invoices t2
          where t2.po_id = p.id and t2.kind = 'purchase'
        )
      order by exact_rank, date_gap nulls last
      limit 8
    ) x
  ) as suggestions
from tax_invoices t
left join manufacturers m on m.id = t.manufacturer_id
where t.kind = 'purchase'
  and t.po_id is null
  and t.manufacturer_id is not null
  and not coalesce(t.no_po, false)
  and not coalesce(t.no_po_needed, false)
  and not coalesce(m.default_no_po, false);

grant select on v_unmatched_purchase_ti to anon, authenticated, service_role;

notify pgrst, 'reload schema';
