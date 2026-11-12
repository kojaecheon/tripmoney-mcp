-- 전용 고객 DB만 대상으로 적용한다. 원격 적용 버전: 20261020053726.
-- 로그인 자격은 이 migration에 포함하지 않는다.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if pg_catalog.current_setting('server_encoding') <> 'UTF8' then
    raise exception 'customer_utf8_required';
  end if;
  if exists(select 1 from pg_catalog.pg_namespace
    where nspname in ('customer','customer_private','customer_auth'))
    or exists(select 1 from pg_catalog.pg_roles where rolname in
      ('customer_writer','customer_auth_owner','customer_app','customer_auth_runtime')) then
    raise exception 'customer_objects_already_exist';
  end if;
end $preflight$;

create role customer_writer nologin nosuperuser nocreatedb nocreaterole nobypassrls;
create role customer_auth_owner nologin nosuperuser nocreatedb nocreaterole nobypassrls;
create role customer_app nologin nosuperuser nocreatedb nocreaterole nobypassrls;
create role customer_auth_runtime nologin nosuperuser nocreatedb nocreaterole nobypassrls;
-- 관리자 postgres에만 소유권 이전을 허용한다. 앱 로그인에는 부여하지 않는다.
grant customer_writer, customer_auth_owner to postgres;
create schema customer authorization customer_writer;
create schema customer_private authorization customer_writer;
create schema customer_auth authorization customer_auth_owner;
revoke all on schema customer,customer_private,customer_auth from public,anon,authenticated;

