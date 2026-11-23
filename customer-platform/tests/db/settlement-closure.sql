-- 임시 로컬 PostgreSQL에 durable-store.sql과 settlement-closure.sql을 적용한 뒤 psql로 실행한다.
begin;

create function pg_temp.ledger_step(doc jsonb, action text, member_id text, target_id text, ledger jsonb)
returns jsonb language sql as $$
  select jsonb_set(jsonb_set(jsonb_set(doc, '{trip,revision}', to_jsonb((doc->'trip'->>'revision')::bigint+1)),
    '{ledger}', ledger), '{audits}', doc->'audits'||jsonb_build_array(jsonb_build_object(
      'tripId',doc->'trip'->>'id','memberId',member_id,'targetId',target_id,
      'action',action,'revision',(doc->'trip'->>'revision')::bigint+1,'at','2026-11-02T00:00:00.001Z')));
$$;

create function pg_temp.check_transition(previous jsonb, next jsonb, actor uuid,
  expected_error text default null, expected_message text default null)
returns void language plpgsql as $$
begin
  perform customer_private.travel_transition(previous,next,'ledger',
    jsonb_build_object('kind','trip','tripId',previous->'trip'->>'id'),actor);
  if expected_error is not null then raise exception 'expected rejection: %',expected_error; end if;
exception when others then
  if sqlstate is distinct from expected_error or (expected_message is not null and sqlerrm is distinct from expected_message) then
    raise;
  end if;
end;
$$;

do $$
declare
  owner_actor constant uuid := '10000000-0000-4000-8000-000000000001';
  editor_actor constant uuid := '10000000-0000-4000-8000-000000000002';
  trip_id constant text := '20000000-0000-4000-8000-000000000001';
  owner_member constant text := '30000000-0000-4000-8000-000000000001';
  editor_member constant text := '30000000-0000-4000-8000-000000000002';
  snapshot_id constant text := '40000000-0000-4000-8000-000000000001';
  daily_id constant text := '40000000-0000-4000-8000-000000000002';
  new_snapshot_id constant text := '40000000-0000-4000-8000-000000000003';
  final_snapshot jsonb; daily_snapshot jsonb; closed_snapshot jsonb;
  expenses jsonb; confirmed jsonb; ledger jsonb; initial jsonb; closed jsonb; reopened jsonb; prev jsonb;
  reopen_fields jsonb:=jsonb_build_object('reopenedAt','2026-11-02T00:00:00.002Z','reopenedByMemberId',owner_member);
  closed_fields jsonb:=jsonb_build_object('closedAt','2026-11-02T00:00:00.000Z','closedByMemberId',owner_member);
  command text; closure_helper regprocedure;
  scope jsonb:=jsonb_build_object('kind','trip','tripId',trip_id);
  session_hash text:=repeat('a',64);
  receipt_key text:=owner_actor::text||':settlement.close:70000000-0000-4000-8000-000000000001';
  state_before jsonb; state_after jsonb;
