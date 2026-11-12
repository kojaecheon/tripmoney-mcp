import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { IdentityError } from '../../core/contracts.js';
import { createAuthStore } from '../../server/auth/store.js';
import type { ChallengeLease, SessionLease } from '../../server/auth/store-contract.js';
const hash='a'.repeat(64), emailKey='b'.repeat(64), clientHash='c'.repeat(64);
const uid='11111111-1111-4111-8111-111111111111', pid='22222222-2222-4222-8222-222222222222';
const fresh={hash,userId:uid,providerSessionId:pid,tokensCipher:'synthetic.cipher'};
const stored={...fresh,expiresAt:'2026-10-31T00:00:00.000Z',version:'1',revoked:false,refreshPending:false,usable:true,nowSeconds:'1793318400'};
type Call={sql:string;values:unknown[]};
function fixture(answer:(c:Call)=>unknown[]|undefined=()=>undefined){
 const calls:Call[]=[],released:unknown[]=[];let connects=0;
 const client=Object.assign(new EventEmitter(),{async query(sql:string,values:unknown[]=[]){
  const c={sql,values};calls.push(c);const custom=answer(c);if(custom)return{rows:custom,rowCount:custom.length};
  let rows:unknown[]=[];
  if(/pg_advisory_unlock/.test(sql))rows=[{unlocked:true}];
  else if(/as "now"/.test(sql))rows=[{now:'2026-10-30T00:00:00.000Z',windowStart:'2026-10-30T00:00:00.000Z'}];
  else if(/as "emailHits"/.test(sql))rows=[{emailHits:'0',clientHits:'0',recentEmail:false}];
  else if(/select email_key/.test(sql))rows=[{emailKey}];
  else if(/returning email_cipher/.test(sql))rows=[{emailCipher:'synthetic.email'}];
  else if(/returning expires_at/.test(sql))rows=[{expiresAt:stored.expiresAt}];
  else if(/returning version/.test(sql))rows=[{version:sql.includes('version=version+1')?String(Number(values[1])+1):String(values[1])}];
  else if(/returning tokens_cipher/.test(sql))rows=[{tokensCipher:fresh.tokensCipher,userId:uid,providerSessionId:pid}];
  else if(/from customer_auth.sessions/.test(sql))rows=[{...stored}];
  else if(/returning hash/.test(sql))rows=[{hash}];
  return{rows,rowCount:rows.length};
 },release(v?:unknown){released.push(v);}}) as unknown as PoolClient;
 const pool={async connect(){connects++;return client;}} as Pick<Pool,'connect'>;
 return{store:createAuthStore(pool),pool,client,calls,released,get connects(){return connects;}};
}
const code=(s:string)=>(e:unknown)=>e instanceof IdentityError&&e.code===s&&!e.cause;
const commands=(calls:Call[])=>calls.filter(c=>/^(begin|commit|rollback)$/i.test(c.sql)).map(c=>c.sql.toLowerCase());
test('reservation locks sorted identifiers before DB clock and atomically counts limits',async()=>{
 const f=fixture();await f.store.reserveChallenge({hash,emailCipher:'synthetic.email',emailKey,clientHash});
 const locks=f.calls.filter(c=>/pg_advisory_xact_lock/.test(c.sql));assert.equal(locks.length,2);
 const keys=locks.map(c=>BigInt(String(c.values[0])));assert.deepEqual(keys,[...keys].sort((a,b)=>a<b?-1:1));
 assert.ok(f.calls.indexOf(locks[1]!)<f.calls.findIndex(c=>/as "now"/.test(c.sql)));
 const limits=f.calls.find(c=>/as "emailHits"/.test(c.sql))!;assert.match(limits.sql,/interval '1 hour'/);assert.match(limits.sql,/interval '60 seconds'/);
 for(const key of[emailKey,clientHash])assert.ok(f.calls.some(c=>/insert into customer_auth.rate_buckets/.test(c.sql)&&c.values.includes(key)));
 assert.ok(f.calls.some(c=>/insert into customer_auth.challenges/.test(c.sql)&&c.values.includes(hash)&&/600 seconds/.test(c.sql)));
 assert.deepEqual(commands(f.calls),['begin','commit']);assert.equal(f.connects,1);assert.deepEqual(f.released,[undefined]);
 for(const v of[hash,emailKey,clientHash,'synthetic.email'])assert.ok(f.calls.every(c=>!c.sql.includes(v)));
 for(const setting of['statement_timeout','lock_timeout','idle_in_transaction_session_timeout'])assert.ok(f.calls.some(c=>c.sql.includes(setting)));
});
for(const limits of[{emailHits:'5',clientHits:'0',recentEmail:false},{emailHits:'0',clientHits:'20',recentEmail:false},{emailHits:'0',clientHits:'0',recentEmail:true}])test(`rate limited ${JSON.stringify(limits)}`,async()=>{
 const f=fixture(c=>/as "emailHits"/.test(c.sql)?[limits]:undefined);
 await assert.rejects(f.store.reserveChallenge({hash,emailCipher:'synthetic.email',emailKey,clientHash}),code('rate_limited'));
 assert.ok(!f.calls.some(c=>/insert into/.test(c.sql)));assert.deepEqual(commands(f.calls),['begin','rollback']);
});
test('ready invalidates older ready rows under email lock and failed cleanup is sending only',async()=>{
 const f=fixture();await f.store.markChallengeReady(hash);
 const updates=f.calls.filter(c=>/update customer_auth.challenges/.test(c.sql));assert.equal(updates.length,2);
 assert.ok(f.calls.findIndex(c=>/pg_advisory_xact_lock/.test(c.sql))<f.calls.indexOf(updates[0]!));
 assert.match(updates[0]!.sql,/status='ready'/);assert.match(updates[1]!.sql,/status='sending'/);assert.deepEqual(commands(f.calls),['begin','commit']);
 const g=fixture();await g.store.markChallengeFailed(hash);assert.match(g.calls.find(c=>/update customer_auth.challenges/.test(c.sql))!.sql,/status='sending'/);
});
test('challenge attempt commits before callback continues and fifth attempt may consume atomically',async()=>{
 const f=fixture();let captured:ChallengeLease|undefined;
 await f.store.withChallenge(hash,async l=>{captured=l;await assert.rejects(l.consumeAndCreateSession(fresh),code('unauthenticated'));
 assert.deepEqual(await l.reserveAttempt(),{emailCipher:'synthetic.email'});assert.equal(commands(f.calls).at(-1),'commit');
 await assert.rejects(l.reserveAttempt(),code('unauthenticated'));assert.equal((await l.consumeAndCreateSession(fresh)).expiresAt,stored.expiresAt);});
 assert.equal(f.connects,1);const attempt=f.calls.find(c=>/attempts=attempts\+1/.test(c.sql))!;assert.match(attempt.sql,/attempts<5/);assert.match(attempt.sql,/consumed_at is null/);
 assert.match(f.calls.find(c=>/status='consumed'/.test(c.sql))!.sql,/attempts<=5/);assert.ok(f.calls.some(c=>/86400 seconds/.test(c.sql)));
 await assert.rejects(captured!.reserveAttempt(),code('unavailable'));assert.equal(f.calls.filter(c=>/pg_advisory_unlock/.test(c.sql)).length,1);
});
test('unusable challenge rejects and insert failure rolls back consumption',async()=>{
 const f=fixture(c=>/returning email_cipher/.test(c.sql)?[]:undefined);await assert.rejects(f.store.withChallenge(hash,l=>l.reserveAttempt()),code('unauthenticated'));
 const g=fixture(c=>{if(/insert into customer_auth.sessions/.test(c.sql))throw new Error('secret SQL');});
 await assert.rejects(g.store.withChallenge(hash,async l=>{await l.reserveAttempt();await l.consumeAndCreateSession(fresh);}),code('unavailable'));assert.ok(commands(g.calls).includes('rollback'));
});
test('session durable pending gate, CAS save and exact confirmed activation',async()=>{
 const f=fixture();let saved:SessionLease|undefined;await f.store.withSession(hash,async l=>{saved=l;
 const row=await l.read();assert.equal(row!.nowSeconds,1793318400);assert.equal(row!.version,1);
 await assert.rejects(l.activateRefresh(2),code('unavailable'));await assert.rejects(l.saveRefresh(1,'new.cipher'),code('unavailable'));
 await l.markRefreshPending(1);assert.equal(commands(f.calls).at(-1),'commit');assert.equal(await l.saveRefresh(1,'new.cipher'),2);
 await assert.rejects(l.activateRefresh(3),code('unavailable'));await l.activateRefresh(2);});
 const updates=f.calls.filter(c=>/update customer_auth.sessions/.test(c.sql));assert.equal(updates.length,3);
 assert.match(updates[0]!.sql,/refresh_pending=true/);assert.match(updates[1]!.sql,/version=version\+1/);assert.doesNotMatch(updates[1]!.sql,/refresh_pending=false/);assert.match(updates[2]!.sql,/refresh_pending=false/);
 for(const c of updates){assert.match(c.sql,/version=\$2/);assert.match(c.sql,/revoked_at is null/);assert.match(c.sql,/expires_at>clock_timestamp\(\)/);}
 await assert.rejects(saved!.read(),code('unavailable'));
});
test('CAS rejection and MAX_SAFE_INTEGER prevent unsafe refresh',async()=>{
 const f=fixture(c=>/update customer_auth.sessions/.test(c.sql)?[]:undefined);await assert.rejects(f.store.withSession(hash,l=>l.markRefreshPending(1)),code('unauthenticated'));
 const g=fixture();await g.store.withSession(hash,async l=>{await assert.rejects(l.markRefreshPending(0),code('unavailable'));await assert.rejects(l.markRefreshPending(1.5),code('unavailable'));await l.markRefreshPending(Number.MAX_SAFE_INTEGER);await assert.rejects(l.saveRefresh(Number.MAX_SAFE_INTEGER,'new.cipher'),code('unavailable'));});
});
test('revoke commits before returning cleanup data, regardless of pending and expiration',async()=>{
 const f=fixture();await f.store.withSession(hash,async l=>{assert.deepEqual(await l.revoke(),{tokensCipher:fresh.tokensCipher,userId:uid,providerSessionId:pid});assert.equal(commands(f.calls).at(-1),'commit');});
 assert.doesNotMatch(f.calls.find(c=>/set revoked_at/.test(c.sql))!.sql,/expires_at>|not refresh_pending/);
 const g=fixture(c=>/returning tokens_cipher/.test(c.sql)?[]:undefined);assert.equal(await g.store.withSession(hash,l=>l.revoke()),null);
});
test('invalid hash and malformed cipher stop before checkout',async()=>{
 const f=fixture();for(const bad of['','A'.repeat(64),hash+'x',3 as unknown as string]){await assert.rejects(f.store.withSession(bad,async()=>{}),IdentityError);await assert.rejects(f.store.withChallenge(bad,async()=>{}),IdentityError);await assert.rejects(f.store.markChallengeReady(bad),IdentityError);}
 await assert.rejects(f.store.reserveChallenge({hash,emailCipher:'',emailKey,clientHash}),IdentityError);assert.equal(f.connects,0);
});
for(const failure of['commit','rollback','unlock'])test(`${failure} uncertainty discards connection`,async()=>{
 let failed=false;const f=fixture(c=>{if(failure==='commit'&&c.sql==='commit'&&!failed){failed=true;throw new Error('secret SQL');}if(failure==='rollback'&&(c.sql==='rollback'||/from customer_auth.sessions/.test(c.sql)))throw new Error('secret SQL');if(failure==='unlock'&&/pg_advisory_unlock/.test(c.sql))return[{unlocked:false}];});
 await assert.rejects(f.store.withSession(hash,l=>l.read()),e=>code('unavailable')(e)&&!(e as Error).message.includes('secret'));assert.deepEqual(f.released,[true]);
});
test('callback errors and malformed rows sanitized, unlock uses same checkout',async()=>{
 const f=fixture();await assert.rejects(f.store.withSession(hash,async()=>{throw new IdentityError('unavailable','secret callback');}),e=>code('unavailable')(e)&&!(e as Error).message.includes('secret'));assert.equal(f.connects,1);assert.ok(f.calls.some(c=>/pg_advisory_unlock/.test(c.sql)));
 const g=fixture(c=>/from customer_auth.sessions/.test(c.sql)?[{...stored,version:'9007199254740992'}]:undefined);await assert.rejects(g.store.withSession(hash,l=>l.read()),code('unavailable'));
});

