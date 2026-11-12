import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createLocalRuntime } from '../../server/local/runtime.js';
import { IdentityError, type Actor, type TripInput } from '../../core/contracts.js';
import type { LedgerCommand, ExpenseInput, ScheduleInput } from '../../core/ledger/contracts.js';

const trip: TripInput = { name:'여행', destination:'서울', alias:'소유자', startDate:'2026-11-03',
  endDate:'2026-11-05', timeZone:'Asia/Seoul', budgetKrw:100000, settlementMode:'end_of_trip', dailyTime:'20:00' };
const schedule: ScheduleInput = { date:trip.startDate, startTime:'10:00', endTime:'11:00', title:'점심', place:'식당', budgetKrw:60000 };
const client = '5'.repeat(64);
const rejected = (p:Promise<unknown>, code:string) => assert.rejects(p, {code});
async function fixture(t: TestContext) {
  const r = createLocalRuntime();
  t.after(() => r.close());
  const login = async (name:string) => {
    const challenge = await r.authService.requestCode(name+'@example.invalid',client);
    const result = await r.authService.verifyCode(challenge.challengeToken,'123456');
    return (await r.authService.authenticate(result.sessionToken)).actor;
  };
  const owner = await login('owner');
  const {value:{trip:{id},ownerMember}} = await r.identityService.createTrip(owner,trip,uuid());
  assert.ok(r.ledgerService, 'shared ledger service must be present');
  const get = (actor = owner) => r.ledgerService.get(actor,id);
  const run = async (cmd:LedgerCommand, actor = owner) => r.ledgerService.execute(actor,id,cmd,(await get(actor)).revision,uuid());
  const add = async (name:string) => {
    const actor = await login(name);
    const invitation = await r.identityService.issueInvite(owner,id,'editor',(await get()).revision,uuid());
    const token = new URLSearchParams(new URL(invitation.value.url).hash.slice(1)).get('t')!;
    const joined = await r.identityService.acceptInvite(actor,token,name,uuid(),client);
    return {actor,memberId:joined.value.member.id};
  };
  const expense: ExpenseInput = {itineraryId:null,title:'공통',occurredLocal:'2026-11-03T10:30',currency:'KRW',
    amount:'10000',payerId:ownerMember.id,splitIds:[ownerMember.id],refreshRate:false};
  const {alias, ...settings} = trip;
  return {r,id,owner,get,run,add,login,expense,settings,ownerId:ownerMember.id};
}

test('linked and common costs survive moving and cancelling their schedule', async t => {
  const f = await fixture(t);
  const item = (await f.run({type:'schedule.create',input:schedule})).value.targetId!;
  assert.equal((await f.get()).items[0]?.id,item);
  const linked = {...f.expense,itineraryId:item,amount:'45000'};
  const expenseId = (await f.run({type:'expense.create',input:linked})).value.targetId!;
  const common = (await f.run({type:'expense.create',input:f.expense})).value.targetId!;
  await f.run({type:'schedule.update',id:item,input:{...schedule,date:'2026-11-04'}});
  const {summary} = await f.get();
  assert.equal(summary.allocatedKrw,60000);
  assert.equal(summary.spentKrw,55000);
  assert.equal(summary.remainingKrw,45000);
  assert.equal(summary.unassignedKrw,10000);
  assert.deepEqual(summary.byItem,[{itineraryId:item,budgetKrw:60000,spentKrw:45000,remainingKrw:15000}]);
  assert.deepEqual(summary.byDate,[{date:'2026-11-03',spentKrw:55000}]);
  await f.run({type:'schedule.cancel',id:item});
  assert.equal((await f.get()).summary.spentKrw,55000);
  assert.equal((await f.get()).summary.allocatedKrw,0);
  await rejected(f.run({type:'expense.create',input:linked}),'validation');
  await f.run({type:'expense.update',id:expenseId,input:linked});
  await f.run({type:'expense.cancel',id:common});
  assert.equal((await f.get()).summary.unassignedKrw,0);
});

