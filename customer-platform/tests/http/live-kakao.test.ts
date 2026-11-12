import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {createCustomerAuthServer} from '../../server/http/server.js';
import {readHttpConfig} from '../../server/http/config.js';
import type {AuthService} from '../../server/auth/service.js';
const origin='https://tripmoney.example.invalid',host=new URL(origin).host;
const userId='10000000-0000-4000-8000-000000000001',tripId='20000000-0000-4000-8000-000000000001';
const token=Buffer.alloc(32,8).toString('base64url');
async function fixture(enabled=true) {
 const calls:any[]=[];
 const kakaoService={async handleSkill(input:any){calls.push(['skill',input]);return typeof input.headers['x-tripmoney-skill-secret']==='string'?{status:200,body:{version:'2.0',template:{outputs:[]}}}:{status:403,body:{error:{code:'forbidden',message:'허용되지 않은 요청입니다.'}}};},
  async issuePair(actor:any,id:string){calls.push(['pair',actor,id]);return{code:'fixture',expiresAt:'2026-11-08T00:05:00Z'};},
  async approvePair(actor:any,id:string,expectedTripId?:string){calls.push(['approve',actor,id,expectedTripId]);return{grantId:id};},async unlink(actor:any,id:string){calls.push(['unlink',actor,id]);}};
 const config=readHttpConfig({publicOrigin:origin,clientKey:Buffer.alloc(32,9),mode:'customer'});
 const server=createCustomerAuthServer({config,authService:{authenticate:async()=>({actor:{userId,sessionHash:'a'.repeat(64)}})} as unknown as AuthService,...(enabled?{kakaoService}:{} as any)} as any);
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const asset=(path:string)=>new Promise<any>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:(server.address() as AddressInfo).port,path,headers:{Host:host}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:text,type:res.headers['content-type']}));});req.on('error',reject);req.end();});
 const publicConfig=()=>new Promise<any>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:(server.address() as AddressInfo).port,path:'/api/customer/public-config',headers:{Host:host}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve(JSON.parse(text)));});req.on('error',reject);req.end();});
 const send=(path:string,headers:Record<string,string|string[]>={},body='{}')=>new Promise<any>((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:(server.address() as AddressInfo).port,method:'POST',path,headers:{Host:host,'Content-Type':'application/json',...headers}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),headers:res.headers}));});req.on('error',reject);req.end(body);
 });
 return {calls,send,publicConfig,asset,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
test('skill endpoint is opt-in and separate from cookie and browser Origin authentication',async()=>{
 const absent=await fixture(false);try{assert.equal((await absent.send('/api/channels/kakao/skill')).status,404);}finally{await absent.close();}
 const f=await fixture();try {
  const result=await f.send('/api/channels/kakao/skill',{'x-tripmoney-skill-secret':'fixture'});
  assert.equal(result.status,200);assert.equal(f.calls[0][0],'skill');
  assert.equal(result.headers['set-cookie'],undefined);
 } finally {await f.close();}
});
test('skill adapter preserves duplicate secret headers as an array and rejects oversized bodies',async()=>{
 const f=await fixture();try {
  assert.equal((await f.send('/api/channels/kakao/skill',{'x-tripmoney-skill-secret':['first','second']})).status,403);
  assert.ok(Array.isArray(f.calls[0][1].headers['x-tripmoney-skill-secret']));
  const count=f.calls.length;
  assert.equal((await f.send('/api/channels/kakao/skill',{},'x'.repeat(16385))).status,413);
  assert.equal(f.calls.length,count);
 } finally {await f.close();}
});
test('web pairing requires cookie, Origin, expected account and exact fields',async()=>{
 const f=await fixture();const body=JSON.stringify({tripId});
 const headers={Origin:origin,'X-TripMoney-Request':'1','X-TripMoney-Expected-Account':userId,Cookie:`__Host-tripmoney_session=${token}`};
 try {
  assert.equal((await f.send('/api/customer/kakao/pair',{},body)).status,403);
  assert.equal((await f.send('/api/customer/kakao/pair',{...headers,Cookie:''},body)).status,401);
  assert.equal((await f.send('/api/customer/kakao/pair',{...headers,'X-TripMoney-Expected-Account':'other'},body)).status,412);
  assert.equal((await f.send('/api/customer/kakao/pair',headers,JSON.stringify({tripId,admin:true}))).status,422);
  assert.equal(f.calls.length,0);
  assert.equal((await f.send('/api/customer/kakao/pair',headers,body)).status,200);
  assert.deepEqual(f.calls[0],['pair',{userId,sessionHash:'a'.repeat(64)},tripId]);
 } finally {await f.close();}
});

test('customer config advertises development Kakao only when the live service is wired',async()=>{
 const absent=await fixture(false);try{assert.equal((await absent.publicConfig()).channels,undefined);}finally{await absent.close();}
 const live=await fixture();try{assert.deepEqual((await live.publicConfig()).channels,{kakao:{mode:'development',channelUrl:'https://pf.kakao.com/_xjvDxeX',botName:'TripMoney 개발봇'}});}finally{await live.close();}
});

test('live pairing modules are served from the fixed static allowlist',async()=>{
 const f=await fixture();try {
  for(const path of ['/kakao/api.mjs','/kakao/validation.mjs','/kakao/controller.mjs','/kakao/view.mjs','/kakao/mount.mjs','/kakao/style.css']){
   const response=await f.asset(path);assert.equal(response.status,200,path);assert.match(response.type,path.endsWith('.css')?/^text\/css/:/^text\/javascript/);
  }
  assert.equal((await f.asset('/kakao/../api.mjs')).status,404);
 } finally {await f.close();}
});

test('web approval requires exactly pendingId and expected tripId before calling the service',async()=>{
 const f=await fixture(),pendingId='30000000-0000-4000-8000-000000000001';
 const headers={Origin:origin,'X-TripMoney-Request':'1','X-TripMoney-Expected-Account':userId,Cookie:`__Host-tripmoney_session=${token}`};
 try {
  for(const body of [{pendingId},{tripId},{pendingId,tripId,extra:true},{pendingId,tripId:'invalid'},{pendingId:'invalid',tripId}]){
   assert.equal((await f.send('/api/customer/kakao/approve',headers,JSON.stringify(body))).status,422);
  }
  assert.equal(f.calls.length,0);
  assert.equal((await f.send('/api/customer/kakao/approve',headers,JSON.stringify({pendingId,tripId}))).status,200);
  assert.deepEqual(f.calls[0],['approve',{userId,sessionHash:'a'.repeat(64)},pendingId,tripId]);
  assert.equal((await f.send('/api/customer/kakao/pair',headers,JSON.stringify({tripId,pendingId}))).status,422);
  assert.equal((await f.send('/api/customer/kakao/unlink',headers,JSON.stringify({grantId:pendingId,tripId}))).status,422);
  assert.equal((await f.send('/api/customer/kakao/unlink',headers,JSON.stringify({grantId:pendingId}))).status,200);
 }finally{await f.close();}
});
