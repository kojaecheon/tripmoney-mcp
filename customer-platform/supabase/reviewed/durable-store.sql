-- 승인 대상: tripmoney-customer-dev (agddopryfqsyfshoowgk) 전용 개발 DB.
-- 기준일: 2026-11-08. 원본 11-07 base와 11-08 확장은 보존한다.
-- 적용 전 암호화 백업·대상·기존 객체 부재 확인이 필요하다.
-- 보완: 실제 웹 세션 행 잠금, 기존 경비 ID 보존·중복 차단.
-- 이 파일은 단일 외부 transaction에서 검증·적용한다. BEGIN/COMMIT 내장 없음.

set local lock_timeout='5s';
set local statement_timeout='30s';

create table customer_private.travel_documents (
  trip_id uuid primary key,
  body jsonb not null check(jsonb_typeof(body)='object'),
  check(body->'trip'->>'id'=trip_id::text),
  check(jsonb_typeof(body->'members')='array' and jsonb_typeof(body->'invites')='array'
    and jsonb_typeof(body->'audits')='array')
);
create table customer_private.travel_receipts (
  actor uuid not null,
  receipt_key text not null,
  trip_id uuid not null references customer_private.travel_documents(trip_id),
  value jsonb not null check(jsonb_typeof(value)='object'),
  primary key(actor,receipt_key),
  check(receipt_key like actor::text||':%'),
  check(value->>'hash' ~ '^[0-9a-f]{64}$')
);
create table customer_private.travel_attempts (
  actor uuid not null,
  client_hash text not null check(client_hash ~ '^[0-9a-f]{64}$'),
  attempted_at timestamptz not null default clock_timestamp()
);
create index travel_attempt_actor on customer_private.travel_attempts(actor,attempted_at);
create index travel_attempt_client on customer_private.travel_attempts(client_hash,attempted_at);

alter table customer_private.travel_documents owner to customer_writer;
alter table customer_private.travel_receipts owner to customer_writer;
alter table customer_private.travel_attempts owner to customer_writer;
alter table customer_private.travel_documents enable row level security;
alter table customer_private.travel_documents force row level security;
alter table customer_private.travel_receipts enable row level security;
alter table customer_private.travel_receipts force row level security;
alter table customer_private.travel_attempts enable row level security;
alter table customer_private.travel_attempts force row level security;
-- owner도 RLS 적용. 직접 접근은 nologin 함수 소유자만 허용한다.
create policy travel_writer on customer_private.travel_documents to customer_writer using(true) with check(true);
create policy travel_writer on customer_private.travel_receipts to customer_writer using(true) with check(true);
create policy travel_writer on customer_private.travel_attempts to customer_writer using(true) with check(true);
revoke all on customer_private.travel_documents,customer_private.travel_receipts,customer_private.travel_attempts
  from public,anon,authenticated,customer_app,customer_auth_runtime;

create function customer_private.travel_member(p_body jsonb,p_actor uuid) returns jsonb
language sql immutable set search_path='' as $$
  select m from pg_catalog.jsonb_array_elements(p_body->'members') m
    where m->>'userId'=p_actor::text limit 1
$$;

-- 기존 배열이 변경 없이 남아 있는지 확인한다. audit/receipt의 과거 기록 덮어쓰기를 막는다.
create function customer_private.travel_contains(p_after jsonb,p_before jsonb) returns boolean
language sql immutable set search_path='' as $$
  select not exists(select 1 from pg_catalog.jsonb_array_elements(p_before) old
    where not exists(select 1 from pg_catalog.jsonb_array_elements(p_after) new where new=old))
$$;

-- Scope 계약은 travel-repositories.ts와 같다.
-- create: 현재 소유한 여행(20개 제한과 생성 receipt 재전송), list: 현재 참여 여행,
-- trip: 현재 참여 여행 한 개, invite: 실제 proof에 해당하는 여행 한 개.
-- invite scope 결과는 서버 도메인 전용이며 HTTP에서는 inspect DTO의 이름·역할·만료만 반환한다.
-- 실제 세션 행 잠금은 로그아웃·철회와 저장의 순서를 직렬화한다.
create function customer_auth.travel_lock_session(p_actor uuid,p_hash text) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare s record;
begin
  if p_actor is null or coalesce(p_hash,'') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='P0401',message='session_unavailable';
  end if;
  select user_id,expires_at,revoked_at,refresh_pending into s
    from customer_auth.sessions where hash=p_hash for update;
  if not found or s.user_id is distinct from p_actor or s.revoked_at is not null or s.refresh_pending
    or s.expires_at<=pg_catalog.clock_timestamp() then
    raise exception using errcode='P0401',message='session_unavailable';
  end if;
  return s.expires_at;
end $$;
alter function customer_auth.travel_lock_session(uuid,text) owner to customer_auth_owner;
revoke all on function customer_auth.travel_lock_session(uuid,text) from public,anon,authenticated,customer_app,customer_auth_runtime;
grant execute on function customer_auth.travel_lock_session(uuid,text) to customer_writer;

create function customer_private.travel_load(p_scope jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  a uuid; kind text:=p_scope->>'kind'; d jsonb; m jsonb; inv jsonb;
  ts jsonb:='[]'; ms jsonb:='[]'; ins jsonb:='[]'; aus jsonb:='[]'; ls jsonb:='[]'; rs jsonb;
  target uuid; proof_found boolean:=false;
begin
  perform pg_catalog.pg_advisory_xact_lock(708170061::bigint);
  a:=customer_private.actor_id();
  perform customer_auth.travel_lock_session(a,pg_catalog.current_setting('customer.session_hash',true));
  a:=customer_private.assert_actor();
  if pg_catalog.jsonb_typeof(p_scope) is distinct from 'object'
    or kind is null or kind not in ('create','list','trip','invite') then
    raise exception using errcode='P0422',message='scope_invalid';
  end if;
  if a is null then raise exception using errcode='P0401',message='actor_required'; end if;
  if kind='trip' then
    if coalesce(p_scope->>'tripId','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
      raise exception using errcode='P0422',message='trip_scope_invalid';
    end if;
    target:=(p_scope->>'tripId')::uuid;
  elsif kind='invite' then
    if pg_catalog.jsonb_typeof(p_scope->'proof') is distinct from 'object'
      or coalesce(p_scope->'proof'->>'id','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      or coalesce(p_scope->'proof'->>'kid','') !~ '^[A-Za-z0-9_-]{1,16}$'
      or coalesce(p_scope->'proof'->>'hash','') !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='P0410',message='invite_unavailable';
    end if;
  end if;
  for d in select body from customer_private.travel_documents order by trip_id loop
    m:=customer_private.travel_member(d,a);
    if kind='create' and d->'trip'->>'ownerUserId' is distinct from a::text then continue; end if;
    if kind='list' and not coalesce((m->>'active')::boolean,false) then continue; end if;
    if kind='trip' then
      if d->'trip'->>'id' is distinct from target::text then continue; end if;
      if not coalesce((m->>'active')::boolean,false) then
        raise exception using errcode='P0404',message='trip_unavailable';
      end if;
    end if;
    if kind='invite' then
      select i into inv from pg_catalog.jsonb_array_elements(d->'invites') i
        where i->>'id'=p_scope->'proof'->>'id' and i->>'keyId'=p_scope->'proof'->>'kid'
          and i->>'tokenHash'=p_scope->'proof'->>'hash';
      if not found then continue; end if;
      if ((inv->>'status'='pending' and (inv->>'expiresAt')::timestamptz>pg_catalog.clock_timestamp())
        or (inv->>'status'='accepted' and inv->>'acceptedBy'=a::text and coalesce((m->>'active')::boolean,false))) is not true then
        raise exception using errcode='P0410',message='invite_unavailable';
      end if;
      proof_found:=true;
    end if;
    ts:=ts||pg_catalog.jsonb_build_array(d->'trip');
    ms:=ms||(d->'members');ins:=ins||(d->'invites');aus:=aus||(d->'audits');
    if d->'ledger' is distinct from 'null'::jsonb then ls:=ls||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(d->'trip'->>'id',d->'ledger')); end if;
  end loop;
  if kind='invite' and not proof_found then raise exception using errcode='P0410',message='invite_unavailable'; end if;
  if kind='trip' and pg_catalog.jsonb_array_length(ts)=0 then raise exception using errcode='P0404',message='trip_unavailable'; end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(receipt_key,value) order by receipt_key),'[]') into rs
    from customer_private.travel_receipts where actor=a;
  return pg_catalog.jsonb_build_object('trips',ts,'members',ms,'invites',ins,'audits',aus,'ledgers',ls,'receipts',rs);
