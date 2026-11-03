-- 2026-11-03: "매칭 불필요" 플래그 (운영비성 매입 = 세무사/광고/운송/임차료 등)
-- 두 레벨 지원:
--   1. tax_invoices.no_po_needed    — TI 1건만 매칭 불필요
--   2. manufacturers.default_no_po  — 이 거래처의 모든 매입은 항상 매칭 불필요
-- v_unmatched_purchase_ti에서 둘 중 하나라도 true면 큐에서 제외.

alter table tax_invoices    add column if not exists no_po_needed  boolean default false;
alter table manufacturers   add column if not exists default_no_po boolean default false;

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
    select coalesce(jsonb_agg(x order by abs_diff), '[]'::jsonb)
    from (
      select
        p.id,
        p.po_no,
        p.total_amount,
        p.ordered_at,
        (p.total_amount - t.amount) as diff,
        abs(p.total_amount - t.amount) as abs_diff
      from purchase_orders p
      where p.manufacturer_id = t.manufacturer_id
        and coalesce(p.is_active, true)
        and coalesce(p.status, '') <> '취소'
        and not exists (
          select 1 from tax_invoices t2
          where t2.po_id = p.id and t2.kind = 'purchase'
        )
      order by abs(p.total_amount - t.amount) asc, p.ordered_at desc
      limit 5
    ) x
  ) as suggestions
from tax_invoices t
left join manufacturers m on m.id = t.manufacturer_id
where t.kind = 'purchase'
  and t.po_id is null
  and t.manufacturer_id is not null
  and not coalesce(t.no_po_needed, false)
  and not coalesce(m.default_no_po, false);

grant select on v_unmatched_purchase_ti to anon, authenticated, service_role;

notify pgrst, 'reload schema';
