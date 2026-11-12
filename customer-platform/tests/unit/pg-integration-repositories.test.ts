import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {createApi} from '../../web/api.mjs';
import {IdentityError, type Actor} from '../../core/contracts.js';
import {createPgChannelRepository, createPgProviderUsageStore} from '../../server/db/integration-repositories.js';
const actor:Actor={userId:randomUUID(),sessionHash:'a'.repeat(64)};
const sender={environment:'development' as const,botId:'development-bot',botUserKey:'private-sender'};
const at=Date.parse('2026-11-08T00:00:00Z');
const tripId=randomUUID(), memberId=randomUUID(), grantId=randomUUID();
const state=()=>({trips:[{id:tripId,ownerUserId:actor.userId,name:'합성 여행',destination:'서울',startDate:'2026-11-08',endDate:'2026-11-10',timeZone:'Asia/Seoul',budgetKrw:50000,settlementMode:'daily',dailyTime:'20:00',revision:1,status:'active',createdAt:new Date(at).toISOString()}],members:[{id:memberId,tripId,userId:actor.userId,alias:'소유자',role:'owner',active:true}],invites:[],receipts:[],audits:[],ledgers:[]});
const command={type:'schedule.create' as const,input:{date:'2026-11-08',startTime:'10:00',endTime:'11:00',title:'직접 쓴 일정',place:'직접 쓴 장소',budgetKrw:10000}};
// Synthetic serialized SQL boundary. PostgreSQL lock/RLS behavior is separately unverified.
function database(options:{expiresAt?:unknown}={}){
  const stamp=(fallback:string)=>Object.hasOwn(options,'expiresAt')?options.expiresAt:fallback;
  let saved:any=state(), confirmed:any=null, live=true, revoked=false, failSave=false, loseCommit=false, revokeOnSave=false, currentTime=at, activeGrant=grantId, tail=Promise.resolve();
  let review:any=null,approvedGrants:{grantId:string;tripId:string;pendingId:string}[]=[];const log:{sql:string;values:any[]}[]=[];const requests=new Map<string,{scope:string;period:string}>();
  const pool={connect:async()=>{let pending:any, pendingResult:any,pendingGrants:typeof approvedGrants, unlock:()=>void=()=>{};return {
    query:async(sql:string,values:any[]=[])=>{log.push({sql,values});let value:any;
      if(sql==='begin'){const prev=tail;tail=new Promise<void>(r=>{unlock=r;});await prev;pending=structuredClone(saved);pendingResult=confirmed;pendingGrants=structuredClone(approvedGrants);}
      else if(sql==='rollback') unlock();
      else if(sql==='commit'){saved=pending;confirmed=pendingResult;approvedGrants=pendingGrants;unlock();if(loseCommit){loseCommit=false;throw Error('secret database URL');}}
      else if(sql.includes('assert_actor')) {if(!live) throw {code:'P0401'};}
      else if(sql.includes('channel_load')) {
        if(!live) throw {code:'P0401'};if(revoked || pending.members[0].role==='viewer' || !pending.members[0].active) throw {code:'P0403'};
        if(values[1] && (!review || values[1]!==review.tokenHash || values[2]!==review.operationId || review.grantId!==activeGrant || currentTime>=review.expiresAt)) throw {code:'P0409'};
        value={actor,tripId,grantId:activeGrant,expiresAt:stamp(new Date(at+3600000).toISOString()),state:pending,
          confirmation:values[1]?{...review,result:confirmed}:null};
      } else if(sql.includes('channel_review')) {review={grantId:activeGrant,expiresAt:at+300000,tokenHash:values[2],operationId:values[3],command:JSON.parse(values[4]),expectedRevision:values[5]};value={expiresAt:stamp(new Date(at+300000).toISOString())};}
      else if(sql.includes('channel_save')) {if(failSave)throw Error('secret database URL');if(revokeOnSave)live=false;if(!live)throw {code:'P0401'};if(revoked)throw {code:'P0403'};assert.deepEqual(JSON.parse(values[3]),pending);pending=JSON.parse(values[4]);pendingResult=JSON.parse(values[5]);value=true;}
      else if(sql.includes('provider_usage_reserve')) {const key=JSON.stringify([values[0],values[1]]),period=values[4]??new Date(currentTime).toISOString().slice(0,10);value=!requests.has(key)&&[...requests.values()].filter(r=>r.scope===values[0]&&r.period===period).length<values[2];if(value)requests.set(key,{scope:values[0],period});}
      else if(sql.includes('channel_claim')) {value={pendingId:grantId,expiresAt:stamp(new Date(at+300000).toISOString())};}
      else if(sql.includes('channel_web')) {value=JSON.parse(values[1]);if(values[0]==='approve'){const grant={grantId,tripId,pendingId:value.pendingId};pendingGrants.push(grant);value={grantId,tripId};}value={...value,expiresAt:stamp(new Date(at+600000).toISOString())};}
      return {rows:value===undefined?[]:[{value}]};
    },release:()=>{unlock();}};}} as unknown as Pool;
  return {pool,log,get approvedGrants(){return approvedGrants;},get saved(){return saved;},set live(v:boolean){live=v;},set revoked(v:boolean){revoked=v;},set failSave(v:boolean){failSave=v;},set loseCommit(v:boolean){loseCommit=v;},get review(){return review;},set time(v:number){currentTime=v;},switchTrip(){activeGrant=randomUUID();},set revokeOnSave(v:boolean){revokeOnSave=v;}};
}
const rejected=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:any)=>e instanceof IdentityError&&e.code===code);
test('channel lease executes domain and atomic save without pretending to be a web actor',async()=>{
  const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});
  const context=await repo.context(sender);assert.equal(context.tripId,tripId);assert.equal(context.ledger.items.length,0);
  const review=await repo.review(sender,command,1);const result=await repo.confirm(sender,review.token,review.operationId);
  assert.equal(result.tripRevision,2);assert.equal(db.saved.ledgers[0][1].items.length,1);
  assert.ok(!db.log.some(x=>x.sql.includes('assert_actor')||x.sql.includes('travel_save')||x.sql.includes('set_config')));
  assert.ok(!JSON.stringify(db.log).includes(sender.botUserKey));assert.ok(!JSON.stringify(review).includes(actor.sessionHash));
});
test('confirmation retry uses fixed operation and returns original receipt without second save',async()=>{
  const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});const review=await repo.review(sender,command,1);
  const first=await repo.confirm(sender,review.token,review.operationId),second=await repo.confirm(sender,review.token,review.operationId);
  assert.equal(first.value.targetId,second.value.targetId);assert.equal(second.replayed,true);
  assert.equal(db.log.filter(x=>x.sql.includes('channel_save')).length,1);
  await rejected(repo.confirm(sender,review.token,randomUUID()),'conflict');
});
test('rollback leaves ledger unchanged and secrets out of error',async()=>{
  const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});const review=await repo.review(sender,command,1);db.failSave=true;
  await assert.rejects(repo.confirm(sender,review.token,review.operationId),(e:any)=>e.code==='unavailable'&&!e.message.includes('secret'));
  assert.equal(db.saved.trips[0].revision,1);assert.ok(db.log.some(x=>x.sql==='rollback'));
});
test('lost commit response retries the committed receipt',async()=>{
  const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});const review=await repo.review(sender,command,1);db.loseCommit=true;
  await rejected(repo.confirm(sender,review.token,review.operationId),'unavailable');
  assert.equal((await repo.confirm(sender,review.token,review.operationId)).replayed,true);assert.equal(db.saved.trips[0].revision,2);
});
test('logout and grant revocation invalidate previously reviewed confirmation',async()=>{
  for(const kind of ['live','revoked'] as const){const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});const review=await repo.review(sender,command,1);
    db[kind]=kind==='revoked';await rejected(repo.confirm(sender,review.token,review.operationId),kind==='live'?'unauthenticated':'forbidden');assert.equal(db.saved.trips[0].revision,1);}
});
test('review rejects stale revision before persisting token',async()=>{
  const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});await rejected(repo.review(sender,command,2),'conflict');assert.equal(db.review,null);
});
test('web pairing sets verified actor and never sends raw pairing code to SQL',async()=>{
  const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});const pair=await repo.issuePair(actor,tripId);
  assert.match(pair.code,/^[a-f0-9]{24}$/);assert.ok(db.log.some(x=>x.sql.includes('assert_actor')));assert.ok(!JSON.stringify(db.log).includes(pair.code));
});
test('close invalidates channel adapter and does not close caller pool',async()=>{
  const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});repo.close();await rejected(repo.context(sender),'unavailable');assert.equal(db.log.length,0);
});
test('durable usage denies duplicate ID and daily capacity',async()=>{
  const db=database(),store=createPgProviderUsageStore({pool:db.pool,now:()=>at});const input={scope:'claude:server-scope',requestId:randomUUID(),limit:1,expiresAt:at+60000};
  assert.equal(await store.reserve(input),true);assert.equal(await store.reserve(input),false);assert.equal(await store.reserve({...input,requestId:randomUUID()}),false);
});
test('usage validates expiry before acquiring connection',async()=>{
  const db=database(),store=createPgProviderUsageStore({pool:db.pool,now:()=>at});await rejected(store.reserve({scope:'x',requestId:'r',limit:1,expiresAt:at-1}),'validation');assert.equal(db.log.length,0);
});

