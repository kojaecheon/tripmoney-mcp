import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {IdentityError} from '../../core/contracts.js';
import type {LedgerDTO} from '../../core/ledger/contracts.js';
import {createRecommendationService} from '../../server/recommendation/service.js';
import {createSyntheticPlaceProvider} from '../../server/places/synthetic-provider.js';
import {createSyntheticRecommendationProvider} from '../../server/ai/synthetic-recommendation.js';
const actor={userId:randomUUID(),sessionHash:'session'}, tripId=randomUUID();
const input={date:'2026-11-07',startTime:'10:00',endTime:'11:00',title:'방문',place:'예시',budgetKrw:1000,placeRef:null};
function fixture(output: unknown={items:[{input,reason:'관심사 반영'}]}, anyTrip=false) {
 let instant=Date.parse('2026-11-07T00:00:00Z'),calls=0,active=true;
 const ledger={tripId,revision:1,role:'editor',startDate:'2026-11-07',endDate:'2026-11-09',timeZone:'Asia/Bangkok',budgetKrw:10000,members:[{active:true}],items:[]} as unknown as LedgerDTO;
 const receipts=new Map<string,any>();const saved:any[]=[];const contexts:any[]=[];
 const service=createRecommendationService({identityService:{async getTrip(_actor,id){if(!active)throw new IdentityError('forbidden','removed');return {...ledger,id:anyTrip?id:tripId,destination:'방콕',memberCount:2} as any;}},ledgerService:{async get(_actor,id){if(!active)throw new IdentityError('forbidden','removed');return {...structuredClone(ledger),tripId:anyTrip?id:tripId};},async execute(_a,_t,command,revision,op){const hash=JSON.stringify(command);const receipt=receipts.get(op);if(receipt){if(receipt.hash!==hash)throw new IdentityError('conflict','payload');return {...receipt.change,replayed:true};}if(revision!==ledger.revision)throw new IdentityError('conflict','revision');saved.push(command);ledger.revision++;const change={value:{targetId:randomUUID()},tripRevision:ledger.revision,replayed:false};receipts.set(op,{hash,change});return change;}},placeService:{async resolve(){return [];}},provider:{source:'synthetic',async generate(c){calls++;contexts.push(c);return output;}},now:()=>instant});
 return {service,ledger,saved,contexts,get calls(){return calls;},setTime:(n:number)=>{instant=n;},remove:()=>{active=false;}};
}
test('generation sends only allowed travel fields and adoption persists server subset once with receipt replay',async()=>{
 const f=fixture();const draft=await f.service.generate(actor,tripId,{interests:['산책'],pace:'relaxed'},1);
 assert.equal(draft.items.length,1);assert.equal(draft.source,'synthetic');assert.equal(draft.items[0]!.placeStatus,'unverified');assert.equal(draft.items[0]!.input.placeRef,null);
 assert.deepEqual(Object.keys(f.contexts[0]).sort(),['destination','startDate','endDate','timeZone','memberCount','budgetKrw','interests','pace'].sort());
 const op=randomUUID(),ids=[draft.items[0]!.id];const first=await f.service.adopt(actor,tripId,draft.id,ids,op);assert.equal(first.tripRevision,2);
 const replay=await f.service.adopt(actor,tripId,draft.id,ids,op);assert.equal(replay.replayed,true);assert.equal(f.saved.length,1);assert.equal(f.saved[0].type,'schedule.adopt');assert.deepEqual(f.saved[0].inputs,[draft.items[0]!.input]);
 await assert.rejects(f.service.adopt(actor,tripId,draft.id,ids,randomUUID()),{code:'conflict'});
 f.remove();await assert.rejects(f.service.adopt(actor,tripId,draft.id,ids,op),{code:'forbidden'});f.service.close();
});
test('rejects stale, expired, foreign, empty, duplicate selections and changed replay payload',async()=>{
 const f=fixture({items:[{input,reason:'이유'},{input:{...input,title:'둘'},reason:'둘'}]});const d=await f.service.generate(actor,tripId,{interests:[],pace:'balanced'},1);const id=d.items[0]!.id;
 for(const ids of [[],[id,id],[randomUUID()]])await assert.rejects(f.service.adopt(actor,tripId,d.id,ids,randomUUID()),{code:'validation'});
 await assert.rejects(f.service.adopt({...actor,userId:randomUUID()},tripId,d.id,[id],randomUUID()),{code:'not_found'});
 const op=randomUUID();await f.service.adopt(actor,tripId,d.id,[id],op);await assert.rejects(f.service.adopt(actor,tripId,d.id,[d.items[1]!.id],op),{code:'conflict'});
 f.setTime(Date.parse(d.expiresAt));await assert.rejects(f.service.adopt(actor,tripId,d.id,[id],op),{code:'conflict'});
 const g=fixture();const stale=await g.service.generate(actor,tripId,{interests:[],pace:'packed'},1);g.ledger.revision++;await assert.rejects(g.service.adopt(actor,tripId,stale.id,[stale.items[0]!.id],randomUUID()),{code:'conflict'});
});
test('rejects untrusted provider dates, budgets, oversized candidates, accessors, and invalid requests',async()=>{
 for(const bad of [{items:[]},{items:Array(61).fill({input,reason:'a'})},{items:[{input:{...input,date:'2027-01-01'},reason:'a'}]},{items:[{input:{...input,budgetKrw:10001},reason:'a'}]},{items:[{input,reason:'x'.repeat(501)}]},Object.defineProperty({},'items',{get(){assert.fail('getter executed');}})]){
  const f=fixture(bad);await assert.rejects(f.service.generate(actor,tripId,{interests:[],pace:'balanced'},1),{code:'validation'});
 }
 const f=fixture();for(const request of [{interests:Array(6).fill('x'),pace:'balanced'},{interests:['x'.repeat(41)],pace:'balanced'},{interests:[],pace:'fast'}])await assert.rejects(f.service.generate(actor,tripId,request as any,1),{code:'validation'});assert.equal(f.calls,0);
 f.ledger.role='viewer';await assert.rejects(f.service.generate(actor,tripId,{interests:[],pace:'balanced'},1),{code:'forbidden'});
});
test('reserves generation quotas before provider and enforces local trip day plus user day',async()=>{
 const f=fixture();for(let n=0;n<3;n++)await f.service.generate(actor,tripId,{interests:[],pace:'balanced'},1);await assert.rejects(f.service.generate(actor,tripId,{interests:[],pace:'balanced'},1),{code:'rate_limited'});assert.equal(f.calls,3);
 f.setTime(Date.parse('2026-11-07T18:00:00Z'));await f.service.generate(actor,tripId,{interests:[],pace:'balanced'},1);assert.equal(f.calls,4);
 const g=fixture(undefined,true);for(let n=0;n<10;n++)await g.service.generate(actor,randomUUID(),{interests:[],pace:'balanced'},1);await assert.rejects(g.service.generate(actor,randomUUID(),{interests:[],pace:'balanced'},1),{code:'rate_limited'});assert.equal(g.calls,10);
});
test('synthetic provider is explicit and generates bounded trip candidates',async()=>{
 const provider=createSyntheticRecommendationProvider();assert.equal(provider.source,'synthetic');const result=await provider.generate({destination:'방콕',startDate:'2026-11-07',endDate:'2026-11-09',timeZone:'Asia/Bangkok',memberCount:2,budgetKrw:10000,interests:['미술'],pace:'balanced'}) as any;assert.ok(result.items.length>0&&result.items.length<=60);assert.equal(result.items[0].input.date,'2026-11-07');
});