test('malformed cleanup fields cannot roll back already committed revocation',async()=>{
 const f=fixture(c=>/returning tokens_cipher/.test(c.sql)?[{tokensCipher:'',userId:uid,providerSessionId:pid}]:undefined);
 await assert.rejects(f.store.withSession(hash,l=>l.revoke()),code('unavailable'));
 const revocation=f.calls.findIndex(c=>/set revoked_at/.test(c.sql));
 assert.equal(f.calls.slice(revocation+1).find(c=>/^(commit|rollback)$/.test(c.sql))!.sql,'commit');
});
test('a failed save commit prevents activation even if callback catches the failure',async()=>{
 let saving=false;const f=fixture(c=>{if(/version=version\+1/.test(c.sql))saving=true;if(saving&&c.sql==='commit')throw new Error('lost save response');});
 await assert.rejects(f.store.withSession(hash,async l=>{await l.markRefreshPending(1);await assert.rejects(l.saveRefresh(1,'new.cipher'),code('unavailable'));await assert.rejects(l.activateRefresh(2),code('unavailable'));}),code('unavailable'));
 assert.ok(!f.calls.some(c=>/refresh_pending=false/.test(c.sql)));assert.deepEqual(f.released,[true]);
});

test('DB clock precision survives the UTC hour boundary rate lookup',async()=>{
 const f=fixture(c=>/as "now"/.test(c.sql)?[{now:'2026-10-30 01:00:00.000123+00',windowStart:'2026-10-30 01:00:00+00'}]:undefined);
 await f.store.reserveChallenge({hash,emailCipher:'synthetic.email',emailKey,clientHash});
 const limits=f.calls.find(c=>/as "emailHits"/.test(c.sql))!;
 assert.equal(limits.values[2],'2026-10-30 01:00:00.000123+00');
 assert.equal(limits.values[3],'2026-10-30 01:00:00+00');
 assert.match(f.calls.find(c=>/as "now"/.test(c.sql))!.sql,/at time zone 'UTC'/);
});