test('parallel confirmations serialize into one saved row and one replay',async()=>{
  const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});const r=await repo.review(sender,command,1);
  const results=await Promise.all([repo.confirm(sender,r.token,r.operationId),repo.confirm(sender,r.token,r.operationId)]);
  assert.deepEqual(results.map(x=>x.replayed).sort(),[false,true]);assert.equal(db.saved.ledgers[0][1].items.length,1);
});
test('expiry and trip switch make old confirmation unavailable',async()=>{
  for(const scenario of ['expiry','switch']){const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});const r=await repo.review(sender,command,1);
    if(scenario==='expiry')db.time=at+300001;else db.switchTrip();await rejected(repo.confirm(sender,r.token,r.operationId),'conflict');assert.equal(db.saved.trips[0].revision,1);}
});
test('current role removal invalidates context and confirm',async()=>{
  const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});const r=await repo.review(sender,command,1);db.saved.members[0].role='viewer';
  await rejected(repo.context(sender),'forbidden');await rejected(repo.confirm(sender,r.token,r.operationId),'forbidden');
});
test('final save denial rolls back after domain calculation',async()=>{
  const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});const r=await repo.review(sender,command,1);db.revokeOnSave=true;
  await rejected(repo.confirm(sender,r.token,r.operationId),'unauthenticated');assert.equal(db.saved.trips[0].revision,1);
  assert.equal(db.log.filter(x=>x.sql.includes('channel_save')).length,1);
});
test('settlement lock is rechecked after review before final expense save',async()=>{
  const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at});
  const expense={type:'expense.create' as const,input:{itineraryId:null,title:'직접 입력',occurredLocal:'2026-11-08T10:00',currency:'KRW' as const,amount:'5000',payerId:memberId,splitIds:[memberId],refreshRate:false}};
  const r=await repo.review(sender,expense,1);
  db.saved.ledgers=[[tripId,{items:[],expenses:[],fx:{source:'demo',rateMilli:38600},snapshots:[{date:'2026-11-08',reopenedAt:null}],payments:[],expenseRevision:0,confirmedPaymentRevision:0}]];
  await rejected(repo.confirm(sender,r.token,r.operationId),'validation');assert.equal(db.log.filter(x=>x.sql.includes('channel_save')).length,0);
});
test('ambiguous reservation commit never grants a second provider call',async()=>{
  const db=database(),store=createPgProviderUsageStore({pool:db.pool,now:()=>at});const input={scope:'google:scope',requestId:'fixed-id',limit:10,expiresAt:at+60000};
  db.loseCommit=true;await rejected(store.reserve(input),'unavailable');assert.equal(await store.reserve(input),false);
});
test('malformed SQL reservation response fails closed',async()=>{
  const pool={connect:async()=>({query:async()=>({rows:[{value:'yes'}]}),release(){}})} as unknown as Pool;
  const store=createPgProviderUsageStore({pool,now:()=>at});await rejected(store.reserve({scope:'x',requestId:'r',limit:1,expiresAt:at+60000}),'unavailable');
});

