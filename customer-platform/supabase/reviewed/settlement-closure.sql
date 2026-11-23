-- 정산 마감 증분 검토안. durable-store.sql 적용 상태에서 이 파일을 단독 실행한다.
-- 기존 정산과 지급 데이터는 읽기만 한다. 이전 검증 함수는 내부 호출용으로 보존한다.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $preflight$
declare
  previous_source text;
begin
  select p.prosrc into previous_source from pg_catalog.pg_proc p
  where p.oid=pg_catalog.to_regprocedure('customer_private.travel_transition(jsonb,jsonb,text,jsonb,uuid)')
    and p.proowner='customer_writer'::regrole and not p.prosecdef;
  if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(previous_source,'UTF8')),'hex')
      is distinct from '72b95cd23656fceee5e3c964e206e3d090b94998cddda2a4a78187ee69f1cf68' then
    raise exception 'durable_store_transition_version_mismatch';
  end if;
  execute pg_catalog.format(
    'create function customer_private.travel_transition_before_settlement_close(p_old jsonb,p_new jsonb,p_action text,p_scope jsonb,p_actor uuid) returns void language plpgsql set search_path='''' as %L',
    previous_source);
end $preflight$;

alter function customer_private.travel_transition_before_settlement_close(jsonb,jsonb,text,jsonb,uuid) owner to customer_writer;
revoke all on function customer_private.travel_transition_before_settlement_close(jsonb,jsonb,text,jsonb,uuid)
  from public,anon,authenticated,customer_app,customer_auth_runtime;

do $check_acl$
begin
  if exists (select 1 from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    where p.oid='customer_private.travel_transition_before_settlement_close(jsonb,jsonb,text,jsonb,uuid)'::regprocedure
      and a.grantee<>p.proowner) then
    raise exception 'settlement_transition_helper_acl_invalid';
  end if;
end $check_acl$;

-- OID, 소유권, 접근 권한을 보존해 travel_save와 channel_save가 같은 검사를 사용한다.
create or replace function customer_private.travel_transition(p_old jsonb,p_new jsonb,p_action text,p_scope jsonb,p_actor uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare
  history jsonb:=p_new->'audits'->-1;
  action text:=history->>'action';
  projected jsonb:=p_new;
  old_snapshots jsonb:=coalesce(p_old->'ledger'->'snapshots','[]'::jsonb);
  new_snapshots jsonb:=p_new->'ledger'->'snapshots';
  target_id text:=history->>'targetId';
  previous_snapshot jsonb;
  next_snapshot jsonb;
  snapshot_index integer;
  final_index integer;
  final_count bigint;
  mark_time text;
  mark_actor text:=history->>'memberId';
  mark_fields jsonb;
begin
  -- 기존 함수가 같은 소유자 권한, 변경 가능 영역, revision, 감사 이력을 검증한다.
  -- 기존 검증에는 마감 동작을 확정 동작으로 전달하고 실제 저장할 감사 행은 유지한다.
  if p_action='ledger' and action='settlement.close' then
    projected:=pg_catalog.jsonb_set(p_new,'{audits,-1,action}','"settlement.finalize"');
  end if;
  perform customer_private.travel_transition_before_settlement_close(p_old,projected,p_action,p_scope,p_actor);
  if p_action is distinct from 'ledger' then return; end if;

  if action in ('expense.create','expense.update','expense.cancel','fx.update','payment.report',
      'payment.confirm','payment.requestVoid','payment.confirmVoid') then
    if exists(select 1 from pg_catalog.jsonb_array_elements(old_snapshots) s
      where s->'date'='null'::jsonb and s->'reopenedAt'='null'::jsonb and s?'closedAt') then
      raise exception using errcode='P0422',message='settlement_locked';
    end if;
    return;
  end if;
  if action not in ('settlement.finalize','settlement.reopen','settlement.close') then return; end if;

  if pg_catalog.jsonb_typeof(old_snapshots) is distinct from 'array'
    or pg_catalog.jsonb_typeof(new_snapshots) is distinct from 'array' then
    raise exception using errcode='P0422',message='settlement_snapshots_invalid';
  end if;
  select min((s.ordinality-1)::integer),count(*) into final_index,final_count
  from pg_catalog.jsonb_array_elements(old_snapshots) with ordinality as s(snapshot,ordinality)
  where s.snapshot->'date'='null'::jsonb and s.snapshot->'reopenedAt'='null'::jsonb;
  if final_count>1 then raise exception using errcode='P0409',message='settlement_final_ambiguous'; end if;

  if action='settlement.finalize' then
    next_snapshot:=new_snapshots->-1;
    if (new_snapshots-(-1)) is distinct from old_snapshots or next_snapshot is null
      or (next_snapshot ?| array['closedAt','closedByMemberId'])
      or next_snapshot->'reopenedAt' is distinct from 'null'::jsonb
      or next_snapshot->'reopenedByMemberId' is distinct from 'null'::jsonb
      or coalesce(target_id,'') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      or next_snapshot->>'id' is distinct from target_id
      or (pg_catalog.jsonb_typeof(next_snapshot->'date') in ('string','null')) is not true then
      raise exception using errcode='P0403',message='settlement_snapshot_append_required';
    end if;
    if final_index is not null or exists(select 1 from pg_catalog.jsonb_array_elements(old_snapshots) s
      where s->>'id'=target_id or (s->'reopenedAt'='null'::jsonb and s->'date'=next_snapshot->'date')) then
      raise exception using errcode='P0409',message='settlement_snapshot_conflict';
    end if;
    return;
  end if;

  if action='settlement.close' then
    snapshot_index:=final_index;
    previous_snapshot:=old_snapshots->snapshot_index;
    if previous_snapshot is null or (previous_snapshot ?| array['closedAt','closedByMemberId']) then
      raise exception using errcode='P0409',message='settlement_close_unavailable';
    end if;
    next_snapshot:=new_snapshots->snapshot_index;
    mark_time:=next_snapshot->>'closedAt';
    mark_fields:=pg_catalog.jsonb_build_object('closedAt',mark_time,'closedByMemberId',mark_actor);
  else
    select (s.ordinality-1)::integer into snapshot_index
    from pg_catalog.jsonb_array_elements(old_snapshots) with ordinality as s(snapshot,ordinality)
    where s.snapshot->>'id'=target_id and s.snapshot->'reopenedAt'='null'::jsonb;
    if snapshot_index is null or (final_index is not null and snapshot_index<>final_index) then
      raise exception using errcode='P0409',message='settlement_reopen_unavailable';
    end if;
    previous_snapshot:=old_snapshots->snapshot_index;
    next_snapshot:=new_snapshots->snapshot_index;
    mark_time:=next_snapshot->>'reopenedAt';
    mark_fields:=pg_catalog.jsonb_build_object('reopenedAt',mark_time,'reopenedByMemberId',mark_actor);
  end if;

  if target_id is null or target_id is distinct from previous_snapshot->>'id' or mark_actor is null
    or next_snapshot is distinct from previous_snapshot||mark_fields
    or new_snapshots is distinct from pg_catalog.jsonb_set(old_snapshots,array[snapshot_index::text],next_snapshot) then
    raise exception using errcode='P0403',message='settlement_snapshot_change_forbidden';
  end if;
  if (case when mark_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    and pg_catalog.pg_input_is_valid(mark_time,'timestamp with time zone')
    then pg_catalog.to_char(mark_time::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=mark_time
    else false end) is not true then
    raise exception using errcode='P0422',message='settlement_mark_time_invalid';
  end if;
  if action='settlement.reopen' then return; end if;

  if pg_catalog.jsonb_typeof(p_old->'ledger'->'payments') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_old->'ledger'->'expenses') is distinct from 'array' then
    raise exception using errcode='P0422',message='settlement_ledger_invalid';
  end if;
  if exists(select 1 from pg_catalog.jsonb_array_elements(p_old->'ledger'->'payments') p
    where p->>'status' in ('reported','void_requested')) then
    raise exception using errcode='P0409',message='settlement_payments_pending';
  end if;
  -- 확정 당시 금액은 보존하고 현재 경비·분담 및 확인된 지급으로 멤버별 잔액을 계산한다.
  if exists (
    with expenses(row) as (
      select x from pg_catalog.jsonb_array_elements(p_old->'ledger'->'expenses') x where x->>'status'='active'
    ), payments(row) as (
      select x from pg_catalog.jsonb_array_elements(p_old->'ledger'->'payments') x where x->>'status'='confirmed'
    ), deltas(member_id,amount) as (
      select row->>'payerId',(row->>'amountKrw')::numeric from expenses
      union all
      select share->>'memberId',-(share->>'amountKrw')::numeric from expenses
      cross join lateral pg_catalog.jsonb_array_elements(row->'shares') share
      union all
      select row->>'fromMemberId',(row->>'amountKrw')::numeric from payments
      union all
      select row->>'toMemberId',-(row->>'amountKrw')::numeric from payments
    )
    select 1 from deltas group by member_id
    having sum(amount)<>0 or bool_or(amount is null)
      or not exists(select 1 from pg_catalog.jsonb_array_elements(p_old->'members') m where m->>'id'=deltas.member_id)
  ) then raise exception using errcode='P0409',message='settlement_balance_remaining'; end if;
end $$;

commit;