end $$;

-- 1개의 변경된 여행에 대해 actor 권한과 action별 수정 가능 영역을 확인한다.
-- 모든 금액 및 정산 결과는 기존 TypeScript 도메인의 계산 결과를 사용한다.
create function customer_private.travel_transition(p_old jsonb,p_new jsonb,p_action text,p_scope jsonb,p_actor uuid) returns void
language plpgsql set search_path='' as $$
declare
  me jsonb:=customer_private.travel_member(p_old,p_actor); nextme jsonb:=customer_private.travel_member(p_new,p_actor);
  ot jsonb:=p_old->'trip'; nt jsonb:=p_new->'trip'; om jsonb:=p_old->'members'; nm jsonb:=p_new->'members';
  oi jsonb:=p_old->'invites'; ni jsonb:=p_new->'invites'; ol jsonb; nl jsonb;
  inv jsonb; newinv jsonb; previous jsonb; changed jsonb; history jsonb;
  oldrev bigint; newrev bigint:=(p_new->'trip'->>'revision')::bigint;
  n integer:=0; action text; myid text; is_join boolean:=false; field text;
begin
  -- 내부 호출도 NULL·알 수 없는 action을 거절한다. 공개 함수의 검사에만 의존하지 않는다.
  if p_action is null or p_action not in ('create','update','manage','issue','revoke','accept','ledger') then
    raise exception using errcode='P0403',message='action_forbidden';
  end if;
  if p_actor is null or pg_catalog.jsonb_typeof(p_scope) is distinct from 'object'
    or (p_scope->>'kind') is distinct from (case when p_action='create' then 'create' when p_action='accept' then 'invite' else 'trip' end) then
    raise exception using errcode='P0403',message='transition_scope_invalid';
  end if;
  if pg_catalog.jsonb_typeof(p_new) is distinct from 'object' or pg_catalog.jsonb_typeof(nt) is distinct from 'object'
    or pg_catalog.jsonb_typeof(nm) is distinct from 'array' or pg_catalog.jsonb_typeof(ni) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_new->'audits') is distinct from 'array'
    or (pg_catalog.jsonb_typeof(p_new->'ledger') in ('object','null')) is not true then
    raise exception using errcode='P0422',message='document_invalid';
  end if;
  foreach field in array array['id','ownerUserId','createdAt','status'] loop
    if pg_catalog.jsonb_typeof(nt->field) is distinct from 'string' then raise exception using errcode='P0422',message='trip_identity_required'; end if;
  end loop;
  if pg_catalog.jsonb_typeof(nt->'revision') is distinct from 'number' or newrev is null then raise exception using errcode='P0422',message='revision_required'; end if;
  if p_old is not null and (pg_catalog.jsonb_typeof(p_old) is distinct from 'object'
    or pg_catalog.jsonb_typeof(ot) is distinct from 'object' or pg_catalog.jsonb_typeof(om) is distinct from 'array'
    or pg_catalog.jsonb_typeof(oi) is distinct from 'array') then raise exception using errcode='P0422',message='previous_document_invalid'; end if;
  if nt->>'status' is distinct from 'active' or newrev<1 or newrev>9007199254740991 then raise exception using errcode='P0422',message='trip_invalid'; end if;
  if pg_catalog.jsonb_array_length(nm)>2048 or pg_catalog.jsonb_array_length(ni)>4096
    or pg_catalog.jsonb_array_length(p_new->'audits')>8192 then raise exception using errcode='P0422',message='state_limit'; end if;
  -- 불변 소유자와 멤버 유일성. 탈퇴 멤버도 과거 경비 참조를 위해 보존한다.
  if (select count(*) from pg_catalog.jsonb_array_elements(nm) m where m->>'role'='owner') is distinct from 1
    or not exists(select 1 from pg_catalog.jsonb_array_elements(nm) m where m->>'role'='owner'
      and m->>'userId'=nt->>'ownerUserId' and (m->>'active')::boolean)
    or exists(select 1 from pg_catalog.jsonb_array_elements(nm) m where m->>'tripId' is distinct from nt->>'id'
      or (m->>'role' in ('owner','editor','viewer')) is not true or pg_catalog.jsonb_typeof(m->'active') is distinct from 'boolean')
    or (select count(*) from pg_catalog.jsonb_array_elements(nm)) is distinct from (select count(distinct m->>'id') from pg_catalog.jsonb_array_elements(nm) m)
    or (select count(*) from pg_catalog.jsonb_array_elements(nm)) is distinct from (select count(distinct m->>'userId') from pg_catalog.jsonb_array_elements(nm) m)
    or (select count(*) from pg_catalog.jsonb_array_elements(nm)) is distinct from (select count(distinct m->>'alias') from pg_catalog.jsonb_array_elements(nm) m)
    or (select count(*) from pg_catalog.jsonb_array_elements(nm) m where (m->>'active')::boolean)>8 then
    raise exception using errcode='P0422',message='members_invalid';
  end if;
  if p_old is null then
    if p_action is distinct from 'create' or p_scope->>'kind' is distinct from 'create' or nt->>'ownerUserId' is distinct from p_actor::text
      or newrev is distinct from 1 or pg_catalog.jsonb_array_length(nm) is distinct from 1 or nextme->>'role' is distinct from 'owner'
      or ni is distinct from '[]'::jsonb or p_new->'ledger' is distinct from 'null'::jsonb then
      raise exception using errcode='P0403',message='create_forbidden';
    end if;
    if (select count(*) from customer_private.travel_documents where body->'trip'->>'ownerUserId'=p_actor::text)>=20 then
      raise exception using errcode='P0409',message='trip_limit';
    end if;
    oldrev:=0;
  else
    oldrev:=(ot->>'revision')::bigint;
    if nt->>'id' is distinct from ot->>'id' or nt->>'ownerUserId' is distinct from ot->>'ownerUserId' or nt->>'createdAt' is distinct from ot->>'createdAt' then
      raise exception using errcode='P0403',message='trip_identity_immutable';
    end if;
    if p_action is distinct from 'accept' and not coalesce((me->>'active')::boolean,false) then raise exception using errcode='P0404',message='trip_unavailable'; end if;
    if p_action in ('update','manage','issue','revoke') and me->>'role' is distinct from 'owner' then raise exception using errcode='P0403',message='owner_required'; end if;
    if p_action is distinct from 'update' and (nt-'revision') is distinct from (ot-'revision') then raise exception using errcode='P0403',message='settings_immutable'; end if;
    if p_action not in ('manage','accept') and nm is distinct from om then raise exception using errcode='P0403',message='members_immutable'; end if;
    if p_action not in ('issue','revoke','accept') and ni is distinct from oi then raise exception using errcode='P0403',message='invites_immutable'; end if;
    if p_action is distinct from 'ledger' and p_new->'ledger' is distinct from p_old->'ledger' then raise exception using errcode='P0403',message='ledger_immutable'; end if;
    if p_action='manage' then
      if pg_catalog.jsonb_array_length(nm) is distinct from pg_catalog.jsonb_array_length(om) then raise exception using errcode='P0422',message='member_count'; end if;
      for changed in select x from pg_catalog.jsonb_array_elements(nm) x loop
        select x into previous from pg_catalog.jsonb_array_elements(om) x where x->>'id'=changed->>'id';
        if previous is null then raise exception using errcode='P0422',message='member_missing'; end if;
        if previous is distinct from changed then
          n:=n+1;
          if previous->>'role'='owner' or (previous->>'active')::boolean is not true
            or (previous-array['role','active']) is distinct from (changed-array['role','active'])
            or (changed->>'role' in ('editor','viewer')) is not true then raise exception using errcode='P0403',message='member_change_forbidden'; end if;
        end if;
      end loop;
      if n>1 then raise exception using errcode='P0422',message='member_change_count'; end if;
    elsif p_action='issue' then
      if pg_catalog.jsonb_array_length(ni) is distinct from pg_catalog.jsonb_array_length(oi)+1
        or not customer_private.travel_contains(ni,oi) then raise exception using errcode='P0422',message='invite_append_required'; end if;
      select x into inv from pg_catalog.jsonb_array_elements(ni) x where not exists(select 1 from pg_catalog.jsonb_array_elements(oi) y where y=x);
      if inv->>'tripId' is distinct from nt->>'id' or (inv->>'role' in ('editor','viewer')) is not true or inv->>'status' is distinct from 'pending'
        or inv->'acceptedBy' is distinct from 'null'::jsonb or coalesce(inv->>'tokenHash','') !~ '^[0-9a-f]{64}$'
        or coalesce(inv->>'keyId','') !~ '^[A-Za-z0-9_-]{1,16}$' or ((inv->>'expiresAt')::timestamptz>pg_catalog.clock_timestamp()) is not true
        or exists(select 1 from customer_private.travel_documents d,pg_catalog.jsonb_array_elements(d.body->'invites') x where x->>'id'=inv->>'id' or x->>'tokenHash'=inv->>'tokenHash') then
        raise exception using errcode='P0422',message='invite_invalid'; end if;
    elsif p_action='revoke' then
      if pg_catalog.jsonb_array_length(ni) is distinct from pg_catalog.jsonb_array_length(oi) then raise exception using errcode='P0422',message='invite_count'; end if;
      for changed in select x from pg_catalog.jsonb_array_elements(ni) x loop
        select x into previous from pg_catalog.jsonb_array_elements(oi) x where x->>'id'=changed->>'id';
        if previous is null then raise exception using errcode='P0422',message='invite_missing'; end if;
        if previous is distinct from changed then
          n:=n+1;
          if previous->>'status' is distinct from 'pending' or ((previous->>'expiresAt')::timestamptz>pg_catalog.clock_timestamp()) is not true
            or changed->>'status' is distinct from 'revoked' or (previous-'status') is distinct from (changed-'status') then
            raise exception using errcode='P0410',message='invite_unavailable'; end if;
        end if;
      end loop;
      if n is distinct from 1 then raise exception using errcode='P0422',message='invite_change_count'; end if;
    elsif p_action='accept' then
      if p_scope->>'kind' is distinct from 'invite' then raise exception using errcode='P0403',message='proof_required'; end if;
      select x into inv from pg_catalog.jsonb_array_elements(oi) x where x->>'id'=p_scope->'proof'->>'id'
        and x->>'keyId'=p_scope->'proof'->>'kid' and x->>'tokenHash'=p_scope->'proof'->>'hash';
      if inv is null then raise exception using errcode='P0410',message='invite_unavailable'; end if;
      is_join:=not coalesce((me->>'active')::boolean,false);
      if not is_join then
        if nm is distinct from om or ni is distinct from oi or nt is distinct from ot then raise exception using errcode='P0403',message='already_joined'; end if;
      else
        if inv->>'status' is distinct from 'pending' or ((inv->>'expiresAt')::timestamptz>pg_catalog.clock_timestamp()) is not true
          or nextme is null or (nextme->>'active')::boolean is not true or nextme->>'role' is distinct from inv->>'role'
          or nextme->>'tripId' is distinct from nt->>'id' then raise exception using errcode='P0410',message='invite_unavailable'; end if;
        if me is not null and (me-array['role','active','alias']) is distinct from (nextme-array['role','active','alias']) then raise exception using errcode='P0403',message='member_identity_immutable'; end if;
        if (select coalesce(pg_catalog.jsonb_agg(x),'[]') from pg_catalog.jsonb_array_elements(om) x where x->>'userId' is distinct from p_actor::text)
           is distinct from  (select coalesce(pg_catalog.jsonb_agg(x),'[]') from pg_catalog.jsonb_array_elements(nm) x where x->>'userId' is distinct from p_actor::text) then
          raise exception using errcode='P0403',message='other_members_immutable'; end if;
        select x into newinv from pg_catalog.jsonb_array_elements(ni) x where x->>'id'=inv->>'id';
        if newinv is null or newinv is distinct from pg_catalog.jsonb_set(pg_catalog.jsonb_set(inv,'{status}','"accepted"'),'{acceptedBy}',pg_catalog.to_jsonb(p_actor::text))
          or (select coalesce(pg_catalog.jsonb_agg(x),'[]') from pg_catalog.jsonb_array_elements(oi) x where x->>'id' is distinct from inv->>'id')
           is distinct from  (select coalesce(pg_catalog.jsonb_agg(x),'[]') from pg_catalog.jsonb_array_elements(ni) x where x->>'id' is distinct from inv->>'id') then
          raise exception using errcode='P0403',message='invite_accept_invalid'; end if;
      end if;
    elsif p_action='ledger' then
      if (me->>'role' in ('owner','editor')) is not true then raise exception using errcode='P0403',message='editor_required'; end if;
      history:=p_new->'audits'->-1;action:=history->>'action';myid:=me->>'id';
      if myid is null or action is null or action not in ('schedule.create','schedule.adopt','schedule.update','schedule.cancel','schedule.reorder',
        'expense.create','expense.update','expense.cancel','fx.update','settlement.finalize','settlement.reopen',
        'payment.report','payment.confirm','payment.requestVoid','payment.confirmVoid') then
        raise exception using errcode='P0403',message='ledger_action_forbidden';
      end if;
      if action in ('fx.update','settlement.finalize','settlement.reopen') and me->>'role' is distinct from 'owner' then raise exception using errcode='P0403',message='owner_required'; end if;
      ol:=case when p_old->'ledger'='null'::jsonb then '{"items":[],"expenses":[],"fx":{"source":"demo","rateMilli":38600},"snapshots":[],"payments":[],"expenseRevision":0,"confirmedPaymentRevision":0}'::jsonb else p_old->'ledger' end;
      nl:=p_new->'ledger';
      if action in ('schedule.create','schedule.adopt','schedule.update','schedule.cancel','schedule.reorder') then
        if (ol-'items') is distinct from (nl-'items') then raise exception using errcode='P0403',message='schedule_boundary'; end if;
      elsif action in ('expense.create','expense.update','expense.cancel') then
        if (ol-array['expenses','expenseRevision']) is distinct from (nl-array['expenses','expenseRevision']) then raise exception using errcode='P0403',message='expense_boundary'; end if;
        -- 이전 경비 ID 보존과 유일성을 먼저 검사해 같은 길이의 ID 교체를 막는다.
        if pg_catalog.jsonb_typeof(ol->'expenses') is distinct from 'array'
          or pg_catalog.jsonb_typeof(nl->'expenses') is distinct from 'array' then
          raise exception using errcode='P0422',message='expenses_invalid';
        end if;
        if (select count(*) from pg_catalog.jsonb_array_elements(nl->'expenses'))
          is distinct from (select count(distinct x->>'id') from pg_catalog.jsonb_array_elements(nl->'expenses') x) then
          raise exception using errcode='P0422',message='duplicate_expense';
        end if;
        if exists(select 1 from pg_catalog.jsonb_array_elements(ol->'expenses') old
          where not exists(select 1 from pg_catalog.jsonb_array_elements(nl->'expenses') new where new->>'id'=old->>'id')) then
          raise exception using errcode='P0403',message='expense_delete_forbidden';
        end if;
        -- 완료 정산의 날짜와 변경 경비의 변경 전후 날짜가 겹치면 거절한다.
        for changed in select x from pg_catalog.jsonb_array_elements(nl->'expenses') x loop
          select x into previous from pg_catalog.jsonb_array_elements(ol->'expenses') x where x->>'id'=changed->>'id';
          if previous is distinct from changed and exists(select 1 from pg_catalog.jsonb_array_elements(ol->'snapshots') s
            where s->'reopenedAt'='null'::jsonb and (s->'date'='null'::jsonb or s->>'date'=changed->>'localDate' or s->>'date'=previous->>'localDate')) then
            raise exception using errcode='P0422',message='settlement_locked'; end if;
        end loop;
        if pg_catalog.jsonb_array_length(nl->'expenses')<pg_catalog.jsonb_array_length(ol->'expenses') then raise exception using errcode='P0403',message='expense_delete_forbidden'; end if;
      elsif action='fx.update' then
        if (ol-'fx') is distinct from (nl-'fx') then raise exception using errcode='P0403',message='fx_boundary'; end if;
      elsif action in ('settlement.finalize','settlement.reopen') then
        if (ol-'snapshots') is distinct from (nl-'snapshots') then raise exception using errcode='P0403',message='settlement_boundary'; end if;
      elsif action in ('payment.report','payment.confirm','payment.requestVoid','payment.confirmVoid') then
        if (ol-array['payments','confirmedPaymentRevision']) is distinct from (nl-array['payments','confirmedPaymentRevision']) then raise exception using errcode='P0403',message='payment_boundary'; end if;
        for changed in select x from pg_catalog.jsonb_array_elements(nl->'payments') x loop
          select x into previous from pg_catalog.jsonb_array_elements(ol->'payments') x where x->>'id'=changed->>'id';
          if previous is distinct from changed then
            n:=n+1;
            if previous is null then
              if action is distinct from 'payment.report' or changed->>'fromMemberId' is distinct from myid or changed->>'toMemberId'=myid or changed->>'status' is distinct from 'reported'
                or not exists(select 1 from pg_catalog.jsonb_array_elements(nm) m where m->>'id'=changed->>'toMemberId' and (m->>'active')::boolean and m->>'role' in ('owner','editor')) then
                raise exception using errcode='P0403',message='payment_report_forbidden'; end if;
            else
              if previous->>'fromMemberId' is distinct from myid and previous->>'toMemberId' is distinct from myid then raise exception using errcode='P0403',message='payment_party_required'; end if;
              if (previous-array['revision','status','confirmedAt','confirmedDate','voidRequestedByMemberId','voidRequestedAt','voidedAt','voidedByMemberId'])
                 is distinct from  (changed-array['revision','status','confirmedAt','confirmedDate','voidRequestedByMemberId','voidRequestedAt','voidedAt','voidedByMemberId']) then raise exception using errcode='P0403',message='payment_identity_immutable'; end if;
              if action='payment.confirm' and (previous->>'toMemberId' is distinct from myid or previous->>'status' is distinct from 'reported' or changed->>'status' is distinct from 'confirmed') then raise exception using errcode='P0403',message='payment_confirm_forbidden'; end if;
              if action='payment.requestVoid' and ((previous->>'status'='reported' and previous->>'fromMemberId'=myid and changed->>'status'='voided')
                or (previous->>'status'='confirmed' and changed->>'status'='void_requested' and changed->>'voidRequestedByMemberId'=myid)) is not true then raise exception using errcode='P0403',message='payment_void_forbidden'; end if;
              if action='payment.confirmVoid' and ((previous->>'status'='void_requested' and previous->>'voidRequestedByMemberId' is not null
                and previous->>'voidRequestedByMemberId' is distinct from myid and changed->>'status'='voided' and changed->>'voidedByMemberId'=myid) is not true) then raise exception using errcode='P0403',message='payment_confirm_void_forbidden'; end if;
            end if;
          end if;
        end loop;
        if n is distinct from 1 or pg_catalog.jsonb_array_length(nl->'payments') is distinct from pg_catalog.jsonb_array_length(ol->'payments')+(case when action='payment.report' then 1 else 0 end) then raise exception using errcode='P0422',message='payment_change_count'; end if;
      else raise exception using errcode='P0422',message='ledger_action_invalid';
      end if;
    elsif p_action is distinct from 'update' then raise exception using errcode='P0422',message='action_invalid';
    end if;
  end if;
  if newrev is distinct from oldrev+(case when p_action='accept' and not is_join then 0 else 1 end) then raise exception using errcode='P0409',message='revision_conflict'; end if;
  if pg_catalog.jsonb_array_length(p_new->'audits') is distinct from coalesce(pg_catalog.jsonb_array_length(p_old->'audits'),0)+1
    or not customer_private.travel_contains(p_new->'audits',coalesce(p_old->'audits','[]')) then raise exception using errcode='P0422',message='audit_append_required'; end if;
  history:=p_new->'audits'->-1;
  if history->>'tripId' is distinct from nt->>'id' or history->>'memberId' is distinct from nextme->>'id' or (history->>'revision')::bigint is distinct from newrev
    or (p_action is distinct from 'ledger' and history->>'action' is distinct from p_action) then raise exception using errcode='P0422',message='audit_invalid'; end if;