test('explicit local-day period does not reset at UTC midnight',async()=>{
  const db=database(),store=createPgProviderUsageStore({pool:db.pool,now:()=>at});
  const input={scope:'recommendation:trip:user',requestId:'local-1',limit:1,expiresAt:at+60000,periodKey:'2026-11-08'};
  assert.equal(await store.reserve(input),true);db.time=at+86400000;
  assert.equal(await store.reserve({...input,requestId:'local-2'}),false);
  assert.equal(await store.reserve({...input,requestId:'local-3',periodKey:'2026-11-09'}),true);
  assert.equal(await store.reserve({...input,periodKey:'2026-11-09'}),false);
});
test('omitted period uses database UTC day while duplicate requests stay denied',async()=>{
  const db=database(),store=createPgProviderUsageStore({pool:db.pool,now:()=>at});
  const input={scope:'google:stable-user',requestId:'utc-1',limit:1,expiresAt:at+60000};
  assert.equal(await store.reserve(input),true);db.time=at+86400000;
  assert.equal(await store.reserve({...input,requestId:'utc-2'}),true);assert.equal(await store.reserve(input),false);
});
test('invalid period is rejected before database reservation',async()=>{
  const db=database(),store=createPgProviderUsageStore({pool:db.pool,now:()=>at});
  for(const periodKey of ['', 'x'.repeat(65),'unsafe period'])await rejected(store.reserve({scope:'scope',requestId:'r',limit:1,expiresAt:at+60000,periodKey}),'validation');
  assert.equal(db.log.length,0);
});

