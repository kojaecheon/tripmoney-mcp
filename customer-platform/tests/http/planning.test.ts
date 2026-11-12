import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { readHttpConfig } from '../../server/http/config.js';
import { createCustomerAuthServer } from '../../server/http/server.js';
import { createLocalRuntime } from '../../server/local/runtime.js';

async function fixture(t: TestContext) {
  const runtime=createLocalRuntime();
  const server=createCustomerAuthServer({config:readHttpConfig({publicOrigin:'http://127.0.0.1:8125',clientKey:randomBytes(32)}),...runtime});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.close();});
  const jar=new Map<string,string>(), port=(server.address() as AddressInfo).port;
  function send(path:string,data?:unknown,extra:Record<string,string>={},anonymous=false):Promise<{status:number;body:any}> {
    return new Promise((resolve,reject)=>{
      const raw=data===undefined?undefined:JSON.stringify(data);
      const req=request({hostname:'127.0.0.1',port,path,method:raw===undefined?'GET':'POST',headers:{Host:'127.0.0.1:8125',Origin:'http://127.0.0.1:8125',
        'Content-Type':'application/json','X-TripMoney-Request':'1',...(!anonymous?{Cookie:[...jar.values()].join('; ')}:{}),...extra}},res=>{
        if(!anonymous) for(const cookie of res.headers['set-cookie']??[]) {const value=cookie.split(';')[0]!;jar.set(value.split('=')[0]!,value);}
        const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{
          const value=Buffer.concat(chunks).toString();let body:unknown;try{body=JSON.parse(value);}catch{body=value;}
          resolve({status:res.statusCode!,body});
        });
      }); req.on('error',reject);req.end(raw);
    });
  }
  await send('/api/customer/auth/request-code',{email:'owner@example.invalid'});
  await send('/api/customer/auth/verify-code',{code:'123456'});
  const me=(await send('/api/customer/me')).body.me;
  const trip=(await send('/api/customer/trips',{name:'지도 초안 시험',destination:'서울',startDate:'2026-11-07',endDate:'2026-11-08',
    timeZone:'Asia/Seoul',budgetKrw:100000,alias:'나',settlementMode:'daily',dailyTime:'20:00',operationId:randomUUID()})).body.value.trip;
  return {send,trip,account:me.userId};
}

test('synthetic planning endpoints require the current account, origin and trip without changing the ledger',async t=>{
  const {send,trip,account}=await fixture(t), base=`/api/customer/trips/${trip.id}`;
  const headers={'X-TripMoney-Expected-Account':account};
  const found=await send(base+'/places/search',{query:'카페'},headers);
  assert.equal(found.status,200);
  assert.ok(found.body.places.length>0);
  assert.equal(found.body.places[0].source,'synthetic');
  const ref=found.body.places[0].ref;
  assert.equal((await send(base+'/places/resolve',{refs:[ref]},headers)).status,200);
  const park=(await send(base+'/places/search',{query:'공원'},headers)).body.places[0];
  assert.equal((await send(base+'/places/route',{refs:[ref,park.ref],mode:'walking'},headers)).status,200);
  const roundTrip=await send(base+'/places/route',{refs:[ref,park.ref,ref],mode:'walking'},headers);
  assert.equal(roundTrip.status,200);
  assert.equal(roundTrip.body.route.status,'ok');
  assert.deepEqual(roundTrip.body.route.places.map((p:any)=>p.ref),[ref,park.ref,ref]);
  const draft=await send(base+'/drafts',{message:'택시 15000원',expectedRevision:1},headers);
  assert.equal(draft.status,200);assert.equal(draft.body.draft.source,'synthetic');
  assert.equal(draft.body.draft.kind,'expense');
  const ledger=(await send(base+'/ledger')).body.ledger;
  assert.equal(ledger.revision,1);assert.equal(ledger.expenses.length,0);
  assert.equal((await send(base+'/places/search',{query:'카페'},{},true)).status,401);
  assert.equal((await send(base+'/places/search',{query:'카페'},{Origin:'https://other.invalid'})).status,403);
  assert.equal((await send(base+'/drafts',{message:'택시 15000원',expectedRevision:1},{'X-TripMoney-Expected-Account':randomUUID()})).status,412);
  assert.equal((await send(base+'/drafts',{message:'택시 15000원',expectedRevision:2},headers)).status,409);
  assert.equal((await send(base+'/places/search',{query:'카페',role:'owner'},headers)).status,422);
  assert.equal((await send(`/api/customer/trips/${randomUUID()}/places/search`,{query:'카페'},headers)).status,404);
});

test('a joined viewer can search places but cannot generate write drafts',async t=>{
  const {send,trip}=await fixture(t),base=`/api/customer/trips/${trip.id}`;
  const invite=await send(base+'/invites',{role:'viewer',expectedRevision:1,operationId:randomUUID()});
  const token=new URLSearchParams(new URL(invite.body.value.url).hash.slice(1)).get('t');
  await send('/api/customer/auth/logout',{});
  await send('/api/customer/auth/request-code',{email:'viewer@example.invalid'});
  await send('/api/customer/auth/verify-code',{code:'123456'});
  assert.equal((await send('/api/customer/invites/accept',{token,alias:'조회자',operationId:randomUUID()})).status,200);
  assert.equal((await send(base+'/places/search',{query:'카페'})).status,200);
  assert.equal((await send(base+'/drafts',{message:'택시 15000원',expectedRevision:3})).status,403);
  const ledger=(await send(base+'/ledger')).body.ledger;
  assert.equal(ledger.revision,3);assert.equal(ledger.expenses.length,0);
});
