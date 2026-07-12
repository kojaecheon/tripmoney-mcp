-- Prototype readiness additions used by the web dashboard and settlement links.
alter table tripmoney.members
  add column if not exists bank_name text,
  add column if not exists account_no text;

create index if not exists idx_tm_expenses_spent_at on tripmoney.expenses(spent_at desc);
