import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test, {type TestContext} from 'node:test';
import {IdentityError} from '../../core/contracts.js';
import {createLocalRuntime} from '../../server/local/runtime.js';

const contractsPath = '../../core/places/contracts.js';
const servicePath = '../../server/places/service.js';
const providerPath = '../../server/places/synthetic-provider.js';
const cafe = {ref:{provider:'demo',placeId:'demo-cafe'},name:'체험 카페',address:'합성 장소, 실제 주소 없음',lat:37.56,lng:126.97,source:'synthetic'};
const park = {ref:{provider:'demo',placeId:'demo-park'},name:'체험 공원',address:'합성 장소, 실제 주소 없음',lat:37.57,lng:126.98,source:'synthetic'};
async function modules() {
  return {...await import(contractsPath), ...await import(servicePath), ...await import(providerPath)};
}
async function fixture(t: TestContext) {
  const r = createLocalRuntime(); t.after(()=>r.close());
  const login = async (name:string) => {
    const challenge = await r.authService.requestCode(name+'@example.invalid','5'.repeat(64));
    const result = await r.authService.verifyCode(challenge.challengeToken,'123456');
    return (await r.authService.authenticate(result.sessionToken)).actor;
  };
  const actor = await login('maps-owner');
  const {value:{trip}} = await r.identityService.createTrip(actor,{name:'지도 체험',destination:'서울',alias:'소유자',
    startDate:'2026-11-07',endDate:'2026-11-08',timeZone:'Asia/Seoul',budgetKrw:10000,settlementMode:'end_of_trip',dailyTime:'20:00'},randomUUID());
  const m = await modules();
  return {r,actor,id:trip.id,login,...m};
}

test('place references reject extra fields, unknown providers, oversized IDs and controls', async () => {
  const {normalizePlaceRef} = await modules();
  assert.deepEqual(normalizePlaceRef({provider:'google',placeId:'ChIJ_demo-1'}),{provider:'google',placeId:'ChIJ_demo-1'});
  assert.deepEqual(normalizePlaceRef(cafe.ref),cafe.ref);
  for (const input of [null,{},[],{...cafe.ref,lat:1},{provider:'osm',placeId:'a'},
    {provider:'google',placeId:''},{provider:'demo',placeId:'x'.repeat(257)},
    {provider:'google',placeId:'a\nb'},{provider:'google',placeId:' a'}, {provider:'google',placeId:'a b'}]) {
    assert.equal(normalizePlaceRef(input),null);
  }
});

test('synthetic search and resolve keep fixture identity, do not invent matches for text or Google IDs', async t => {
  const f = await fixture(t), provider = f.createSyntheticPlaceProvider();
  const service = f.createPlaceService({ledgerService:f.r.ledgerService,provider});
  assert.deepEqual(await service.search(f.actor,f.id,'카페'),[cafe]);
  assert.deepEqual(await service.search(f.actor,f.id,'없는 실제 식당'),[]);
  assert.deepEqual(await service.resolve(f.actor,f.id,[park.ref,cafe.ref]),[park,cafe]);
  assert.deepEqual(await service.resolve(f.actor,f.id,[{provider:'google',placeId:'ChIJ_unknown'}]),[]);
  assert.deepEqual(await service.route(f.actor,f.id,[cafe.ref,park.ref],'walking'),{
    status:'ok',source:'synthetic',mode:'walking',message:'합성 장소를 직선으로 연결한 체험 경로입니다. 실제 도로와 이동 시간은 제공하지 않습니다.',
    places:[cafe,park],path:[{lat:37.56,lng:126.97},{lat:37.57,lng:126.98}],
  });
  const unsupported = await service.route(f.actor,f.id,[cafe.ref,{provider:'google',placeId:'ChIJ_unknown'}],'driving');
  assert.equal(unsupported.status,'unsupported');
  assert.deepEqual((await f.r.ledgerService.get(f.actor,f.id)).items,[]);
});

test('every place operation checks current trip membership before provider calls', async t => {
  const f = await fixture(t), outsider = await f.login('maps-outsider');
  const provider = {search:async()=>assert.fail('unauthorized search'),resolve:async()=>assert.fail('unauthorized resolve'),route:async()=>assert.fail('unauthorized route')};
  const service = f.createPlaceService({ledgerService:f.r.ledgerService,provider});
  for (const operation of [()=>service.search(outsider,f.id,'카페'),()=>service.resolve(outsider,f.id,[cafe.ref]),
    ()=>service.route(outsider,f.id,[cafe.ref,park.ref],'walking')]) await assert.rejects(operation(),{code:'not_found'});
});

test('invalid queries, references, limits and modes never reach the provider', async t => {
  const f = await fixture(t);
  const provider = {search:async()=>assert.fail('invalid search'),resolve:async()=>assert.fail('invalid resolve'),route:async()=>assert.fail('invalid route')};
  const service = f.createPlaceService({ledgerService:f.r.ledgerService,provider});
  for (const query of ['', 'x'.repeat(121),'카페\n']) await assert.rejects(service.search(f.actor,f.id,query),{code:'validation'});
  for (const refs of [[{...cafe.ref,secret:'x'}],Array(61).fill(cafe.ref),[cafe.ref,cafe.ref]]) {
    await assert.rejects(service.resolve(f.actor,f.id,refs),{code:'validation'});
  }
  await assert.rejects(service.route(f.actor,f.id,[cafe.ref],'walking'),{code:'validation'});
  await assert.rejects(service.route(f.actor,f.id,[cafe.ref,park.ref],'flying'),{code:'validation'});
});

