import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createLocalRuntime} from '../../server/local/runtime.js';

test('local runtime exposes authenticated revision waits, decorated writes and shutdown cleanup',async t=>{
 const r=createLocalRuntime();t.after(()=>r.close());
 assert.equal(typeof r.changesService?.wait,'function');
 const challenge=await r.authService.requestCode('sync@example.invalid','a'.repeat(64));
 const login=await r.authService.verifyCode(challenge.challengeToken,'123456');
 const {actor}=await r.authService.authenticate(login.sessionToken);
 const made=await r.identityService.createTrip(actor,{name:'공동 여행',destination:'서울',alias:'나',startDate:'2026-11-08',endDate:'2026-11-09',timeZone:'Asia/Seoul',budgetKrw:100000,settlementMode:'daily',dailyTime:'20:00'},randomUUID());
 const tripId=made.value.trip.id;
 const readCurrent=async()=>({accountId:actor.userId,revision:(await r.identityService.getTrip(actor,tripId)).revision});
 const pending=r.changesService.wait({tripId,afterRevision:1,readCurrent});
 await r.ledgerService.execute(actor,tripId,{type:'schedule.create',input:{title:'산책',place:'',date:'2026-11-08',startTime:'',endTime:'',budgetKrw:0}},1,randomUUID());
 assert.deepEqual(await pending,{tripId,revision:2});
 const closing=r.changesService.wait({tripId,afterRevision:2,readCurrent});
 const rejected=assert.rejects(closing,{code:'unavailable'});r.close();await rejected;
});
