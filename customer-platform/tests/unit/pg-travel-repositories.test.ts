import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { IdentityError, type Actor, type TripInput } from '../../core/contracts.js';
import type { LedgerCommand } from '../../core/ledger/contracts.js';
import type { IdentityRepository } from '../../server/identity/contracts.js';
import type { LedgerRepository } from '../../server/ledger/contracts.js';
import { createPgTravelRepositories } from '../../server/db/travel-repositories.js';
type Repositories = {identityRepository: IdentityRepository; ledgerRepository: LedgerRepository; close(): void};
type Factory = (options: {pool: Pool; now?: () => number}) => Repositories;
// Synthetic SQL boundary: tests adapter transactions and real domain rules, not PostgreSQL grants, RLS, or locks.
async function factory(): Promise<Factory> { return createPgTravelRepositories; }
const owner: Actor = {userId: randomUUID(),sessionHash:'a'.repeat(64)};
const guest: Actor = {userId: randomUUID(),sessionHash:'b'.repeat(64)};
const stranger: Actor = {userId: randomUUID(),sessionHash:'c'.repeat(64)};
const input: TripInput = {name:'합성 여행',destination:'서울',startDate:'2026-11-01',endDate:'2026-11-03',
  timeZone:'Asia/Seoul',budgetKrw:10000,alias:'소유자',settlementMode:'daily',dailyTime:'20:00'};
const op = () => ({operationId:randomUUID(),hash:'d'.repeat(64)});
const proof = () => ({id:randomUUID(),kid:'v1',hash:'e'.repeat(64)});
const empty = () => ({trips:[],members:[],invites:[],receipts:[],audits:[],ledgers:[]});
const rejected = (promise: unknown, code: string) => assert.rejects(Promise.resolve(promise),
  (error: unknown) => error instanceof IdentityError && error.code === code);