test('synthetic candidates reference demo fixtures and retain explicit synthetic status after place proof',async()=>{
 const provider=createSyntheticRecommendationProvider(),placeProvider=createSyntheticPlaceProvider();
 const raw=await provider.generate({destination:'방콕',startDate:'2026-11-07',endDate:'2026-11-09',timeZone:'Asia/Bangkok',memberCount:2,budgetKrw:10000,interests:[],pace:'balanced'}) as any;
 assert.deepEqual(raw.items[0].input.placeRef,{provider:'demo',placeId:'demo-cafe'});
 const f=fixture();const service=createRecommendationService({identityService:{async getTrip(){return {id:tripId,role:'editor',revision:1,destination:'방콕',memberCount:2} as any;}},ledgerService:{async get(){return f.ledger;},async execute(){assert.fail('generation must not save');}},placeService:{async resolve(_a,_t,refs){return await placeProvider.resolve(refs) as any;}},provider});
 const draft=await service.generate(actor,tripId,{interests:[],pace:'balanced'},1);assert.equal(draft.items[0]!.placeStatus,'synthetic');assert.equal(draft.items[0]!.input.place,'체험 카페');assert.equal(draft.items[1]!.input.placeRef?.placeId,'demo-park');service.close();
});
test('rejects sparse and excessively nested provider trees as validation errors',async()=>{
 let nested:any={};for(let n=0;n<100;n++)nested={child:nested};
 for(const output of [{items:new Array(1)},{items:[{input,reason:'이유'}],extra:nested}])await assert.rejects(fixture(output).service.generate(actor,tripId,{interests:[],pace:'balanced'},1),{code:'validation'});
});
test('generation rechecks revision and membership after provider work and client mutation cannot alter cached candidates',async()=>{
 for(const revoke of [false,true]){
  let release!:(value:unknown)=>void;const f=fixture(new Promise(r=>release=r));const pending=f.service.generate(actor,tripId,{interests:[],pace:'balanced'},1);await new Promise<void>(r=>setImmediate(r));if(revoke)f.remove();else f.ledger.revision++;release({items:[{input,reason:'이유'}]});await assert.rejects(pending,{code:revoke?'forbidden':'conflict'});
 }
 const f=fixture(),draft=await f.service.generate(actor,tripId,{interests:[],pace:'balanced'},1),id=draft.items[0]!.id;draft.items[0]!.input.budgetKrw=999999;await f.service.adopt(actor,tripId,draft.id,[id],randomUUID());assert.equal(f.saved[0].inputs[0].budgetKrw,1000);f.service.close();await assert.rejects(f.service.generate(actor,tripId,{interests:[],pace:'balanced'},2),{code:'unavailable'});
});
test('provider failures are not retried and still consume reserved generation attempts',async()=>{
 let calls=0;const f=fixture();const service=createRecommendationService({identityService:{async getTrip(){return {id:tripId,role:'editor',revision:1,destination:'방콕',memberCount:2} as any;}},ledgerService:{async get(){return f.ledger;},async execute(){assert.fail('failed generation must not save');}},placeService:{async resolve(){return [];}},provider:{source:'synthetic',async generate(){calls++;throw Error('offline');}}});
 for(let n=0;n<3;n++)await assert.rejects(service.generate(actor,tripId,{interests:[],pace:'balanced'},1),{code:'unavailable'});assert.equal(calls,3);await assert.rejects(service.generate(actor,tripId,{interests:[],pace:'balanced'},1),{code:'rate_limited'});assert.equal(calls,3);service.close();
});
test('rejects custom array prototypes before invoking provider array methods',async()=>{
 const items=[{input,reason:'이유'}];Object.setPrototypeOf(items,{map(){throw Error('untrusted prototype executed');}});
 await assert.rejects(fixture({items}).service.generate(actor,tripId,{interests:[],pace:'balanced'},1),{code:'validation'});
});

