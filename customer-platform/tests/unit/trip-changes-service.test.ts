import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { IdentityError, type TripInput } from '../../core/contracts.js';
import { createTripChangeNotifier, createTripChangesService, createNotifyingServices, type TripChangesOptions } from '../../server/sync/service.js';
import { createLocalRuntime } from '../../server/local/runtime.js';
const tripId = '11111111-1111-1111-1111-111111111111';
const accountId = '22222222-2222-2222-2222-222222222222';
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: any) => e.code === code);
const snapshot = (revision = 1) => ({ accountId, revision });
function fixture(options: TripChangesOptions = { heartbeatMs: 100, probeMs: 20 }) {
  const notifier = createTripChangeNotifier();
  const service = createTripChangesService(notifier, options);
  return { notifier, service, close() { service.close(); notifier.close(); } };
}

test('notifier isolates trips, normalizes IDs, removes aborts and closes outstanding waits', async () => {
  const n = createTripChangeNotifier(), c = new AbortController();
  try {
    let other = false;
    const untouched = n.wait(uuid(), { signal: c.signal, timeoutMs: 1000 }).then(() => { other = true; }, () => {});
    const done = n.wait(tripId.toUpperCase(), { timeoutMs: 1000 });
    n.publish(tripId); await done; assert.equal(other, false);
    c.abort(); await untouched;
    const closed = rejects(n.wait(tripId, { timeoutMs: 1000 }), 'unavailable'); n.close(); await closed;
    await rejects(n.wait(tripId, { timeoutMs: 1 }), 'unavailable');
    n.publish(tripId);
  } finally { n.close(); }
});

test('notifier forgets prior publications and releases capacity after repeated aborts', async () => {
  const n = createTripChangeNotifier();
  try {
    n.publish(tripId); let settled = false;
    const c = new AbortController();
    const p = n.wait(tripId, { signal: c.signal, timeoutMs: 1000 }).then(() => { settled = true; }, () => {});
    await nextTurn(); assert.equal(settled, false); c.abort(); await p;
    for (let i = 0; i < 100; i++) {
      const controller = new AbortController();
      const pending = assert.rejects(n.wait(tripId, { signal: controller.signal, timeoutMs: 1000 }), { name: 'AbortError' });
      controller.abort(); await pending;
    }
    await n.wait(tripId, { timeoutMs: 1 });
  } finally { n.close(); }
});

test('service validates input and returns only trip ID and current revision', async () => {
  const f = fixture(); let reads = 0;
  const readCurrent = async () => { reads++; return { ...snapshot(3), secret: 'private' }; };
  try {
    for (const id of ['', 'bad', '00000000-0000-0000-0000-000000000000']) await rejects(f.service.wait({ tripId: id, afterRevision: 1, readCurrent }), 'validation');
    for (const revision of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) await rejects(f.service.wait({ tripId, afterRevision: revision, readCurrent }), 'validation');
    assert.equal(reads, 0);
    assert.deepEqual(await f.service.wait({ tripId: tripId.toUpperCase(), afterRevision: 1, readCurrent }), { tripId, revision: 3 });
    assert.deepEqual(await f.service.wait({ tripId, afterRevision: 0, readCurrent }), { tripId, revision: 3 });
    await rejects(f.service.wait({ tripId, afterRevision: 4, readCurrent }), 'conflict');
  } finally { f.close(); }
});

test('registration precedes the second read and catches a write between the two reads', async () => {
  const f = fixture(); let reads = 0;
  try {
    const result = await f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => {
      if (++reads === 1) return snapshot();
      f.notifier.publish(tripId); return snapshot(2);
    } });
    assert.deepEqual(result, { tripId, revision: 2 }); assert.equal(reads, 2);
  } finally { f.close(); }
});

test('local publication wakes a wait and unchanged signals never invent revisions', async () => {
  const f = fixture(); let revision = 1, reads = 0, completed = false;
  try {
    const p = f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => { reads++; return snapshot(revision); } }).then(value => { completed = true; return value; });
    await nextTurn(); f.notifier.publish(tripId); await nextTurn(); assert.equal(completed, false);
    revision = 2; f.notifier.publish(tripId);
    assert.deepEqual(await p, { tripId, revision: 2 }); assert.ok(reads >= 3);
  } finally { f.close(); }
});

