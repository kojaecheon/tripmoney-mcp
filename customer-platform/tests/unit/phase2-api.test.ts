import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createApi} from '../../web/api.mjs';
const tripId='10000000-0000-4000-8000-000000000001',draftId='20000000-0000-4000-8000-000000000001',itemId='30000000-0000-4000-8000-000000000001';
const at='2026-11-07T12:00:00.000Z';
const input={date:'2026-11-07',startTime:'10:00',endTime:'11:00',title:'후보',place:'체험 카페',budgetKrw:1000,placeRef:{provider:'demo' as const,placeId:'demo-cafe'}};
test('recommendation client projects candidates and sends account-bound selection only',async()=>{
  let sent:any,body:any={recommendation:{id:draftId,tripId,baseRevision:3,source:'synthetic',expiresAt:at,
    items:[{id:itemId,input:{...input,secret:'private'},reason:'합성 예시',placeStatus:'synthetic',actor:'private'}],warnings:[]}};
  const api=createApi(async(url,init)=>{sent={url,init};return new Response(JSON.stringify(body));});
  assert.equal(typeof api.generateRecommendation,'function');
  const dto=await api.generateRecommendation(tripId,{interests:['산책'],pace:'balanced'},3,'account');
  assert.deepEqual(dto.items[0]!.input,input);
  assert.equal(new Headers(sent.init.headers).get('X-TripMoney-Expected-Account'),'account');
  body={value:{targetId:itemId},tripRevision:4,replayed:false,actor:'private'};
  await api.adoptRecommendation(tripId,draftId,[itemId],draftId,'account');
  assert.deepEqual(JSON.parse(sent.init.body),{selectedIds:[itemId],operationId:draftId});
  body={recommendation:{...dto,tripId:itemId}};
  await assert.rejects(api.generateRecommendation(tripId,{interests:[],pace:'balanced'},3,'account'),{code:'invalid_response'});
});
test('local channel client keeps secrets out of projected status and sends confirmation token only',async()=>{
  let sent:any,body:any={status:{source:'synthetic',linked:false,expiresAt:null,tripId:null,trips:[],actor:{sessionHash:'private'}}};
  const api=createApi(async(url,init)=>{sent={url,init};return new Response(JSON.stringify(body));});
  assert.equal(typeof api.kakaoStatus,'function');
  assert.deepEqual(await api.kakaoStatus('account'),{source:'synthetic',linked:false,expiresAt:null,tripId:null,trips:[]});
  assert.equal(sent.init.method,'GET');
  body={confirmation:{token:'a'.repeat(43),tripId,tripName:'합성 여행',kind:'schedule',input,baseRevision:3,expiresAt:at,actor:'private'}};
  const confirmation=await api.reviewKakaoDraft(draftId,input,'account');
  assert.equal(Object.hasOwn(confirmation,'actor'),false);
  body={value:{targetId:itemId},tripRevision:4,replayed:false};
  await api.confirmKakao(confirmation.token,draftId,'account');
  assert.equal(sent.url,'/api/customer/kakao-local/confirm');
  assert.deepEqual(JSON.parse(sent.init.body),{token:confirmation.token,operationId:draftId});
});
