import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLiveMailPermit,readLiveMailPermit} from '../../server/integration/mail-permit.js';
import {readLiveConfig} from '../../server/integration/config.js';
import {createPreparedRuntime,createLiveRuntime} from '../../server/integration/runtime.js';
import {createLocalAuthStore} from '../../server/local/auth-store.js';
import {createLocalAuthProvider} from '../../server/local/auth-provider.js';
import {createLocalTravelRepositories} from '../../server/local/identity-store.js';

const project='agddopryfqsyfshoowgk';
const encoded=(n:number)=>Buffer.alloc(32,n).toString('base64url');
const env=()=>({CUSTOMER_PUBLIC_ORIGIN:'https://tripmoney.example.invalid',
 CUSTOMER_DB_TEST_URL:`postgresql://customer_app_login:fixture@db.${project}.supabase.co:5432/postgres`,
 CUSTOMER_DB_AUTH_URL:`postgresql://customer_auth_login:fixture@db.${project}.supabase.co:5432/postgres`,
 CUSTOMER_SUPABASE_URL:`https://${project}.supabase.co`,CUSTOMER_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',
 CUSTOMER_AUTH_KEYS:JSON.stringify({active:encoded(1),previous:encoded(6)}),CUSTOMER_AUTH_ACTIVE_KID:'active',
 CUSTOMER_INVITE_KEYS:JSON.stringify({active:encoded(2)}),CUSTOMER_INVITE_ACTIVE_KID:'active',
 CUSTOMER_AUTH_RATE_KEY:encoded(3),CUSTOMER_HTTP_CLIENT_KEY:encoded(4)});
test('live config reuses restricted DB settings and persistent purpose-separated keys without an admin URL',()=>{
 const source=env(),first=readLiveConfig(source),second=readLiveConfig(source);
 assert.deepEqual(first.authKeys,second.authKeys);assert.equal(first.http.mode,'customer');
 assert.equal(first.http.mailDelivery,false);assert.deepEqual(first.http.trustedProxy,{addresses:['127.0.0.1'],clientHeader:'cf-connecting-ip'});assert.equal(first.authKeys.active!.length,32);
 first.authKeys.active![0]=99;assert.notDeepEqual(first.authKeys,second.authKeys);
 assert.ok(!('adminUrl' in first));
});
test('live config rejects missing, reused, malformed keys, different DB, transaction pool and unsafe origin safely',()=>{
 for(const patch of [
  {CUSTOMER_AUTH_KEYS:'{}'},{CUSTOMER_AUTH_KEYS:'secret private malformed'},
  {CUSTOMER_AUTH_RATE_KEY:encoded(1)},{CUSTOMER_HTTP_CLIENT_KEY:encoded(3)},
  {CUSTOMER_AUTH_ACTIVE_KID:'missing'},
  {CUSTOMER_PUBLIC_ORIGIN:'http://127.0.0.1:8125'},
  {CUSTOMER_DB_TEST_URL:`postgresql://postgres:DO_NOT_LEAK@db.${project}.supabase.co:5432/postgres`},
  {CUSTOMER_DB_AUTH_URL:`postgresql://customer_auth_login:DO_NOT_LEAK@db.${project}.supabase.co:6543/postgres`},
  {CUSTOMER_SUPABASE_URL:'https://other.supabase.co'}
 ]) assert.throws(()=>readLiveConfig({...env(),...patch}),e=>e instanceof Error&&e.message==='customer_live_configuration');
});
test('runtime denies connections before any pool creation when external approval is absent',async()=>{
 let calls=0;
 await assert.rejects(createLiveRuntime(readLiveConfig(env()),{poolFactory:async()=>{calls++;throw new Error('private url');}}),e=>e instanceof Error&&e.message==='customer_live_connections_not_approved');
 assert.equal(calls,0);
});
test('prepared runtime wires existing auth, trip and ledger domain with fake dependencies only',async()=>{
 const store=createLocalAuthStore(),provider=createLocalAuthProvider();
 const repos=createLocalTravelRepositories({assertActor:actor=>store.assertActor(actor)});
 let disposed=0;
 const runtime=createPreparedRuntime(readLiveConfig({...env(),CUSTOMER_LIVE_MAIL_APPROVED:'true'}),{authStore:store,authProvider:provider,repositories:repos,dispose:async()=>{disposed++;store.close();provider.close();}},{mailDeliveryApproved:true,mailRecipient:'owner@example.invalid',mailPermit:{consume(){}}});
 const challenge=await runtime.authService.requestCode('owner@example.invalid','a'.repeat(64));
 const login=await runtime.authService.verifyCode(challenge.challengeToken,'123456');
 const {actor}=await runtime.authService.authenticate(login.sessionToken);
 const created=await runtime.identityService.createTrip(actor,{name:'연결 준비',destination:'방콕',startDate:'2026-11-08',endDate:'2026-11-09',timeZone:'Asia/Bangkok',budgetKrw:100000,alias:'소유자',settlementMode:'daily',dailyTime:'20:00'},randomUUID());
 assert.equal((await runtime.ledgerService.get(actor,created.value.trip.id)).budgetKrw,100000);
 await runtime.close();await runtime.close();assert.equal(disposed,1);
});
test('live runtime closes restricted pools when required SQL is absent without any provider call',async()=>{
 let ended=0;
 const pool={query:async()=>({rows:[{travel:true,channel:false,usage:false}]}),end:async()=>{ended++;}} as any;
 await assert.rejects(createLiveRuntime(readLiveConfig(env()),{databaseApproved:true,authApiApproved:true,poolFactory:async()=>({app:pool,auth:pool}),fetcher:async()=>{throw new Error('provider must not run');}}),e=>e instanceof Error&&!e.message.includes('provider must not run'));
 assert.equal(ended,2);
});
test('prepared runtime blocks OTP delivery without approval and never swaps in local demo credentials',async()=>{
 const store=createLocalAuthStore(),provider=createLocalAuthProvider();let sent=0;
 const repos=createLocalTravelRepositories({assertActor:actor=>store.assertActor(actor)});
 const runtime=createPreparedRuntime(readLiveConfig(env()),{authStore:store,authProvider:{...provider,requestCode:async()=>{sent++;}},repositories:repos,dispose:async()=>{store.close();provider.close();}});
 try {await assert.rejects(runtime.authService.requestCode('fixture@example.invalid','a'.repeat(64)));assert.equal(sent,0);assert.equal(runtime.httpConfig.mailDelivery,false);}
 finally {await runtime.close();}
});