test('active-day order is dense after reorder, move and cancel; foreign permutations roll back', async t => {
  const f = await fixture(t);
  const ids:string[] = [];
  for (let i=0;i<3;i++) ids.push((await f.run({type:'schedule.create',input:schedule})).value.targetId!);
  const before = await f.get();
  for (const invalid of [[ids[0]!], [ids[0]!,ids[0]!,ids[1]!], [ids[0]!,ids[1]!,uuid()]]) {
    await rejected(f.run({type:'schedule.reorder',date:schedule.date,ids:invalid}),'validation');
  }
  assert.deepEqual(await f.get(),before);
  await f.run({type:'schedule.reorder',date:schedule.date,ids:[...ids].reverse()});
  await f.run({type:'schedule.update',id:ids[1]!,input:{...schedule,date:'2026-11-04'}});
  const current = await f.get();
  assert.deepEqual(current.items.filter(i=>i.date===schedule.date).map(i=>[i.id,i.order]),[[ids[2],0],[ids[0],1]]);
  await f.run({type:'schedule.cancel',id:ids[2]!});
  assert.equal((await f.get()).items.find(i=>i.id===ids[0])?.order,0);
});

test('FX snapshots use explicit refresh or currency switch, and historical members retain balances', async t => {
  const f = await fixture(t), b = await f.add('editor');
  const input: ExpenseInput = {...f.expense,currency:'THB',amount:'0.05',payerId:b.memberId,splitIds:[b.memberId,f.ownerId]};
  const id = (await f.run({type:'expense.create',input},b.actor)).value.targetId!;
  await rejected(f.run({type:'fx.update',source:'manual',rateMilli:100000},b.actor),'forbidden');
  await f.run({type:'fx.update',source:'manual',rateMilli:100000});
  assert.equal((await f.get()).expenses[0]!.amountKrw,2);
  await f.run({type:'expense.update',id,input});
  assert.equal((await f.get()).expenses[0]!.rateSource,'demo');
  await f.run({type:'expense.update',id,input:{...input,refreshRate:true}});
  assert.equal((await f.get()).expenses[0]!.amountKrw,5);
  await f.r.identityService.manageMember(f.owner,f.id,b.memberId,'editor',false,(await f.get()).revision,uuid());
  await rejected(f.run({type:'expense.create',input}),'validation');
  await f.run({type:'expense.update',id,input:{...input,currency:'KRW',amount:'9'}});
  const ledger = await f.get(), logged = ledger.expenses[0]!;
  assert.equal(logged.rateSource,'unit');
  assert.equal(logged.amountKrw,9);
  assert.deepEqual(logged.shares.map(s=>s.amountKrw),[5,4]);
  assert.equal(ledger.summary.byMember.find(m=>m.memberId===b.memberId)?.paidKrw,9);
  assert.equal(ledger.summary.byMember.reduce((n,m)=>n+m.netKrw,0),0);
  assert.doesNotMatch(JSON.stringify(ledger),/userId|sessionHash|ownerUserId|operationId|tokenHash|email/);
});

test('shared revisions, canonical receipts and current role gate conflicting and repeated commands', async t => {
  const f = await fixture(t), b = await f.add('editor');
  const version = (await f.get()).revision, op = uuid();
  const command = {type:'schedule.create',input:schedule} as const;
  const execute = (v:number,cmd:LedgerCommand=command) => f.r.ledgerService.execute(b.actor,f.id,cmd,v,op);
  const [created, raced] = await Promise.allSettled([execute(version),
    f.r.identityService.updateTrip(f.owner,f.id,f.settings,version,uuid())]);
  assert.equal(created.status,'fulfilled');
  assert.equal(raced.status,'rejected');
  const saved = await f.r.ledgerService.execute(b.actor,f.id,{...command,input:{...schedule,title:' 점심 '}},version,op.toUpperCase());
  assert.equal(saved.replayed,true);
  assert.deepEqual(Object.keys(saved.value),['targetId']);
  await rejected(execute(version+1),'conflict');
  const other = (await f.r.identityService.createTrip(f.owner,trip,uuid())).value.trip.id;
  await rejected(f.r.ledgerService.execute(f.owner,other,{type:'expense.create',input:f.expense},1,uuid()),'validation');
  await rejected(f.r.ledgerService.execute(f.owner,other,{type:'expense.create',input:{...f.expense,itineraryId:saved.value.targetId}},1,uuid()),'validation');
  await f.r.identityService.manageMember(f.owner,f.id,b.memberId,'viewer',true,(await f.get()).revision,uuid());
  await rejected(execute(version),'forbidden');
  await f.get(b.actor);
  await f.r.identityService.manageMember(f.owner,f.id,b.memberId,'viewer',false,(await f.get()).revision,uuid());
  await rejected(execute(version),'not_found');
});

