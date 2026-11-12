-- A안: 고객 소유 SQL helper와 불필요한 managed Auth 열 권한만 제거한다.
-- 기존 migration 이력과 managed Auth의 정책·소유권은 변경하지 않는다.
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';

do $$
begin
  if not exists(select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid=p.proowner
    where p.oid=pg_catalog.to_regprocedure('customer_auth.provider_session_exists(uuid,uuid)')
      and r.rolname='customer_auth_owner' and p.prosecdef and p.prokind='f') then
    raise exception 'provider_helper_unexpected';
  end if;
end $$;

revoke all on function customer_auth.provider_session_exists(uuid,uuid)
  from public,anon,authenticated,customer_app,customer_auth_runtime;
drop function customer_auth.provider_session_exists(uuid,uuid) restrict;
revoke select(id,user_id) on auth.sessions from customer_auth_owner restrict;

do $$
declare provider_table oid;
begin
  select c.oid into provider_table from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='auth' and c.relname='sessions';
  if provider_table is null then raise exception 'provider_relation_missing'; end if;
  if pg_catalog.to_regprocedure('customer_auth.provider_session_exists(uuid,uuid)') is not null
    or (select count(*) from pg_catalog.pg_roles
      where rolname in ('customer_auth_owner','customer_auth_runtime','customer_app'))<>3
    or exists(select 1 from pg_catalog.pg_roles r
      where r.rolname in ('customer_auth_owner','customer_auth_runtime','customer_app',
        'customer_app_login','customer_auth_login')
        and pg_catalog.has_any_column_privilege(r.oid,provider_table,'SELECT') is distinct from false) then
    raise exception 'provider_boundary_not_removed';
  end if;
end $$;
commit;