test('Google proof keeps only durable place reference and never copies provider name or address into adopted schedule',async()=>{
 const f=fixture(),saved:any[]=[];const googleRef={provider:'google' as const,placeId:'ChIJ_a'};
 const service=createRecommendationService({usageStore:{async reserve(){return true;}},identityService:{async getTrip(){return {id:tripId,role:'editor',revision:1,destination:'서울',memberCount:2} as any;}},ledgerService:{async get(){return f.ledger;},async execute(_a,_id,command){saved.push(command);return {tripRevision:2,value:{targetId:randomUUID()},replayed:false};}},placeService:{async resolve(){return [{ref:googleRef,name:'공급자 명칭',address:'공급자 주소',lat:37,lng:127,source:'google',display:{expiresAt:'2026-11-08T00:05:00.000Z',attributions:[]}}];}},provider:{source:'claude',async generate(){return {items:[{input:{...input,place:'추천 공급자 명칭',placeRef:googleRef},reason:'후보'}]};}}});
 const draft=await service.generate(actor,tripId,{interests:[],pace:'balanced'},1);assert.equal(draft.items[0]!.placeStatus,'verified');assert.equal(draft.items[0]!.input.place,'');assert.deepEqual(draft.items[0]!.input.placeRef,googleRef);
 await service.adopt(actor,tripId,draft.id,[draft.items[0]!.id],randomUUID());assert.doesNotMatch(JSON.stringify(saved),/공급자 명칭|공급자 주소/);service.close();
});

