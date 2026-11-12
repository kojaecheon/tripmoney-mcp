import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { IdentityError, type Actor, type TripInput } from '../../core/contracts.js';
import type { LedgerCommand, ScheduleInput } from '../../core/ledger/contracts.js';
import { normalizeLedgerCommand } from '../../core/ledger/normalize.js';
import { createLedgerService } from '../../server/ledger/service.js';
import { buildIdentityRepository } from '../../server/local/identity-store.js';
import { buildLedgerRepository } from '../../server/local/ledger-store.js';
import { createTravelState } from '../../server/local/travel-state.js';

const trip: TripInput = {name:'여행',destination:'서울',alias:'소유자',startDate:'2026-11-07',
  endDate:'2026-11-09',timeZone:'Asia/Seoul',budgetKrw:100000,settlementMode:'daily',dailyTime:'20:00'};
const input: ScheduleInput = {date:trip.startDate,startTime:'10:00',endTime:'11:00',title:'카페',place:'서울',budgetKrw:1000};
const adopt = (inputs: unknown): LedgerCommand => ({type:'schedule.adopt',inputs} as unknown as LedgerCommand);
const operation = () => ({operationId:uuid(),hash:uuid()});
async function fixture(t: TestContext) {
  let revoked = false, onStamp: (() => void) | undefined;
  const shared = createTravelState({assertActor:()=>{
    if (revoked) throw new IdentityError('unauthenticated','다시 로그인해 주세요.');
  },now:()=>{ const callback=onStamp;onStamp=undefined;callback?.();return Date.parse('2026-11-07T00:00:00Z'); }});
  t.after(()=>shared.close());
  const identity = buildIdentityRepository(shared,()=>Date.parse('2026-11-07T00:00:00Z')).repository;
  const ledger = createLedgerService({repository:buildLedgerRepository(shared)});
  const owner: Actor = {userId:uuid(),sessionHash:'local'};
  const {value:{trip:{id}}} = identity.create(owner,trip,operation()) as Awaited<ReturnType<typeof identity.create>>;
  const get = () => ledger.get(owner,id);
  const run = async (command: LedgerCommand) => ledger.execute(owner,id,command,(await get()).revision,uuid());
  const add = (role:'editor'|'viewer'='editor') => {
    const actor: Actor = {userId:uuid(),sessionHash:'local'}, proof={id:uuid(),kid:'local',hash:uuid()};
    identity.issue(owner,id,role,shared.read(owner,s=>s.trips.get(id)!.revision),operation(),proof);
    const joined=identity.accept(actor,proof,role,operation()) as Awaited<ReturnType<typeof identity.accept>>;
    return {actor,memberId:joined.value.members.find(m=>m.userId===actor.userId)!.id};
  };
  return {shared,identity,ledger,owner,id,get,run,add,
    onStamp(callback:()=>void) { onStamp=callback; }, revoke(value:boolean) { revoked=value; }};
}

test('adoption creates all schedules with one revision, receipt and audit targeting the first item', async t => {
  const f=await fixture(t), before=await f.get(), counts=f.shared.counts();
  const command=adopt([{...input,title:' 카페 ',placeRef:{provider:'demo',placeId:'demo-cafe'}},
    {...input,title:'식사',budgetKrw:2000}]);
  const saved=await f.run(command), after=await f.get();
  assert.equal(after.revision,before.revision+1);
  assert.deepEqual(after.items.map(i=>[i.title,i.order,i.budgetKrw]),[['카페',0,1000],['식사',1,2000]]);
  assert.deepEqual(after.items[0]!.placeRef,{provider:'demo',placeId:'demo-cafe'});
  assert.equal(saved.value.targetId,after.items[0]!.id);
  assert.equal(after.summary.allocatedKrw,3000);
  assert.equal(f.shared.counts().receipts,counts.receipts+1);
  assert.equal(f.shared.counts().audits,counts.audits+1);
  assert.deepEqual(after.history[0],{memberId:after.members[0]!.id,action:'schedule.adopt',
    targetId:after.items[0]!.id,at:'2026-11-07T00:00:00.000Z',revision:2});
});

test('invalid later candidates roll back the whole adoption and allow correction with the same operation', async t => {
  const f=await fixture(t);
  for (const patch of [{title:''},{date:'2026-11-10'},{startTime:'12:00',endTime:'11:00'},
      {budgetKrw:-1},{budgetKrw:Number.MAX_SAFE_INTEGER+1},{placeRef:{provider:'other',placeId:'x'}}]) {
    const before=await f.get(), counts=f.shared.counts(), op=uuid();
    await assert.rejects(f.ledger.execute(f.owner,f.id,adopt([input,{...input,...patch}]),before.revision,op),{code:'validation'});
    assert.deepEqual(await f.get(),before);
    assert.deepEqual(f.shared.counts(),counts);
    assert.equal((await f.ledger.execute(f.owner,f.id,adopt([input]),before.revision,op)).replayed,false);
  }
});

