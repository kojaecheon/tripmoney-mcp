import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readHttpConfig} from '../../server/http/config.js';
import {createCustomerAuthServer} from '../../server/http/server.js';
import type {AuthService} from '../../server/auth/service.js';
import {createApi,ApiError} from '../../web/api.mjs';
import {createAuthController} from '../../web/auth/controller.mjs';
import type {CustomerApi} from '../../web/api.mjs';

const origin='https://tripmoney.example.invalid';
const key=Buffer.alloc(32,7);
async function dispatch(path:string,config:any,data?:unknown) {
 const req=Readable.from(data===undefined?[]:[Buffer.from(JSON.stringify(data))]) as any;
 Object.assign(req,{url:path,method:data===undefined?'GET':'POST',socket:{remoteAddress:'127.0.0.1'},headers:{host:new URL(origin).host,origin,'content-type':'application/json','x-tripmoney-request':'1'},rawHeaders:['Host',new URL(origin).host,'Origin',origin,'Content-Type','application/json','X-TripMoney-Request','1']});
 const headers:Record<string,unknown>={};let status=0;
 const server=createCustomerAuthServer({config,authService:{requestCode:async()=>({challengeToken:key.toString('base64url')})} as unknown as AuthService});
 const raw=await new Promise<string>((resolve)=>server.emit('request',req,{get statusCode(){return status;},set statusCode(value){status=value;},setHeader(name:string,value:unknown){headers[name]=value;},end(value?:string|Buffer){resolve(Buffer.isBuffer(value)?value.toString():value??'');}}));
 return {status,headers,raw,body:raw.startsWith('{')?JSON.parse(raw):null};
}
test('customer mode exposes no demo code and uses mail wording',async()=>{
 const config=readHttpConfig({publicOrigin:origin,clientKey:key,mode:'customer',mailDelivery:true} as any);
 const result=await dispatch('/api/customer/public-config',config);
 assert.deepEqual(result.body,{mode:'customer',mailDelivery:true});
 assert.ok(!result.raw.includes('123456'));
 const requested=await dispatch('/api/customer/auth/request-code',config,{email:'traveler@example.invalid'});
 assert.equal(requested.body.message,'이메일로 받은 인증번호를 입력해 주세요.');
 const page=await dispatch('/',config);
 assert.ok(!page.raw.includes('123456'));
});
test('customer mode cannot use an insecure public origin or accept invalid mode',()=>{
 assert.throws(()=>readHttpConfig({publicOrigin:'http://127.0.0.1:8125',clientKey:key,mode:'customer'} as any));
 assert.throws(()=>readHttpConfig({publicOrigin:origin,clientKey:key,mode:'unknown'} as any));
});
test('browser accepts customer config only without a demo code',async()=>{
 const config={mode:'customer',mailDelivery:true};
 assert.deepEqual(await createApi(async()=>new Response(JSON.stringify(config))).publicConfig(),config);
 await assert.rejects(createApi(async()=>new Response(JSON.stringify({...config,code:'123456'}))).publicConfig());
 assert.deepEqual(await createApi(async()=>new Response(JSON.stringify({message:'이메일로 받은 인증번호를 입력해 주세요.'}))).requestCode('a@example.invalid'),{message:'이메일로 받은 인증번호를 입력해 주세요.'});
});
test('customer controller starts without fake email and never suggests the demo code',async()=>{
 const api={publicConfig:async()=>({mode:'customer',mailDelivery:true}),me:async()=>{throw new ApiError(401,'unauthenticated');},requestCode:async()=>({message:'이메일로 받은 인증번호를 입력해 주세요.'})} as unknown as CustomerApi;
 const controller=createAuthController(api);
 try {
  await controller.bootstrap();assert.equal(controller.state.email,'');
  controller.setEmail('real@example.invalid');await controller.requestCode();
  assert.equal(controller.state.phase,'code');assert.ok(!controller.state.status.includes('123456'));
 } finally {controller.destroy();}
});
