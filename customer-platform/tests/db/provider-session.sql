-- A안의 SQL 권한 축소 검사다. 실제 provider 정상·폐기 검사는 별도로 수행한다.
-- SELECT의 표시값만 확인하지 않고, 조건 불충족 시 SQL 오류로 실패시킨다.
begin;
set local statement_timeout='15s';
do $$
declare provider_table oid; expected_roles integer;
begin
  if pg_catalog.to_regprocedure('customer_auth.provider_session_exists(uuid,uuid)') is not null then
    raise exception 'provider_helper_still_exists';
  end if;
  select c.oid into provider_table from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='auth' and c.relname='sessions';
  if provider_table is null then raise exception 'provider_relation_missing'; end if;
  select count(*) into expected_roles from pg_catalog.pg_roles
    where rolname in ('customer_auth_owner','customer_auth_runtime','customer_app',
      'customer_app_login','customer_auth_login');
  if expected_roles<>5 or exists(select 1 from pg_catalog.pg_roles r
    where r.rolname in ('customer_auth_owner','customer_auth_runtime','customer_app',
      'customer_app_login','customer_auth_login')
      and pg_catalog.has_any_column_privilege(r.oid,provider_table,'SELECT') is distinct from false) then
    raise exception 'provider_select_boundary_invalid';
  end if;
end $$;
rollback;