// Break caught: validating the approved trip after withActor has already committed
// would persist a wrong-trip grant even though the caller receives a conflict.
test('wrong-trip approval rolls back the grant inside the actor transaction',async()=>{
 const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at}),pendingId=randomUUID();
 let rejection:unknown;try{await repo.approvePair(actor,pendingId,randomUUID());}catch(error){rejection=error;}
 assert.deepEqual(db.approvedGrants,[]);
 assert.ok(rejection instanceof IdentityError&&rejection.code==='conflict');
 assert.equal(db.log.some(entry=>entry.sql==='commit'),false);
 const approved=await repo.approvePair(actor,pendingId,tripId);
 assert.equal(approved.tripId,tripId);
 assert.deepEqual(db.approvedGrants,[{grantId,tripId,pendingId}]);
});
test('approval without an expected trip keeps the internal repository contract compatible',async()=>{
 const db=database(),repo=createPgChannelRepository({pool:db.pool,now:()=>at}),pendingId=randomUUID();
 assert.equal((await repo.approvePair(actor,pendingId)).tripId,tripId);
 assert.deepEqual(db.approvedGrants,[{grantId,tripId,pendingId}]);
});

// Break caught: raw PostgreSQL microseconds / offsets reaching the strict real web parser.
test('PostgreSQL expiry crosses adapter and real web API parser as UTC milliseconds',async()=>{
 const db=database({expiresAt:'2099-11-08T00:10:00.123456+00:00'}),repo=createPgChannelRepository({pool:db.pool,now:()=>at});
 const api=createApi(async(url,options)=>{
  const input=JSON.parse(options!.body as string);
  const body=url==='/api/customer/kakao/pair'?await repo.issuePair(actor,input.tripId):await repo.approvePair(actor,input.pendingId,input.tripId);
  return new Response(JSON.stringify(body));
 });
 const pair=await api.issueKakaoLivePair(tripId,actor.userId);
 assert.equal(pair.expiresAt,'2099-11-08T00:10:00.123Z');
 const claim=await repo.claimPair(sender,pair.code);
 assert.equal(claim.expiresAt,'2099-11-08T00:10:00.123Z');
 const approval=await api.approveKakaoLivePair(claim.pendingId,tripId,actor.userId);
 assert.deepEqual(approval,{grantId,tripId,expiresAt:'2099-11-08T00:10:00.123Z'});
 assert.equal((await repo.context(sender)).expiresAt,'2099-11-08T00:10:00.123Z');
 assert.equal((await repo.review(sender,command,1)).expiresAt,'2099-11-08T00:10:00.123Z');
});
test('nonzero SQL timezone offset is converted to the same UTC instant',async()=>{
 const db=database({expiresAt:'2099-11-08T09:10:00.123456+09:00'}),repo=createPgChannelRepository({pool:db.pool,now:()=>at});
 assert.equal((await repo.issuePair(actor,tripId)).expiresAt,'2099-11-08T00:10:00.123Z');
});
test('invalid database expiry rejects approval before committing its grant',async()=>{
 for(const expiresAt of [null,123,'infinity','not-a-date','2099-02-30T00:00:00Z','2099-11-08']){
  const db=database({expiresAt}),repo=createPgChannelRepository({pool:db.pool,now:()=>at});
  let error:unknown;try{await repo.approvePair(actor,randomUUID(),tripId);}catch(rejection){error=rejection;}
  assert.deepEqual(db.approvedGrants,[],String(expiresAt));
  assert.ok(error instanceof IdentityError&&error.code==='unavailable');
 }
});
