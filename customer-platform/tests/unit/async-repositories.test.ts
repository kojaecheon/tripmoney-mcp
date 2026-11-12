import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Actor, TripInput } from '../../core/contracts.js';
import type { IdentityRepository } from '../../server/identity/contracts.js';
import { createIdentityService } from '../../server/identity/service.js';
import { createLocalTravelRepositories } from '../../server/local/identity-store.js';

const input: TripInput = {name:'비동기 여행', destination:'서울', startDate:'2026-11-07', endDate:'2026-11-08',
  timeZone:'Asia/Seoul', budgetKrw:10000, alias:'소유자', settlementMode:'daily', dailyTime:'20:00'};
const actor = (): Actor => ({userId:randomUUID(),sessionHash:'1'.repeat(64)});

test('identity service awaits asynchronous repository results across the travel and invite lifecycle', async () => {
  const local = createLocalTravelRepositories({assertActor:()=>{}});
  const asynchronous = new Proxy(local.identityRepository, {
    get(target, name) {
      const method = Reflect.get(target,name);
      return name === 'close' ? method : async (...args: unknown[]) => {
        await Promise.resolve();
        return Reflect.apply(method,target,args);
      };
    }
  }) as IdentityRepository;
  const s = createIdentityService({repository:asynchronous,inviteKeys:{local:Buffer.alloc(32,7)},activeKid:'local',publicOrigin:'http://127.0.0.1:8125'});
  const a = actor(), b = actor(), client = '2'.repeat(64);
  try {
    const created = await s.createTrip(a,input,randomUUID()), id = created.value.trip.id;
    assert.equal((await s.listTrips(a))[0]?.id,id);
    assert.equal((await s.getTrip(a,id)).name,input.name);
    assert.equal((await s.listMembers(a,id)).length,1);
    const {alias,...settings} = input;
    await s.updateTrip(a,id,{...settings,name:'수정'},1,randomUUID());
    const invite = await s.issueInvite(a,id,'editor',2,randomUUID());
    const token = new URLSearchParams(new URL(invite.value.url).hash.slice(1)).get('t')!;
    assert.equal((await s.listInvites(a,id)).length,1);
    assert.equal((await s.getInviteLink(a,id,invite.value.invite.id)).url,invite.value.url);
    assert.equal((await s.inspectInvite(b,token,client)).state,'pending');
    const joined = await s.acceptInvite(b,token,'동행자',randomUUID(),client);
    await s.manageMember(a,id,joined.value.member.id,'viewer',true,4,randomUUID());
    const second = await s.issueInvite(a,id,'viewer',5,randomUUID());
    assert.equal((await s.revokeInvite(a,id,second.value.invite.id,6,randomUUID())).value.status,'revoked');
  } finally { local.close(); }
});

test('invite inspection waits for asynchronous attempt reservation before reading an invite', async () => {
  const events: string[] = [];
  const repository = {
    async reserveAttempt() { await Promise.resolve(); events.push('reserved'); },
    async inspect() { events.push('inspect'); return {state:'pending',tripName:'검사',role:'viewer',expiresAt:'2026-11-08T00:00:00Z'}; }
  } as unknown as IdentityRepository;
  const {makeInviteToken} = await import('../../core/token.js');
  const s = createIdentityService({repository,inviteKeys:{local:Buffer.alloc(32,7)},activeKid:'local',publicOrigin:'http://127.0.0.1:8125'});
  await s.inspectInvite(actor(),makeInviteToken(randomUUID(),'local',Buffer.alloc(32,7)),'2'.repeat(64));
  assert.deepEqual(events,['reserved','inspect']);
});
