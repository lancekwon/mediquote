-- 49 되돌리기 — DB 잠그기 전 상태(2026-11-09 pg_policies 기준)로 복구. 문제가 생기면 이것만 실행.

do $$
declare
  r record;
begin
  for r in select * from (values
    ('cash_balance_log', 'cash_balance_all'), ('cat_items', 'all'), ('categories', 'all'),
    ('chat_messages', 'chat_messages_all'), ('chat_sessions', 'chat_sessions_all'), ('contracts', 'all'),
    ('deliveries', 'all'), ('delivery_items', 'all'), ('equipment', 'all'),
    ('expected_revenue', 'expected_revenue_all'), ('hospital_equipment_locations', 'hospital_equipment_locations_all'),
    ('hospital_statements', 'hospital_statements_all'), ('hospitals', 'all'), ('leads', 'all'), ('manufacturers', 'all'),
    ('order_requests', 'order_requests_all'), ('payable_transactions', 'payable_tx_all'), ('po_checklist_items', 'po_checklist_all'),
    ('po_notes', 'po_notes_all'), ('purchase_order_items', 'all'), ('purchase_orders', 'all'), ('quote_shares', 'all'),
    ('quotes', 'all'), ('quotes_ai_draft', 'quotes_ai_draft_all'), ('receivable_transactions', 'receivable_tx_all'),
    ('sales_notes', 'all'), ('sales_reps', 'all'), ('service_requests', 'all'), ('tax_invoices', 'tax_invoices_all')
  ) v(tbl, pol) loop
    execute format('drop policy if exists admin_all on public.%I', r.tbl);
    execute format('drop policy if exists %I on public.%I', r.pol, r.tbl);
    execute format('create policy %I on public.%I for all using (true) with check (true)', r.pol, r.tbl);
  end loop;
end $$;

drop policy if exists admin_all on public.equipment_price_history;
drop policy if exists public_insert_eph on public.equipment_price_history;
drop policy if exists public_select_eph on public.equipment_price_history;
create policy public_insert_eph on public.equipment_price_history for insert with check (true);
create policy public_select_eph on public.equipment_price_history for select using (true);

drop policy if exists admin_all on public.accounts;
alter table public.accounts disable row level security;

alter view public.v_activity_feed set (security_invoker = false);
alter view public.v_expected_revenue_summary set (security_invoker = false);
alter view public.v_payable_balance set (security_invoker = false);
alter view public.v_receivable_balance set (security_invoker = false);
alter view public.v_unmatched_purchase_ti set (security_invoker = false);

drop policy if exists admin_insert_equipment on storage.objects;
drop policy if exists admin_update_equipment on storage.objects;
drop policy if exists admin_delete_equipment on storage.objects;
drop policy if exists public_insert_equipment on storage.objects;
drop policy if exists public_update_equipment on storage.objects;
drop policy if exists public_delete_equipment on storage.objects;
create policy public_insert_equipment on storage.objects for insert with check (bucket_id = 'equipment');
create policy public_update_equipment on storage.objects for update using (bucket_id = 'equipment') with check (bucket_id = 'equipment');
create policy public_delete_equipment on storage.objects for delete using (bucket_id = 'equipment');

drop function if exists public.is_admin();
