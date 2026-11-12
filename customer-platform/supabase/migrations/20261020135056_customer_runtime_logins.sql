-- 비밀번호 설정과 LOGIN 활성화는 사용자 보안 입력 후 별도 단계에서 수행한다.
-- 동일 이름이 있으면 CREATE ROLE 오류로 전체 rollback한다.
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';

create role customer_app_login nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role customer_auth_login nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant customer_app to customer_app_login with inherit true, set false, admin false;
grant customer_auth_runtime to customer_auth_login with inherit true, set false, admin false;

do $$
declare
  login_name text; runtime_name text; login_id oid; runtime_id oid; provider_table oid;
begin
  select c.oid into provider_table from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='auth' and c.relname='sessions';
  if provider_table is null then raise exception 'provider_relation_missing'; end if;
  if pg_catalog.to_regprocedure('customer_auth.provider_session_exists(uuid,uuid)') is not null then
    raise exception 'provider_boundary_required';
  end if;

  for login_name,runtime_name in select * from (values
    ('customer_app_login','customer_app'),
    ('customer_auth_login','customer_auth_runtime')) as expected(login_name,runtime_name)
  loop
    select r.oid into login_id from pg_catalog.pg_roles r where r.rolname=login_name;
    select r.oid into runtime_id from pg_catalog.pg_roles r where r.rolname=runtime_name;
    if login_id is null or runtime_id is null or not exists(select 1 from pg_catalog.pg_roles r
      where r.oid=login_id and not r.rolcanlogin and r.rolinherit
        and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole
        and not r.rolreplication and not r.rolbypassrls) then
      raise exception 'runtime_login_attributes_invalid';
    end if;
    if (select count(*) from pg_catalog.pg_auth_members m where m.member=login_id)<>1
      or not exists(select 1 from pg_catalog.pg_auth_members m
        where m.member=login_id and m.roleid=runtime_id and m.inherit_option
          and not m.set_option and not m.admin_option)
      or pg_catalog.pg_has_role(login_id,runtime_id,'USAGE') is distinct from true
      or exists(select 1 from pg_catalog.pg_roles r
        where r.oid not in (login_id,runtime_id) and pg_catalog.pg_has_role(login_id,r.oid,'MEMBER')) then
      raise exception 'runtime_login_membership_invalid';
    end if;
    if exists(select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('customer','customer_private','customer_auth')
        and pg_catalog.pg_has_role(login_id,c.relowner,'USAGE'))
      or exists(select 1 from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('customer','customer_private','customer_auth')
          and pg_catalog.pg_has_role(login_id,p.proowner,'USAGE'))
      or exists(select 1 from pg_catalog.pg_namespace n
        where n.nspname in ('customer','customer_private','customer_auth')
          and pg_catalog.pg_has_role(login_id,n.nspowner,'USAGE')) then
      raise exception 'runtime_login_owns_customer_objects';
    end if;
    if exists(select 1 from pg_catalog.pg_namespace n
      where n.nspname in ('public','customer','customer_private','customer_auth')
        and pg_catalog.has_schema_privilege(login_id,n.oid,'CREATE'))
      or pg_catalog.has_any_column_privilege(login_id,provider_table,'SELECT') is distinct from false then
      raise exception 'runtime_login_privileges_invalid';
    end if;
  end loop;
end $$;
commit;
