-- TripMoney 전용 스키마 (Supabase 프로젝트 fjgwjmjjfpaldxnkhwbd 에 적용 완료)
create schema if not exists tripmoney;

create table if not exists tripmoney.trips (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  base_currency text not null default 'KRW',
  start_date    date,
  end_date      date,
  api_key       text,
  created_at    timestamptz not null default now()
);

create table if not exists tripmoney.members (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references tripmoney.trips(id) on delete cascade,
  name       text not null,
  role       text not null default 'editor' check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now()
);

create table if not exists tripmoney.schedules (
  id             uuid primary key default gen_random_uuid(),
  trip_id        uuid not null references tripmoney.trips(id) on delete cascade,
  title          text not null,
  start_at       timestamptz,
  end_at         timestamptz,
  location       text,
  lat            double precision,
  lng            double precision,
  planned_budget numeric(14,2) default 0,
  status         text not null default 'planned' check (status in ('planned','ongoing','done','canceled')),
  created_by     uuid references tripmoney.members(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists tripmoney.expenses (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid not null references tripmoney.trips(id) on delete cascade,
  schedule_id     uuid references tripmoney.schedules(id) on delete set null,
  payer_member_id uuid references tripmoney.members(id) on delete set null,
  title           text not null,
  amount          numeric(14,2) not null,
  currency        text not null default 'KRW',
  exchange_rate   numeric(16,6) not null default 1,
  amount_base     numeric(14,2) not null,
  pay_method      text not null default 'card' check (pay_method in ('card','cash')),
  receipt_url     text,
  source          text not null default 'manual' check (source in ('manual','receipt')),
  note            text,
  spent_at        timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create table if not exists tripmoney.expense_shares (
  id           uuid primary key default gen_random_uuid(),
  expense_id   uuid not null references tripmoney.expenses(id) on delete cascade,
  member_id    uuid not null references tripmoney.members(id) on delete cascade,
  share_base   numeric(14,2) not null default 0,
  unique (expense_id, member_id)
);

create index if not exists idx_tm_members_trip   on tripmoney.members(trip_id);
create index if not exists idx_tm_schedules_trip on tripmoney.schedules(trip_id);
create index if not exists idx_tm_expenses_trip  on tripmoney.expenses(trip_id);
create index if not exists idx_tm_expenses_sched on tripmoney.expenses(schedule_id);
create index if not exists idx_tm_shares_expense on tripmoney.expense_shares(expense_id);
