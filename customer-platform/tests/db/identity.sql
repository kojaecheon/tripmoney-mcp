-- 합성 DB 계약 검사. 전체 fixture는 마지막 ROLLBACK으로 제거한다.
begin;
set local statement_timeout = '15s';
do $test$
declare table_count integer;
begin
  if pg_catalog.to_regnamespace('customer') is null then
    raise exception 'identity_schema_missing';
  end if;
  select count(*) into table_count from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('customer','customer_private','customer_auth')
      and c.relkind='r' and c.relrowsecurity;
  if table_count<>8 then raise exception 'eight_rls_tables_required'; end if;
  if not pg_catalog.has_table_privilege('customer_app','customer.trips','SELECT')
    or pg_catalog.has_table_privilege('customer_app','customer.trips','INSERT')
    or pg_catalog.has_table_privilege('customer_writer','customer_auth.sessions','SELECT') then
    raise exception 'role_grants_incorrect';
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname in
      ('customer_app','customer_auth_runtime','customer_writer','customer_auth_owner')
      and (rolcanlogin or rolsuper or rolbypassrls or rolcreatedb or rolcreaterole)) then
    raise exception 'role_escalation';
  end if;
  if exists(select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace,
    lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    where n.nspname in ('customer','customer_private','customer_auth')
      and a.grantee=0 and a.privilege_type='EXECUTE') then
    raise exception 'public_function_execution';
  end if;
end $test$;

do $fixture$
declare users uuid[]; session_hashes text[]; trip uuid:=pg_catalog.gen_random_uuid(); i integer;
begin
  for i in 1..9 loop
    users[i]:=pg_catalog.gen_random_uuid();
    session_hashes[i]:=pg_catalog.md5(pg_catalog.gen_random_uuid()::text)||pg_catalog.md5(pg_catalog.gen_random_uuid()::text);
    insert into customer_auth.sessions(hash,user_id,provider_session_id,tokens_cipher,expires_at)
      values(session_hashes[i],users[i],pg_catalog.gen_random_uuid(),'DB_ONLY_SYNTHETIC_NOT_PROVIDER_AUTH',
        pg_catalog.clock_timestamp()+interval '1 hour');
  end loop;
  insert into customer.trips(id,owner_user_id,name,destination,start_date,end_date,time_zone,
    budget_krw,settlement_mode,daily_time)
    values(trip,users[1],'합성 계약 검사','서울','2026-11-01','2026-11-03','Asia/Seoul',100000,'daily','20:00');
  insert into customer.memberships(id,trip_id,user_id,alias,role,active) values
    (pg_catalog.gen_random_uuid(),trip,users[1],'소유자','owner',true),
    (pg_catalog.gen_random_uuid(),trip,users[2],'편집자','editor',true),
    (pg_catalog.gen_random_uuid(),trip,users[3],'조회자','viewer',true),
    (pg_catalog.gen_random_uuid(),trip,users[4],'비활성','editor',false);
  perform pg_catalog.set_config('test.trip',trip::text,true);
  for i in 1..9 loop
    perform pg_catalog.set_config('test.user'||i,users[i]::text,true);
    perform pg_catalog.set_config('test.hash'||i,session_hashes[i],true);
  end loop;
end $fixture$;
set constraints all immediate;
set constraints all deferred;

set local role customer_app;
do $test$
declare visible integer;
begin
  select count(*) into visible from customer.trips;
  if visible<>0 then raise exception 'contextless_read_leak'; end if;
  begin
    perform customer_private.assert_actor();
    raise exception 'contextless_actor_accepted';
  exception when sqlstate 'P0401' then null; end;
  perform pg_catalog.set_config('customer.actor_id',pg_catalog.current_setting('test.user1'),true);
  perform pg_catalog.set_config('customer.session_hash',pg_catalog.current_setting('test.hash1'),true);
  if customer_private.assert_actor()<>pg_catalog.current_setting('test.user1')::uuid then
    raise exception 'actor_mismatch'; end if;
  select count(*) into visible from customer.trips;
  if visible<>1 then raise exception 'owner_read_failed'; end if;
  select count(*) into visible from customer.memberships;
  if visible<>4 then raise exception 'membership_read_failed'; end if;
  begin
    update customer.trips set name='허용되면 안 되는 변경' where id=pg_catalog.current_setting('test.trip')::uuid;
    raise exception 'direct_write_allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform hash from customer_auth.sessions;
    raise exception 'app_auth_read_allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform id from customer.invites;
    raise exception 'invite_direct_read_allowed';
  exception when insufficient_privilege then null; end;
  perform pg_catalog.set_config('customer.actor_id',pg_catalog.current_setting('test.user9'),true);
  perform pg_catalog.set_config('customer.session_hash',pg_catalog.current_setting('test.hash9'),true);
  select count(*) into visible from customer.trips;
  if visible<>0 then raise exception 'nonmember_read_leak'; end if;
  perform pg_catalog.set_config('customer.actor_id',pg_catalog.current_setting('test.user4'),true);
  perform pg_catalog.set_config('customer.session_hash',pg_catalog.current_setting('test.hash4'),true);
  select count(*) into visible from customer.trips;
  if visible<>0 then raise exception 'inactive_read_leak'; end if;
  perform pg_catalog.set_config('customer.actor_id',pg_catalog.current_setting('test.user1'),true);
  -- 다른 사용자의 유효 세션 해시도 해당 actor의 인증으로 사용할 수 없다.
  begin
    perform customer_private.assert_actor();
    raise exception 'foreign_session_accepted';
  exception when sqlstate 'P0401' then null; end;
  perform pg_catalog.set_config('customer.session_hash',pg_catalog.repeat('0',64),true);
  begin
    perform customer_private.assert_actor();
    raise exception 'forged_session_accepted';
  exception when sqlstate 'P0401' then null; end;
  perform pg_catalog.set_config('customer.actor_id','not-a-uuid',true);
  if customer_private.actor_id() is not null then raise exception 'invalid_uuid_accepted'; end if;
end $test$;
reset role;

set local role anon;
do $test$
begin
  begin perform id from customer.trips; raise exception 'anon_read_allowed';
  exception when insufficient_privilege then null; end;
  begin perform customer_private.assert_actor(); raise exception 'anon_helper_allowed';
  exception when insufficient_privilege then null; end;
end $test$;
reset role;
set local role authenticated;
do $test$
begin
  begin perform id from customer.trips; raise exception 'authenticated_read_allowed';
  exception when insufficient_privilege then null; end;
  begin perform customer_private.assert_actor(); raise exception 'authenticated_helper_allowed';
  exception when insufficient_privilege then null; end;
end $test$;
reset role;

set local role customer_auth_runtime;
do $test$
begin
  begin perform id from customer.trips; raise exception 'auth_trip_read_allowed';
  exception when insufficient_privilege then null; end;
end $test$;
reset role;
rollback;
select 'PASS' as identity_foundation_contract, 'all synthetic rows rolled back' as cleanup;
