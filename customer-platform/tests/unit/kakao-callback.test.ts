import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createKakaoService, type KakaoSkillRequest, type KakaoSkillResponse} from '../../server/channels/kakao/service.js';
import type {ChannelRepository, ProviderUsageStore} from '../../server/integration/contracts.js';

const secret='test-header-secret-with-at-least-32-characters';
const start=Date.parse('2026-11-08T00:00:00Z');
const response:KakaoSkillResponse={version:'2.0',template:{outputs:[{simpleText:{text:'내용을 확인해 주세요.'}}]}};
const request=(url='https://callback.example.invalid/token'):KakaoSkillRequest=>({headers:{'x-tripmoney-skill-secret':secret},rawBody:JSON.stringify({version:'2.0',bot:{id:'dev-bot'},userRequest:{user:{id:'bot-user',type:'botUserKey'},callbackUrl:url},action:{params:{command:'context'}}})});
function fixture() {
 let clock=start,calls=0;
 const reservations=new Set<string>();
 const usageStore:ProviderUsageStore={async reserve(input){const id=input.scope+'|'+input.requestId;if(reservations.has(id))return false;reservations.add(id);return true;}};
 const options={repository:{} as ChannelRepository,usageStore,skillSecret:secret,botId:'dev-bot',environment:'development' as const,now:()=>clock};
 const transport=async(input:any)=>{calls++;assert.equal(input.url,'https://callback.example.invalid/token');assert.equal(input.redirect,'error');assert.equal(input.headers['content-type'],'application/json');assert.equal(input.headers['x-tripmoney-skill-secret'],undefined);assert.equal(input.body,JSON.stringify(response));return {status:200,body:JSON.stringify({status:'SUCCESS',taskId:'fixture-task',timestamp:start})};};
 const callback={allowedHosts:['callback.example.invalid'],allowExternal:true,transport,timeoutMs:50};
 return {options,callback,usageStore,get calls(){return calls;},setTime:(value:number)=>{clock=value;}};
}

test('callbacks default to blocked even when a transport is supplied',async()=>{
 const f=fixture();
 for(const callback of [undefined,{...f.callback,allowExternal:false},{...f.callback,allowExternal:undefined},{...f.callback,transport:undefined}]){
  const service=createKakaoService({...f.options,callback});
  await assert.rejects(service.prepareCallback(request()),{code:'unavailable'});
 }
 assert.equal(f.calls,0);
});

test('callback URL accepts only exact public HTTPS hosts and rejects credentials, IPs and oversized URLs',async()=>{
 const f=fixture(),service=createKakaoService({...f.options,callback:f.callback});
 for(const url of ['http://callback.example.invalid/token','https://callback.example.invalid.evil.test/token','https://evil.test/token','https://user:password@callback.example.invalid/token','https://127.0.0.1/token','https://[::1]/token','https://callback.example.invalid:8443/token','https://callback.example.invalid./token','https://callback.example.invalid/#token','https://callback.example.invalid/'+ 'x'.repeat(2048)]){
  await assert.rejects(service.prepareCallback(request(url)),{code:'forbidden'});
 }
 const valid=request();
 await assert.rejects(service.prepareCallback({...valid,headers:{}}),{code:'forbidden'});
 assert.equal(f.calls,0);
});

test('a callback is single use across service instances and passes only the bounded response to transport',async()=>{
 const f=fixture();
 const service=createKakaoService({...f.options,callback:f.callback});
 const delivery=await service.prepareCallback(request());
 assert.deepEqual(delivery.ack,{version:'2.0',useCallback:true});
 assert.equal(delivery.expiresAt,new Date(start+55000).toISOString());
 const other=createKakaoService({...f.options,callback:f.callback});
 await assert.rejects(other.prepareCallback(request()),{code:'forbidden'});
 await delivery.send(response);
 await assert.rejects(delivery.send(response),{code:'forbidden'});
 assert.equal(f.calls,1);
});

test('expired or oversized callback bodies never cause an outbound call',async()=>{
 const f=fixture();
 const service=createKakaoService({...f.options,callback:f.callback});
 const delivery=await service.prepareCallback(request());
 f.setTime(start+55000);
 await assert.rejects(delivery.send(response),{code:'forbidden'});
 assert.equal(f.calls,0);
 const g=fixture();
 const oversized=await createKakaoService({...g.options,callback:g.callback}).prepareCallback(request());
 await assert.rejects(oversized.send({version:'2.0',template:{outputs:[{simpleText:{text:'x'.repeat(8193)}}]}}),{code:'validation'});
 await assert.rejects(oversized.send(response),{code:'forbidden'});
 assert.equal(g.calls,0);
});

test('ambiguous failures, excessive responses and timeouts remain consumed and expose safe errors',async()=>{
 for(const kind of ['failure','oversized','timeout']){
  const f=fixture();let attempts=0,signal:AbortSignal|undefined;
  const transport=async(input:any)=>{attempts++;signal=input.signal;if(kind==='failure')throw new Error('SECRET https://private.invalid/token');if(kind==='oversized')return {status:200,body:'x'.repeat(4097)};return new Promise<never>(()=>{});};
  const service=createKakaoService({...f.options,callback:{...f.callback,transport,timeoutMs:5}});
  const delivery=await service.prepareCallback(request());
  await assert.rejects(delivery.send(response),(error:any)=>{assert.equal(error.code,'unavailable');assert.equal(error.message.includes('SECRET'),false);assert.equal(error.message.includes('private.invalid'),false);return true;});
  await assert.rejects(delivery.send(response),{code:'forbidden'});
  await assert.rejects(service.prepareCallback(request()),{code:'forbidden'});
  assert.equal(attempts,1);
  if(kind==='timeout')assert.equal(signal?.aborted,true);
 }
});

test('a slow durable reservation cannot issue an already expired callback acknowledgement',async()=>{
 const f=fixture();
 const usageStore:ProviderUsageStore={async reserve(input){if(input.scope.startsWith('kakao:callback:'))f.setTime(start+55000);return true;}};
 const service=createKakaoService({...f.options,usageStore,callback:f.callback});
 await assert.rejects(service.prepareCallback(request()),{code:'forbidden'});
 assert.equal(f.calls,0);
});

test('HTTP success with a Kakao callback failure is not reported as successful delivery',async()=>{
 const f=fixture();
 const service=createKakaoService({...f.options,callback:{...f.callback,transport:async()=>({status:200,body:JSON.stringify({status:'FAIL',message:'SECRET token https://private.invalid'})})}});
 const delivery=await service.prepareCallback(request());
 await assert.rejects(delivery.send(response),(error:any)=>{assert.equal(error.code,'unavailable');assert.equal(error.message.includes('SECRET'),false);return true;});
});

test('administrator bot test callback tokens are refused without outbound transport',async()=>{
 const f=fixture(),incoming=request();
 const payload=JSON.parse(String(incoming.rawBody));payload.userRequest.params={surface:'BuilderBotTest'};
 const service=createKakaoService({...f.options,callback:f.callback});
 await assert.rejects(service.prepareCallback({...incoming,rawBody:JSON.stringify(payload)}),{code:'forbidden'});
 assert.equal(f.calls,0);
});