end $$;

create function customer_private.travel_save(p_scope jsonb,p_before jsonb,p_after jsonb,p_action text) returns boolean
language plpgsql security definer set search_path='' as $$
declare
  a uuid; live jsonb; t jsonb; olddoc jsonb; newdoc jsonb; changed_id uuid; changed_doc jsonb;
  changed_count integer:=0; r jsonb; prior jsonb; receipt_count integer:=0; action text; field text;
begin
  -- p_action=NULL이면 NOT IN도 NULL이므로 명시적으로 거절한다.
  if p_action is null or p_action not in ('create','update','manage','issue','revoke','accept','ledger') then
    raise exception using errcode='P0403',message='action_forbidden';
  end if;
  if pg_catalog.jsonb_typeof(p_before) is distinct from 'object' or pg_catalog.jsonb_typeof(p_after) is distinct from 'object' then
    raise exception using errcode='P0422',message='state_required';
  end if;
  -- travel_load가 세션·권한·proof 재검사와 동일 advisory transaction lock을 수행한다.
  live:=customer_private.travel_load(p_scope);a:=customer_private.assert_actor();
  if a is null then raise exception using errcode='P0401',message='actor_required'; end if;
  if live is distinct from p_before then raise exception using errcode='P0409',message='state_conflict'; end if;
  if (p_scope->>'kind') is distinct from (case when p_action='create' then 'create' when p_action='accept' then 'invite' else 'trip' end) then raise exception using errcode='P0403',message='write_scope'; end if;
  foreach field in array array['trips','members','invites','audits','ledgers','receipts'] loop
    if pg_catalog.jsonb_typeof(p_after->field) is distinct from 'array' then raise exception using errcode='P0422',message='state_invalid'; end if;
  end loop;
  if pg_catalog.jsonb_array_length(p_after->'trips') is distinct from pg_catalog.jsonb_array_length(p_before->'trips')+(case when p_action='create' then 1 else 0 end) then raise exception using errcode='P0422',message='trip_count'; end if;
  if exists(select 1 from pg_catalog.jsonb_array_elements(p_before->'trips') old where not exists(select 1 from pg_catalog.jsonb_array_elements(p_after->'trips') new where old->>'id'=new->>'id')) then raise exception using errcode='P0403',message='trip_delete_forbidden'; end if;
  if (select count(*) from pg_catalog.jsonb_array_elements(p_after->'trips')) is distinct from (select count(distinct x->>'id') from pg_catalog.jsonb_array_elements(p_after->'trips') x) then raise exception using errcode='P0422',message='duplicate_trip'; end if;
  for t in select x from pg_catalog.jsonb_array_elements(p_after->'trips') x loop
    select body into olddoc from customer_private.travel_documents where trip_id=(t->>'id')::uuid;
    select pg_catalog.jsonb_build_object('trip',t,
      'members',(select coalesce(pg_catalog.jsonb_agg(x),'[]') from pg_catalog.jsonb_array_elements(p_after->'members') x where x->>'tripId'=t->>'id'),
      'invites',(select coalesce(pg_catalog.jsonb_agg(x),'[]') from pg_catalog.jsonb_array_elements(p_after->'invites') x where x->>'tripId'=t->>'id'),
      'audits',(select coalesce(pg_catalog.jsonb_agg(x),'[]') from pg_catalog.jsonb_array_elements(p_after->'audits') x where x->>'tripId'=t->>'id'),
      'ledger',coalesce((select x->1 from pg_catalog.jsonb_array_elements(p_after->'ledgers') x where x->>0=t->>'id'),'null')) into newdoc;
    if olddoc is distinct from newdoc then
      changed_count:=changed_count+1;changed_id:=(t->>'id')::uuid;changed_doc:=newdoc;
      if olddoc is not null and not exists(select 1 from pg_catalog.jsonb_array_elements(p_before->'trips') x where x->>'id'=t->>'id') then raise exception using errcode='P0403',message='out_of_scope'; end if;
      perform customer_private.travel_transition(olddoc,newdoc,p_action,p_scope,a);
    end if;
  end loop;
  if changed_count is distinct from 1 then raise exception using errcode='P0422',message='single_trip_required'; end if;
  -- 기존 receipt는 불변이다. actor/action/operation ID는 전체 여행에서 유일하다.
  if not customer_private.travel_contains(p_after->'receipts',p_before->'receipts') then raise exception using errcode='P0403',message='receipt_immutable'; end if;
  action:=changed_doc->'audits'->-1->>'action';
  if action is null then raise exception using errcode='P0422',message='receipt_action_required'; end if;
  for r in select x from pg_catalog.jsonb_array_elements(p_after->'receipts') x loop
    select value into prior from customer_private.travel_receipts where actor=a and receipt_key=r->>0;
    if found then
      if prior is distinct from r->1 then raise exception using errcode='P0409',message='receipt_conflict'; end if;
      continue;
    end if;
    receipt_count:=receipt_count+1;
    if pg_catalog.jsonb_array_length(r) is distinct from 2 or coalesce(r->>0,'') !~ ('^'||a::text||':'||pg_catalog.replace(action,'.','[.]')||':[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
      or coalesce(r->1->>'hash','') !~ '^[0-9a-f]{64}$' or r->1->'result'->'replayed' is distinct from 'false'::jsonb
      or r->1->'result'->'tripRevision' is distinct from changed_doc->'trip'->'revision' then raise exception using errcode='P0422',message='receipt_invalid'; end if;
  end loop;
  if receipt_count is distinct from 1 then raise exception using errcode='P0422',message='single_receipt_required'; end if;
  insert into customer_private.travel_documents(trip_id,body) values(changed_id,changed_doc)
    on conflict(trip_id) do update set body=excluded.body;
  for r in select x from pg_catalog.jsonb_array_elements(p_after->'receipts') x loop
    insert into customer_private.travel_receipts(actor,receipt_key,trip_id,value) values(a,r->>0,changed_id,r->1) on conflict(actor,receipt_key) do nothing;
  end loop;
  return true;
end $$;

-- 별도 트랜잭션으로 선예약. 이후 malformed/expired proof 검사 실패에도 시도 횟수가 남는다.
-- 단일 전역 lock은 actor와 client 두 제한을 함께 원자적으로 검사한다.
create function customer_private.travel_reserve_attempt(p_client text) returns boolean
language plpgsql security definer set search_path='' as $$
declare a uuid; at_time timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(708170062::bigint);
  a:=customer_private.assert_actor();at_time:=pg_catalog.clock_timestamp();
  if a is null then raise exception using errcode='P0401',message='actor_required'; end if;
  if p_client is null or p_client !~ '^[0-9a-f]{64}$' then raise exception using errcode='P0422',message='client_invalid'; end if;
  delete from customer_private.travel_attempts where attempted_at<=at_time-interval '60 seconds';
  if (select count(*) from customer_private.travel_attempts where actor=a)>=30
    or (select count(*) from customer_private.travel_attempts where client_hash=p_client)>=60 then return false; end if;
  if (select count(*) from customer_private.travel_attempts)>=8192 then raise exception using errcode='P0503',message='attempt_capacity'; end if;
  insert into customer_private.travel_attempts(actor,client_hash,attempted_at) values(a,p_client,at_time);
  return true;
end $$;

alter function customer_private.travel_member(jsonb,uuid) owner to customer_writer;
alter function customer_private.travel_contains(jsonb,jsonb) owner to customer_writer;
alter function customer_private.travel_load(jsonb) owner to customer_writer;
alter function customer_private.travel_transition(jsonb,jsonb,text,jsonb,uuid) owner to customer_writer;
alter function customer_private.travel_save(jsonb,jsonb,jsonb,text) owner to customer_writer;
alter function customer_private.travel_reserve_attempt(text) owner to customer_writer;
revoke all on function customer_private.travel_member(jsonb,uuid),customer_private.travel_contains(jsonb,jsonb),
  customer_private.travel_load(jsonb),customer_private.travel_transition(jsonb,jsonb,text,jsonb,uuid),
  customer_private.travel_save(jsonb,jsonb,jsonb,text),customer_private.travel_reserve_attempt(text)
  from public,anon,authenticated,customer_app,customer_auth_runtime;
grant execute on function customer_private.travel_load(jsonb),customer_private.travel_save(jsonb,jsonb,jsonb,text),
  customer_private.travel_reserve_attempt(text) to customer_app;

-- 채널 위임·확인 저장·사용량 예약 확장

set local lock_timeout='5s';
set local statement_timeout='30s';

create table customer_private.channel_pairs (
  code_hash text primary key check(code_hash ~ '^[0-9a-f]{64}$'),
  actor uuid not null, session_hash text not null check(session_hash ~ '^[0-9a-f]{64}$'),
  trip_id uuid not null references customer_private.travel_documents(trip_id),
  expires_at timestamptz not null, pending_id uuid unique,
  environment text check(environment='development'), bot_id text, sender_hash text,
  approved_at timestamptz, created_at timestamptz not null default clock_timestamp(),
  check((pending_id is null and environment is null and bot_id is null and sender_hash is null)
    or (pending_id is not null and environment is not null and bot_id is not null and sender_hash ~ '^[0-9a-f]{64}$'))
);
create table customer_private.channel_grants (
  id uuid primary key, actor uuid not null, session_hash text not null check(session_hash ~ '^[0-9a-f]{64}$'),
  trip_id uuid not null references customer_private.travel_documents(trip_id),
  environment text not null check(environment='development'), bot_id text not null,
  sender_hash text not null check(sender_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null, revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create unique index channel_one_current_grant on customer_private.channel_grants(environment,bot_id,sender_hash) where revoked_at is null;
create table customer_private.channel_confirmations (
  token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
  operation_id uuid not null unique, grant_id uuid not null references customer_private.channel_grants(id),
  command jsonb not null check(command->>'type' in ('schedule.create','expense.create')),
  expected_revision bigint not null check(expected_revision between 1 and 9007199254740991),
  expires_at timestamptz not null, result jsonb, consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check((result is null)=(consumed_at is null))
);
create table customer_private.provider_usage_reservations (
  scope text not null check(length(scope) between 1 and 256),
  request_id text not null check(length(request_id) between 1 and 256),
  usage_day date not null, period_key text not null check(period_key ~ '^[A-Za-z0-9:_-]{1,64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(scope,request_id)
);
create index provider_usage_period on customer_private.provider_usage_reservations(scope,period_key);

alter table customer_private.channel_pairs owner to customer_writer;
alter table customer_private.channel_grants owner to customer_writer;
alter table customer_private.channel_confirmations owner to customer_writer;
alter table customer_private.provider_usage_reservations owner to customer_writer;
alter table customer_private.channel_pairs enable row level security;
alter table customer_private.channel_pairs force row level security;
alter table customer_private.channel_grants enable row level security;
alter table customer_private.channel_grants force row level security;
alter table customer_private.channel_confirmations enable row level security;
alter table customer_private.channel_confirmations force row level security;
alter table customer_private.provider_usage_reservations enable row level security;
alter table customer_private.provider_usage_reservations force row level security;
create policy channel_pairs_writer on customer_private.channel_pairs to customer_writer using(true) with check(true);
create policy channel_grants_writer on customer_private.channel_grants to customer_writer using(true) with check(true);
create policy channel_confirmations_writer on customer_private.channel_confirmations to customer_writer using(true) with check(true);
create policy provider_usage_writer on customer_private.provider_usage_reservations to customer_writer using(true) with check(true);
revoke all on customer_private.channel_pairs,customer_private.channel_grants,customer_private.channel_confirmations,
  customer_private.provider_usage_reservations from public,anon,authenticated,customer_app,customer_auth_runtime;

-- 인증 테이블 SELECT 권한을 writer/app에 주지 않고 실제 승인 세션 행만 잠근다.
-- auth/store.ts의 read FOR UPDATE와 revoke UPDATE는 같은 sessions.hash 행을 사용한다.
-- 만료 시각만 반환하고 암호화된 provider token은 읽지 않는다.
create function customer_auth.channel_lock_session(p_actor uuid,p_hash text) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare s record;
begin
  select user_id,expires_at,revoked_at,refresh_pending into s
    from customer_auth.sessions where hash=p_hash for update;
  if not found or s.user_id is distinct from p_actor or s.revoked_at is not null or s.refresh_pending
    or s.expires_at<=pg_catalog.clock_timestamp() then
    raise exception using errcode='P0401',message='session_unavailable';
  end if;
  return s.expires_at;
end $$;
alter function customer_auth.channel_lock_session(uuid,text) owner to customer_auth_owner;
revoke all on function customer_auth.channel_lock_session(uuid,text) from public,anon,authenticated,customer_app,customer_auth_runtime;
grant execute on function customer_auth.channel_lock_session(uuid,text) to customer_writer;

create function customer_private.channel_sender(p_sender jsonb) returns void
language plpgsql set search_path='' as $$
begin
  if pg_catalog.jsonb_typeof(p_sender) is distinct from 'object' or p_sender->>'environment' is distinct from 'development'
    or coalesce(pg_catalog.length(p_sender->>'botId'),0) not between 1 and 128
    or coalesce(p_sender->>'senderHash','') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='P0422',message='sender_invalid';
  end if;
end $$;

-- aggregate와 같은 advisory lock, grant, 승인 세션 순으로 잠근다. 멤버 변경도 같은 aggregate lock을 사용한다.
create function customer_private.channel_authorize(p_sender jsonb) returns customer_private.channel_grants
language plpgsql set search_path='' as $$
declare g customer_private.channel_grants; d jsonb; m jsonb;
begin
  perform customer_private.channel_sender(p_sender);
  perform pg_catalog.pg_advisory_xact_lock(708170061::bigint);
  select * into g from customer_private.channel_grants where environment=p_sender->>'environment'
    and bot_id=p_sender->>'botId' and sender_hash=p_sender->>'senderHash' and revoked_at is null for update;
  if not found or g.expires_at<=pg_catalog.clock_timestamp() then raise exception using errcode='P0403',message='grant_unavailable'; end if;
  perform customer_auth.channel_lock_session(g.actor,g.session_hash);
  select body into d from customer_private.travel_documents where trip_id=g.trip_id for update;
  m:=customer_private.travel_member(d,g.actor);
  if d->'trip'->>'status' is distinct from 'active' or (m->>'active')::boolean is not true
    or (m->>'role' in ('owner','editor')) is not true then raise exception using errcode='P0403',message='editor_required'; end if;
  return g;
end $$;

create function customer_private.channel_state(p_trip uuid,p_actor uuid) returns jsonb
language sql set search_path='' as $$
  select pg_catalog.jsonb_build_object('trips',pg_catalog.jsonb_build_array(d.body->'trip'),
    'members',d.body->'members','invites',d.body->'invites','audits',d.body->'audits',
    'ledgers',case when d.body->'ledger'='null'::jsonb then '[]'::jsonb else pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(p_trip::text,d.body->'ledger')) end,
    'receipts',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(receipt_key,value) order by receipt_key),'[]')
      from customer_private.travel_receipts where actor=p_actor))
  from customer_private.travel_documents d where d.trip_id=p_trip