test('Claude recommendation quotas survive service recreation and separate trip local day from user UTC day',async()=>{
 const f=fixture(),counts=new Map<string,number>(),seen=new Set<string>(),reservations:any[]=[];let calls=0,instant=Date.parse('2026-11-07T16:59:00Z');
 const usageStore={async reserve(row:any){reservations.push(row);const duplicate=`${row.scope}:${row.requestId}`;if(seen.has(duplicate))return false;seen.add(duplicate);const bucket=`${row.scope}:${row.periodKey}`;const count=counts.get(bucket)??0;if(count>=row.limit)return false;counts.set(bucket,count+1);return true;}};
 const create=()=>createRecommendationService({identityService:{async getTrip(){return {id:tripId,role:'editor',revision:1,destination:'서울',memberCount:2} as any;}},ledgerService:{async get(){return f.ledger;},async execute(){assert.fail('generation must not save');}},placeService:{async resolve(){return [];}},provider:{source:'claude',async generate(){calls++;return {items:[{input,reason:'후보'}]};}},usageStore,now:()=>instant} as any);
 for(let n=0;n<3;n++){const service=create();await service.generate(actor,tripId,{interests:[],pace:'balanced'},1);service.close();}
 const fourth=create();await assert.rejects(fourth.generate(actor,tripId,{interests:[],pace:'balanced'},1),{code:'rate_limited'});assert.equal(calls,3);fourth.close();
 const tripReservation=reservations[0],userReservation=reservations[1];assert.equal(tripReservation.scope,`recommendation:trip:${tripId}`);assert.equal(userReservation.scope,`recommendation:user:${actor.userId}`);assert.equal(tripReservation.periodKey,'2026-11-07');assert.equal(userReservation.periodKey,'2026-11-07');
 instant=Date.parse('2026-11-07T17:01:00Z');const nextLocalDay=create();await nextLocalDay.generate(actor,tripId,{interests:[],pace:'balanced'},1);assert.equal(reservations.at(-2).periodKey,'2026-11-08');assert.equal(reservations.at(-1).periodKey,'2026-11-07');assert.equal(calls,4);nextLocalDay.close();
 // Storage contract: changing period must not revive a spent reservation ID.
 assert.equal(await usageStore.reserve({...tripReservation,periodKey:'2026-11-08'}),false);
});

test('Claude recommendation requires durable quota storage and ambiguous failures remain charged',async()=>{
 const f=fixture();let calls=0;
 const options={identityService:{async getTrip(){return {id:tripId,role:'editor',revision:1,destination:'서울',memberCount:2} as any;}},ledgerService:{async get(){return f.ledger;},async execute(){assert.fail('must not save');}},placeService:{async resolve(){return [];}},provider:{source:'claude' as const,async generate(){calls++;throw Error('provider secret');}}};
 const missing=createRecommendationService(options);await assert.rejects(missing.generate(actor,tripId,{interests:[],pace:'balanced'},1),{code:'unavailable'});assert.equal(calls,0);missing.close();
 let tripCount=0,userCount=0;const usageStore={async reserve(row:any){if(row.scope.startsWith('recommendation:trip:'))return ++tripCount<=3;return ++userCount<=10;}};
 for(let n=0;n<4;n++){const service=createRecommendationService({...options,usageStore} as any);await assert.rejects(service.generate(actor,tripId,{interests:[],pace:'balanced'},1),{code:n===3?'rate_limited':'unavailable'});service.close();}assert.equal(calls,3);assert.equal(tripCount,4);assert.equal(userCount,3);
});