test('mail approval alone cannot bypass recipient allowlist and single-use permit',async()=>{
 const store=createLocalAuthStore(),provider=createLocalAuthProvider();let sent=0;
 const repos=createLocalTravelRepositories({assertActor:actor=>store.assertActor(actor)});
 const runtime=createPreparedRuntime(readLiveConfig({...env(),CUSTOMER_LIVE_MAIL_APPROVED:'true'}),{authStore:store,authProvider:{...provider,requestCode:async()=>{sent++;}},repositories:repos,dispose:async()=>{store.close();provider.close();}},{mailDeliveryApproved:true});
 try {await assert.rejects(runtime.authService.requestCode('other@example.invalid','b'.repeat(64)));assert.equal(sent,0);assert.equal(runtime.httpConfig.mailDelivery,false);}
 finally {await runtime.close();}
});

test('approved runtime spends one persistent permit before provider failure and blocks other recipients',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tripmoney-runtime-mail-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const permit=path.join(dir,'permit.json');createLiveMailPermit(permit,'owner@example.invalid');let sends=0;
 const attempt=async(email:string,approved=true)=>{
  const store=createLocalAuthStore(),provider=createLocalAuthProvider();
  const runtime=createPreparedRuntime(readLiveConfig({...env(),CUSTOMER_LIVE_MAIL_APPROVED:approved?'true':'false'}),{
   authStore:store,authProvider:{...provider,requestCode:async()=>{sends++;throw new Error('provider private failure');}},
   repositories:createLocalTravelRepositories({assertActor:actor=>store.assertActor(actor)}),dispose:async()=>{store.close();provider.close();}
  },{mailDeliveryApproved:true,mailRecipient:'owner@example.invalid',mailPermit:readLiveMailPermit(permit,'owner@example.invalid')});
  try {await assert.rejects(runtime.authService.requestCode(email,'c'.repeat(64)),e=>e instanceof Error&&!e.message.includes('private'));}
  finally{await runtime.close();}
 };
 await attempt('other@example.invalid');await attempt('owner@example.invalid',false);assert.equal(sends,0);
 await attempt('owner@example.invalid');assert.equal(sends,1);
 await attempt('owner@example.invalid');assert.equal(sends,1);
});

test('actual runtime advertises email links only with the real provider redirect configured',async()=>{
 const config=readLiveConfig(env());assert.equal(config.http.authMethod,undefined);
 const pool={query:async()=>({rows:[{travel:true,channel:true,usage:true}]}),end:async()=>{}} as any;
 const runtime=await createLiveRuntime(config,{databaseApproved:true,authApiApproved:true,poolFactory:async()=>({app:pool,auth:pool}),fetcher:async()=>{throw new Error('no provider request expected');}});
 try{assert.equal(runtime.httpConfig.authMethod,'email-link');assert.equal(runtime.httpConfig.mailDelivery,false);}
 finally{await runtime.close();}
});