create table customer.trips (
  id uuid primary key,
  owner_user_id uuid not null,
  name text not null check(char_length(name) between 1 and 80 and name=btrim(name)),
  destination text not null check(char_length(destination) between 1 and 100 and destination=btrim(destination)),
  start_date date not null,
  end_date date not null,
  time_zone text not null,
  budget_krw bigint not null check(budget_krw between 0 and 9007199254740991),
  settlement_mode text not null check(settlement_mode in ('daily','end_of_trip')),
  daily_time text not null check(daily_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  status text not null default 'active' check(status='active'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(end_date>=start_date and end_date-start_date<=13)
);
create table customer.memberships (
  id uuid primary key,
  trip_id uuid not null references customer.trips(id) on delete restrict,
  user_id uuid not null,
  alias text collate "C" not null check(char_length(alias) between 1 and 40
    and alias=btrim(alias) and alias=normalize(alias,NFC)),
  role text not null check(role in ('owner','editor','viewer')),
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(trip_id,user_id),
  unique(trip_id,alias),
  check(role<>'owner' or active)
);
create unique index one_owner_per_trip on customer.memberships(trip_id) where role='owner';
create index member_user_active on customer.memberships(user_id,trip_id) where active;
create table customer.invites (
  id uuid primary key,
  trip_id uuid not null references customer.trips(id) on delete restrict,
  role text not null check(role in ('editor','viewer')),
  token_hash text unique not null check(token_hash ~ '^[0-9a-f]{64}$'),
  key_id text not null check(key_id ~ '^[A-Za-z0-9_-]{1,16}$'),
  expires_at timestamptz not null,
  status text not null default 'pending' check(status in ('pending','accepted','revoked')),
  accepted_by uuid,
  accepted_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  check(expires_at>created_at),
  check((status='accepted' and accepted_by is not null and accepted_at is not null)
    or (status<>'accepted' and accepted_by is null and accepted_at is null))
);
create index invite_trip_status on customer.invites(trip_id,status,expires_at);
create table customer_private.command_receipts (
  actor uuid not null,
  action text not null,
  operation_id uuid not null,
  trip_id uuid not null references customer.trips(id) on delete restrict,
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null check(jsonb_typeof(result)='object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor,action,operation_id)
);
create index receipt_trip on customer_private.command_receipts(trip_id);
create table customer_private.audit_events (
  id uuid primary key,
  actor uuid not null,
  trip_id uuid not null references customer.trips(id) on delete restrict,
  action text not null,
  target_id uuid not null,
  revision bigint not null check(revision between 1 and 9007199254740991),
  metadata jsonb not null default '{}' check(jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default clock_timestamp()
);
create index audit_trip on customer_private.audit_events(trip_id);
create table customer_auth.challenges (
  hash text primary key check(hash ~ '^[0-9a-f]{64}$'),
  email_cipher text not null,
  email_key text not null,
  status text not null check(status in ('sending','ready','failed','consumed')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check(expires_at>created_at)
);
create index challenge_email_state on customer_auth.challenges(email_key,status);
create table customer_auth.sessions (
  hash text primary key check(hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null,
  provider_session_id uuid not null,
  tokens_cipher text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  version bigint not null default 1 check(version between 1 and 9007199254740991),
  created_at timestamptz not null default clock_timestamp(),
  check(expires_at>created_at)
);
create table customer_auth.rate_buckets (
  scope text not null,
  subject_hash text not null check(subject_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hits integer not null check(hits>0),
  last_at timestamptz not null,
  primary key(scope,subject_hash,window_start)
);

alter table customer.trips owner to customer_writer;
alter table customer.memberships owner to customer_writer;
alter table customer.invites owner to customer_writer;
alter table customer_private.command_receipts owner to customer_writer;
alter table customer_private.audit_events owner to customer_writer;
alter table customer_auth.challenges owner to customer_auth_owner;
alter table customer_auth.sessions owner to customer_auth_owner;
alter table customer_auth.rate_buckets owner to customer_auth_owner;
alter table customer.trips enable row level security;
alter table customer.memberships enable row level security;
alter table customer.invites enable row level security;
alter table customer_private.command_receipts enable row level security;
alter table customer_private.audit_events enable row level security;
alter table customer_auth.challenges enable row level security;
alter table customer_auth.sessions enable row level security;
alter table customer_auth.rate_buckets enable row level security;
revoke all on all tables in schema customer,customer_private,customer_auth
  from public,anon,authenticated,customer_app,customer_auth_runtime;
grant usage on schema customer,customer_private to customer_app;
grant select on customer.trips,customer.memberships to customer_app;
grant usage on schema customer_auth to customer_auth_runtime;
grant select,insert,update,delete on customer_auth.challenges,customer_auth.sessions,
  customer_auth.rate_buckets to customer_auth_runtime;
create policy auth_runtime on customer_auth.challenges to customer_auth_runtime using(true) with check(true);
create policy auth_runtime on customer_auth.sessions to customer_auth_runtime using(true) with check(true);
create policy auth_runtime on customer_auth.rate_buckets to customer_auth_runtime using(true) with check(true);
-- 스키마 한정 REVOKE로는 전역 기본 PUBLIC EXECUTE를 취소할 수 없다.
alter default privileges for role customer_writer revoke execute on functions from public;
alter default privileges for role customer_auth_owner revoke execute on functions from public;

create function customer_private.check_trip_owner() returns trigger
language plpgsql security definer set search_path='' as $$
declare t uuid; expected uuid; owners integer; affected uuid[];
begin
  if TG_TABLE_NAME='trips' then
    affected:=array[NEW.id];
  elsif TG_OP='INSERT' then
    affected:=array[NEW.trip_id];
  elsif TG_OP='DELETE' then
    affected:=array[OLD.trip_id];
  else
    affected:=array[OLD.trip_id,NEW.trip_id];
  end if;
  foreach t in array affected loop
    select owner_user_id into expected from customer.trips where id=t;
    if not found then continue; end if;
    select count(*) into owners from customer.memberships
      where trip_id=t and role='owner' and active and user_id=expected;
    if owners<>1 or (select count(*) from customer.memberships where trip_id=t and role='owner')<>1 then
      raise exception using errcode='P0422',message='owner_required';
    end if;
  end loop;
  return null;
end $$;
alter function customer_private.check_trip_owner() owner to customer_writer;
create constraint trigger trip_owner_check after insert or update on customer.trips
  deferrable initially deferred for each row execute function customer_private.check_trip_owner();
create constraint trigger member_owner_check after insert or update or delete on customer.memberships
  deferrable initially deferred for each row execute function customer_private.check_trip_owner();

create function customer_private.actor_id() returns uuid language plpgsql stable
set search_path='' as $$
begin return nullif(pg_catalog.current_setting('customer.actor_id',true),'')::uuid;
exception when invalid_text_representation then return null;
end $$;
alter function customer_private.actor_id() owner to customer_writer;
grant usage on schema customer_private to customer_auth_owner;
grant execute on function customer_private.actor_id() to customer_auth_owner;
create function customer_auth.session_live() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from customer_auth.sessions s
    where s.hash=pg_catalog.current_setting('customer.session_hash',true)
      and s.user_id=customer_private.actor_id() and s.revoked_at is null
      and s.expires_at>pg_catalog.statement_timestamp());
$$;
alter function customer_auth.session_live() owner to customer_auth_owner;
grant usage on schema customer_auth to customer_writer,customer_app;
grant execute on function customer_auth.session_live() to customer_writer,customer_app;
create function customer_private.assert_actor() returns uuid
language plpgsql stable security definer set search_path='' as $$
begin
  if not customer_auth.session_live() then
    raise exception using errcode='P0401',message='unauthenticated';
  end if;
  return customer_private.actor_id();
end $$;
create function customer_private.is_member(t uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select customer_auth.session_live() and exists(select 1 from customer.memberships m
    where m.trip_id=t and m.user_id=customer_private.actor_id() and m.active);
$$;
create function customer_private.is_owner(t uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select customer_auth.session_live() and exists(select 1 from customer.memberships m
    where m.trip_id=t and m.user_id=customer_private.actor_id() and m.active and m.role='owner');
$$;
alter function customer_private.assert_actor() owner to customer_writer;
alter function customer_private.is_member(uuid) owner to customer_writer;
alter function customer_private.is_owner(uuid) owner to customer_writer;
create policy trip_read on customer.trips for select to customer_app
  using(customer_private.is_member(id));
create policy member_read on customer.memberships for select to customer_app
  using(customer_private.is_member(trip_id));

grant usage on schema auth to customer_auth_owner;
grant select(id,user_id) on auth.sessions to customer_auth_owner;
create function customer_auth.provider_session_exists(p_id uuid,p_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.sessions where id=p_id and user_id=p_user);
$$;
alter function customer_auth.provider_session_exists(uuid,uuid) owner to customer_auth_owner;
revoke all on all functions in schema customer,customer_private,customer_auth
  from public,anon,authenticated,customer_app,customer_auth_runtime;
grant execute on function customer_private.actor_id() to customer_auth_owner;
grant execute on function customer_auth.session_live() to customer_writer,customer_app;
grant execute on function customer_private.actor_id(),customer_private.assert_actor(),
  customer_private.is_member(uuid),customer_private.is_owner(uuid) to customer_app;
grant execute on function customer_auth.provider_session_exists(uuid,uuid) to customer_auth_runtime;
commit;
