import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createApi} from '../../web/api.mjs';
const id='10000000-0000-4000-8000-000000000001';
const candidate={ref:{provider:'demo',placeId:'demo-cafe'},name:'합성 카페',address:'합성 주소',lat:37,lng:127,source:'synthetic'};
test('planning client sends account-bound POSTs and projects place data',async()=>{
  let sent:any,body:any={places:[{...candidate,secret:'private'}]};
  const api=createApi(async(url,init)=>{sent={url,init};return new Response(JSON.stringify(body));});
  assert.equal(typeof api.searchPlaces,'function');
  assert.deepEqual(await api.searchPlaces(id,'카페','account'),[candidate]);
  assert.equal(sent.url,`/api/customer/trips/${id}/places/search`);
  assert.equal(new Headers(sent.init.headers).get('X-TripMoney-Expected-Account'),'account');
  assert.deepEqual(JSON.parse(sent.init.body),{query:'카페'});
  body={places:[{...candidate,lat:91}]};
  await assert.rejects(api.searchPlaces(id,'카페','account'),{code:'invalid_response'});
});
test('planning client rejects cross-trip drafts and projects allowed fields only',async()=>{
  let draft:any={tripId:id,baseRevision:3,kind:'expense',source:'synthetic',fields:{title:'택시',currency:'KRW',amount:'15000',admin:true},missing:['payerId','splitIds'],warnings:['합성 체험']};
  const api=createApi(async()=>new Response(JSON.stringify({draft})));
  assert.equal(typeof api.generateDraft,'function');
  assert.equal(Object.hasOwn((await api.generateDraft(id,'택시 15000원',3,'account')).fields,'admin'),false);
  draft={...draft,tripId:'20000000-0000-4000-8000-000000000001'};
  await assert.rejects(api.generateDraft(id,'택시 15000원',3,'account'),{code:'invalid_response'});
  draft={...draft,tripId:id,baseRevision:2};
  await assert.rejects(api.generateDraft(id,'택시 15000원',3,'account'),{code:'invalid_response'});
});
