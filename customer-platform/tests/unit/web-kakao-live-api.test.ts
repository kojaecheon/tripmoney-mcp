import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi,ApiError} from '../../web/api.mjs';
const account='20000000-0000-4000-8000-000000000001',trip='10000000-0000-4000-8000-000000000001',pending='30000000-0000-4000-8000-000000000001',grant='40000000-0000-4000-8000-000000000001';
const expiresAt='2099-01-01T00:00:00.000Z',pair={code:'0123456789abcdef01234567',expiresAt};
const channels={kakao:{mode:'development',channelUrl:'https://pf.kakao.com/_xjvDxeX',botName:'TripMoney 개발봇'}};
const json=(body:unknown)=>new Response(JSON.stringify(body));
const invalid=(error:unknown)=>error instanceof ApiError&&error.code==='invalid_response';
// Catches dropping channels from the allowlist or accepting another channel / unsafe URL.
test('public config accepts only the designated Kakao development channel',async()=>{
 const base={mode:'customer',mailDelivery:true};
 assert.deepEqual(await createApi(async()=>json({...base,channels})).publicConfig(),{...base,channels});
 for(const value of [{},null,{...channels,secret:'no'},{kakao:{...channels.kakao,channelUrl:'https://pf.kakao.com/other'}},{kakao:{...channels.kakao,mode:'production'}},{kakao:{...channels.kakao,token:'no'}}])await assert.rejects(createApi(async()=>json({...base,channels:value})).publicConfig(),invalid);
});
// Catches crossing the real endpoints with synthetic ones, leaked URL payloads, or missing account guards.
test('real pairing writes carry only the explicit IDs and expected account header',async()=>{
 const calls:{url:string;init:RequestInit}[]=[],responses:unknown[]=[pair,{grantId:grant,tripId:trip,expiresAt},{unlinked:true}];
 const api:any=createApi(async(url,init)=>{calls.push({url,init});return json(responses.shift());});
 assert.deepEqual(await api.issueKakaoLivePair(trip,account),pair);
 assert.deepEqual(await api.approveKakaoLivePair(pending,trip,account),{grantId:grant,tripId:trip,expiresAt});
 assert.deepEqual(await api.unlinkKakaoLive(grant,account),{unlinked:true});
 assert.deepEqual(calls.map(c=>c.url),['/api/customer/kakao/pair','/api/customer/kakao/approve','/api/customer/kakao/unlink']);
 assert.deepEqual(calls.map(c=>JSON.parse(c.init.body as string)),[{tripId:trip},{pendingId:pending,tripId:trip},{grantId:grant}]);
 for(const {init} of calls){assert.equal(init.method,'POST');assert.equal(init.credentials,'same-origin');assert.equal((init.headers as any)['X-TripMoney-Expected-Account'],account);assert.equal((init.headers as any)['X-TripMoney-Request'],'1');}
});
// Catches malformed inputs causing network work and untrusted responses being presented as an approval.
test('real API refuses malformed IDs, codes, timestamps and additional response fields',async()=>{
 let calls=0;const api:any=createApi(async()=>{calls++;return json(pair);});
 for(const args of [['bad',account],[trip,''],[trip,'00000000-0000-0000-0000-000000000000']])await assert.rejects(api.issueKakaoLivePair(...args),invalid);
 assert.equal(calls,0);
 for(const bad of [{...pair,code:'ABCDEF0123456789abcdef01'},{...pair,code:'short'},{...pair,expiresAt:'2099-02-30T00:00:00.000Z'},{...pair,expiresAt:'2020-01-01T00:00:00Z'},{...pair,secret:'no'}])await assert.rejects((createApi(async()=>json(bad)) as any).issueKakaoLivePair(trip,account),invalid);
 for(const bad of [{grantId:'bad',tripId:trip,expiresAt},{grantId:grant,tripId:'bad',expiresAt},{grantId:grant,tripId:trip,expiresAt:'tomorrow'},{grantId:grant,tripId:trip,expiresAt,token:'no'}])await assert.rejects((createApi(async()=>json(bad)) as any).approveKakaoLivePair(pending,trip,account),invalid);
 for(const bad of [{unlinked:false},{unlinked:true,grantId:grant},{}])await assert.rejects((createApi(async()=>json(bad)) as any).unlinkKakaoLive(grant,account),invalid);
});
