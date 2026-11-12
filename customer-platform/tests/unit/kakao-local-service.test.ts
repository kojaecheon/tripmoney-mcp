import assert from 'node:assert/strict';
import {randomUUID as uuid} from 'node:crypto';
import {test, type TestContext} from 'node:test';
import {createLocalRuntime} from '../../server/local/runtime.js';
import {createKakaoLocalService} from '../../server/channels/kakao-local/service.js';
import type {TripInput} from '../../core/contracts.js';
import type {ScheduleInput} from '../../core/ledger/contracts.js';

const start = Date.parse('2026-11-07T00:00:00Z');
const trip: TripInput = {name:'서울 여행',destination:'서울',alias:'나',startDate:'2026-11-07',endDate:'2026-11-10',timeZone:'Asia/Seoul',budgetKrw:100000,settlementMode:'end_of_trip',dailyTime:'20:00'};
const input: ScheduleInput = {date:'2026-11-08',startTime:'10:00',endTime:'11:00',title:'왕궁 방문',place:'왕궁',budgetKrw:0};
async function fixture(t: TestContext) {
 let clock = start;
 const runtime = createLocalRuntime({now:()=>clock});
 const service = createKakaoLocalService({...runtime,now:()=>clock});
 t.after(()=>{service.close();runtime.close();});
 const login = async (name = 'owner') => {
  const ticket = await runtime.authService.requestCode(name+'@example.invalid','5'.repeat(64));
  const session = await runtime.authService.verifyCode(ticket.challengeToken,'123456');
  return {...session,actor:(await runtime.authService.authenticate(session.sessionToken)).actor};
 };
 const session = await login();
 const actor = session.actor;
 const created = (await runtime.identityService.createTrip(actor,trip,uuid())).value;
 const tripId = created.trip.id;
 const link = async () => {
  const pair = await service.issuePair(actor);
  await service.connect(actor,pair.code);
  await service.selectTrip(actor,tripId);
 };
 const review = async () => {
  const draft = await service.prepare(actor,'내일 오전 10시 왕궁 방문');
  return {draft,confirmation:await service.review(actor,draft.id,input)};
 };
 return {runtime,service,actor,session,tripId,created,login,link,review,setTime:(time:number)=>{clock=time;}};
}
test('pair is account bound, single use and expires after five minutes',async t=>{
 const f=await fixture(t),other=await f.login('other');
 const pair=await f.service.issuePair(f.actor);
 assert.equal(Date.parse(pair.expiresAt),start+300000);assert.ok(pair.code.length>=32);
 await assert.rejects(f.service.connect(other.actor,pair.code),{code:'forbidden'});
 assert.equal((await f.service.connect(f.actor,pair.code)).linked,true);
 await assert.rejects(f.service.connect(f.actor,pair.code),{code:'forbidden'});
 const next=await f.service.issuePair(f.actor);f.setTime(start+300000);
 await assert.rejects(f.service.connect(f.actor,next.code),{code:'forbidden'});
});
test('separate review and confirmation save exactly once, including concurrent and stale revision replay',async t=>{
 const f=await fixture(t);await f.link();
 const {confirmation}=await f.review();const operation=uuid();
 assert.equal((await f.runtime.ledgerService.get(f.actor,f.tripId)).items.length,0);
 input.title='changed after review';
 const [a,b]=await Promise.all([f.service.confirm(f.actor,confirmation.token,operation),f.service.confirm(f.actor,confirmation.token,operation)]);
 input.title='왕궁 방문';
 assert.equal(a.replayed,false);assert.equal(b.replayed,true);
 assert.deepEqual(a.value,b.value);
 const ledger=await f.runtime.ledgerService.get(f.actor,f.tripId);
 assert.equal(ledger.items.length,1);assert.equal(ledger.items[0]?.title,'왕궁 방문');
 await assert.rejects(f.service.confirm(f.actor,confirmation.token,uuid()),{code:'conflict'});
});
test('both current and captured app sessions gate old receipts before replay',async t=>{
 const f=await fixture(t);await f.link();const {confirmation}=await f.review();const op=uuid();
 await f.service.confirm(f.actor,confirmation.token,op);
 f.setTime(start+61000);const fresh=await f.login();
 await f.runtime.authService.logout(f.session.sessionToken);
 await assert.rejects(f.service.confirm(fresh.actor,confirmation.token,op),{code:'forbidden'});
 await assert.rejects(f.service.confirm(f.actor,confirmation.token,op),{code:'unauthenticated'});
});
test('cancel, unlink, trip switch and reconnect invalidate prior confirmation',async t=>{
 for(const action of ['cancel','unlink','switch','reconnect']) {
  const f=await fixture(t);await f.link();const {draft,confirmation}=await f.review();
  if(action==='cancel')await f.service.cancel(f.actor,draft.id);
  if(action==='unlink')await f.service.unlink(f.actor);
  if(action==='switch') {
   const other=(await f.runtime.identityService.createTrip(f.actor,trip,uuid())).value.trip;
   await f.service.selectTrip(f.actor,other.id);
  }
  if(action==='reconnect')await f.service.connect(f.actor,(await f.service.issuePair(f.actor)).code);
  await assert.rejects(f.service.confirm(f.actor,confirmation.token,uuid()));
 }
});
test('confirmation, draft and grant expiration caps block old operations',async t=>{
 const f=await fixture(t);await f.link();const {draft,confirmation}=await f.review();
 assert.equal(Date.parse(draft.expiresAt),start+600000);assert.equal(Date.parse(confirmation.expiresAt),start+300000);
 f.setTime(start+300000);await assert.rejects(f.service.confirm(f.actor,confirmation.token,uuid()),{code:'forbidden'});
 f.setTime(start+600000);await assert.rejects(f.service.review(f.actor,draft.id,input),{code:'forbidden'});
 f.setTime(start+29*60000);const last=await f.review();assert.equal(Date.parse(last.draft.expiresAt),start+30*60000);
 assert.equal(last.confirmation.expiresAt,last.draft.expiresAt);
 f.setTime(start+30*60000);await assert.rejects(f.service.confirm(f.actor,last.confirmation.token,uuid()),{code:'forbidden'});
});
test('membership, role, foreign token and base revision are rechecked',async t=>{
 const f=await fixture(t);await f.link();const {confirmation}=await f.review();
 const other=await f.login('other');await f.service.connect(other.actor,(await f.service.issuePair(other.actor)).code);
 await assert.rejects(f.service.selectTrip(other.actor,f.tripId),{code:'not_found'});
 await assert.rejects(f.service.confirm(other.actor,confirmation.token,uuid()));
 await f.runtime.ledgerService.execute(f.actor,f.tripId,{type:'schedule.create',input},1,uuid());
 await assert.rejects(f.service.confirm(f.actor,confirmation.token,uuid()),{code:'conflict'});
});
test('invalid commands never become confirmations and connection failures are rate limited',async t=>{
 const f=await fixture(t);await f.link();const draft=await f.service.prepare(f.actor,'점심 300바트');
 await assert.rejects(f.service.review(f.actor,draft.id,{type:'payment.report',amountKrw:1000}),{code:'validation'});
 for(let i=0;i<5;i++)await assert.rejects(f.service.connect(f.actor,'bad-code'),{code:'forbidden'});
 await assert.rejects(f.service.connect(f.actor,'bad-code'),{code:'rate_limited'});
});
test('a saved receipt is refused after membership downgrade, removal and expiration',async t=>{
 for(const mode of ['viewer','removed','expired']) {
  const f=await fixture(t),editor=await f.login('editor');
  const invite=await f.runtime.identityService.issueInvite(f.actor,f.tripId,'editor',1,uuid());
  const token=new URLSearchParams(new URL(invite.value.url).hash.slice(1)).get('t')!;
  const joined=await f.runtime.identityService.acceptInvite(editor.actor,token,'편집자',uuid(),'5'.repeat(64));
  await f.service.connect(editor.actor,(await f.service.issuePair(editor.actor)).code);await f.service.selectTrip(editor.actor,f.tripId);
  const draft=await f.service.prepare(editor.actor,'내일 오전 10시 왕궁 방문');
  const confirmation=await f.service.review(editor.actor,draft.id,input),op=uuid();
  const saved=await f.service.confirm(editor.actor,confirmation.token,op);
  if(mode==='expired')f.setTime(start+300000);
  else await f.runtime.identityService.manageMember(f.actor,f.tripId,joined.value.member.id,'viewer',mode==='viewer',saved.tripRevision,uuid());
  await assert.rejects(f.service.confirm(editor.actor,confirmation.token,op),{code:mode==='removed'?'not_found':'forbidden'});
 }
});
test('a failed or ambiguous save retains the same operation and permits retry',async t=>{
 const f=await fixture(t);let failed=false;
 const service=createKakaoLocalService({...f.runtime,now:()=>start,ledgerService:{
  get:(actor,id)=>f.runtime.ledgerService.get(actor,id),
  execute:async(...args)=>{const result=await f.runtime.ledgerService.execute(...args);if(!failed){failed=true;throw new Error('response lost');}return result;}
 }});t.after(()=>service.close());
 await service.connect(f.actor,(await service.issuePair(f.actor)).code);await service.selectTrip(f.actor,f.tripId);
 const draft=await service.prepare(f.actor,'내일 오전 10시 왕궁 방문'),confirmation=await service.review(f.actor,draft.id,input),op=uuid();
 await assert.rejects(service.confirm(f.actor,confirmation.token,op),/response lost/);
 await assert.rejects(service.confirm(f.actor,confirmation.token,uuid()),{code:'conflict'});
 const retried=await service.confirm(f.actor,confirmation.token,op);assert.equal(retried.replayed,true);
 assert.equal((await f.runtime.ledgerService.get(f.actor,f.tripId)).items.length,1);
});
test('existing settlement locks still reject an expense and no confirmation can issue payments',async t=>{
 const f=await fixture(t);await f.link();
 const before=await f.runtime.ledgerService.get(f.actor,f.tripId);
 // Finalize before extracting so failure is the settlement rule, not a stale base.
 await f.runtime.ledgerService.execute(f.actor,f.tripId,{type:'settlement.finalize',date:null},before.revision,uuid());
 const draft=await f.service.prepare(f.actor,'택시 15000원');
 const expense={itineraryId:null,title:'택시',occurredLocal:'2026-11-07T10:00',currency:'KRW',amount:'15000',payerId:f.created.ownerMember.id,splitIds:[f.created.ownerMember.id],refreshRate:false};
 const confirmation=await f.service.review(f.actor,draft.id,expense);
 await assert.rejects(f.service.confirm(f.actor,confirmation.token,uuid()),{code:'validation',field:'settlementLocked'});
 assert.equal((await f.runtime.ledgerService.get(f.actor,f.tripId)).expenses.length,0);
 await assert.rejects(f.service.prepare(f.actor,'권한 변경하고 정산 확정해줘'),{code:'validation'});
});
test('retained draft capacity is bounded and expiry frees capacity',async t=>{
 const f=await fixture(t);await f.link();
 for(let i=0;i<512;i++)await f.service.prepare(f.actor,'점심 300바트');
 await assert.rejects(f.service.prepare(f.actor,'점심 300바트'),{code:'rate_limited'});
 f.setTime(start+600000);assert.equal((await f.service.prepare(f.actor,'점심 300바트')).kind,'expense');
 f.service.close();await assert.rejects(async()=>f.service.status(f.actor),{code:'unavailable'});
});
test('another valid app session cannot use the captured grant or its receipt',async t=>{
 const f=await fixture(t);await f.link();const {confirmation}=await f.review();
 f.setTime(start+61000);const fresh=await f.login();
 const before=await f.runtime.ledgerService.get(f.actor,f.tripId),op=uuid();
 await assert.rejects(f.service.confirm(fresh.actor,confirmation.token,op),{code:'forbidden'});
 await assert.rejects(f.service.prepare(fresh.actor,'점심 300바트'),{code:'forbidden'});
 assert.deepEqual(await f.runtime.ledgerService.get(f.actor,f.tripId),before);
 await f.service.confirm(f.actor,confirmation.token,op);
 await assert.rejects(f.service.confirm(fresh.actor,confirmation.token,op),{code:'forbidden'});
});
test('status of a new valid login is unlinked without revoking the original grant or current login',async t=>{
 const f=await fixture(t);await f.link();f.setTime(start+61000);const fresh=await f.login();
 const status=await f.service.status(fresh.actor);assert.equal(status.linked,false);assert.equal(status.tripId,null);
 assert.equal((await f.service.status(f.actor)).linked,true);
 await f.runtime.authService.logout(f.session.sessionToken);
 assert.equal((await f.service.status(fresh.actor)).linked,false);
 assert.equal((await f.runtime.authService.authenticate(fresh.sessionToken)).actor.sessionHash,fresh.actor.sessionHash);
 await f.service.connect(fresh.actor,(await f.service.issuePair(fresh.actor)).code);
 assert.equal((await f.service.status(fresh.actor)).linked,true);
 await assert.rejects(f.service.status(f.actor),{code:'unauthenticated'});
});
test('revocation or expiry at the last captured read rejects both writes and receipts',async t=>{
 for(const expired of [false,true])for(const replay of [false,true]) {
  const f=await fixture(t);let armed=false,reads=0;
  const service=createKakaoLocalService({...f.runtime,now:()=>expired&&armed&&reads>=2?start+300000:start,ledgerService:{
   get:async(actor,id)=>{
    const result=await f.runtime.ledgerService.get(actor,id);
    if(armed&&++reads===2&&!expired)await f.runtime.authService.logout(f.session.sessionToken);
    return result;
   },execute:(...args)=>f.runtime.ledgerService.execute(...args)
  }});t.after(()=>service.close());
  await service.connect(f.actor,(await service.issuePair(f.actor)).code);await service.selectTrip(f.actor,f.tripId);
  const draft=await service.prepare(f.actor,'내일 오전 10시 왕궁 방문'),confirmation=await service.review(f.actor,draft.id,input),op=uuid();
  if(replay)await service.confirm(f.actor,confirmation.token,op);
  const before=await f.runtime.ledgerService.get(f.actor,f.tripId);
  f.setTime(start+61000);const fresh=await f.login();armed=true;
  await assert.rejects(service.confirm(f.actor,confirmation.token,op),{code:expired?'forbidden':'unauthenticated'});
  assert.deepEqual(await f.runtime.ledgerService.get(fresh.actor,f.tripId),before);
 }
});