$$;

create function customer_private.channel_web(p_action text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a uuid; sh text; t uuid; d jsonb; m jsonb; p customer_private.channel_pairs; g customer_private.channel_grants;
  deadline timestamptz; session_deadline timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(708170061::bigint);
  a:=customer_private.assert_actor();sh:=pg_catalog.current_setting('customer.session_hash',true);
  session_deadline:=customer_auth.channel_lock_session(a,sh);
  if p_action='issue' then
    if coalesce(p_input->>'codeHash','') !~ '^[0-9a-f]{64}$' then raise exception using errcode='P0422',message='code_invalid'; end if;
    t:=(p_input->>'tripId')::uuid;
  elsif p_action='approve' then
    select * into p from customer_private.channel_pairs where pending_id=(p_input->>'pendingId')::uuid for update;
    if not found or p.actor is distinct from a or p.session_hash is distinct from sh or p.approved_at is not null
      or p.expires_at<=pg_catalog.clock_timestamp() then raise exception using errcode='P0403',message='pair_unavailable'; end if;
    t:=p.trip_id;
  elsif p_action='unlink' then
    select * into g from customer_private.channel_grants where id=(p_input->>'grantId')::uuid for update;
    if not found or g.actor is distinct from a then raise exception using errcode='P0403',message='grant_unavailable'; end if;
    update customer_private.channel_grants set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp()) where id=g.id;
    return '{"unlinked":true}'::jsonb;
  else raise exception using errcode='P0422',message='action_invalid';
  end if;
  select body into d from customer_private.travel_documents where trip_id=t for update;
  m:=customer_private.travel_member(d,a);
  if d->'trip'->>'status' is distinct from 'active' or (m->>'active')::boolean is not true
    or (m->>'role' in ('owner','editor')) is not true then raise exception using errcode='P0403',message='editor_required'; end if;
  if p_action='issue' then
    if (select count(*) from customer_private.channel_pairs where actor=a and approved_at is null and expires_at>pg_catalog.clock_timestamp())>=5 then
      raise exception using errcode='P0409',message='pair_limit'; end if;
    deadline:=least(session_deadline,pg_catalog.clock_timestamp()+interval '10 minutes');
    insert into customer_private.channel_pairs(code_hash,actor,session_hash,trip_id,expires_at) values(p_input->>'codeHash',a,sh,t,deadline);
    return pg_catalog.jsonb_build_object('expiresAt',deadline);
  end if;
  -- A sender can have only one current trip. Switching revokes old grants and therefore all prior reviews.
  update customer_private.channel_grants set revoked_at=pg_catalog.clock_timestamp()
    where environment=p.environment and bot_id=p.bot_id and sender_hash=p.sender_hash and revoked_at is null;
  g.id:=pg_catalog.gen_random_uuid();deadline:=least(session_deadline,pg_catalog.clock_timestamp()+interval '24 hours');
  insert into customer_private.channel_grants(id,actor,session_hash,trip_id,environment,bot_id,sender_hash,expires_at)
    values(g.id,a,sh,t,p.environment,p.bot_id,p.sender_hash,deadline);
  update customer_private.channel_pairs set approved_at=pg_catalog.clock_timestamp() where code_hash=p.code_hash;
  return pg_catalog.jsonb_build_object('grantId',g.id,'tripId',t,'expiresAt',deadline);