test('provider output is projected and rejects forged sources, invalid coordinates and unrelated resolved IDs', async t => {
  const f = await fixture(t);
  let output:unknown = [{...cafe,privateToken:'hidden'}];
  const provider = {search:async()=>output,resolve:async()=>output,route:async()=>null};
  const service = f.createPlaceService({ledgerService:f.r.ledgerService,provider});
  assert.deepEqual(await service.search(f.actor,f.id,'카페'),[cafe]);
  for (const bad of [[{...cafe,lat:91}],[{...cafe,lng:Infinity}],[{...cafe,source:'google'}],
    [{...cafe,name:'x'.repeat(201)}],Array(21).fill(cafe),[{...cafe,address:'bad\u0000address'}]]) {
    output = bad; await assert.rejects(service.search(f.actor,f.id,'카페'),{code:'unavailable'});
  }
  output = [park];
  await assert.rejects(service.resolve(f.actor,f.id,[cafe.ref]),{code:'unavailable'});
  output = [cafe,cafe];
  await assert.rejects(service.resolve(f.actor,f.id,[cafe.ref]),{code:'unavailable'});
});

test('route failures are safe explicit previews and cannot expose provider exceptions or malformed geometry', async t => {
  const f = await fixture(t); let output:unknown = null; let fail = false;
  const provider = {search:async()=>{throw Error('secret upstream');},resolve:async()=>[],route:async()=>{if(fail)throw Error('secret upstream');return output;}};
  const service = f.createPlaceService({ledgerService:f.r.ledgerService,provider});
  await assert.rejects(service.search(f.actor,f.id,'카페'),{code:'unavailable'});
  output = {status:'ok',source:'synthetic',mode:'walking',message:'합성',places:[cafe,park],path:[{lat:NaN,lng:1}]};
  assert.equal((await service.route(f.actor,f.id,[cafe.ref,park.ref],'walking')).status,'error');
  fail = true;
  const result = await service.route(f.actor,f.id,[cafe.ref,park.ref],'walking');
  assert.equal(result.status,'error'); assert.doesNotMatch(JSON.stringify(result),/secret/);
});

test('membership revoked during a provider request blocks the pending response', async t => {
  const f = await fixture(t); let allowed = true; let release:(v:unknown)=>void=()=>{};
  const ledgerService = {get:async()=>{if(!allowed)throw new IdentityError('not_found','없음');return f.r.ledgerService.get(f.actor,f.id);}};
  const service = f.createPlaceService({ledgerService,provider:{search:()=>new Promise(resolve=>{release=resolve;}),resolve:async()=>[],route:async()=>null}});
  const pending = service.search(f.actor,f.id,'카페');
  await new Promise(resolve=>setImmediate(resolve)); allowed=false; release([cafe]);
  await assert.rejects(pending,{code:'not_found'});
});

test('a provider cannot rewrite the requested references to authorize unrelated response places',async t=>{
  const f=await fixture(t);
  const service=f.createPlaceService({ledgerService:f.r.ledgerService,provider:{search:async()=>[],
    resolve:async(refs:any[])=>{refs[0].placeId='demo-park';return[park];},route:async()=>null}});
  await assert.rejects(service.resolve(f.actor,f.id,[cafe.ref]),{code:'unavailable'});
  assert.equal(cafe.ref.placeId,'demo-cafe');
});

test('route preserves repeated visits in order while resolve continues to reject duplicate references',async t=>{
  const f=await fixture(t), service=f.createPlaceService({ledgerService:f.r.ledgerService,provider:f.createSyntheticPlaceProvider()});
  const route=await service.route(f.actor,f.id,[cafe.ref,park.ref,cafe.ref],'walking');
  assert.equal(route.status,'ok');
  assert.deepEqual(route.places,[cafe,park,cafe]);
  assert.deepEqual(route.path,[{lat:37.56,lng:126.97},{lat:37.57,lng:126.98},{lat:37.56,lng:126.97}]);
  const samePlace=await service.route(f.actor,f.id,[cafe.ref,cafe.ref],'driving');
  assert.equal(samePlace.status,'ok');assert.deepEqual(samePlace.places,[cafe,cafe]);
  await assert.rejects(service.resolve(f.actor,f.id,[cafe.ref,park.ref,cafe.ref]),{code:'validation'});
  await assert.rejects(service.route(f.actor,f.id,Array(21).fill(cafe.ref),'walking'),{code:'validation'});
});

test('route rejects a provider changing repeated visit order or dropping the return visit',async t=>{
  const f=await fixture(t);let places=[cafe,cafe,park];
  const service=f.createPlaceService({ledgerService:f.r.ledgerService,provider:{search:async()=>[],resolve:async()=>[],
    route:async()=>({status:'ok',source:'synthetic',mode:'walking',message:'합성 체험',places,path:[{lat:37.56,lng:126.97},{lat:37.57,lng:126.98}]})}});
  assert.equal((await service.route(f.actor,f.id,[cafe.ref,park.ref,cafe.ref],'walking')).status,'error');
  places=[cafe,park];
  assert.equal((await service.route(f.actor,f.id,[cafe.ref,park.ref,cafe.ref],'walking')).status,'error');
});

test('Google route failures keep Google source instead of describing the failure as synthetic',async t=>{
 const f=await fixture(t),service=f.createPlaceService({ledgerService:f.r.ledgerService,provider:{search:async()=>[],resolve:async()=>[],route:async()=>{throw Error('upstream secret');}}});
 const route=await service.route(f.actor,f.id,[{provider:'google',placeId:'ChIJ_a'},{provider:'google',placeId:'ChIJ_b'}],'walking');assert.equal(route.status,'error');assert.equal(route.source,'google');assert.doesNotMatch(route.message,/체험|secret/);
});
