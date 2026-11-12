import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {request} from 'node:http';
import type {AddressInfo} from 'node:net';
import {test,type TestContext} from 'node:test';
import {createLocalRuntime} from '../../server/local/runtime.js';
import {createCustomerAuthServer} from '../../server/http/server.js';
import {readHttpConfig} from '../../server/http/config.js';

async function fixture(t:TestContext) {
  let clock=Date.now();
  const runtime=createLocalRuntime({now:()=>clock});
  const server=createCustomerAuthServer({config:readHttpConfig({publicOrigin:'http://127.0.0.1:8125',clientKey:randomBytes(32)}),...runtime});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.close();});
  const jar=new Map<string,string>();const port=(server.address() as AddressInfo).port;
  function send(path:string,data?:unknown,extra:Record<string,string>={},anonymous=false):Promise<{status:number;body:any}> {
    return new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port,path,method:data===undefined?'GET':'POST',headers:{Host:'127.0.0.1:8125',Origin:'http://127.0.0.1:8125',
        'Content-Type':'application/json','X-TripMoney-Request':'1',...(!anonymous?{Cookie:[...jar.values()].join('; ')}:{}),...extra}},res=>{
        if(!anonymous)for(const cookie of res.headers['set-cookie']??[]) {const value=cookie.split(';')[0]!;jar.set(value.split('=')[0]!,value);}
        const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();let body:unknown;try{body=JSON.parse(raw);}catch{body=raw;}resolve({status:res.statusCode!,body});});
      });req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
    });
  }
  async function login(email:string) {await send('/api/customer/auth/request-code',{email});await send('/api/customer/auth/verify-code',{code:'123456'});return (await send('/api/customer/me')).body.me.userId as string;}
  const account=await login('owner@example.invalid');
  const trip=(await send('/api/customer/trips',{name:'2차 합성 시험',destination:'서울',startDate:'2026-11-07',endDate:'2026-11-08',timeZone:'Asia/Seoul',
    budgetKrw:100000,alias:'나',settlementMode:'daily',dailyTime:'20:00',operationId:randomUUID()})).body.value.trip;
  return {send,trip,account,login,advance(ms:number){clock+=ms;}};
}

test('recommendation HTTP adopts only selected server candidates once and binds the account',async t=>{
  const {send,trip,account}=await fixture(t),base=`/api/customer/trips/${trip.id}`;
  const input={interests:['산책'],pace:'balanced',expectedRevision:1};
  const generated=await send(base+'/recommendations',input);
  assert.equal(generated.status,200);
  const draft=generated.body.recommendation;
  assert.equal(draft.source,'synthetic');assert.ok(draft.items.length>=2);
  const body={selectedIds:[draft.items[0].id],operationId:randomUUID()};
  assert.equal((await send(`${base}/recommendations/${draft.id}/adopt`,body,{'X-TripMoney-Expected-Account':randomUUID()})).status,412);
  const adopted=await send(`${base}/recommendations/${draft.id}/adopt`,body,{'X-TripMoney-Expected-Account':account});
  assert.equal(adopted.status,200);
  assert.equal((await send(`${base}/recommendations/${draft.id}/adopt`,body)).body.replayed,true);
  const ledger=(await send(base+'/ledger')).body.ledger;
  assert.equal(ledger.items.length,1);assert.equal(ledger.revision,2);
  assert.equal((await send(base+'/recommendations',input,{Origin:'https://other.invalid'})).status,403);
  assert.equal((await send(base+'/recommendations',input,{},true)).status,401);
});

