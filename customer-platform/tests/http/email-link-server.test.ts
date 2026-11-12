import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createCustomerAuthServer} from '../../server/http/server.js';
import {readHttpConfig} from '../../server/http/config.js';
import type {AuthService} from '../../server/auth/service.js';
const origin='https://tripmoney.example.invalid',token=Buffer.alloc(32,8).toString('base64url');
const me={userId:'10000000-0000-4000-8000-000000000001',email:'fixture@example.invalid',expiresAt:new Date(Date.now()+600000).toISOString()};
async function dispatch(path:string,{link=true,method='GET',data,headers={}}:{link?:boolean;method?:string;data?:unknown;headers?:Record<string,string>}={}){
 const calls:unknown[]=[];
 const config=readHttpConfig({publicOrigin:origin,clientKey:Buffer.alloc(32,9),mode:'customer',mailDelivery:true,...(link?{authMethod:'email-link'}:{})} as any);
 const service={requestCode:async()=>({challengeToken:token}),verifyEmailLink:async(...args:unknown[])=>{calls.push(args);return{sessionToken:token,me};}} as unknown as AuthService;
 const server=createCustomerAuthServer({config,authService:service});
 const req=Readable.from(data===undefined?[]:[Buffer.from(JSON.stringify(data))]) as any;
 const allHeaders={host:new URL(origin).host,origin,'x-tripmoney-request':'1','content-type':'application/json',cookie:`__Host-tripmoney_challenge=${token}`,...headers};
 Object.assign(req,{url:path,method,socket:{remoteAddress:'127.0.0.1'},headers:allHeaders,rawHeaders:Object.entries(allHeaders).flat()});
 let status=200;const responseHeaders:Record<string,any>={};
 const raw=await new Promise<string>(resolve=>server.emit('request',req,{get statusCode(){return status;},set statusCode(v){status=v;},setHeader(k:string,v:unknown){responseHeaders[k.toLowerCase()]=v;},end(v?:string|Buffer){resolve(Buffer.isBuffer(v)?v.toString():v??'');}}));
 return{status,raw,body:raw.startsWith('{')?JSON.parse(raw):null,headers:responseHeaders,calls};
}
test('link mode public configuration and request wording are opt-in while the callback remains a fixed static path',async()=>{
 const configured=await dispatch('/api/customer/public-config');assert.equal(configured.body.authMethod,'email-link');assert.ok(!configured.raw.includes('123456'));
 assert.equal((await dispatch('/api/customer/public-config',{link:false})).body.authMethod,undefined);
 const requested=await dispatch('/api/customer/auth/request-code',{method:'POST',data:{email:'fixture@example.invalid'}});
 assert.equal(requested.body.message,'로그인을 요청한 브라우저에서 이메일의 로그인 링크를 열어 주세요.');
 assert.equal((await dispatch('/auth/callback')).status,200);
 const script=await dispatch('/auth/email-link.mjs');assert.equal(script.status,200);assert.match(script.headers['content-type'],/^text\/javascript/);
 assert.throws(()=>readHttpConfig({publicOrigin:origin,clientKey:Buffer.alloc(32,9),mode:'local-demo',authMethod:'email-link'}));
 assert.equal((await dispatch('/auth/callback?access_token=PRIVATE')).status,404);
 assert.equal((await dispatch('/auth/%63allback')).status,404);
});
test('verify-link applies strict browser headers, challenge cookie and fixed session DTO',async()=>{
 const header=Buffer.from(JSON.stringify({alg:'ES256'})).toString('base64url');
 const payload=Buffer.from(JSON.stringify({sub:'fixture'})).toString('base64url');
 const signature=Buffer.from('synthetic').toString('base64url');
 const data={accessToken:[header,payload,signature].join('.'),refreshToken:'synthetic-refresh'};
 for(const headers of ([{origin:'https://other.invalid'},{'x-tripmoney-request':''},{'content-type':'text/plain'}] as Record<string,string>[])){
  const result=await dispatch('/api/customer/auth/verify-link',{method:'POST',data,headers});assert.equal(result.status,403);assert.equal(result.calls.length,0);
 }
 const missing=await dispatch('/api/customer/auth/verify-link',{method:'POST',data,headers:{cookie:''}});assert.equal(missing.status,401);assert.equal(missing.calls.length,0);
 const verified=await dispatch('/api/customer/auth/verify-link',{method:'POST',data});
 assert.equal(verified.status,200);assert.deepEqual(verified.body,{me});assert.deepEqual(verified.calls,[[token,data]]);
 assert.equal(verified.headers['set-cookie'].length,2);assert.ok(verified.headers['set-cookie'][0].startsWith('__Host-tripmoney_session='));
 assert.ok(verified.headers['set-cookie'][1].includes('Max-Age=0'));assert.ok(!verified.raw.includes('synthetic-'));
 assert.equal((await dispatch('/api/customer/auth/verify-link',{link:false,method:'POST',data})).status,404);
});