test('periodic probe catches a different process and heartbeat rechecks membership', async () => {
  const f = fixture({ heartbeatMs: 30, probeMs: 5 }); let revision = 1, reads = 0;
  try {
    const p = f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => { reads++; return snapshot(revision); } });
    await nextTurn(); revision = 2;
    assert.deepEqual(await p, { tripId, revision: 2 }); assert.ok(reads >= 3);
    let authorized = true;
    const denied = rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => { if (!authorized) throw new IdentityError('not_found', '없음'); return snapshot(); } }), 'not_found');
    await nextTurn(); authorized = false; await denied;
    let heartbeatReads = 0;
    assert.deepEqual(await f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => { heartbeatReads++; return snapshot(); } }), { tripId, revision: 1 });
    assert.ok(heartbeatReads >= 3);
  } finally { f.close(); }
});

test('account switching and authorization revocation reject before publishing a revision', async () => {
  const f = fixture(); let currentAccount = accountId, forbidden = false;
  try {
    const p = rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => ({ accountId: currentAccount, revision: 1 }) }), 'unauthenticated');
    await nextTurn(); currentAccount = uuid(); f.notifier.publish(tripId); await p;
    const revoked = rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => { if (forbidden) throw new IdentityError('unauthenticated', '로그인'); return snapshot(); } }), 'unauthenticated');
    await nextTurn(); forbidden = true; f.notifier.publish(tripId); await revoked;
  } finally { f.close(); }
});

test('global quota is enforced and freed on abort and close', async () => {
  const f = fixture({ heartbeatMs: 1000, probeMs: 1000 });
  const controllers: AbortController[] = [];
  const pending: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < 64; i++) {
      const c = new AbortController(); controllers.push(c);
      pending.push(assert.rejects(f.service.wait({ tripId, afterRevision: 1, signal: c.signal, readCurrent: async () => ({ accountId: `account-${Math.floor(i / 2)}`, revision: 1 }) }), (e: any) => e.name === 'AbortError' || e.code === 'unavailable'));
    }
    await nextTurn();
    await rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => { throw new IdentityError('not_found', '없음'); } }), 'rate_limited');
    await rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => ({ accountId: 'extra', revision: 1 }) }), 'rate_limited');
    controllers[0]!.abort(); await nextTurn();
    await rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => ({ accountId: 'account-1', revision: 1 }) }), 'rate_limited');
    assert.deepEqual(await f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => snapshot(2) }), { tripId, revision: 2 });
    f.service.close(); await Promise.all(pending);
    await rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => snapshot() }), 'unavailable');
  } finally { controllers.forEach(c => c.abort()); f.close(); await Promise.all(pending); }
});

test('abort and close settle promptly even while the authorization callback is pending', async () => {
  const f = fixture(); const c = new AbortController();
  let rejectRead!: (error: unknown) => void;
  const slowRead = new Promise<ReturnType<typeof snapshot>>((_, reject) => { rejectRead = reject; });
  try {
    const aborted = assert.rejects(f.service.wait({ tripId, afterRevision: 1, signal: c.signal, readCurrent: () => slowRead }), { name: 'AbortError' });
    await nextTurn(); c.abort(); await aborted; rejectRead(new Error('late callback rejection')); await nextTurn();
    const closed = rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: () => new Promise(() => {}) }), 'unavailable');
    f.service.close(); await closed;
  } finally { f.close(); }
});

test('initial authorization I/O is included in the global 64 request limit', async () => {
  const f = fixture(); const pending: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < 64; i++) pending.push(rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: () => new Promise(() => {}) }), 'unavailable'));
    let read = false;
    await rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => { read = true; return snapshot(); } }), 'rate_limited');
    assert.equal(read, false);
    f.close(); await Promise.all(pending);
  } finally { f.close(); await Promise.all(pending); }
});

test('account quota still authorizes membership before denying the third wait', async () => {
  const f = fixture(), c = new AbortController(); const pending: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < 2; i++) pending.push(assert.rejects(f.service.wait({ tripId, afterRevision: 1, signal: c.signal, readCurrent: async () => snapshot() }), { name: 'AbortError' }));
    await nextTurn();
    await rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => { throw new IdentityError('not_found', '없음'); } }), 'not_found');
    await rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: async () => snapshot() }), 'rate_limited');
    c.abort(); await Promise.all(pending);
  } finally { c.abort(); f.close(); await Promise.all(pending); }
});

