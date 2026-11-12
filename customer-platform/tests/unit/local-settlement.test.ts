import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type { TripInput } from '../../core/contracts.js';
import type { ExpenseInput, LedgerCommand } from '../../core/ledger/contracts.js';
import { createLocalRuntime } from '../../server/local/runtime.js';

const day = '2026-11-01';
const nextDay = '2026-11-02';
const lastDay = '2026-11-03';
const client = '5'.repeat(64);

async function fixture(t: TestContext, initialTime = '2026-11-02T00:59:00Z') {
  let now = Date.parse(initialTime);
  const setClock = (instant: string) => { now = Date.parse(instant); };
  const runtime = createLocalRuntime({now: () => now});
  t.after(() => runtime.close());
  const {authService, identityService, ledgerService} = runtime;
  async function login(name: string) {
    const {challengeToken} = await authService.requestCode(name+'@example.invalid',client);
    const {sessionToken} = await authService.verifyCode(challengeToken,'123456');
    return (await authService.authenticate(sessionToken)).actor;
  }
  const owner = await login('owner');
  const trip: TripInput = {name:'여행',destination:'뉴욕',alias:'소유자',startDate:day,endDate:lastDay,
    timeZone:'America/New_York',budgetKrw:10000,settlementMode:'daily',dailyTime:'20:00'};
  const {value:{trip:{id},ownerMember:{id:ownerId}}} = await identityService.createTrip(owner,trip,randomUUID());
  const get = (actor = owner) => ledgerService.get(actor,id);
  const run = async (cmd: LedgerCommand, actor = owner) =>
    ledgerService.execute(actor,id,cmd,(await get(actor)).revision,randomUUID());
  async function changePayment(type: 'payment.confirm'|'payment.requestVoid'|'payment.confirmVoid', paymentId: string,
                               actor = owner) {
    const ledger = await get(actor), payment = ledger.settlement.payments.find(p => p.id === paymentId);
    assert.ok(payment);
    return ledgerService.execute(actor,id,{type,id:paymentId,expectedPaymentRevision:payment.revision},
      ledger.revision,randomUUID());
  }
  async function add(name: string, role: 'editor'|'viewer' = 'editor') {
    const actor = await login(name);
    const invitation = await identityService.issueInvite(owner,id,role,(await get()).revision,randomUUID());
    const token = new URLSearchParams(new URL(invitation.value.url).hash.slice(1)).get('t')!;
    const {value:{member:{id:memberId}}} = await identityService.acceptInvite(actor,token,name,randomUUID(),client);
    return {actor,memberId};
  }
  const expense: ExpenseInput = {itineraryId:null,title:'공통',occurredLocal:day+'T01:59',currency:'KRW',
    amount:'1001',payerId:ownerId,splitIds:[ownerId],refreshRate:false};
  const {alias,...settings} = trip;
  const update = async (patch: Partial<typeof settings>) =>
    identityService.updateTrip(owner,id,{...settings,...patch},(await get()).revision,randomUUID());
  return {identityService,ledgerService,id,owner,ownerId,get,run,changePayment,add,expense,update,setClock};
}