test('local channel pairing, review and confirmation save once, then unlink revokes the confirmation',async t=>{
  const {send,trip}=await fixture(t),base='/api/customer/kakao-local';
  assert.equal((await send(base)).body.status.linked,false);
  const pair=await send(base+'/pair',{});assert.equal(pair.status,200);
  assert.equal((await send(base+'/connect',{code:pair.body.pair.code})).body.status.linked,true);
  assert.equal((await send(base+'/trip',{tripId:trip.id})).body.status.tripId,trip.id);
  const pending=await send(base+'/drafts',{message:'택시 15000원'});assert.equal(pending.status,200);
  const ledger=(await send(`/api/customer/trips/${trip.id}/ledger`)).body.ledger;
  const member=ledger.members.find((m:any)=>m.isMe);
  const input={itineraryId:null,title:'택시',occurredLocal:'2026-11-07T13:00',currency:'KRW',amount:'15000',payerId:member.id,splitIds:[member.id],refreshRate:false};
  const reviewed=await send(`${base}/drafts/${pending.body.draft.id}/review`,{input});assert.equal(reviewed.status,200);
  assert.equal((await send(`/api/customer/trips/${trip.id}/ledger`)).body.ledger.expenses.length,0);
  const confirm={token:reviewed.body.confirmation.token,operationId:randomUUID()};
  assert.equal((await send(base+'/confirm',confirm)).status,200);
  assert.equal((await send(base+'/confirm',confirm)).body.replayed,true);
  assert.equal((await send(`/api/customer/trips/${trip.id}/ledger`)).body.ledger.summary.spentKrw,15000);
  assert.equal((await send(base+'/unlink',{})).body.status.linked,false);
  assert.notEqual((await send(base+'/confirm',confirm)).status,200);
  assert.equal((await send(base+'/pair',{botUserKey:'forged'})).status,422);
});

test('local channel cannot bind another account using its pair code and accepts no anonymous caller',async t=>{
  const {send,login}=await fixture(t),base='/api/customer/kakao-local';
  const pair=(await send(base+'/pair',{})).body.pair;
  await send('/api/customer/auth/logout',{});await login('other@example.invalid');
  assert.notEqual((await send(base+'/connect',{code:pair.code})).status,200);
  assert.equal((await send(base)).body.status.linked,false);
  assert.equal((await send(base,undefined,{},true)).status,401);
  assert.equal((await send(base+'/pair',{}, {Origin:'https://other.invalid'})).status,403);
});

test('a viewer cannot generate recommendations or channel drafts after joining the trip',async t=>{
  const {send,trip,login}=await fixture(t),tripPath=`/api/customer/trips/${trip.id}`,channel='/api/customer/kakao-local';
  const issued=await send(tripPath+'/invites',{role:'viewer',expectedRevision:1,operationId:randomUUID()});
  const token=new URLSearchParams(new URL(issued.body.value.url).hash.slice(1)).get('t');
  await send('/api/customer/auth/logout',{});await login('viewer@example.invalid');
  assert.equal((await send('/api/customer/invites/accept',{token,alias:'조회자',operationId:randomUUID()})).status,200);
  assert.equal((await send(tripPath+'/recommendations',{interests:[],pace:'balanced',expectedRevision:3})).status,403);
  const code=(await send(channel+'/pair',{})).body.pair.code;
  assert.equal((await send(channel+'/connect',{code})).status,200);
  assert.equal((await send(channel+'/trip',{tripId:trip.id})).status,403);
  assert.equal((await send(channel+'/drafts',{message:'택시 15000원'})).status,403);
  assert.equal((await send(tripPath+'/ledger')).body.ledger.expenses.length,0);
});

test('a new login cannot reuse the channel authority captured by a logged-out session',async t=>{
  const {send,trip,login,advance}=await fixture(t),channel='/api/customer/kakao-local';
  const code=(await send(channel+'/pair',{})).body.pair.code;
  await send(channel+'/connect',{code});await send(channel+'/trip',{tripId:trip.id});
  await send('/api/customer/auth/logout',{});advance(61000);await login('owner@example.invalid');
  const status=await send(channel);assert.equal(status.status,200);assert.equal(status.body.status.linked,false);
  assert.equal((await send('/api/customer/me')).status,200);
  assert.notEqual((await send(channel+'/drafts',{message:'택시 15000원'})).status,200);
});
