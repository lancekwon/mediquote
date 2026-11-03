-- 2026-11-03: Clobe 중복 저장 방지
-- cash_balance_log, tax_invoices에 Clobe 소스 ID 컬럼 추가 + unique 제약
-- 이후 저장 스크립트는 반드시 clobe_tx_id / clobe_ti_id 세팅. 기존 비어있는 row는 null 허용(수동 입력 포함).

alter table cash_balance_log
  add column if not exists clobe_tx_id bigint;

alter table tax_invoices
  add column if not exists clobe_ti_id text;

-- unique 제약 (null은 중복 허용 — 수동 입력 레코드는 clobe_tx_id/ti_id 비어있음)
create unique index if not exists ux_cash_balance_log_clobe_tx
  on cash_balance_log (clobe_tx_id)
  where clobe_tx_id is not null;

create unique index if not exists ux_tax_invoices_clobe_ti
  on tax_invoices (clobe_ti_id)
  where clobe_ti_id is not null;

comment on column cash_balance_log.clobe_tx_id is 'Clobe transactionId (라벨링된 은행 거래 유니크 ID). 저장 스크립트가 Clobe에서 받은 거래 insert 시 세팅. 수동 입력은 null.';
comment on column tax_invoices.clobe_ti_id is 'Clobe 세금계산서 ID (예: 20261103-10261103-26125970). 저장 스크립트가 Clobe에서 받은 TI insert 시 세팅. 수동 발행/음수 수정세금계산서는 null 가능.';
