-- 2026-11-03: 매칭 필요 매입 TI 큐 (PO 자동매칭 실패분)
-- 매입 세금계산서 중 po_id가 비어있고, manufacturer가 지정된 것들.
-- suggestions: 같은 거래처의 unmatched PO 상위 5건 (금액 차이 오름차순)

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
where t.kind = 'purchase'
  and t.po_id is null
  and t.manufacturer_id is not null;

grant select on v_unmatched_purchase_ti to anon, authenticated, service_role;

notify pgrst, 'reload schema';