test('hard deadline releases hanging initial reads and handles their later rejection', async () => {
  const f = fixture({ heartbeatMs: 5, probeMs: 2, requestTimeoutMs: 15 });
  let rejectRead!: (reason: unknown) => void;
  try {
    const read = new Promise<ReturnType<typeof snapshot>>((_, reject) => { rejectRead = reject; });
    await rejects(f.service.wait({ tripId, afterRevision: 1, readCurrent: () => read }), 'unavailable');
    rejectRead(new Error('late rejection after hard deadline')); await nextTurn();
    assert.deepEqual(await f.service.wait({ tripId, afterRevision: 0, readCurrent: async () => snapshot() }), { tripId, revision: 1 });
    assert.throws(() => createTripChangesService(f.notifier, { requestTimeoutMs: 30_001 }), (e: any) => e.code === 'validation');
  } finally { f.close(); }
});

test('closing the changes service also closes direct notifier waits', async () => {
  const f = fixture();
  const pending = rejects(f.notifier.wait(tripId, { timeoutMs: 1000 }), 'unavailable');
  f.service.close(); await pending;
});

const input: TripInput = { name: '서울 여행', destination: '서울', startDate: '2026-11-02', endDate: '2026-11-03', timeZone: 'Asia/Seoul', budgetKrw: 0, alias: '소유자', settlementMode: 'end_of_trip', dailyTime: '20:00' };
async function login(runtime: ReturnType<typeof createLocalRuntime>, name: string) {
  const challenge = await runtime.authService.requestCode(`${name}@example.invalid`, '1'.repeat(64));
  const loggedIn = await runtime.authService.verifyCode(challenge.challengeToken, '123456');
  return (await runtime.authService.authenticate(loggedIn.sessionToken)).actor;
}

test('decorators publish every committed identity and ledger mutation without replay or failure signals', async () => {
  const runtime = createLocalRuntime(), notifier = createTripChangeNotifier();
  const publishedIds: string[] = [];
  const s = createNotifyingServices({ identityService: runtime.identityService, ledgerService: runtime.ledgerService, notifier: { ...notifier, publish(id) { publishedIds.push(id); notifier.publish(id); } } });
  async function observed<T>(id: string, operation: () => Promise<T>, expected: boolean) {
    const c = new AbortController(); let published = false;
    const waiting = notifier.wait(id, { signal: c.signal, timeoutMs: 1000 }).then(() => { published = true; }, () => {});
    try { const result = await operation(); await nextTurn(); assert.equal(published, expected); return result; }
    finally { c.abort(); await waiting; }
  }
  try {
    const owner = await login(runtime, 'changes-owner'), guest = await login(runtime, 'changes-guest');
    const createOp = uuid(); const created = await s.identityService.createTrip(owner, input, createOp); const id = created.value.trip.id;
    assert.deepEqual(publishedIds, [id]);
    await observed(id, () => s.identityService.createTrip(owner, input, createOp), false);
    const { alias, ...settings } = input;
    await observed(id, () => s.identityService.updateTrip(owner, id, { ...settings, name: '수정' }, 1, uuid()), true);
    await observed(id, async () => { await rejects(s.identityService.updateTrip(owner, id, settings, 1, uuid()), 'conflict'); }, false);
    const invite = await observed(id, () => s.identityService.issueInvite(owner, id, 'editor', 2, uuid()), true);
    const token = new URLSearchParams(new URL(invite.value.url).hash.slice(1)).get('t')!;
    const acceptOp = uuid(); const accepted = await observed(id, () => s.identityService.acceptInvite(guest, token, '동행', acceptOp, '1'.repeat(64)), true);
    await observed(id, () => s.identityService.acceptInvite(guest, token, '동행', acceptOp, '1'.repeat(64)), false);
    await observed(id, () => s.identityService.manageMember(owner, id, accepted.value.member.id, 'viewer', true, 4, uuid()), true);
    const next = await observed(id, () => s.identityService.issueInvite(owner, id, 'viewer', 5, uuid()), true);
    await observed(id, () => s.identityService.revokeInvite(owner, id, next.value.invite.id, 6, uuid()), true);
    const ledgerOp = uuid();
    await observed(id, () => s.ledgerService.execute(owner, id, { type: 'fx.update', rateMilli: 42000, source: 'manual' }, 7, ledgerOp), true);
    await observed(id, () => s.ledgerService.execute(owner, id, { type: 'fx.update', rateMilli: 42000, source: 'manual' }, 7, ledgerOp), false);
    assert.equal((await s.identityService.getTrip(owner, id)).revision, 8);
    assert.equal((await s.ledgerService.get(owner, id)).revision, 8);
  } finally { notifier.close(); runtime.close(); }
});
