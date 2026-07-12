-- Money-changing audit trail for paid beta trust and operator support.
create table if not exists tripmoney.audit_events (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid references tripmoney.trips(id) on delete set null,
  actor_member_id uuid references tripmoney.members(id) on delete set null,
  action          text not null,
  target_type     text not null,
  target_id       text,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists idx_tm_audit_trip_created on tripmoney.audit_events(trip_id, created_at desc);
create index if not exists idx_tm_audit_target on tripmoney.audit_events(target_type, target_id);
