import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { test } from 'node:test';
import { createLocalRuntime } from '../../server/local/runtime.js';
import type { TripInput } from '../../core/contracts.js';
const client = '1'.repeat(64);
const input: TripInput = { name: '서울 여행', destination: '서울', startDate: '2026-11-02', endDate: '2026-11-03', timeZone: 'Asia/Seoul', budgetKrw: 0, alias: '소유자', settlementMode: 'end_of_trip', dailyTime: '20:00' };
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: any) => error.code === code);
const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('t')!;
async function login(runtime: ReturnType<typeof createLocalRuntime>, name: string) {
 const challenge = await runtime.authService.requestCode(`${name}@example.invalid`, client);
 const result = await runtime.authService.verifyCode(challenge.challengeToken, '123456');
 return { ...result, actor: (await runtime.authService.authenticate(result.sessionToken)).actor };
}
test('runtime creates copied private travel DTOs and checks current session before replay', async () => {
 const runtime = createLocalRuntime(); try {
 assert.equal(typeof runtime.identityService, 'object');
 const a = await login(runtime, 'owner'); const s = runtime.identityService; const op = uuid();
 const created = await s.createTrip(a.actor, input, op); const id = created.value.trip.id;
 assert.equal(created.tripRevision, 1); assert.equal(created.value.trip.role, 'owner'); assert.equal(created.value.trip.memberCount, 1);
 assert.equal((await s.createTrip(a.actor, { ...input, name: ' 서울 여행 ' }, op.toUpperCase())).replayed, true);
 await rejects(s.createTrip(a.actor, { ...input, name: '다름' }, op), 'conflict');
 created.value.trip.name = '외부 수정'; assert.equal((await s.getTrip(a.actor, id)).name, input.name);
 assert.doesNotMatch(JSON.stringify(await s.listTrips(a.actor)), /ownerUserId|userId|session|email|tokenHash|keyId/);
 await runtime.authService.logout(a.sessionToken); await rejects(s.createTrip(a.actor, input, op), 'unauthenticated');
 } finally { runtime.close(); }
});
test('invite flow enforces permissions, receipts, membership and rejoining with original member id', async () => {
 const runtime = createLocalRuntime(); try {
 const a = await login(runtime, 'owner'), b = await login(runtime, 'guest'), c = await login(runtime, 'outsider'); const s = runtime.identityService;
 const created = await s.createTrip(a.actor, input, uuid()); const id = created.value.trip.id;
 await rejects(s.getTrip(c.actor, id), 'not_found');
 const op = uuid(); const issued = await s.issueInvite(a.actor, id, 'viewer', 1, op); const token = tokenOf(issued.value.url);
 assert.equal((await s.inspectInvite(b.actor, token, client)).state, 'pending');
 assert.ok((await s.getInviteLink(a.actor, id, issued.value.invite.id)).url === issued.value.url);
 const acceptOp = uuid(); const joined = await s.acceptInvite(b.actor, token, ' B ', acceptOp, client);
 assert.equal(joined.value.member.role, 'viewer'); assert.equal(joined.tripRevision, 3);
 assert.equal((await s.acceptInvite(b.actor, token, 'B', acceptOp, client)).replayed, true);
 await rejects(s.acceptInvite(b.actor, token, '다름', acceptOp, client), 'conflict');
 await rejects(s.issueInvite(a.actor, id, 'viewer', 1, op), 'invite_unavailable');
 assert.deepEqual(await s.inspectInvite(b.actor, token, client), { state: 'joined', tripId: id });
 await rejects(s.inspectInvite(c.actor, token, client), 'invite_unavailable');
 const { alias, ...settings } = input;
 await rejects(s.updateTrip(b.actor, id, settings, 3, uuid()), 'forbidden');
 await s.manageMember(a.actor, id, joined.value.member.id, 'viewer', false, 3, uuid());
 await rejects(s.acceptInvite(b.actor, token, 'B', acceptOp, client), 'invite_unavailable');
 await rejects(s.getTrip(b.actor, id), 'not_found');
 await rejects(s.manageMember(a.actor, id, joined.value.member.id, 'viewer', true, 4, uuid()), 'conflict');
 await rejects(s.manageMember(a.actor, id, created.value.ownerMember.id, 'viewer', false, 4, uuid()), 'conflict');
 const next = await s.issueInvite(a.actor, id, 'editor', 4, uuid());
 const rejoined = await s.acceptInvite(b.actor, tokenOf(next.value.url), 'B', uuid(), client);
 assert.equal(rejoined.value.member.id, joined.value.member.id); assert.equal(rejoined.value.member.role, 'editor');
 const pending = await s.issueInvite(a.actor, id, 'viewer', 6, uuid());
 const existing = await s.acceptInvite(b.actor, tokenOf(pending.value.url), 'ignored', uuid(), client);
 assert.equal(existing.value.member.alias, 'B'); assert.equal(existing.value.member.role, 'editor');
 assert.equal((await s.listInvites(a.actor, id)).find(v => v.id === pending.value.invite.id)!.status, 'pending');
 } finally { runtime.close(); }
});
test('revoked tokens consume rate budget and close invalidates service', async () => {
 let clock = Date.parse('2026-11-02T00:00:00Z'); const runtime = createLocalRuntime({ now: () => clock }); try {
 const a = await login(runtime, 'owner'), b = await login(runtime, 'guest'); const s = runtime.identityService;
 const t = await s.createTrip(a.actor, input, uuid()); const id = t.value.trip.id;
 const invite = await s.issueInvite(a.actor, id, 'viewer', 1, uuid());
 await s.revokeInvite(a.actor, id, invite.value.invite.id, 2, uuid());
 await rejects(s.inspectInvite(b.actor, tokenOf(invite.value.url), client), 'invite_unavailable');
 for (let i = 0; i < 29; i++) await rejects(s.inspectInvite(b.actor, 'invalid', client), 'invite_unavailable');
 await rejects(s.inspectInvite(b.actor, 'invalid', client), 'rate_limited');
 clock += 60_000; await rejects(s.inspectInvite(b.actor, 'invalid', client), 'invite_unavailable');
 runtime.close(); await rejects(s.listTrips(a.actor), 'unavailable');
 } finally { runtime.close(); }
});