test('daily settlement separates local day spend from cumulative expense shares', async t => {
  const f = await fixture(t), editor = await f.add('editor');
  const input = {...f.expense,splitIds:[editor.memberId,f.ownerId]};
  await f.run({type:'expense.create',input});
  await f.run({type:'expense.create',input:{...input,occurredLocal:nextDay+'T00:00',amount:'201'}});
  const cancelled = (await f.run({type:'expense.create',input:{...input,amount:'20'}})).value.targetId!;
  await f.run({type:'expense.cancel',id:cancelled});
  await f.identityService.manageMember(f.owner,f.id,editor.memberId,'editor',false,(await f.get()).revision,randomUUID());

  const {settlement,expenses} = await f.get();
  assert.equal(expenses[0]?.occurredAt,'2026-11-01T05:59:00.000Z');
  assert.equal(expenses[1]?.occurredAt,'2026-11-02T05:00:00.000Z');
  assert.equal(settlement.today,day);
  assert.equal(settlement.due,false);
  assert.deepEqual(settlement.days.map(({date,spentKrw,current})=>[date,spentKrw,current.spentKrw]),[
    [day,1001,1001],[nextDay,201,1202],[lastDay,0,1202]
  ]);
  const editorShare = editor.memberId < f.ownerId ? 501 : 500;
  assert.deepEqual(settlement.days[0]?.current.transfers,[
    {fromMemberId:editor.memberId,toMemberId:f.ownerId,amountKrw:editorShare}
  ]);
  assert.equal(settlement.final.balances.find(m=>m.memberId === editor.memberId)?.netKrw,-(2*editorShare-400));
  assert.equal(settlement.final.balances.reduce((sum,m)=>sum+m.netKrw,0),0);
  f.setClock('2026-11-02T01:00:00Z');
  assert.equal((await f.get()).settlement.due,true);
  f.setClock('2026-11-02T05:00:00Z');
  assert.equal((await f.get()).settlement.today,nextDay);
  assert.equal((await f.get()).settlement.due,false);
});

test('daily notice stays due after the first cutoff in a repeated local hour', async t => {
  const f = await fixture(t,'2026-11-01T05:29:00Z');
  await f.update({dailyTime:'01:30'});
  assert.equal((await f.get()).settlement.due,false);
  f.setClock('2026-11-01T05:30:00Z');
  assert.equal((await f.get()).settlement.due,true);
  f.setClock('2026-11-01T06:00:00Z');
  assert.equal((await f.get()).settlement.due,true);
});

test('daily notice starts at the first available minute after a spring clock gap', async t => {
  const f = await fixture(t,'2026-03-08T06:59:00Z');
  await f.update({dailyTime:'02:30',startDate:'2026-03-08',endDate:'2026-03-08'});
  assert.equal((await f.get()).settlement.due,false);
  f.setClock('2026-03-08T07:00:00Z');
  assert.equal((await f.get()).settlement.due,true);
});

test('only an owner finalizes current or past daily dates, retaining prior versions through reopen', async t => {
  const f = await fixture(t), editor = await f.add('editor');
  const cmd = {type:'settlement.finalize',date:day} as const;
  await assert.rejects(f.run(cmd,editor.actor),{code:'forbidden'});
  await assert.rejects(f.run({...cmd,date:nextDay}),{code:'validation',field:'date'});
  await assert.rejects(f.run({...cmd,date:'2026-10-31'}),{code:'validation',field:'date'});
  const initialRevision = (await f.get()).revision, operationId = randomUUID();
  const result = await f.ledgerService.execute(f.owner,f.id,cmd,initialRevision,operationId);
  const saved = (await f.get()).settlement.snapshots[0]!;
  assert.equal(saved.id,result.value.targetId);
  assert.equal(saved.sourceRevision,initialRevision);
  assert.equal(saved.createdByMemberId,f.ownerId);
  assert.equal(saved.reopenedAt,null);
  await assert.rejects(f.run(cmd),{code:'conflict'});
  const replayed = await f.ledgerService.execute(f.owner,f.id,cmd,initialRevision,operationId);
  assert.deepEqual(replayed,{...result,replayed:true});
  await assert.rejects(f.update({startDate:nextDay}),{code:'validation',field:'startDate'});
  await assert.rejects(f.update({settlementMode:'end_of_trip'}),{code:'validation',field:'settlementMode'});
  await assert.rejects(f.update({timeZone:'Asia/Seoul'}),{code:'validation',field:'timeZone'});

  await f.run({type:'settlement.reopen',date:day});
  await f.run({type:'expense.create',input:f.expense});
  await f.run(cmd);
  const [previous,current] = (await f.get()).settlement.snapshots;
  assert.deepEqual(previous,{...saved,reopenedAt:'2026-11-02T00:59:00.000Z',reopenedByMemberId:f.ownerId});
  assert.equal(current?.result.spentKrw,1001);
  assert.equal(current?.reopenedAt,null);
  assert.notEqual(current?.id,saved.id);
});