test('travel edits respect active dates and lock time zone after even cancelled expenses', async t => {
  const f = await fixture(t);
  const item = (await f.run({type:'schedule.create',input:schedule})).value.targetId!;
  const update = async (patch: Partial<typeof f.settings>) => f.r.identityService.updateTrip(f.owner,f.id,
    {...f.settings,...patch},(await f.get()).revision,uuid());
  await rejected(update({startDate:'2026-11-04'}),'validation');
  await f.run({type:'schedule.cancel',id:item});
  const expense = (await f.run({type:'expense.create',input:f.expense})).value.targetId!;
  await rejected(update({startDate:'2026-11-04'}),'validation');
  await f.run({type:'expense.cancel',id:expense});
  await update({startDate:'2026-11-04'});
  await rejected(update({timeZone:'America/New_York'}),'validation');
});

test('retained limits include cancelled rows; overflow rejects the entire command', async t => {
  const f = await fixture(t);
  const id = (await f.run({type:'schedule.create',input:{...schedule,budgetKrw:Number.MAX_SAFE_INTEGER}})).value.targetId!;
  const before = await f.get();
  await rejected(f.run({type:'schedule.create',input:schedule}),'validation');
  assert.deepEqual(await f.get(),before);
  await f.run({type:'schedule.cancel',id});
  for (let i=1;i<60;i++) await f.run({type:'schedule.create',input:schedule});
  await rejected(f.run({type:'schedule.create',input:schedule}),'conflict');
  const expense = (await f.run({type:'expense.create',input:f.expense})).value.targetId!;
  await f.run({type:'expense.cancel',id:expense});
  for (let i=1;i<80;i++) await f.run({type:'expense.create',input:f.expense});
  await rejected(f.run({type:'expense.create',input:f.expense}),'conflict');
  const current = await f.get();
  assert.equal(current.items.length,60);
  assert.equal(current.expenses.length,80);
  assert.equal(current.history.length,30);
  assert.equal(current.history[0]?.revision,current.revision);
});

test('revocation detected at the final check discards expense, shares, audit and receipt', async t => {
  const {createLocalTravelRepositories} = await import('../../server/local/identity-store.js');
  assert.equal(typeof createLocalTravelRepositories,'function');
  const {createLedgerService} = await import('../../server/ledger/service.js');
  const {createIdentityService} = await import('../../server/identity/service.js');
  let armed=false, revoke=false;
  const repos = createLocalTravelRepositories({now:()=>{ if (armed) revoke=true; return 1700000000000; },
    assertActor:()=>{ if(revoke) throw new IdentityError('unauthenticated','다시 로그인해 주세요.'); }});
  t.after(()=>repos.close());
  const identity = createIdentityService({repository:repos.identityRepository,activeKid:'local',inviteKeys:{local:Buffer.alloc(32)},publicOrigin:'http://127.0.0.1:8125'});
  const ledger = createLedgerService({repository:repos.ledgerRepository});
  const actor:Actor = {userId:uuid(),sessionHash:'local'};
  const {value:{trip:{id},ownerMember}} = await identity.createTrip(actor,trip,uuid());
  const before=await ledger.get(actor,id), op=uuid();
  const cmd:LedgerCommand = {type:'expense.create',input:{itineraryId:null,title:'공통',occurredLocal:'2026-11-03T10:30',
    currency:'KRW',amount:'5',payerId:ownerMember.id,splitIds:[ownerMember.id],refreshRate:false}};
  armed=true;
  await rejected(ledger.execute(actor,id,cmd,1,op),'unauthenticated');
  armed=false; revoke=false;
  assert.deepEqual(await ledger.get(actor,id),before);
  assert.equal((await ledger.execute(actor,id,cmd,1,op)).replayed,false);
  repos.close();
  await rejected(ledger.get(actor,id),'unavailable');
});