function database() {
  let saved: any = empty(), tail = Promise.resolve();
  const sessions = new Map([owner,guest,stranger].map(a => [a.userId,a.sessionHash]));
  const log: string[] = [];
  let saveFailure = false, commitFailure = false, released = 0;
  let rates: {actor: string; client: string}[] = [];
  const pool = {connect: async () => {
    let unlock: (() => void) | undefined, state: any, actorId = '', sessionHash = '', pendingRates = rates;
    return {query: async (sql: string, values: any[] = []) => {
      log.push(sql);let rows: any[] = [];
      if (sql === 'begin') {
        const previous = tail; tail = new Promise<void>(resolve => { unlock = resolve; });
        await previous; state = structuredClone(saved); pendingRates = structuredClone(rates);
      } else if (sql.includes("set_config('customer.actor_id'")) actorId = values[0];
      else if (sql.includes("set_config('customer.session_hash'")) sessionHash = values[0];
      else if (sql === 'select customer_private.assert_actor()') {
        if (sessions.get(actorId) !== sessionHash) throw {code:'P0401'};
      } else if (sql.startsWith('select customer_private.travel_load(')) {
        const scope = JSON.parse(values[0]);
        const ids = scope.kind === 'create' ? state.trips.filter((t:any)=>t.ownerUserId===actorId).map((t:any)=>t.id)
          : scope.kind === 'list' ? state.members.filter((m:any)=>m.userId===actorId&&m.active).map((m:any)=>m.tripId)
          : scope.kind === 'trip' ? [scope.tripId]
          : state.invites.filter((i:any)=>i.id===scope.proof.id&&i.keyId===scope.proof.kid&&i.tokenHash===scope.proof.hash).map((i:any)=>i.tripId);
        rows = [{state:{trips:state.trips.filter((t:any)=>ids.includes(t.id)),members:state.members.filter((m:any)=>ids.includes(m.tripId)),
          invites:state.invites.filter((i:any)=>ids.includes(i.tripId)),audits:state.audits.filter((a:any)=>ids.includes(a.tripId)),
          ledgers:state.ledgers.filter((r:any)=>ids.includes(r[0])),receipts:state.receipts.filter((r:any)=>r[0].startsWith(actorId+':'))}}];
      } else if (sql.startsWith('select customer_private.travel_save(')) {
        if (saveFailure) throw new Error('synthetic save failure');
        const after = JSON.parse(values[2]); const ids = after.trips.map((t:any)=>t.id);
        state.trips = [...state.trips.filter((t:any)=>!ids.includes(t.id)),...after.trips];
        for (const field of ['members','invites','audits']) state[field] = [...state[field].filter((r:any)=>!ids.includes(r.tripId)),...after[field]];
        state.ledgers = [...state.ledgers.filter((r:any)=>!ids.includes(r[0])),...after.ledgers];
        state.receipts = [...state.receipts.filter((r:any)=>!r[0].startsWith(actorId+':')),...after.receipts];rows = [{saved:true}];
      } else if (sql.startsWith('select customer_private.travel_reserve_attempt(')) {
        const allowed = pendingRates.filter(r=>r.actor===actorId).length < 30 && pendingRates.filter(r=>r.client===values[0]).length < 60;
        if (allowed) pendingRates.push({actor:actorId,client:values[0]});rows = [{allowed}];
      } else if (sql === 'commit') {
        if (commitFailure) throw new Error('synthetic commit failure');
        saved = state; rates = pendingRates; unlock?.(); unlock = undefined;
      } else if (sql === 'rollback') { unlock?.(); unlock = undefined; }
      else throw new Error('Unexpected query: '+sql);
      return {rows,rowCount:rows.length};
    },release: () => {released++;unlock?.();}};
  }} as unknown as Pool;
  return {pool,log,sessions,failSave:()=>{saveFailure=true;},failCommit:()=>{commitFailure=true;},
    get released(){return released;},get data(){return structuredClone(saved);}};
}
async function fixture() {
  const create = await factory(), db = database();
  const connect = () => create({pool:db.pool,now:()=>Date.parse('2026-11-03T12:00:00Z')});
  const repo = connect(), identity = repo.identityRepository, ledger = repo.ledgerRepository;
  const created = await identity.create(owner,input,op()), id = created.value.trip.id;
  const ownerId = created.value.members[0]!.id;
  const get = (a=owner) => Promise.resolve(ledger.get(a,id));
  const execute = async (command: LedgerCommand,a=owner) => { const revision=(await get(a)).revision;
    return ledger.execute(a,id,()=>({command,expectedRevision:revision,operation:op()})); };
  const add = async (role: 'editor'|'viewer'='editor') => {
    const p=proof();await identity.issue(owner,id,role,(await get()).revision,op(),p);
    const joined=await identity.accept(guest,p,'동행',op());return {proof:p,member:joined.value.members.find(m=>m.userId===guest.userId)!};
  };
  return {db,repo,connect,identity,ledger,id,ownerId,get,execute,add};
}
test('재연결 뒤 여행·일정·감사 이력과 중복 요청 결과를 보존한다', async () => {
  const f=await fixture(), operation=op();
  const command: LedgerCommand={type:'schedule.create',input:{date:'2026-11-01',title:'산책',place:'서울',budgetKrw:1000,startTime:'10:00',endTime:'11:00'}};
  const first=await f.ledger.execute(owner,f.id,()=>({command,expectedRevision:1,operation}));
  f.repo.close();const next=f.connect();
  assert.equal((await next.identityRepository.get(owner,f.id)).trip.name,'합성 여행');
  const dto=await next.ledgerRepository.get(owner,f.id);
  assert.equal(dto.items.length,1);assert.equal(dto.history.length,2);assert.equal(dto.revision,2);
  const replay=await next.ledgerRepository.execute(owner,f.id,()=>({command,expectedRevision:1,operation}));
  assert.equal(replay.replayed,true);assert.equal(replay.value.targetId,first.value.targetId);
  assert.equal((await next.ledgerRepository.get(owner,f.id)).history.length,2);
  await rejected(next.ledgerRepository.execute(owner,f.id,()=>({command,expectedRevision:2,operation:{...operation,hash:'f'.repeat(64)}})),'conflict');
  await rejected(f.identity.get(owner,f.id),'unavailable');
});
test('계정 권한과 현재 멤버 상태를 재연결 및 재전송에도 확인한다', async () => {
  const f=await fixture();await rejected(f.identity.get(stranger,f.id),'not_found');
  const joined=await f.add('viewer');assert.equal((await f.get(guest)).role,'viewer');
  await rejected(f.execute({type:'fx.update',rateMilli:40000,source:'manual'},guest),'forbidden');
  await f.identity.manage(owner,f.id,joined.member.id,'viewer',false,(await f.get()).revision,op());
  const next=f.connect();await rejected(next.ledgerRepository.get(guest,f.id),'not_found');
  f.db.sessions.delete(owner.userId);await rejected(next.identityRepository.get(owner,f.id),'unauthenticated');
});
test('동일 revision 경합은 한 건만 반영하고 나머지는 롤백한다', async () => {
  const f=await fixture(), second=f.connect();
  const write=(r: LedgerRepository,rateMilli: number)=>r.execute(owner,f.id,()=>({command:{type:'fx.update',rateMilli,source:'manual'},expectedRevision:1,operation:op()}));
  const results=await Promise.allSettled([write(f.ledger,40000),write(second.ledgerRepository,41000)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
  assert.equal(failed.reason.code,'conflict');assert.equal((await f.get()).revision,2);assert.equal((await f.get()).history.length,2);
});
for(const stage of ['save','commit'] as const) test(`${stage} 실패는 원장·revision·receipt·감사 이력을 함께 롤백한다`,async()=>{
  const f=await fixture(), before=f.db.data;
  if(stage==='save') f.db.failSave();else f.db.failCommit();
  await rejected(f.execute({type:'fx.update',rateMilli:40000,source:'manual'}),'unavailable');
  assert.deepEqual(f.db.data,before);assert.equal(f.db.log.at(-1),'rollback');assert.ok(f.db.released>=2);
});
test('정산 잠금과 지급 확인을 영구 상태에서 검사하고 계산을 보존한다',async()=>{
  const f=await fixture(), joined=await f.add();
  const expense={itineraryId:null,title:'식사',occurredLocal:'2026-11-01T12:00',currency:'KRW' as const,amount:'1000',payerId:f.ownerId,splitIds:[f.ownerId,joined.member.id],refreshRate:false};
  await f.execute({type:'expense.create',input:expense});
  const payment=await f.execute({type:'payment.report',toMemberId:f.ownerId,amountKrw:500},guest);
  let dto=await f.get();const p=dto.settlement.payments[0]!;
  await f.execute({type:'payment.confirm',id:payment.value.targetId!,expectedPaymentRevision:p.revision});
  await f.execute({type:'settlement.finalize',date:null});
  dto=await f.connect().ledgerRepository.get(owner,f.id);
  assert.equal(dto.expenses[0]!.amountKrw,1000);assert.equal(dto.settlement.payments[0]!.status,'confirmed');
  assert.deepEqual(dto.settlement.final.transfers,[]);assert.equal(dto.settlement.snapshots.length,1);
  const before=f.db.data;await rejected(f.execute({type:'expense.create',input:expense}),'validation');assert.deepEqual(f.db.data,before);
  await f.execute({type:'settlement.reopen',date:null});await f.execute({type:'expense.create',input:expense});
  assert.equal((await f.get()).summary.spentKrw,2000);
});
test('초대 발급·검사·수락·재전송·폐기와 시도 제한을 저장 경로로 처리한다',async()=>{
  const f=await fixture(), p=proof();await f.identity.issue(owner,f.id,'editor',1,op(),p);
  assert.equal((await f.identity.inspect(guest,p)).state,'pending');
  const operation=op();await f.identity.accept(guest,p,'동행',operation);
  const next=f.connect();assert.equal((await next.identityRepository.accept(guest,p,'동행',operation)).replayed,true);
  assert.deepEqual(await next.identityRepository.inspect(guest,p),{state:'joined',tripId:f.id});
  assert.equal((await f.identity.invites(owner,f.id)).length,1);
  const p2=proof();await f.identity.issue(owner,f.id,'viewer',(await f.get()).revision,op(),p2);
  assert.equal((await f.identity.link(owner,f.id,p2.id)).id,p2.id);
  await f.identity.revoke(owner,f.id,p2.id,(await f.get()).revision,op());
  await rejected(next.identityRepository.inspect(stranger,p2),'invite_unavailable');
  for(let i=0;i<30;i++) await next.identityRepository.reserveAttempt(stranger,'1'.repeat(64));
  await rejected(f.identity.reserveAttempt(stranger,'1'.repeat(64)),'rate_limited');
  assert.equal((await f.identity.list(guest)).length,1);assert.equal((await f.identity.members(owner,f.id)).length,2);
  const {alias,...settings}=input;await f.identity.update(owner,f.id,{...settings,name:'수정 여행'},(await f.get()).revision,op());
  assert.equal((await next.identityRepository.get(owner,f.id)).trip.name,'수정 여행');
});
test('잘못된 Actor는 연결 전 거절하고 만료 세션은 state 로드 전에 거절한다',async()=>{
  const make=await factory(),db=database(),r=make({pool:db.pool});
  await rejected(r.identityRepository.list({...owner,sessionHash:'invalid'}),'unauthenticated');assert.equal(db.log.length,0);
  db.sessions.delete(owner.userId);await rejected(r.identityRepository.list(owner),'unauthenticated');
  assert.ok(!db.log.some(q=>q.includes('travel_load')));assert.equal(db.log.at(-1),'rollback');
});