begin
  final_snapshot:=jsonb_build_object('id',snapshot_id,'date',null,'reopenedAt',null,'reopenedByMemberId',null,
    'result','{"spentKrw":1000,"balances":[],"transfers":[]}'::jsonb);
  daily_snapshot:=final_snapshot||jsonb_build_object('id',daily_id,'date','2026-11-01');
  closed_snapshot:=final_snapshot||closed_fields;
  expenses:=jsonb_build_array(jsonb_build_object('id','50000000-0000-4000-8000-000000000001','status','active',
    'amountKrw',1000,'localDate','2026-11-01','payerId',owner_member,'shares',jsonb_build_array(
      jsonb_build_object('memberId',owner_member,'amountKrw',500),jsonb_build_object('memberId',editor_member,'amountKrw',500))));
  confirmed:=jsonb_build_object('id','60000000-0000-4000-8000-000000000001','fromMemberId',editor_member,
    'toMemberId',owner_member,'amountKrw',500,'status','confirmed');
  ledger:=jsonb_build_object('snapshots',jsonb_build_array(daily_snapshot,final_snapshot),'expenses',expenses,
    'payments',jsonb_build_array(confirmed),'fx','{"source":"demo","rateMilli":38600}'::jsonb,
    'items','[]'::jsonb,'expenseRevision',3,'confirmedPaymentRevision',4);
  initial:=jsonb_build_object('trip',jsonb_build_object('id',trip_id,'ownerUserId',owner_actor,
    'status','active','createdAt','2026-11-01T00:00:00.000Z','revision',6), 'members',jsonb_build_array(
    jsonb_build_object('id',owner_member,'tripId',trip_id,'userId',owner_actor,'role','owner','active',true,'alias','소유자'),
    jsonb_build_object('id',editor_member,'tripId',trip_id,'userId',editor_actor,'role','editor','active',true,'alias','편집자')),
    'invites','[]'::jsonb,'audits','[]'::jsonb,'ledger',ledger);
  closed:=pg_temp.ledger_step(initial,'settlement.close',owner_member,snapshot_id,
    jsonb_set(ledger,'{snapshots,1}',closed_snapshot));

  -- 확인 지급까지 반영하면 잔액은 0이고, 기존 일일·최종 확정 금액은 보존된다.
  perform pg_temp.check_transition(initial,closed,owner_actor);
  perform pg_temp.check_transition(initial,jsonb_set(closed,'{audits,0,memberId}',to_jsonb(editor_member)),editor_actor,'P0403');
  perform pg_temp.check_transition(initial,jsonb_set(closed,'{audits,0,targetId}',to_jsonb(daily_id)),owner_actor,'P0403');
  perform pg_temp.check_transition(initial,jsonb_set(closed,'{ledger,snapshots,1,closedAt}','"2026-02-31T00:00:00.000Z"'),owner_actor,'P0422');
  perform pg_temp.check_transition(initial,jsonb_set(closed,'{ledger,snapshots,0}',daily_snapshot||closed_fields),owner_actor,'P0403');
  perform pg_temp.check_transition(initial,jsonb_set(closed,'{ledger,snapshots,1,result,spentKrw}','0'),owner_actor,'P0403');
  perform pg_temp.check_transition(initial,pg_temp.ledger_step(initial,'settlement.finalize',owner_member,snapshot_id,
    closed->'ledger'),owner_actor,'P0403');

  -- 전체 합계가 0이어도 개별 멤버 잔액이 남거나 입금 확인·취소 요청이 남으면 거절한다.
  prev:=jsonb_set(initial,'{ledger,payments,0,amountKrw}','400');
  perform pg_temp.check_transition(prev,pg_temp.ledger_step(prev,'settlement.close',owner_member,snapshot_id,
    jsonb_set(prev->'ledger','{snapshots,1}',closed_snapshot)),owner_actor,'P0409','settlement_balance_remaining');
  foreach command in array array['reported','void_requested'] loop
    prev:=jsonb_set(initial,'{ledger,payments}',ledger->'payments'||jsonb_build_array(confirmed||jsonb_build_object(
      'id','60000000-0000-4000-8000-000000000002','status',command)));
    perform pg_temp.check_transition(prev,pg_temp.ledger_step(prev,'settlement.close',owner_member,snapshot_id,
      jsonb_set(prev->'ledger','{snapshots,1}',closed_snapshot)),owner_actor,'P0409','settlement_payments_pending');
  end loop;
  prev:=jsonb_set(initial,'{ledger,snapshots}','[]');
  perform pg_temp.check_transition(prev,pg_temp.ledger_step(prev,'settlement.close',owner_member,snapshot_id,
    prev->'ledger'),owner_actor,'P0409');

  -- 마감된 원장에서 일정 수정은 허용하고 재무 명령은 모두 차단한다.
  perform pg_temp.check_transition(closed,pg_temp.ledger_step(closed,'schedule.create',owner_member,null,
    jsonb_set(closed->'ledger','{items}','[{"title":"합성 일정"}]')),owner_actor);
  foreach command in array array['expense.create','expense.update','expense.cancel','fx.update'] loop
    perform pg_temp.check_transition(closed,pg_temp.ledger_step(closed,command,owner_member,null,
      closed->'ledger'),owner_actor,'P0422','settlement_locked');
  end loop;
  perform pg_temp.check_transition(closed,pg_temp.ledger_step(closed,'payment.report',owner_member,null,
    jsonb_set(closed->'ledger','{payments}',closed->'ledger'->'payments'||jsonb_build_array(confirmed||jsonb_build_object(
      'id','60000000-0000-4000-8000-000000000002','status','reported','fromMemberId',owner_member,
      'toMemberId',editor_member)))),owner_actor,'P0422','settlement_locked');
  perform pg_temp.check_transition(closed,pg_temp.ledger_step(closed,'payment.requestVoid',owner_member,null,
    jsonb_set(closed->'ledger','{payments,0}',confirmed||jsonb_build_object('status','void_requested',
      'voidRequestedByMemberId',owner_member))),owner_actor,'P0422','settlement_locked');
  perform pg_temp.check_transition(closed,pg_temp.ledger_step(closed,'settlement.close',owner_member,snapshot_id,
    closed->'ledger'),owner_actor,'P0409');
  perform pg_temp.check_transition(closed,pg_temp.ledger_step(closed,'settlement.reopen',owner_member,snapshot_id,
    jsonb_set(closed->'ledger','{snapshots,1}',final_snapshot||reopen_fields)),owner_actor,'P0403');
  reopened:=pg_temp.ledger_step(closed,'settlement.reopen',owner_member,snapshot_id,
    jsonb_set(closed->'ledger','{snapshots,1}',closed_snapshot||reopen_fields));
  perform pg_temp.check_transition(closed,reopened,owner_actor);
  perform pg_temp.check_transition(reopened,pg_temp.ledger_step(reopened,'fx.update',owner_member,null,
    jsonb_set(reopened->'ledger','{fx,rateMilli}','40000')),owner_actor);
  perform pg_temp.check_transition(reopened,pg_temp.ledger_step(reopened,'settlement.finalize',owner_member,new_snapshot_id,
    jsonb_set(reopened->'ledger','{snapshots}',reopened->'ledger'->'snapshots'||jsonb_build_array(final_snapshot||
      jsonb_build_object('id',new_snapshot_id)))),owner_actor);

  closure_helper:=to_regprocedure('customer_private.travel_transition_before_settlement_close(jsonb,jsonb,text,jsonb,uuid)');
  if closure_helper is null or has_function_privilege('customer_app',closure_helper,'execute')
      or has_function_privilege('anon',closure_helper,'execute') or has_function_privilege('authenticated',closure_helper,'execute') then
    raise exception 'transition helper ACL is invalid';
  end if;

  -- 앱 권한으로 공개 저장 함수를 실행한다. 같은 감사 행과 receipt가 다시 조회되어야 한다.
  insert into customer_private.travel_documents(trip_id,body) values(trip_id::uuid,initial);
  insert into customer_auth.sessions(hash,user_id,provider_session_id,tokens_cipher,expires_at)
    values(session_hash,owner_actor,gen_random_uuid(),'local-fixture',clock_timestamp()+interval '10 minutes');
  perform set_config('customer.actor_id',owner_actor::text,true);
  perform set_config('customer.session_hash',session_hash,true);
  set local role customer_app;
  state_before:=customer_private.travel_load(scope);
  state_after:=state_before||jsonb_build_object('trips',jsonb_build_array(closed->'trip'),'audits',closed->'audits',
    'ledgers',jsonb_build_array(jsonb_build_array(trip_id,closed->'ledger')),'receipts',jsonb_build_array(
      jsonb_build_array(receipt_key,jsonb_build_object('hash',repeat('b',64),'result',jsonb_build_object('replayed',false,
        'value',jsonb_build_object('targetId',snapshot_id),'tripRevision',7)))));
  if customer_private.travel_save(scope,state_before,state_after,'ledger') is not true
    or customer_private.travel_load(scope) is distinct from state_after then
    raise exception 'close write and read must retain the audit and receipt';
  end if;
  begin
    perform customer_private.travel_save(scope,state_before,state_after,'ledger');
    raise exception 'stale write should fail';
  exception when sqlstate 'P0409' then
    if sqlerrm is distinct from 'state_conflict' then raise; end if;
  end;
  reset role;
end $$;

rollback;