test('a stale outer write cannot overwrite a successful nested write', async t => {
  const {createLocalTravelRepositories} = await import('../../server/local/identity-store.js');
  const {createLedgerService} = await import('../../server/ledger/service.js');
  const {createIdentityService} = await import('../../server/identity/service.js');
  let duringWrite: (() => void) | undefined;
  const repos = createLocalTravelRepositories({assertActor:()=>{},now:()=>{
    const callback = duringWrite;
    duringWrite = undefined;
    callback?.();
    return 1700000000000;
  }});
  t.after(()=>repos.close());
  const identity = createIdentityService({repository:repos.identityRepository,activeKid:'local',inviteKeys:{local:Buffer.alloc(32)},publicOrigin:'http://127.0.0.1:8125'});
  const ledger = createLedgerService({repository:repos.ledgerRepository});
  const actor:Actor = {userId:uuid(),sessionHash:'local'};
  const {value:{trip:{id}}} = await identity.createTrip(actor,trip,uuid());
  const before = await ledger.get(actor,id);
  const innerCommand = {type:'schedule.create',input:schedule} as const;
  const outerCommand: LedgerCommand = {type:'schedule.reorder',date:schedule.date,ids:[]};
  const innerOp = uuid(), outerOp = uuid();
  let inner: ReturnType<typeof ledger.execute> | undefined;
  duringWrite = () => { inner = ledger.execute(actor,id,innerCommand,before.revision,innerOp); };

  const [outer] = await Promise.allSettled([
    ledger.execute(actor,id,outerCommand,before.revision,outerOp)
  ]);
  assert.ok(inner);
  const saved = await inner;
  const after = await ledger.get(actor,id);
  assert.equal(after.revision,before.revision+1);
  assert.deepEqual(after.items.map(item=>item.id),[saved.value.targetId]);
  assert.deepEqual(after.history.map(entry=>[entry.action,entry.targetId]),[
    ['schedule.create',saved.value.targetId], ...before.history.map(entry=>[entry.action,entry.targetId])
  ]);
  assert.equal(outer.status,'rejected');
  assert.ok(outer.reason instanceof IdentityError);
  assert.equal(outer.reason.code,'conflict');
  const replay = await ledger.execute(actor,id,innerCommand,before.revision,innerOp);
  assert.deepEqual(replay,{...saved,replayed:true});
  await rejected(ledger.execute(actor,id,outerCommand,before.revision,outerOp),'conflict');
});

test('other trips cannot reuse the same receipt or introduce a foreign itinerary, payer or split member', async t => {
  const f = await fixture(t);
  const other = (await f.r.identityService.createTrip(f.owner,trip,uuid())).value;
  const op = uuid(), cmd = {type:'schedule.create',input:schedule} as const;
  const primary = await f.r.ledgerService.execute(f.owner,f.id,cmd,1,op);
  const executeOther = (command: LedgerCommand, operation: string = uuid()) =>
    f.r.ledgerService.execute(f.owner,other.trip.id,command,1,operation);
  await rejected(executeOther(cmd,op),'conflict');
  const local = {...f.expense,payerId:other.ownerMember.id,splitIds:[other.ownerMember.id]};
  for (const input of [{...local,itineraryId:primary.value.targetId},{...local,payerId:f.ownerId},
      {...local,splitIds:[other.ownerMember.id,f.ownerId]}]) {
    await rejected(executeOther({type:'expense.create',input}),'validation');
  }
  const current = await f.r.ledgerService.get(f.owner,other.trip.id);
  assert.equal(current.revision,1);
  assert.equal(current.items.length+current.expenses.length,0);
});

test('invalid expense edits preserve historical shares and do not create receipts', async t => {
  const f = await fixture(t), b = await f.add('editor');
  const id = (await f.run({type:'expense.create',input:f.expense})).value.targetId!;
  await f.r.identityService.manageMember(f.owner,f.id,b.memberId,'editor',false,(await f.get()).revision,uuid());
  const before = await f.get();
  for (const patch of [{splitIds:[b.memberId]}, {payerId:b.memberId}, {splitIds:[f.ownerId,f.ownerId]},
      {occurredLocal:'2026-11-06T00:00'}, {amount:'1.20'}, {amount:'0.01',currency:'THB' as const}]) {
    const op = uuid();
    await rejected(f.r.ledgerService.execute(f.owner,f.id,{type:'expense.update',id,input:{...f.expense,...patch}},
      before.revision,op),'validation');
  }
  assert.deepEqual(await f.get(),before);
});