end $$;

create function customer_private.channel_claim(p_sender jsonb,p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p customer_private.channel_pairs; d jsonb; m jsonb;
begin
  perform customer_private.channel_sender(p_sender);perform pg_catalog.pg_advisory_xact_lock(708170061::bigint);
  select * into p from customer_private.channel_pairs where code_hash=p_hash for update;
  if not found or p.expires_at<=pg_catalog.clock_timestamp() or p.approved_at is not null then raise exception using errcode='P0403',message='pair_unavailable'; end if;
  perform customer_auth.channel_lock_session(p.actor,p.session_hash);
  select body into d from customer_private.travel_documents where trip_id=p.trip_id for update;
  m:=customer_private.travel_member(d,p.actor);
  if d->'trip'->>'status' is distinct from 'active' or (m->>'active')::boolean is not true
    or (m->>'role' in ('owner','editor')) is not true then raise exception using errcode='P0403',message='editor_required'; end if;
  if p.pending_id is not null then
    if p.environment is distinct from p_sender->>'environment' or p.bot_id is distinct from p_sender->>'botId'
      or p.sender_hash is distinct from p_sender->>'senderHash' then raise exception using errcode='P0403',message='pair_unavailable'; end if;
  else
    p.pending_id:=pg_catalog.gen_random_uuid();
    update customer_private.channel_pairs set pending_id=p.pending_id,environment=p_sender->>'environment',bot_id=p_sender->>'botId',sender_hash=p_sender->>'senderHash'
      where code_hash=p_hash;
  end if;
  return pg_catalog.jsonb_build_object('pendingId',p.pending_id,'expiresAt',p.expires_at);
end $$;

create function customer_private.channel_load(p_sender jsonb,p_hash text,p_operation uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g customer_private.channel_grants; c customer_private.channel_confirmations; confirmation jsonb;
begin
  g:=customer_private.channel_authorize(p_sender);
  if (p_hash is null) is distinct from (p_operation is null) then raise exception using errcode='P0422',message='confirmation_invalid'; end if;
  if p_hash is not null then
    select * into c from customer_private.channel_confirmations where token_hash=p_hash for update;
    if not found or c.grant_id is distinct from g.id or c.operation_id is distinct from p_operation
      or c.expires_at<=pg_catalog.clock_timestamp() then raise exception using errcode='P0409',message='confirmation_unavailable'; end if;
    confirmation:=pg_catalog.jsonb_build_object('command',c.command,'expectedRevision',c.expected_revision,'operationId',c.operation_id,'result',c.result);
  end if;
  -- Internal server-only lease. Never return actor/sessionHash through HTTP, logs, or bot response DTOs.
  return pg_catalog.jsonb_build_object('actor',pg_catalog.jsonb_build_object('userId',g.actor,'sessionHash',g.session_hash),
    'tripId',g.trip_id,'grantId',g.id,'expiresAt',g.expires_at,'state',customer_private.channel_state(g.trip_id,g.actor),'confirmation',confirmation);
end $$;

create function customer_private.channel_review(p_sender jsonb,p_grant uuid,p_hash text,p_operation uuid,p_command jsonb,p_expected bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g customer_private.channel_grants; d jsonb; deadline timestamptz;
begin
  g:=customer_private.channel_authorize(p_sender);
  if g.id is distinct from p_grant then raise exception using errcode='P0403',message='grant_changed'; end if;
  if coalesce(p_hash,'') !~ '^[0-9a-f]{64}$' or p_operation is null or (p_command->>'type' in ('schedule.create','expense.create')) is not true
    or pg_catalog.jsonb_typeof(p_command->'input') is distinct from 'object' or pg_catalog.octet_length(p_command::text)>16384
    or p_expected is null or p_expected<1 then raise exception using errcode='P0422',message='review_invalid'; end if;
  select body into d from customer_private.travel_documents where trip_id=g.trip_id;
  if (d->'trip'->>'revision')::bigint is distinct from p_expected then raise exception using errcode='P0409',message='revision_conflict'; end if;
  if (select count(*) from customer_private.channel_confirmations where grant_id=g.id and expires_at>pg_catalog.clock_timestamp())>=64 then
    raise exception using errcode='P0409',message='review_limit'; end if;
  deadline:=least(g.expires_at,pg_catalog.clock_timestamp()+interval '5 minutes');
  insert into customer_private.channel_confirmations(token_hash,operation_id,grant_id,command,expected_revision,expires_at)
    values(p_hash,p_operation,g.id,p_command,p_expected,deadline);
  return pg_catalog.jsonb_build_object('expiresAt',deadline);
end $$;

create function customer_private.channel_save(p_sender jsonb,p_hash text,p_operation uuid,p_before jsonb,p_after jsonb,p_result jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare l jsonb; g customer_private.channel_grants; c customer_private.channel_confirmations;
  olddoc jsonb; newdoc jsonb; oldrows jsonb; newrows jsonb; added jsonb; receipt jsonb; receipt_key text; fields text[];
begin
  -- Recheck grant, actual approval session, current role, token and expiry in the final write transaction.
  l:=customer_private.channel_load(p_sender,p_hash,p_operation);
  select * into g from customer_private.channel_grants where id=(l->>'grantId')::uuid;
  select * into c from customer_private.channel_confirmations where token_hash=p_hash;
  if c.result is not null then
    if c.result is distinct from p_result then raise exception using errcode='P0409',message='result_conflict'; end if;return true;
  end if;
  if l->'state' is distinct from p_before then raise exception using errcode='P0409',message='state_conflict'; end if;
  if pg_catalog.jsonb_array_length(p_after->'trips') is distinct from 1 or pg_catalog.jsonb_array_length(p_after->'ledgers') is distinct from 1
    or p_after->'trips'->0->>'id' is distinct from g.trip_id::text or p_after->'ledgers'->0->>0 is distinct from g.trip_id::text
    or p_after->'members' is distinct from p_before->'members' or p_after->'invites' is distinct from p_before->'invites' then
    raise exception using errcode='P0422',message='scope_invalid'; end if;
  select body into olddoc from customer_private.travel_documents where trip_id=g.trip_id;
  if (olddoc->'trip'->>'revision')::bigint is distinct from c.expected_revision then raise exception using errcode='P0409',message='revision_conflict'; end if;
  newdoc:=pg_catalog.jsonb_build_object('trip',p_after->'trips'->0,'members',p_after->'members','invites',p_after->'invites','audits',p_after->'audits','ledger',p_after->'ledgers'->0->1);
  if newdoc->'audits'->-1->>'action' is distinct from c.command->>'type' then raise exception using errcode='P0403',message='command_changed'; end if;
  -- Reuses ONLY pure transition validation. Does not call web assert_actor or travel_save.
  perform customer_private.travel_transition(olddoc,newdoc,'ledger',pg_catalog.jsonb_build_object('kind','trip','tripId',g.trip_id),g.actor);
  if c.command->>'type'='schedule.create' then
    oldrows:=coalesce(nullif(olddoc->'ledger','null'::jsonb)->'items','[]');newrows:=newdoc->'ledger'->'items';
  else oldrows:=coalesce(nullif(olddoc->'ledger','null'::jsonb)->'expenses','[]');newrows:=newdoc->'ledger'->'expenses';end if;
  if pg_catalog.jsonb_array_length(newrows) is distinct from pg_catalog.jsonb_array_length(oldrows)+1
    or not customer_private.travel_contains(newrows,oldrows) then raise exception using errcode='P0403',message='create_only'; end if;
  select x into added from pg_catalog.jsonb_array_elements(newrows) x where not exists(select 1 from pg_catalog.jsonb_array_elements(oldrows) y where x=y);
  if added->>'tripId' is distinct from g.trip_id::text or added->>'status' is distinct from 'active'
    or added->>'id' is distinct from p_result->'value'->>'targetId'
    or newdoc->'audits'->-1->>'targetId' is distinct from added->>'id' then raise exception using errcode='P0422',message='target_invalid'; end if;
  if c.command->>'type'='schedule.create' then
    fields:=array['id','tripId','status','createdAt','updatedAt','updatedByMemberId','order'];
    if (added-fields) is distinct from c.command->'input' then raise exception using errcode='P0403',message='schedule_changed'; end if;
  else
    -- Amount conversion and split arithmetic remain the server domain contract; input identities are fixed here.
    if added->>'title' is distinct from c.command->'input'->>'title' or added->'itineraryId' is distinct from c.command->'input'->'itineraryId'
      or added->>'occurredLocal' is distinct from c.command->'input'->>'occurredLocal' or added->>'currency' is distinct from c.command->'input'->>'currency'
      or added->>'localDate' is distinct from pg_catalog.left(c.command->'input'->>'occurredLocal',10)
      or added->>'timeZone' is distinct from olddoc->'trip'->>'timeZone'
      or added->>'payerId' is distinct from c.command->'input'->>'payerId' or added->'splitIds' is distinct from c.command->'input'->'splitIds' then
      raise exception using errcode='P0403',message='expense_changed'; end if;
  end if;
  receipt_key:=g.actor::text||':'||(c.command->>'type')||':'||p_operation::text;
  if pg_catalog.jsonb_array_length(p_after->'receipts') is distinct from pg_catalog.jsonb_array_length(p_before->'receipts')+1
    or not customer_private.travel_contains(p_after->'receipts',p_before->'receipts') then raise exception using errcode='P0422',message='receipt_append'; end if;
  select x->1 into receipt from pg_catalog.jsonb_array_elements(p_after->'receipts') x where x->>0=receipt_key;
  if receipt is null or coalesce(receipt->>'hash','') !~ '^[0-9a-f]{64}$' or receipt->'result' is distinct from p_result
    or p_result->'replayed' is distinct from 'false'::jsonb or p_result->'tripRevision' is distinct from newdoc->'trip'->'revision' then
    raise exception using errcode='P0422',message='receipt_invalid'; end if;
  update customer_private.travel_documents set body=newdoc where trip_id=g.trip_id;
  insert into customer_private.travel_receipts(actor,receipt_key,trip_id,value) values(g.actor,receipt_key,g.trip_id,receipt);
  update customer_private.channel_confirmations set result=p_result,consumed_at=pg_catalog.clock_timestamp() where token_hash=p_hash;
  return true;
end $$;

create function customer_private.provider_usage_reserve(p_scope text,p_request text,p_limit integer,p_expires timestamptz,p_period text) returns boolean
language plpgsql security definer set search_path='' as $$
declare today date; at_time timestamptz; bucket text;
begin
  -- One reservation lock keeps count and request-id uniqueness atomic. No refund even after ambiguous network failures.
  perform pg_catalog.pg_advisory_xact_lock(708170063::bigint);at_time:=pg_catalog.clock_timestamp();today:=(at_time at time zone 'UTC')::date;
  bucket:=coalesce(p_period,pg_catalog.to_char(at_time at time zone 'UTC','YYYY-MM-DD'));
  if coalesce(pg_catalog.length(p_scope),0) not between 1 and 256 or coalesce(pg_catalog.length(p_request),0) not between 1 and 256
    or bucket !~ '^[A-Za-z0-9:_-]{1,64}$' or p_limit is null or p_limit not between 1 and 10000 or p_expires is null or p_expires<=at_time or p_expires>at_time+interval '48 hours' then
    raise exception using errcode='P0422',message='reservation_invalid'; end if;
  -- Server-derived period is explicit for trip-local days; omission uses database UTC day.
  -- Expiry and period changes never refund or permit repeating the same scope/request_id.
  if exists(select 1 from customer_private.provider_usage_reservations where scope=p_scope and request_id=p_request) then return false;end if;
  if (select count(*) from customer_private.provider_usage_reservations where scope=p_scope and period_key=bucket)>=p_limit then return false;end if;
  insert into customer_private.provider_usage_reservations(scope,request_id,usage_day,period_key,expires_at) values(p_scope,p_request,today,bucket,p_expires);
  return true;
end $$;

alter function customer_private.channel_sender(jsonb) owner to customer_writer;
alter function customer_private.channel_authorize(jsonb) owner to customer_writer;
alter function customer_private.channel_state(uuid,uuid) owner to customer_writer;
alter function customer_private.channel_web(text,jsonb) owner to customer_writer;
alter function customer_private.channel_claim(jsonb,text) owner to customer_writer;
alter function customer_private.channel_load(jsonb,text,uuid) owner to customer_writer;
alter function customer_private.channel_review(jsonb,uuid,text,uuid,jsonb,bigint) owner to customer_writer;
alter function customer_private.channel_save(jsonb,text,uuid,jsonb,jsonb,jsonb) owner to customer_writer;
alter function customer_private.provider_usage_reserve(text,text,integer,timestamptz,text) owner to customer_writer;
revoke all on function customer_private.channel_sender(jsonb),customer_private.channel_authorize(jsonb),customer_private.channel_state(uuid,uuid),
  customer_private.channel_web(text,jsonb),customer_private.channel_claim(jsonb,text),customer_private.channel_load(jsonb,text,uuid),
  customer_private.channel_review(jsonb,uuid,text,uuid,jsonb,bigint),customer_private.channel_save(jsonb,text,uuid,jsonb,jsonb,jsonb),
  customer_private.provider_usage_reserve(text,text,integer,timestamptz,text) from public,anon,authenticated,customer_app,customer_auth_runtime;
grant execute on function customer_private.channel_web(text,jsonb),customer_private.channel_claim(jsonb,text),customer_private.channel_load(jsonb,text,uuid),
  customer_private.channel_review(jsonb,uuid,text,uuid,jsonb,bigint),customer_private.channel_save(jsonb,text,uuid,jsonb,jsonb,jsonb),
  customer_private.provider_usage_reserve(text,text,integer,timestamptz,text) to customer_app;