test('expense creates, edits, moves and cancels enforce daily and final locks independently', async t => {
  const f = await fixture(t);
  const first = (await f.run({type:'expense.create',input:f.expense})).value.targetId!;
  const nextExpense = {...f.expense,occurredLocal:nextDay+'T00:00'};
  await f.run({type:'settlement.finalize',date:day});
  const second = (await f.run({type:'expense.create',input:nextExpense})).value.targetId!;
  const before = await f.get();
  const locked = {code:'validation',field:'settlementLocked'};
  for (const cmd of [
    {type:'expense.create',input:f.expense},
    {type:'expense.update',id:first,input:nextExpense},
    {type:'expense.update',id:second,input:f.expense},
    {type:'expense.cancel',id:first},
  ] satisfies LedgerCommand[]) await assert.rejects(f.run(cmd),locked);
  assert.deepEqual(await f.get(),before);

  await f.run({type:'settlement.finalize',date:null});
  await assert.rejects(f.run({type:'expense.cancel',id:second}),locked);
  await assert.rejects(f.run({type:'settlement.reopen',date:day}),{code:'conflict'});
  f.setClock('2026-11-02T05:00:00Z');
  await assert.rejects(f.run({type:'settlement.finalize',date:nextDay}),{code:'conflict'});
  await assert.rejects(f.update({endDate:nextDay}),{code:'validation',field:'endDate'});
  await f.run({type:'settlement.reopen',date:null});
  await assert.rejects(f.run({type:'expense.cancel',id:first}),locked);
  await f.run({type:'expense.cancel',id:second});
  await f.run({type:'settlement.reopen',date:day});
  await f.update({settlementMode:'end_of_trip'});
  await assert.rejects(f.run({type:'settlement.finalize',date:day}),{code:'conflict'});
  await f.run({type:'settlement.finalize',date:null});
  assert.equal((await f.get()).settlement.snapshots.at(-1)?.result.spentKrw,1001);
});

test('only confirmed partial payments count on their local confirmation date and snapshots retain earlier balances', async t => {
  const f = await fixture(t), editor = await f.add('editor');
  await f.run({type:'expense.create',input:{...f.expense,amount:'1000',splitIds:[f.ownerId,editor.memberId]}});
  await f.run({type:'settlement.finalize',date:day});
  await f.run({type:'settlement.finalize',date:null});
  const saved = (await f.get()).settlement.snapshots;
  const cmd = {type:'payment.report',toMemberId:f.ownerId,amountKrw:200} as const;
  const revision = (await f.get()).revision, operationId = randomUUID();
  const report = await f.ledgerService.execute(editor.actor,f.id,cmd,revision,operationId);
  assert.deepEqual(await f.ledgerService.execute(editor.actor,f.id,cmd,revision,operationId),{...report,replayed:true});
  const id = report.value.targetId!;
  const transfer = (n: number) => [{fromMemberId:editor.memberId,toMemberId:f.ownerId,amountKrw:n}];
  assert.deepEqual((await f.get()).settlement.final.transfers,transfer(500));
  await assert.rejects(f.changePayment('payment.confirm',id,editor.actor),{code:'forbidden'});
  await assert.rejects(f.ledgerService.execute(f.owner,f.id,{type:'payment.confirm',id,expectedPaymentRevision:report.tripRevision},
    revision,randomUUID()),{code:'conflict'});
  f.setClock('2026-11-02T05:00:00Z');
  await f.changePayment('payment.confirm',id);
  await assert.rejects(f.changePayment('payment.confirm',id),{code:'conflict'});
  const confirmed = (await f.get()).settlement;
  assert.equal(confirmed.payments[0]?.confirmedDate,nextDay);
  assert.deepEqual(confirmed.days[0]?.current.transfers,transfer(500));
  assert.deepEqual(confirmed.days[1]?.current.transfers,transfer(300));
  assert.deepEqual(confirmed.final.transfers,transfer(300));
  assert.deepEqual(confirmed.snapshots,saved);
  assert.equal(confirmed.final.balances.find(b=>b.memberId === editor.memberId)?.owedKrw,500);

  const other = (await f.run({...cmd,amountKrw:300},editor.actor)).value.targetId!;
  assert.notEqual(other,id);
  await f.changePayment('payment.confirm',other);
  assert.deepEqual((await f.get()).settlement.final.transfers,[]);
  await f.changePayment('payment.requestVoid',id);
  assert.deepEqual((await f.get()).settlement.final.transfers,[]);
  await assert.rejects(f.changePayment('payment.confirmVoid',id),{code:'forbidden'});
  await f.changePayment('payment.confirmVoid',id,editor.actor);
  const voided = (await f.get()).settlement;
  assert.equal(voided.payments[0]?.status,'voided');
  assert.equal(voided.payments[0]?.voidedByMemberId,editor.memberId);
  assert.deepEqual(voided.final.transfers,transfer(200));
  assert.deepEqual(voided.snapshots,saved);
});

