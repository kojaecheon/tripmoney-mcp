-- Public paid-beta intake funnel and lightweight conversion tracking.
create table if not exists tripmoney.beta_leads (
  id              uuid primary key default gen_random_uuid(),
  name            text,
  contact         text not null,
  trip_name       text,
  destination     text,
  group_size      int,
  trip_date       text,
  segment         text,
  price_interest  text,
  pain            text,
  source          text not null default 'landing',
  status          text not null default 'new',
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists idx_tm_beta_leads_created on tripmoney.beta_leads(created_at desc);
create index if not exists idx_tm_beta_leads_status on tripmoney.beta_leads(status, created_at desc);
create index if not exists idx_tm_beta_leads_source on tripmoney.beta_leads(source, created_at desc);
