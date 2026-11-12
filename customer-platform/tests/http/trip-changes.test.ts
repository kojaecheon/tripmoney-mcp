import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {request,type IncomingHttpHeaders} from 'node:http';
import type {AddressInfo} from 'node:net';
import test,{type TestContext} from 'node:test';
import {createLocalRuntime} from '../../server/local/runtime.js';
import {createCustomerAuthServer} from '../../server/http/server.js';
import {readHttpConfig} from '../../server/http/config.js';
import {createTripChangeNotifier,createTripChangesService,createNotifyingServices} from '../../server/sync/service.js';

const origin='http://127.0.0.1:8125';
const input={name:'공동 여행',destination:'서울',startDate:'2026-11-08',endDate:'2026-11-09',timeZone:'Asia/Seoul',budgetKrw:1000000,settlementMode:'daily',dailyTime:'20:00',alias:'소유자'};
async function setup(t:TestContext,observeWait?:(signal:AbortSignal)=>void){
 const runtime=createLocalRuntime(),notifier=createTripChangeNotifier();
 const services=createNotifyingServices({...runtime,notifier});
 const changesService=createTripChangesService(notifier,{heartbeatMs:120,probeMs:20});
 const server=createCustomerAuthServer({config:readHttpConfig({publicOrigin:origin,clientKey:randomBytes(32)}),authService:runtime.authService,...services,changesService:{...changesService,wait(options){if(options.signal)observeWait?.(options.signal);return changesService.wait(options);}}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=(server.address() as AddressInfo).port;
 t.after(async()=>{changesService.close();runtime.close();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 type Result={status:number;body:any;headers:IncomingHttpHeaders};
 function send(path:string,body?:unknown,cookie='',account='',extra:Record<string,string|string[]>={},method=body===undefined?'GET':'POST'):Promise<Result>{
  const payload=body===undefined?undefined:JSON.stringify(body);
  const headers={Host:'127.0.0.1:8125',Origin:origin,'X-TripMoney-Request':'1','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(account?{'X-TripMoney-Expected-Account':account}:{}),...extra};
  return new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path,method,headers:Object.entries(headers).flatMap(([k,v])=>(Array.isArray(v)?v:[v]).flatMap(x=>[k,x]))},res=>{let raw='';res.setEncoding('utf8');res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode!,body:raw?JSON.parse(raw):null,headers:res.headers}));res.on('error',reject);});req.on('error',reject);req.end(payload);});
 }
 async function login(email:string){
  const challenge=await send('/api/customer/auth/request-code',{email});assert.equal(challenge.status,200);
  const logged=await send('/api/customer/auth/verify-code',{code:'123456'},challenge.headers['set-cookie']![0]!.split(';')[0]);assert.equal(logged.status,200);
  return {cookie:logged.headers['set-cookie']!.find(x=>x.startsWith('tripmoney_session_dev='))!.split(';')[0]!,account:logged.body.me.userId as string};
 }
 const owner=await login('owner@example.invalid');
 const made=await send('/api/customer/trips',{...input,operationId:randomUUID()},owner.cookie,owner.account);assert.equal(made.status,200);
 const id=made.body.value.trip.id as string,path=`/api/customer/trips/${id}/changes`;
 return {runtime,services,changesService,send,login,owner,id,path,port};
}
test('change endpoint advertises opt-in and returns only current authorized revision',async t=>{
 const f=await setup(t);const config=await f.send('/api/customer/public-config');assert.deepEqual(config.body.changes,{mode:'long-poll'});
 const result=await f.send(f.path,{afterRevision:0},f.owner.cookie,f.owner.account);
 assert.equal(result.status,200);assert.deepEqual(result.body,{tripId:f.id,revision:1});assert.equal(result.headers['set-cookie'],undefined);
 const heartbeat=await f.send(f.path,{afterRevision:1},f.owner.cookie,f.owner.account);assert.deepEqual(heartbeat.body,result.body);
});
test('change endpoint requires CSRF, one expected account and strict body without deleting cookies',async t=>{
 const f=await setup(t);
 for(const [body,account,extra,status] of [
  [{afterRevision:1},'',{},422],
  [{afterRevision:1},randomUUID(),{},412],
  [{afterRevision:1},f.owner.account,{'X-TripMoney-Expected-Account':[f.owner.account,f.owner.account]},422],
  [{afterRevision:1},f.owner.account,{Origin:'http://evil.invalid'},403],
  [{afterRevision:1,token:'private'},f.owner.account,{},422],
  [{afterRevision:-1},f.owner.account,{},422],
 ] satisfies [unknown,string,Record<string,string|string[]>,number][]){const r=await f.send(f.path,body,f.owner.cookie,account,extra);assert.equal(r.status,status);assert.equal(r.headers['set-cookie'],undefined);}
 const anonymous=await f.send(f.path,{afterRevision:1},'',f.owner.account);assert.equal(anonymous.status,401);assert.equal(anonymous.headers['set-cookie'],undefined);
});
test('successful ledger commit wakes its authorized waiter and unrelated traveler cannot read signal',async t=>{
 const f=await setup(t);const stranger=await f.login('stranger@example.invalid');
 assert.equal((await f.send(f.path,{afterRevision:0},stranger.cookie,stranger.account)).status,404);
 const pending=f.send(f.path,{afterRevision:1},f.owner.cookie,f.owner.account);
 const saved=await f.send(`/api/customer/trips/${f.id}/ledger/commands`,{command:{type:'schedule.create',input:{date:input.startDate,startTime:'',endTime:'',title:'경복궁',place:'',budgetKrw:20000}},expectedRevision:1,operationId:randomUUID()},f.owner.cookie,f.owner.account);
 assert.equal(saved.status,200);assert.deepEqual((await pending).body,{tripId:f.id,revision:2});
});
test('expired captured session is rechecked during wait and never clears a newer cookie',async t=>{
 let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 const f=await setup(t,entered);const pending=f.send(f.path,{afterRevision:1},f.owner.cookie,f.owner.account);await started;
 const logged=await f.send('/api/customer/auth/logout',{},f.owner.cookie);assert.equal(logged.status,204);
 const result=await pending;assert.equal(result.status,401);assert.equal(result.headers['set-cookie'],undefined);
});
test('removed traveler receives no revision and a disconnected HTTP waiter is cancelled',async t=>{
 let observed!:(signal:AbortSignal)=>void;
 const f=await setup(t,signal=>observed?.(signal));
 const guest=await f.login('guest@example.invalid');
 const invited=await f.send(`/api/customer/trips/${f.id}/invites`,{role:'editor',expectedRevision:1,operationId:randomUUID()},f.owner.cookie,f.owner.account);assert.equal(invited.status,200);
 const token=new URLSearchParams(new URL(invited.body.value.url).hash.slice(1)).get('t');
 const joined=await f.send('/api/customer/invites/accept',{token,alias:'동행자',operationId:randomUUID()},guest.cookie,guest.account);assert.equal(joined.status,200);
 let begin!:()=>void;const started=new Promise<void>(resolve=>begin=resolve);observed=()=>begin();
 const pending=f.send(f.path,{afterRevision:3},guest.cookie,guest.account);await started;
 const removed=await f.send(`/api/customer/trips/${f.id}/members/${joined.body.value.member.id}`,{role:'editor',active:false,expectedRevision:3,operationId:randomUUID()},f.owner.cookie,f.owner.account,{},'PATCH');assert.equal(removed.status,200);
 const result=await pending;assert.equal(result.status,404);assert.equal(result.body.revision,undefined);assert.equal(result.headers['set-cookie'],undefined);
 let signalReady!:(signal:AbortSignal)=>void;const signalPromise=new Promise<AbortSignal>(resolve=>signalReady=resolve);observed=signalReady;
 const req=request({host:'127.0.0.1',port:f.port,path:f.path,method:'POST',headers:{Host:'127.0.0.1:8125',Origin:origin,'Content-Type':'application/json','X-TripMoney-Request':'1','X-TripMoney-Expected-Account':f.owner.account,Cookie:f.owner.cookie}});
 req.on('error',()=>{});req.end(JSON.stringify({afterRevision:4}));
 const signal=await signalPromise;const aborted=new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));req.destroy();await aborted;assert.equal(signal.aborted,true);
});
