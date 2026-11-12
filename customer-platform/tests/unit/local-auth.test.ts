import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalRuntime } from '../../server/local/runtime.js';
import { createLocalAuthStore } from '../../server/local/auth-store.js';
const client='1'.repeat(64);
const rejects=(work:Promise<unknown>,code:string)=>assert.rejects(work,(error:any)=>error.code===code);
test('real AuthService local runtime supports expiry, resend, attempt budget, refresh and isolated logout',async()=>{
 let clock=Date.parse('2026-11-02T00:00:00Z');const runtime=createLocalRuntime({now:()=>clock});const auth=runtime.authService;try{
 const expired=await auth.requestCode('expired@example.invalid',client);clock+=600_000;await rejects(auth.verifyCode(expired.challengeToken,'123456'),'unauthenticated');
 const first=await auth.requestCode('traveler@example.invalid',client);await rejects(auth.requestCode('traveler@example.invalid',client),'rate_limited');
 clock+=60_000;const second=await auth.requestCode('traveler@example.invalid',client);await rejects(auth.verifyCode(first.challengeToken,'123456'),'unauthenticated');
 for(let i=0;i<5;i++)await rejects(auth.verifyCode(second.challengeToken,'000000'),'unauthenticated');await rejects(auth.verifyCode(second.challengeToken,'123456'),'unauthenticated');
 clock+=60_000;const third=await auth.requestCode('traveler@example.invalid',client);const one=await auth.verifyCode(third.challengeToken,'123456');assert.equal(Date.parse(one.me.expiresAt)-clock,86400_000);await rejects(auth.verifyCode(third.challengeToken,'123456'),'unauthenticated');
 clock+=60_000;const fourth=await auth.requestCode('traveler@example.invalid',client);const two=await auth.verifyCode(fourth.challengeToken,'123456');assert.equal(one.me.userId,two.me.userId);
 clock+=3600_000;assert.equal((await auth.authenticate(one.sessionToken)).email,'traveler@example.invalid');assert.equal((await auth.authenticate(two.sessionToken)).email,'traveler@example.invalid');
 await auth.logout(one.sessionToken);await auth.logout(one.sessionToken);await rejects(auth.authenticate(one.sessionToken),'unauthenticated');assert.equal((await auth.authenticate(two.sessionToken)).email,'traveler@example.invalid');
 clock=Date.parse(two.me.expiresAt);await rejects(auth.authenticate(two.sessionToken),'unauthenticated');
 }finally{runtime.close();}
});
test('email and client hourly request limits expire with injected clock',async()=>{
 let clock=Date.parse('2026-11-02T00:00:00Z');const runtime=createLocalRuntime({now:()=>clock});try{
 for(let i=0;i<5;i++){await runtime.authService.requestCode('limited@example.invalid',client);clock+=60_000;}
 await rejects(runtime.authService.requestCode('limited@example.invalid',client),'rate_limited');
 for(let i=0;i<15;i++)await runtime.authService.requestCode(`person${i}@example.invalid`,client);
 await rejects(runtime.authService.requestCode('overflow@example.invalid',client),'rate_limited');clock+=3600_000;await runtime.authService.requestCode('limited@example.invalid',client);
 }finally{runtime.close();}
});
test('concurrent verification consumes one challenge; runtime state is process local and close invalidates it',async()=>{
 const a=createLocalRuntime(),b=createLocalRuntime();try{
 const code=await a.authService.requestCode('traveler@example.invalid',client);const outcomes=await Promise.allSettled([a.authService.verifyCode(code.challengeToken,'123456'),a.authService.verifyCode(code.challengeToken,'123456')]);assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);
 const success=outcomes.find(v=>v.status==='fulfilled')!;if(success.status!=='fulfilled')throw Error('missing');await rejects(b.authService.authenticate(success.value.sessionToken),'unauthenticated');a.close();await rejects(a.authService.authenticate(success.value.sessionToken),'unavailable');
 }finally{a.close();b.close();}
});
test('memory session refresh gate requires exact version before activation',async()=>{
 const store=createLocalAuthStore({now:()=>Date.parse('2026-11-02T00:00:00Z')});try{
 await store.reserveChallenge({hash:'challenge',emailCipher:'encrypted',emailKey:'email',clientHash:client});await store.markChallengeReady('challenge');
 await store.withChallenge('challenge',async lease=>{await lease.reserveAttempt();await lease.consumeAndCreateSession({hash:'session',userId:'user',providerSessionId:'provider',tokensCipher:'old'});});
 await store.withSession('session',async lease=>{await lease.markRefreshPending(1);assert.equal((await lease.read())!.refreshPending,true);await rejects(lease.saveRefresh(0,'bad'),'unavailable');assert.equal(await lease.saveRefresh(1,'new'),2);await rejects(lease.activateRefresh(1),'unavailable');assert.equal((await lease.read())!.refreshPending,true);await lease.activateRefresh(2);assert.equal((await lease.read())!.refreshPending,false);});
 }finally{store.close();}
});
async function refreshSessionStore() {
  const store = createLocalAuthStore({ now: () => Date.parse('2026-11-02T00:00:00Z') });
  await store.reserveChallenge({ hash: 'challenge', emailCipher: 'encrypted', emailKey: 'email', clientHash: client });
  await store.markChallengeReady('challenge');
  await store.withChallenge('challenge', async lease => {
    await lease.reserveAttempt();
    await lease.consumeAndCreateSession({ hash: 'session', userId: 'user', providerSessionId: 'provider', tokensCipher: 'old' });
  });
  return store;
}
test('refresh gate rejects activation before a saved new version across leases', async () => {
  const store = await refreshSessionStore();
  try {
    await store.withSession('session', lease => lease.markRefreshPending(1));
    await store.withSession('session', async lease => {
      await rejects(lease.activateRefresh(1), 'unavailable');
      const pending = (await lease.read())!;
      assert.equal(pending.refreshPending, true);
      assert.equal(pending.version, 1);
      assert.equal(pending.tokensCipher, 'old');
      assert.equal(await lease.saveRefresh(1, 'new'), 2);
    });
    await store.withSession('session', async lease => {
      await lease.activateRefresh(2);
      const active = (await lease.read())!;
      assert.equal(active.refreshPending, false);
      assert.equal(active.version, 2);
      assert.equal(active.tokensCipher, 'new');
    });
  } finally { store.close(); }
});
test('refresh gate rejects repeated save while preserving the first saved version', async () => {
  const store = await refreshSessionStore();
  try {
    await store.withSession('session', async lease => {
      await lease.markRefreshPending(1);
      assert.equal(await lease.saveRefresh(1, 'new'), 2);
    });
    await store.withSession('session', async lease => {
      await rejects(lease.saveRefresh(2, 'replacement'), 'unavailable');
      const saved = (await lease.read())!;
      assert.equal(saved.refreshPending, true);
      assert.equal(saved.version, 2);
      assert.equal(saved.tokensCipher, 'new');
      await lease.activateRefresh(2);
      await lease.markRefreshPending(2);
      assert.equal(await lease.saveRefresh(2, 'next'), 3);
      await lease.activateRefresh(3);
      assert.equal((await lease.read())!.refreshPending, false);
    });
  } finally { store.close(); }
});
