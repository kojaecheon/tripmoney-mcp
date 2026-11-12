begin;
set local lock_timeout='2s';
set local statement_timeout='8s';
alter table customer_auth.sessions
  add column refresh_pending boolean not null default false;
create or replace function customer_auth.session_live() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from customer_auth.sessions s
    where s.hash=pg_catalog.current_setting('customer.session_hash',true)
      and s.user_id=customer_private.actor_id() and s.revoked_at is null
      and not s.refresh_pending
      and s.expires_at>pg_catalog.statement_timestamp());
$$;
commit;
