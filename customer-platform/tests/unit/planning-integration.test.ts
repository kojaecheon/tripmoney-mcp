import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { normalizeLedgerCommand } from '../../core/ledger/normalize.js';
import { createLocalRuntime } from '../../server/local/runtime.js';
import { createLedgerController } from '../../web/ledger/controller.mjs';
import {createTravelController} from '../../web/travel/controller.mjs';

const schedule = {date:'2026-11-07',startTime:'',endTime:'',title:'카페',place:'메모',budgetKrw:1000};
const ref = {provider:'demo' as const,placeId:'demo-cafe'};
test('schedule normalization preserves legacy input and adds only a validated place reference', () => {
  assert.deepEqual(normalizeLedgerCommand({type:'schedule.create',input:schedule}),{type:'schedule.create',input:schedule});
  const input = {...schedule,placeRef:ref};
  assert.deepEqual(normalizeLedgerCommand({type:'schedule.create',input}),{type:'schedule.create',input});
  for (const placeRef of [{...ref,lat:1},{provider:'other',placeId:'x'},{provider:'google',placeId:'\n'}]) {
    assert.throws(()=>normalizeLedgerCommand({type:'schedule.create',input:{...schedule,placeRef}}));
  }
});

async function fixture(t: {after(fn:()=>void):void}) {
  const runtime=createLocalRuntime();
  t.after(()=>runtime.close());
  const code=await runtime.authService.requestCode('owner@example.invalid','1'.repeat(64));
  const login=await runtime.authService.verifyCode(code.challengeToken,'123456');
  const {actor}=await runtime.authService.authenticate(login.sessionToken);
  const trip=(await runtime.identityService.createTrip(actor,{name:'합성 연결 여행',destination:'서울',
    startDate:'2026-11-07',endDate:'2026-11-08',timeZone:'Asia/Seoul',budgetKrw:10000,
    alias:'나',settlementMode:'daily',dailyTime:'20:00'},randomUUID())).value.trip;
  const controller=createLedgerController({
    me:async()=>({me:login.me}), getLedger:id=>runtime.ledgerService.get(actor,id),
    executeLedger:(id,command,revision,op)=>runtime.ledgerService.execute(actor,id,command,revision,op),
  },{pollMs:0});
  t.after(()=>controller.destroy());
  await controller.setContext(actor.userId,trip);
  return {runtime,actor,trip,controller,login};
}

test('explicit place selection changes only place fields and survives schedule save and edit', async t => {
  const {controller:c,runtime,actor,trip}=await fixture(t);
  c.setScheduleField('title','내 일정');
  assert.equal(c.applyPlace({ref,name:'합성 카페'}),true);
  assert.equal(c.state.scheduleDraft.title,'내 일정');
  assert.deepEqual(c.state.scheduleDraft.placeRef,ref);
  assert.equal(await c.saveSchedule(),true);
  const row=(await runtime.ledgerService.get(actor,trip.id)).items[0]!;
  assert.deepEqual(row.placeRef,ref);
  c.editSchedule(row.id);
  assert.deepEqual(c.state.scheduleDraft.placeRef,ref);
  c.setScheduleField('place','직접 바꾼 메모');
  assert.equal(c.state.scheduleDraft.placeRef,null);
});

test('message application fills a blank form without saving and refuses stale or dirty replacement', async t => {
  const {controller:c,runtime,actor,trip}=await fixture(t);
  const draft={tripId:trip.id,baseRevision:1,kind:'schedule' as const,fields:{...schedule,placeRef:ref},missing:[],source:'synthetic' as const,warnings:[]};
  assert.equal(c.applyDraft({...draft,tripId:randomUUID()}),false);
  assert.equal(c.applyDraft({...draft,baseRevision:2}),false);
  assert.equal(c.applyDraft(draft),true);
  assert.equal(c.state.scheduleDraft.budgetKrw,'1000');
  assert.equal((await runtime.ledgerService.get(actor,trip.id)).items.length,0);
  c.setScheduleField('title','내가 수정한 초안');
  assert.equal(c.applyDraft(draft),false);
  assert.equal(c.state.scheduleDraft.title,'내가 수정한 초안');
  assert.equal(await c.saveSchedule(),true);
  assert.equal((await runtime.ledgerService.get(actor,trip.id)).items[0]?.title,'내가 수정한 초안');
});

test('missing message dates and budgets remain blank for explicit confirmation', async t => {
  const {controller:c,trip}=await fixture(t);
  assert.equal(c.applyDraft({tripId:trip.id,baseRevision:1,kind:'expense',fields:{title:'택시',currency:'KRW',amount:'15000'},
    missing:['occurredLocal','payerId','splitIds'],source:'synthetic',warnings:[]}),true);
  assert.equal(c.state.expenseDraft.occurredLocal,'');
  assert.equal(c.state.expenseDraft.payerId,'');
  assert.deepEqual(c.state.expenseDraft.splitIds,[]);
  assert.equal(c.applyDraft({tripId:trip.id,baseRevision:1,kind:'schedule',fields:{title:'미정 일정'},
    missing:['date','budgetKrw'],source:'synthetic',warnings:[]}),true);
  assert.equal(c.state.scheduleDraft.date,'');
  assert.equal(c.state.scheduleDraft.budgetKrw,'');
});

test('legacy schedule edits invalidate a selected place when its memo changes', async t => {
  const {runtime,actor,trip}=await fixture(t);
  const created=await runtime.ledgerService.execute(actor,trip.id,{type:'schedule.create',input:{...schedule,placeRef:ref}},1,randomUUID());
  await runtime.ledgerService.execute(actor,trip.id,{type:'schedule.update',id:created.value.targetId!,input:{...schedule,place:'다른 메모'}},2,randomUUID());
  assert.equal((await runtime.ledgerService.get(actor,trip.id)).items[0]!.placeRef,null);
});

test('planning recovery refreshes the same signed-in travel without clearing a dirty ledger form', async t => {
  const {runtime,actor,trip,controller:c,login}=await fixture(t);
  const travel=createTravelController({me:async()=>({me:login.me}),
    listTrips:()=>runtime.identityService.listTrips(actor),getTrip:(id:string)=>runtime.identityService.getTrip(actor,id),
    listMembers:(id:string)=>runtime.identityService.listMembers(actor,id),listInvites:(id:string)=>runtime.identityService.listInvites(actor,id),
  } as any);
  t.after(()=>travel.destroy());
  await travel.setAccount(actor.userId);await travel.selectTrip(trip.id);
  const unsubscribe=travel.subscribe(state=>{void c.setContext(state.accountId,state.trip);});
  t.after(unsubscribe);
  c.setScheduleField('title','보존할 일정');
  const modulePath='../../web/planning-recovery.mjs';
  const {createPlanningRecovery}=await import(modulePath);
  assert.equal(await createPlanningRecovery({travel,ledger:c})(),true);
  assert.equal(c.state.ledger?.tripId,trip.id);
  assert.equal(c.state.scheduleDraft.title,'보존할 일정');
  assert.equal(travel.state.selectedTripId,trip.id);
});