test('adoption rejects aggregate unsafe budgets without retaining schedules or receipts', async t => {
  const f=await fixture(t), before=await f.get(), counts=f.shared.counts();
  await assert.rejects(f.run(adopt([{...input,budgetKrw:Number.MAX_SAFE_INTEGER},input])),{code:'validation',field:'budgetKrw'});
  assert.deepEqual(await f.get(),before);assert.deepEqual(f.shared.counts(),counts);
});

test('adoption accepts 1 to 60 dense data entries and rejects malformed arrays without reading accessors', () => {
  assert.deepEqual(normalizeLedgerCommand(adopt([input])),{type:'schedule.adopt',inputs:[input]});
  assert.equal((normalizeLedgerCommand(adopt(Array.from({length:60},()=>input))) as {inputs:ScheduleInput[]}).inputs.length,60);
  let accessed=false;
  const accessor=[input];Object.defineProperty(accessor,'0',{enumerable:true,get(){accessed=true;return input;}});
  for (const inputs of [[],Array.from({length:61},()=>input),new Array(1),{0:input,length:1},
      Object.assign([input],{extra:true}),accessor]) {
    assert.throws(()=>normalizeLedgerCommand(adopt(inputs)),{code:'validation',field:'inputs'});
  }
  assert.equal(accessed,false);
  assert.throws(()=>normalizeLedgerCommand({...adopt([input]),extra:true}),{code:'validation',field:'command'});
});

test('the retained 60 schedule limit rejects the whole batch including after cancellations', async t => {
  const f=await fixture(t);
  await f.run(adopt(Array.from({length:59},()=>input)));
  const before=await f.get(), counts=f.shared.counts();
  await assert.rejects(f.run(adopt([input,input])),{code:'conflict'});
  assert.deepEqual(await f.get(),before);assert.deepEqual(f.shared.counts(),counts);
  await f.run({type:'schedule.cancel',id:before.items[0]!.id});
  await f.run(adopt([input]));
  assert.equal((await f.get()).items.length,60);
  const full=await f.get();await assert.rejects(f.run(adopt([input])),{code:'conflict'});
  assert.deepEqual(await f.get(),full);
});

test('same revision concurrent adoptions save only one complete batch', async t => {
  const f=await fixture(t), before=await f.get(), counts=f.shared.counts();
  const results=await Promise.allSettled([f.ledger.execute(f.owner,f.id,adopt([input,input]),before.revision,uuid()),
    f.ledger.execute(f.owner,f.id,adopt([{...input,title:'경합'}]),before.revision,uuid())]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'conflict');
  const after=await f.get();assert.equal(after.items.length,2);assert.equal(after.revision,before.revision+1);
  assert.equal(f.shared.counts().receipts,counts.receipts+1);assert.equal(f.shared.counts().audits,counts.audits+1);
});

test('canonical replays do not duplicate schedules and changed payloads or revisions conflict', async t => {
  const f=await fixture(t), op=uuid(), revision=(await f.get()).revision;
  const command=adopt([input,{...input,title:'식사'}]);
  const saved=await f.ledger.execute(f.owner,f.id,command,revision,op), before=await f.get(), counts=f.shared.counts();
  assert.deepEqual(await f.ledger.execute(f.owner,f.id,adopt([{...input,title:' 카페 '},{...input,title:'식사'}]),revision,op.toUpperCase()),
    {...saved,replayed:true});
  await assert.rejects(f.ledger.execute(f.owner,f.id,adopt([input]),revision,op),{code:'conflict'});
  await assert.rejects(f.ledger.execute(f.owner,f.id,command,revision+1,op),{code:'conflict'});
  assert.deepEqual(await f.get(),before);assert.deepEqual(f.shared.counts(),counts);
});

test('viewers and removed editors cannot adopt or replay a saved adoption', async t => {
  const f=await fixture(t), viewer=f.add('viewer'), editor=f.add(), command=adopt([input,input]), op=uuid();
  let revision=(await f.get()).revision;
  await assert.rejects(f.ledger.execute(viewer.actor,f.id,command,revision,uuid()),{code:'forbidden'});
  await f.ledger.execute(editor.actor,f.id,command,revision,op);
  f.identity.manage(f.owner,f.id,editor.memberId,'editor',false,(await f.get()).revision,operation());
  const before=await f.get(), counts=f.shared.counts();
  await assert.rejects(f.ledger.execute(editor.actor,f.id,command,revision,op),{code:'not_found'});
  assert.deepEqual(await f.get(),before);assert.deepEqual(f.shared.counts(),counts);
});

test('final actor revocation discards every adopted item, audit, receipt and revision', async t => {
  const f=await fixture(t), before=await f.get(), counts=f.shared.counts(), op=uuid(), command=adopt([input,input]);
  f.onStamp(()=>f.revoke(true));
  await assert.rejects(f.ledger.execute(f.owner,f.id,command,before.revision,op),{code:'unauthenticated'});
  f.revoke(false);
  assert.deepEqual(await f.get(),before);assert.deepEqual(f.shared.counts(),counts);
  assert.equal((await f.ledger.execute(f.owner,f.id,command,before.revision,op)).replayed,false);
  assert.equal((await f.get()).items.length,2);
});