test('payment commands reject viewers, other members and invalid amounts and retain withdrawals', async t => {
  const f = await fixture(t), editor = await f.add('editor'), viewer = await f.add('viewer','viewer');
  const third = await f.add('third');
  const report = {type:'payment.report',toMemberId:f.ownerId,amountKrw:100} as const;
  await assert.rejects(f.run(report,viewer.actor),{code:'forbidden'});
  for (const toMemberId of [viewer.memberId,editor.memberId,randomUUID()]) {
    await assert.rejects(f.run({...report,toMemberId},editor.actor),{code:'validation',field:'toMemberId'});
  }
  for (const amountKrw of [0,-1,1.5,1_000_000_000_001,Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(f.run({...report,amountKrw},editor.actor),{code:'validation',field:'amountKrw'});
  }
  const id = (await f.run(report,editor.actor)).value.targetId!;
  assert.equal((await f.get(viewer.actor)).settlement.payments[0]?.status,'reported');
  await assert.rejects(f.changePayment('payment.confirm',id,third.actor),{code:'forbidden'});
  await assert.rejects(f.changePayment('payment.requestVoid',id),{code:'forbidden'});
  await f.changePayment('payment.requestVoid',id,editor.actor);
  const row = (await f.get()).settlement.payments[0]!;
  assert.equal(row.status,'voided');
  assert.equal(row.confirmedAt,null);
  assert.equal(row.voidedByMemberId,editor.memberId);
  await assert.rejects(f.changePayment('payment.confirm',id),{code:'conflict'});
});

test('payments confirmed after the trip reduce final balances only', async t => {
  const f = await fixture(t), editor = await f.add('editor');
  await f.update({endDate:day});
  await f.run({type:'expense.create',input:{...f.expense,amount:'1000',splitIds:[f.ownerId,editor.memberId]}});
  const {value:{targetId}} = await f.run({type:'payment.report',toMemberId:f.ownerId,amountKrw:500},editor.actor);
  f.setClock('2026-11-02T05:00:00Z');
  await f.changePayment('payment.confirm',targetId!);
  const {settlement} = await f.get();
  assert.equal(settlement.due,false);
  assert.deepEqual(settlement.days[0]?.current.transfers,[{
    fromMemberId:editor.memberId,toMemberId:f.ownerId,amountKrw:500
  }]);
  assert.deepEqual(settlement.final.transfers,[]);
});

test('deterministic transfer suggestions reduce every balance to zero', async t => {
  const f = await fixture(t);
  const a = await f.add('a'), b = await f.add('b'), c = await f.add('c');
  await f.run({type:'expense.create',input:{...f.expense,amount:'150',splitIds:[a.memberId]}});
  await f.run({type:'expense.create',input:{...f.expense,amount:'70',splitIds:[b.memberId]}});
  await f.run({type:'expense.create',input:{...f.expense,amount:'80',payerId:c.memberId,splitIds:[b.memberId]}});
  const {balances,transfers} = (await f.get()).settlement.final;
  const [first,second] = [a.memberId,b.memberId].sort();
  assert.deepEqual(transfers,[
    {fromMemberId:first,toMemberId:f.ownerId,amountKrw:150},
    {fromMemberId:second,toMemberId:f.ownerId,amountKrw:70},
    {fromMemberId:second,toMemberId:c.memberId,amountKrw:80},
  ]);
  const remaining = new Map(balances.map(b => [b.memberId,b.netKrw]));
  for (const {fromMemberId,toMemberId,amountKrw} of transfers) {
    remaining.set(fromMemberId,remaining.get(fromMemberId)! + amountKrw);
    remaining.set(toMemberId,remaining.get(toMemberId)! - amountKrw);
  }
  assert.deepEqual([...remaining.values()],[0,0,0,0]);
});

test('payment writes reject a stale row even when the ledger revision is current', async t => {
  const f = await fixture(t), editor = await f.add('editor');
  const reported = await f.run({type:'payment.report',toMemberId:f.ownerId,amountKrw:100},editor.actor);
  const id = reported.value.targetId!;
  assert.equal((await f.get()).settlement.payments[0]?.revision,reported.tripRevision);
  const operationId = randomUUID();
  const confirmation = {type:'payment.confirm',id,expectedPaymentRevision:reported.tripRevision} as const;
  const confirmed = await f.ledgerService.execute(f.owner,f.id,confirmation,reported.tripRevision,operationId);
  assert.deepEqual(await f.ledgerService.execute(f.owner,f.id,confirmation,reported.tripRevision,operationId),
    {...confirmed,replayed:true});
  const before = await f.get();
  assert.equal(before.settlement.payments[0]?.revision,confirmed.tripRevision);
  await assert.rejects(f.run({type:'payment.requestVoid',id,expectedPaymentRevision:reported.tripRevision}),{code:'conflict'});
  assert.deepEqual(await f.get(),before);
});

test('snapshots record independent expense and confirmed payment versions', async t => {
  const f = await fixture(t), editor = await f.add('editor');
  await f.run({type:'settlement.finalize',date:day});
  const empty = (await f.get()).settlement.snapshots[0]!;
  assert.equal(empty.expenseRevision,0);
  assert.equal(empty.confirmedPaymentRevision,0);
  await f.run({type:'settlement.reopen',date:day});

  const expense = await f.run({type:'expense.create',input:f.expense});
  const reported = await f.run({type:'payment.report',toMemberId:f.ownerId,amountKrw:200},editor.actor);
  const id = reported.value.targetId!;
  await f.run({type:'settlement.finalize',date:day});
  const pending = (await f.get()).settlement.snapshots.at(-1)!;
  assert.equal(pending.expenseRevision,expense.tripRevision);
  assert.equal(pending.confirmedPaymentRevision,0);
  assert.equal(pending.sourceRevision,reported.tripRevision);

  const confirmed = await f.run({type:'payment.confirm',id,expectedPaymentRevision:reported.tripRevision});
  const requested = await f.run({type:'payment.requestVoid',id,expectedPaymentRevision:confirmed.tripRevision});
  await f.run({type:'settlement.finalize',date:null});
  const latest = (await f.get()).settlement.snapshots.at(-1)!;
  assert.equal(latest.expenseRevision,expense.tripRevision);
  assert.equal(latest.confirmedPaymentRevision,confirmed.tripRevision);
  assert.equal(latest.sourceRevision,requested.tripRevision);

  const voided = await f.run({type:'payment.confirmVoid',id,expectedPaymentRevision:requested.tripRevision},editor.actor);
  await f.run({type:'settlement.reopen',date:null});
  await f.run({type:'settlement.finalize',date:null});
  const snapshots = (await f.get()).settlement.snapshots;
  assert.equal(snapshots.at(-1)?.confirmedPaymentRevision,voided.tripRevision);
  assert.equal(snapshots.at(-1)?.expenseRevision,expense.tripRevision);
  assert.deepEqual(snapshots[1],pending);
  assert.equal(snapshots[2]?.confirmedPaymentRevision,confirmed.tripRevision);
});
