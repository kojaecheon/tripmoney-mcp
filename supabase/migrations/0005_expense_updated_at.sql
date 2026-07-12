-- 비용 수정/삭제 지원: expenses.updated_at 추가 (updateExpense 낙관적 잠금용)
alter table tripmoney.expenses
  add column if not exists updated_at timestamptz not null default now();