test('session read returns missing rows and rejects corrupted typed fields',async()=>{
 const absent=fixture(c=>/from customer_auth.sessions/.test(c.sql)?[]:undefined);
 assert.equal(await absent.store.withSession(hash,l=>l.read()),null);
 for(const patch of[{hash:'d'.repeat(64)},{userId:'bad'},{providerSessionId:'bad'},{tokensCipher:''},{expiresAt:'bad'},{version:0},{revoked:0},{refreshPending:'false'},{usable:'true'},{nowSeconds:'1.5'},{revoked:true,usable:true}]){
  const f=fixture(c=>/from customer_auth.sessions/.test(c.sql)?[{...stored,...patch}]:undefined);
  await assert.rejects(f.store.withSession(hash,l=>l.read()),code('unavailable'));
 }
});

test('every short transaction applies all timeout settings before its work',async()=>{
 const f=fixture();await f.store.withSession(hash,async l=>{await l.read();await l.markRefreshPending(1);await l.saveRefresh(1,'new.cipher');await l.activateRefresh(2);await l.revoke();});
 const starts=f.calls.map((c,i)=>c.sql==='begin'?i:-1).filter(i=>i>=0);assert.equal(starts.length,7);
 for(const i of starts){assert.match(f.calls[i+1]!.sql,/statement_timeout='8s'/);assert.match(f.calls[i+2]!.sql,/lock_timeout='2s'/);assert.match(f.calls[i+3]!.sql,/idle_in_transaction_session_timeout='15s'/);}
 const lock=f.calls.find(c=>/pg_advisory_lock\(/.test(c.sql))!;
 const unlock=f.calls.find(c=>/pg_advisory_unlock/.test(c.sql))!;assert.deepEqual(unlock.values,lock.values);
});

test('same-session callbacks serialize on one namespaced advisory key while other sessions proceed',async()=>{
 const held=new Set<string>(), waiters=new Map<string,Array<()=>void>>(),released:unknown[]=[], lockKeys:string[]=[];
 const pool={async connect(){return Object.assign(new EventEmitter(),{async query(sql:string,values:unknown[]=[]){
  if(/pg_advisory_lock\(/.test(sql)){
   const key=String(values[0]);lockKeys.push(key);
   if(held.has(key))await new Promise<void>(resolve=>{const list=waiters.get(key)??[];list.push(resolve);waiters.set(key,list);});
   held.add(key);
  }
  if(/pg_advisory_unlock/.test(sql)){
   const key=String(values[0]);const next=waiters.get(key)?.shift();if(next)next();else held.delete(key);
   return {rows:[{unlocked:true}],rowCount:1};
  }
  return {rows:[],rowCount:0};
 },release(v?:unknown){released.push(v);}}) as unknown as PoolClient;}} as Pick<Pool,'connect'>;
 const store=createAuthStore(pool);let releaseFirst:()=>void=()=>{};let firstEntered:()=>void=()=>{};const entered=new Promise<void>(r=>firstEntered=r);
 const gate=new Promise<void>(r=>releaseFirst=r);const events:string[]=[];
 const first=store.withSession(hash,async()=>{events.push('first');firstEntered();await gate;events.push('first finished');});await entered;
 const second=store.withSession(hash,async()=>{events.push('second');});
 await store.withSession('d'.repeat(64),async()=>{events.push('other');});
 assert.deepEqual(events,['first','other']);releaseFirst();await Promise.all([first,second]);
 assert.deepEqual(events,['first','other','first finished','second']);assert.equal(lockKeys[0],lockKeys[1]);assert.notEqual(lockKeys[0],lockKeys[2]);assert.equal(released.length,3);assert.equal(held.size,0);
});

test('lock acquisition uncertainty and raw connection failures never leak SQL errors',async()=>{
 const f=fixture(c=>{if(/pg_advisory_lock\(/.test(c.sql))throw new Error('synthetic secret SQL');});
 await assert.rejects(f.store.withSession(hash,async()=>{}),e=>code('unavailable')(e)&&!(e as Error).message.includes('secret'));assert.deepEqual(f.released,[true]);
 const pool={async connect(){throw new IdentityError('forbidden','synthetic secret');}} as unknown as Pick<Pool,'connect'>;
 await assert.rejects(createAuthStore(pool).withSession(hash,async()=>{}),code('unavailable'));
});

test('overlapping lease methods fail without interleaving transactions',async()=>{
 const f=fixture();await f.store.withSession(hash,async l=>{
  const reading=l.read();await assert.rejects(l.read(),code('unavailable'));await reading;
 });
 assert.equal(f.calls.filter(c=>/from customer_auth.sessions/.test(c.sql)).length,1);
});

test('non-timestamp strings are rejected instead of Date coercion',async()=>{
 const f=fixture(c=>/from customer_auth.sessions/.test(c.sql)?[{...stored,expiresAt:'1'}]:undefined);
 await assert.rejects(f.store.withSession(hash,l=>l.read()),code('unavailable'));
});


test('checked-out error during provider wait is contained until callback settles and discards once',async()=>{
 const f=fixture();let enter:()=>void=()=>{},resume:()=>void=()=>{};
 const entered=new Promise<void>(resolve=>enter=resolve),provider=new Promise<void>(resolve=>resume=resolve);
 let settled=false,callbackDone=false,readError:unknown;
 const request=f.store.withSession(hash,async lease=>{
  enter();await provider;
  try{await lease.read();}catch(error){readError=error;}
  callbackDone=true;return 'synthetic success';
 }).then(value=>({value,error:undefined}),error=>({value:undefined,error})).finally(()=>{settled=true;});
 await entered;const before=f.calls.length;
 let emitThrew=false;
 try{f.client.emit('error',new Error('synthetic connection secret'));}catch{emitThrew=true;}
 await new Promise<void>(resolve=>setImmediate(resolve));
 const releasedWhileWaiting=f.released.length,settledWhileWaiting=settled,listenersWhileWaiting=f.client.listenerCount('error');
 resume();const result=await request;
 assert.equal(emitThrew,false);assert.equal(settledWhileWaiting,false);assert.equal(releasedWhileWaiting,0);assert.equal(listenersWhileWaiting,1);
 assert.equal(callbackDone,true);assert.equal(result.value,undefined);assert.ok(code('unavailable')(result.error));assert.ok(code('unavailable')(readError));
 assert.ok(!(result.error as Error).message.includes('secret'));assert.equal(f.calls.length,before);
 assert.deepEqual(f.released,[true]);assert.equal(f.client.listenerCount('error'),0);
});

test('connection error prevents subsequent transaction commands including rollback',async()=>{
 const f=fixture(c=>{if(c.sql==='begin')f.client.emit('error',new Error('synthetic begin secret'));});
 await assert.rejects(f.store.markChallengeFailed(hash),e=>code('unavailable')(e)&&!(e as Error).message.includes('secret'));
 assert.deepEqual(f.calls.map(c=>c.sql),['begin']);assert.deepEqual(f.released,[true]);assert.equal(f.client.listenerCount('error'),0);
});

test('error listener covers normal and callback failure checkout and is removed after every release',async()=>{
 const f=fixture();const observed:number[]=[];const release=f.client.release.bind(f.client);
 f.client.release=(discard?:Error|boolean)=>{observed.push(f.client.listenerCount('error'));release(discard);};
 for(let i=0;i<3;i++){
  await f.store.withSession(hash,async()=>{assert.equal(f.client.listenerCount('error'),1);});
  assert.equal(f.client.listenerCount('error'),0);
  await assert.rejects(f.store.withSession(hash,async()=>{assert.equal(f.client.listenerCount('error'),1);throw new Error('synthetic callback secret');}),code('unavailable'));
  assert.equal(f.client.listenerCount('error'),0);
 }
 assert.deepEqual(observed,[1,1,1,1,1,1]);assert.equal(f.released.length,6);
});

test('release failure keeps listener through release and cleans it without a second release',async()=>{
 const f=fixture();let releases=0,listenersAtRelease=0;
 f.client.release=()=>{releases++;listenersAtRelease=f.client.listenerCount('error');f.client.emit('error',new Error('synthetic release event secret'));throw new Error('synthetic release secret');};
 await assert.rejects(f.store.withSession(hash,async()=> 'synthetic success'),e=>code('unavailable')(e)&&!(e as Error).message.includes('secret'));
 assert.equal(releases,1);assert.equal(listenersAtRelease,1);assert.equal(f.client.listenerCount('error'),0);
});

test('checkout rejection attaches no client listener and performs no release',async()=>{
 const f=fixture();await f.store.withSession(hash,async()=>{});
 const before=f.released.length;let callbackRan=false;
 f.pool.connect=async()=>{throw new Error('synthetic checkout secret');};
 await assert.rejects(f.store.withSession(hash,async()=>{callbackRan=true;}),e=>code('unavailable')(e)&&!(e as Error).message.includes('secret'));
 assert.equal(f.client.listenerCount('error'),0);assert.equal(f.released.length,before);assert.equal(callbackRan,false);
});

test('repeated connection errors override callback authentication errors without extra cleanup SQL',async()=>{
 for(const method of ['withSession','withChallenge'] as const){
  const f=fixture();
  await assert.rejects(f.store[method](hash,async()=>{
   f.client.emit('error',new Error('synthetic first connection secret'));
   f.client.emit('error',new Error('synthetic repeated connection secret'));
   throw new IdentityError('unauthenticated','synthetic callback secret');
  }),e=>code('unavailable')(e)&&!(e as Error).message.includes('secret'));
  assert.ok(!f.calls.some(c=>/pg_advisory_unlock/.test(c.sql)));
  assert.deepEqual(f.released,[true]);assert.equal(f.client.listenerCount('error'),0);
 }
});


test('synchronous error inside release denies success and preserves the pool idle listener',async()=>{
 const f=fixture();let releases=0,storeListenersAtRelease=0;
 const poolIdleError=()=>{};
 f.client.release=()=>{
  releases++;storeListenersAtRelease=f.client.listenerCount('error');
  // pg-pool reinstalls its idle listener before emitting its release event.
  f.client.on('error',poolIdleError);
  f.client.emit('error',new Error('synthetic release event secret'));
 };
 await assert.rejects(f.store.withSession(hash,async()=> 'synthetic success'),e=>code('unavailable')(e)&&!(e as Error).message.includes('secret'));
 assert.equal(releases,1);assert.equal(storeListenersAtRelease,1);
 assert.deepEqual(f.client.listeners('error'),[poolIdleError]);
 f.client.removeListener('error',poolIdleError);
});