import { createIdentityService } from '../../server/identity/service.js';
import { createLocalIdentityRepositoryForTests } from '../../server/local/identity-store.js';
import { createLocalAuthStore } from '../../server/local/auth-store.js';
import { IdentityError, type Actor } from '../../core/contracts.js';
const actor = (): Actor => ({ userId: uuid(), sessionHash: '2'.repeat(64) });
function isolated() {
 let clock = Date.parse('2026-11-02T00:00:00Z'); const revoked = new Set<string>();
 const local = createLocalIdentityRepositoryForTests({ now: () => clock, assertActor: a => { if (revoked.has(a.userId)) throw new IdentityError('unauthenticated', '다시 로그인해 주세요.'); } });
 const keys = { local: Buffer.alloc(32, 7) };
 const service = createIdentityService({ repository: local.repository, inviteKeys: keys, activeKid: 'local', publicOrigin: 'http://127.0.0.1:8125' });
 return { ...local, service, keys, revoked, advance(ms: number) { clock += ms; } };
}
test('last seat race commits one member and stale revision leaves all domain counts and rows intact', async () => {
 const f = isolated(), s = f.service, a = actor(); try {
 const t = await s.createTrip(a, input, uuid()), id = t.value.trip.id;
 for (let i = 0; i < 6; i++) { const invite = await s.issueInvite(a, id, 'viewer', (await s.getTrip(a, id)).revision, uuid()); await s.acceptInvite(actor(), tokenOf(invite.value.url), `멤버${i}`, uuid(), client); }
 const one = await s.issueInvite(a, id, 'editor', (await s.getTrip(a, id)).revision, uuid());
 const two = await s.issueInvite(a, id, 'viewer', (await s.getTrip(a, id)).revision, uuid()); const before = f.counts();
 const results = await Promise.allSettled([s.acceptInvite(actor(), tokenOf(one.value.url), '마지막1', uuid(), client), s.acceptInvite(actor(), tokenOf(two.value.url), '마지막2', uuid(), client)]);
 assert.equal(results.filter(v => v.status === 'fulfilled').length, 1); assert.equal(results.find(v => v.status === 'rejected')?.reason.reason,'member_limit'); assert.equal((await s.getTrip(a, id)).memberCount, 8);
 assert.equal(f.counts().members, before.members + 1); assert.equal(f.counts().receipts, before.receipts + 1); assert.equal(f.counts().audits, before.audits + 1);
 const baseline = { counts: f.counts(), trip: await s.getTrip(a, id), members: await s.listMembers(a, id), invites: await s.listInvites(a, id) };
 const { alias, ...settings } = input; await rejects(s.updateTrip(a, id, settings, 1, uuid()), 'conflict');
 assert.deepEqual({ counts: f.counts(), trip: await s.getTrip(a, id), members: await s.listMembers(a, id), invites: await s.listInvites(a, id) }, baseline);
 } finally { f.repository.close(); }
});
test('NFC aliases reserve inactive members and returning member retains original id', async () => {
 const f = isolated(), s = f.service, a = actor(), b = actor(); try {
 const t = await s.createTrip(a, { ...input, alias: '가' }, uuid()), id = t.value.trip.id;
 const inv = await s.issueInvite(a, id, 'viewer', 1, uuid()), token = tokenOf(inv.value.url), before = f.counts();
 await assert.rejects(s.acceptInvite(b, token, '가', uuid(), client), (e: any) => e.code === 'conflict' && e.reason === 'alias_taken'); assert.deepEqual({ ...f.counts(), rates: before.rates }, before);
 const joined = await s.acceptInvite(b, token, 'B', uuid(), client); await s.manageMember(a, id, joined.value.member.id, 'editor', false, 3, uuid());
 const next = await s.issueInvite(a, id, 'editor', 4, uuid()); await rejects(s.acceptInvite(actor(), tokenOf(next.value.url), 'B', uuid(), client), 'conflict');
 assert.equal((await s.acceptInvite(b, tokenOf(next.value.url), 'B', uuid(), client)).value.member.id, joined.value.member.id);
 } finally { f.repository.close(); }
});
test('operation identity includes payload and trip, replay precedes revision, and invalid UUID fails', async () => {
 const f = isolated(), s = f.service, a = actor(); try {
 const one = await s.createTrip(a, input, uuid()), two = await s.createTrip(a, input, uuid()); const { alias, ...settings } = input;
 const op = uuid(); await s.updateTrip(a, one.value.trip.id, { ...settings, name: '수정' }, 1, op);
 assert.equal((await s.updateTrip(a, one.value.trip.id, { ...settings, name: '수정' }, 1, op)).replayed, true);
 await rejects(s.updateTrip(a, two.value.trip.id, { ...settings, name: '수정' }, 1, op), 'conflict');
 await rejects(s.updateTrip(a, one.value.trip.id, { ...settings, name: '수정' }, 2, op), 'conflict');
 await rejects(s.createTrip(a, input, '00000000-0000-0000-0000-000000000000'), 'validation');
 await rejects(s.createTrip(a, { ...input, name: 'x'.repeat(81) }, uuid()), 'validation');
 await rejects(s.updateTrip(a, one.value.trip.id, { ...settings, alias: 'bad' } as any, 2, uuid()), 'validation');
 } finally { f.repository.close(); }
});
test('pending twenty quota excludes revoked and expired invites and enforces seven day expiry', async () => {
 const f = isolated(), s = f.service, a = actor(); try {
 const trip = await s.createTrip(a, input, uuid()), id = trip.value.trip.id; let rev = 1; const issued = [];
 for (let i = 0; i < 20; i++) { const op = uuid(); issued.push({ op, change: await s.issueInvite(a, id, 'viewer', rev++, op) }); }
 const before = f.counts(); await rejects(s.issueInvite(a, id, 'viewer', rev, uuid()), 'conflict'); assert.deepEqual(f.counts(), before);
 await s.revokeInvite(a, id, issued[0]!.change.value.invite.id, rev++, uuid());
 const replacement = await s.issueInvite(a, id, 'viewer', rev++, uuid()); assert.equal(Date.parse(replacement.value.invite.expiresAt), Date.parse('2026-11-09T00:00:00Z'));
 f.advance(7 * 86400_000); assert.equal((await s.listInvites(a, id)).filter(i => i.status === 'expired').length, 20);
 await rejects(s.issueInvite(a, id, 'viewer', 2, issued[1]!.op), 'invite_unavailable');
 await rejects(s.getInviteLink(a, id, replacement.value.invite.id), 'invite_unavailable');
 await rejects(s.inspectInvite(actor(), tokenOf(replacement.value.url), client), 'invite_unavailable');
 await s.issueInvite(a, id, 'viewer', rev, uuid());
 } finally { f.repository.close(); }
});
test('owner twenty creation quota is atomic and liveness applies to reads and writes', async () => {
 const f = isolated(), s = f.service, a = actor(); try {
 for (let i = 0; i < 20; i++) await s.createTrip(a, input, uuid());
 const before = f.counts(); await rejects(s.createTrip(a, input, uuid()), 'conflict'); assert.deepEqual(f.counts(), before);
 f.revoked.add(a.userId); await rejects(s.listTrips(a), 'unauthenticated'); await rejects(s.createTrip(a, input, uuid()), 'unauthenticated');
 } finally { f.repository.close(); }
});
test('inspect and accept share actor thirty and client sixty rate reservation including invalid tokens', async () => {
 const f = isolated(), s = f.service, a = actor(), b = actor(), c = actor(); try {
 for (let i = 0; i < 15; i++) { await rejects(s.inspectInvite(a, 'bad', client), 'invite_unavailable'); await rejects(s.acceptInvite(a, 'bad', 'alias', uuid(), client), 'invite_unavailable'); }
 await rejects(s.inspectInvite(a, 'bad', '2'.repeat(64)), 'rate_limited');
 for (let i = 0; i < 30; i++) await rejects(s.inspectInvite(b, 'bad', client), 'invite_unavailable');
 await rejects(s.inspectInvite(c, 'bad', client), 'rate_limited'); assert.equal(f.counts().rates, 60);
 f.advance(60_000); await rejects(s.inspectInvite(c, 'bad', client), 'invite_unavailable'); assert.equal(f.counts().rates, 1);
 } finally { f.repository.close(); }
});
test('auth assertActor rejects substituted, pending, revoked, expired and closed session rows', async () => {
 let clock = Date.parse('2026-11-02T00:00:00Z'); const store = createLocalAuthStore({ now: () => clock }); try {
 await store.reserveChallenge({ hash: 'challenge', emailCipher: 'opaque', emailKey: 'key', clientHash: client }); await store.markChallengeReady('challenge');
 await store.withChallenge('challenge', async lease => { await lease.reserveAttempt(); await lease.consumeAndCreateSession({ hash: 'session', userId: 'user', providerSessionId: 'provider', tokensCipher: 'opaque' }); });
 const a = { userId: 'user', sessionHash: 'session' }; store.assertActor(a);
 assert.throws(() => store.assertActor({ ...a, userId: 'other' }), (e: any) => e.code === 'unauthenticated');
 await store.withSession('session', lease => lease.markRefreshPending(1)); assert.throws(() => store.assertActor(a), (e: any) => e.code === 'unauthenticated');
 await store.withSession('session', async lease => { const version = await lease.saveRefresh(1, 'opaque2'); await lease.activateRefresh(version); }); store.assertActor(a);
 clock += 86400_000; assert.throws(() => store.assertActor(a), (e: any) => e.code === 'unauthenticated');
 clock -= 86400_000; await store.withSession('session', lease => lease.revoke()); assert.throws(() => store.assertActor(a), (e: any) => e.code === 'unauthenticated');
 store.close(); assert.throws(() => store.assertActor(a), (e: any) => e.code === 'unavailable');
 } finally { store.close(); }
});
test('copied keys reconstruct links and DTO allowlists exclude stored internal fields', async () => {
 const f = isolated(), a = actor(); try {
 const t = await f.service.createTrip(a, input, uuid()), issued = await f.service.issueInvite(a, t.value.trip.id, 'viewer', 1, uuid());
 f.keys.local.fill(0); assert.ok((await f.service.getInviteLink(a, t.value.trip.id, issued.value.invite.id)).url === issued.value.url);
 assert.equal(new URL(issued.value.url).pathname, '/invite'); assert.equal(new URL(issued.value.url).search, '');
 assert.deepEqual(Object.keys(issued.value.invite).sort(), ['expiresAt', 'id', 'role', 'status']);
 assert.deepEqual(Object.keys((await f.service.listMembers(a, t.value.trip.id))[0]!).sort(), ['active', 'alias', 'id', 'isMe', 'role', 'tripId']);
 assert.throws(() => createIdentityService({ repository: f.repository, inviteKeys: { local: Buffer.alloc(32) }, activeKid: 'local', publicOrigin: 'http://127.0.0.1:8125/path' }), (e: any) => e.code === 'unavailable');
 } finally { f.repository.close(); }
});
test('accept and revoke race produces one valid outcome and accepted invite cannot revoke membership', async () => {
 const f = isolated(), s = f.service, a = actor(), b = actor(); try {
 const t = await s.createTrip(a, input, uuid()), id = t.value.trip.id;
 const issued = await s.issueInvite(a, id, 'viewer', 1, uuid()), token = tokenOf(issued.value.url);
 const results = await Promise.allSettled([s.acceptInvite(b, token, 'B', uuid(), client), s.revokeInvite(a, id, issued.value.invite.id, 2, uuid())]);
 assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
 if (results[0]!.status === 'fulfilled') {
  assert.equal((await s.getTrip(b, id)).memberCount, 2);
 } else {
  await rejects(s.getTrip(b, id), 'not_found');
  assert.equal((await s.getTrip(a, id)).memberCount, 1);
  assert.equal((await s.listInvites(a, id)).find(row => row.id === issued.value.invite.id)!.status, 'revoked');
 }
 await rejects(s.revokeInvite(a, id, issued.value.invite.id, 3, uuid()), 'invite_unavailable');
 const next = await s.issueInvite(a, id, 'viewer', 3, uuid()); await s.revokeInvite(a, id, next.value.invite.id, 4, uuid());
 await rejects(s.acceptInvite(actor(), tokenOf(next.value.url), 'C', uuid(), client), 'invite_unavailable');
 } finally { f.repository.close(); }
});
test('actor invalidation at final commit check discards the candidate state', async () => {
 let calls = 0;
 const local = createLocalIdentityRepositoryForTests({ assertActor: () => { calls++; if (calls === 2) throw new IdentityError('unauthenticated', '다시 로그인해 주세요.'); } });
 const s = createIdentityService({ repository: local.repository, inviteKeys: { local: Buffer.alloc(32) }, activeKid: 'local', publicOrigin: 'http://127.0.0.1:8125' });
 try { await rejects(s.createTrip(actor(), input, uuid()), 'unauthenticated'); assert.deepEqual(local.counts(), { trips: 0, members: 0, invites: 0, receipts: 0, audits: 0, rates: 0 }); }
 finally { local.repository.close(); }
});
