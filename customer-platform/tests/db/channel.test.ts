import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { Actor } from '../../core/contracts.js';
import type { ChannelCommand, KakaoSender } from '../../server/integration/contracts.js';
import { createPgChannelRepository, createPgProviderUsageStore } from '../../server/db/integration-repositories.js';
import { failCommitPool, interceptPool, operation, rejected, travelFixture } from './travel-fixtures.js';

const schedule: ChannelCommand = { type: 'schedule.create', input: { date: '2026-11-01', startTime: '10:00',
  endTime: '11:00', title: '합성 채널 일정', place: '직접 입력 장소', budgetKrw: 1000 } };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

test('전용 DB 채널 승인·확인·철회·재전송·비용 예약과 기존 자료 보존', { timeout: 120000 }, async t => {
  const f = await travelFixture(); t.after(() => f.cleanup());
  const created = await f.create(), id = created.value.trip.id;
  const ownerId = created.value.members.find(member => member.userId === f.owner.userId)!.id;
  const other = await f.create(f.stranger), otherId = other.value.trip.id;
  const member = await f.add(id);
  const channels: ReturnType<typeof createPgChannelRepository>[] = [];
  const channel = (pool = f.app) => { const repo = createPgChannelRepository({ pool }); channels.push(repo); return repo; };
  t.after(() => { for (const repo of channels) repo.close(); });
  let repo = channel();
  const sender = (): KakaoSender => ({ environment: 'development', botId: `db-test-${f.testRun}`, botUserKey: randomUUID() });
  const get = () => Promise.resolve(f.repositories.ledgerRepository.get(f.owner, id));
  const pair = async (who: KakaoSender, actor = f.owner, tripId = id) => {
    const code = await repo.issuePair(actor, tripId), claim = await repo.claimPair(who, code.code);
    return repo.approvePair(actor, claim.pendingId);
  };
  const confirmationState = async (token: string) => (await f.admin.query(`select result,consumed_at
    from customer_private.channel_confirmations where token_hash=$1`, [hash(token)])).rows;

  await t.test('코드 claim은 동일 sender만 재전송하고 승인 계정·세션·여행을 확인한다', async () => {
    const who = sender(), pairCode = await repo.issuePair(f.owner, id);
    const first = await repo.claimPair(who, pairCode.code);
    assert.deepEqual(await repo.claimPair(who, pairCode.code), first);
    await rejected(repo.claimPair(sender(), pairCode.code), 'forbidden');
    await rejected(repo.approvePair(f.stranger, first.pendingId), 'forbidden');
    // The same user with another valid synthetic session must not approve this session's pair.
    const alternate: Actor = { ...f.owner, sessionHash: f.actors[3]!.sessionHash };
    await f.admin.query('update customer_auth.sessions set user_id=$1 where hash=$2', [f.owner.userId, alternate.sessionHash]);
    try { await rejected(repo.approvePair(alternate, first.pendingId), 'forbidden'); }
    finally { await f.admin.query('update customer_auth.sessions set user_id=$1 where hash=$2', [f.actors[3]!.userId, alternate.sessionHash]); }
    const grant = await repo.approvePair(f.owner, first.pendingId);
    assert.equal(grant.tripId, id); assert.equal((await repo.context(who)).grantId, grant.grantId);
    await rejected(repo.approvePair(f.owner, first.pendingId), 'forbidden');
    await rejected(repo.claimPair(who, pairCode.code), 'forbidden');
    await rejected(repo.issuePair(f.owner, otherId), 'forbidden');
  });
  await t.test('연결 응답 시각은 정규 ISO wire이며 여행 불일치 승인은 기존 grant를 보존한다', async () => {
    const who = sender(), original = await pair(who), target = (await f.create()).value.trip.id;
    const wireTime = (value: string) => {
      assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(new Date(value).toISOString(), value);
    };
    const issued = await repo.issuePair(f.owner, target); wireTime(issued.expiresAt);
    const claim = await repo.claimPair(who, issued.code); wireTime(claim.expiresAt);
    await rejected(repo.approvePair(f.owner, claim.pendingId, id), 'conflict');
    const unchanged = await repo.context(who);
    assert.equal(unchanged.grantId, original.grantId); assert.equal(unchanged.tripId, id);
    // Successful retry proves the failed approval did not consume the pending ID.
    const approved = await repo.approvePair(f.owner, claim.pendingId, target); wireTime(approved.expiresAt);
    const changed = await repo.context(who); wireTime(changed.expiresAt);
    assert.equal(changed.grantId, approved.grantId); assert.equal(changed.tripId, target);
  });
  await t.test('확인 토큰 동시 재전송은 원장·receipt·소비 상태를 한 번만 저장한다', async () => {
    const who = sender(); await pair(who);
    const before = await get(), review = await repo.review(who, schedule, before.revision);
    assert.deepEqual(await get(), before, '검토만으로 원장을 변경하지 않습니다.');
    const results = await Promise.all([repo.confirm(who, review.token, review.operationId),
      repo.confirm(who, review.token, review.operationId)]);
    assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
    assert.equal(results[0]!.value.targetId, results[1]!.value.targetId);
    const after = await get(); assert.equal(after.items.length, before.items.length + 1);
    assert.equal(after.revision, before.revision + 1); assert.equal(after.history.length, before.history.length + 1);
    assert.equal((await f.admin.query(`select count(*)::integer as count from customer_private.travel_receipts
      where trip_id=$1 and receipt_key=$2`, [id, `${f.owner.userId}:schedule.create:${review.operationId}`])).rows[0].count, 1);
    const consumed = await confirmationState(review.token); assert.ok(consumed[0].result); assert.ok(consumed[0].consumed_at);
    await rejected(repo.confirm(who, review.token, randomUUID()), 'conflict');
    repo.close(); repo = channel();
    assert.equal((await repo.confirm(who, review.token, review.operationId)).replayed, true);
    assert.deepEqual(await get(), after);
    await rejected(repo.confirm(sender(), review.token, review.operationId), 'forbidden');
  });
  await t.test('실제 commit 응답 유실 후 재전송은 저장된 한 건만 반환한다', async () => {
    const who = sender(); await pair(who);
    const before = await get(), review = await repo.review(who, schedule, before.revision);
    let lost = false;
    const ambiguous = channel(interceptPool(f.app, async (db, sql, args) => {
      const result = await db.query(sql, args);
      if (sql === 'commit' && !lost) { lost = true; throw new Error('synthetic_commit_response_lost'); }
      return result;
    }));
    await rejected(ambiguous.confirm(who, review.token, review.operationId), 'unavailable');
    const replay = await repo.confirm(who, review.token, review.operationId);
    assert.equal(replay.replayed, true); assert.equal((await get()).items.length, before.items.length + 1);
    assert.equal((await get()).revision, before.revision + 1);
  });
  await t.test('저장 후 SQL 오류는 원장·receipt·토큰 소비를 모두 rollback한다', async () => {
    const who = sender(); await pair(who);
    const before = await get(), review = await repo.review(who, schedule, before.revision);
    const receipts = (await f.admin.query('select receipt_key,value from customer_private.travel_receipts where trip_id=$1 order by receipt_key', [id])).rows;
    const broken = channel(failCommitPool(f.app));
    await rejected(broken.confirm(who, review.token, review.operationId), 'unavailable');
    assert.deepEqual(await get(), before); assert.deepEqual(await confirmationState(review.token), [{ result: null, consumed_at: null }]);
    assert.deepEqual((await f.admin.query('select receipt_key,value from customer_private.travel_receipts where trip_id=$1 order by receipt_key', [id])).rows, receipts);
    assert.equal((await repo.confirm(who, review.token, review.operationId)).replayed, false);
  });
  await t.test('검토 뒤 revision 변경은 최종 저장과 토큰 소비를 거부한다', async () => {
    const who = sender(); await pair(who);
    const before = await get(), review = await repo.review(who, schedule, before.revision);
    await f.repositories.ledgerRepository.execute(f.owner, id, () => ({ command: { type: 'fx.update', rateMilli: 40000,
      source: 'manual' }, expectedRevision: before.revision, operation: operation() }));
    const changed = await get(); await rejected(repo.confirm(who, review.token, review.operationId), 'conflict');
    assert.deepEqual(await get(), changed); assert.deepEqual(await confirmationState(review.token), [{ result: null, consumed_at: null }]);
  });
  await t.test('제한 app의 경비 localDate 변조를 원장·receipt·토큰 소비 전에 거부한다', async () => {
    const who = sender(); await pair(who);
    const before = await get();
    const expense: ChannelCommand = { type: 'expense.create', input: { itineraryId: null, title: '합성 식사',
      occurredLocal: '2026-11-01T12:00', currency: 'KRW', amount: '1000', payerId: ownerId, splitIds: [ownerId], refreshRate: false } };
    const review = await repo.review(who, expense, before.revision);
    const altered = channel(interceptPool(f.app, async (db, sql, args) => {
      if (sql.includes('customer_private.channel_save(')) {
        const after = JSON.parse(args[4] as string); after.ledgers[0][1].expenses.at(-1).localDate = '2026-11-02';
        args = [...args]; args[4] = JSON.stringify(after);
      }
      return db.query(sql, args);
    }));
    await rejected(altered.confirm(who, review.token, review.operationId), 'forbidden');
    assert.deepEqual(await get(), before); assert.deepEqual(await confirmationState(review.token), [{ result: null, consumed_at: null }]);
  });
  await t.test('grant 철회 후 기존 확인과 이미 저장된 결과 재전송을 모두 차단한다', async () => {
    const who = sender(), grant = await pair(who);
    const review = await repo.review(who, schedule, (await get()).revision);
    await repo.confirm(who, review.token, review.operationId); const before = await get();
    await repo.unlink(f.owner, grant.grantId);
    await rejected(repo.context(who), 'forbidden');
    await rejected(repo.confirm(who, review.token, review.operationId), 'forbidden'); assert.deepEqual(await get(), before);
  });
  await t.test('정산 잠금은 경비 검토와 검토 후 최종 저장에서 다시 확인한다', async () => {
    const who = sender(); await pair(who);
    const expense: ChannelCommand = { type: 'expense.create', input: { itineraryId: null, title: '잠금 확인용 합성 경비',
      occurredLocal: '2026-11-01T12:00', currency: 'KRW', amount: '1000', payerId: ownerId, splitIds: [ownerId], refreshRate: false } };
    const review = await repo.review(who, expense, (await get()).revision);
    await f.repositories.ledgerRepository.execute(f.owner, id, () => ({ command: { type: 'settlement.finalize', date: '2026-11-01' },
      expectedRevision: review.expectedRevision, operation: operation() }));
    const locked = await get();
    await rejected(repo.review(who, expense, locked.revision), 'validation');
    await rejected(repo.confirm(who, review.token, review.operationId), 'conflict');
    assert.deepEqual(await get(), locked); assert.deepEqual(await confirmationState(review.token), [{ result: null, consumed_at: null }]);
    await f.repositories.ledgerRepository.execute(f.owner, id, () => ({ command: { type: 'settlement.reopen', date: '2026-11-01' },
      expectedRevision: locked.revision, operation: operation() }));
  });
  await t.test('같은 sender가 여행을 전환하면 이전 grant와 토큰을 사용할 수 없다', async () => {
    const who = sender(); await pair(who);
    const review = await repo.review(who, schedule, (await get()).revision);
    await pair(who, f.stranger, otherId);
    assert.equal((await repo.context(who)).tripId, otherId);
    await rejected(repo.confirm(who, review.token, review.operationId), 'conflict');
    assert.equal((await f.repositories.ledgerRepository.get(f.stranger, otherId)).items.length, 0);
  });
  await t.test('만료 확인 토큰은 저장 및 재전송에 사용할 수 없다', async () => {
    const who = sender(); await pair(who);
    const review = await repo.review(who, schedule, (await get()).revision), before = await get();
    await f.admin.query(`update customer_private.channel_confirmations set expires_at=clock_timestamp()-interval '1 second'
      where token_hash=$1`, [hash(review.token)]);
    await rejected(repo.confirm(who, review.token, review.operationId), 'conflict'); assert.deepEqual(await get(), before);
  });
  await t.test('동행자의 viewer 전환·멤버 비활성화는 기존 grant와 검토 결과에 즉시 적용한다', async () => {
    const who = sender(); await pair(who, f.guest);
    const review = await repo.review(who, schedule, (await get()).revision);
    await f.repositories.identityRepository.manage(f.owner, id, member.id, 'viewer', true, (await get()).revision, operation());
    await rejected(repo.context(who), 'forbidden'); await rejected(repo.confirm(who, review.token, review.operationId), 'forbidden');
    await f.repositories.identityRepository.manage(f.owner, id, member.id, 'editor', false, (await get()).revision, operation());
    await rejected(repo.context(who), 'forbidden'); await rejected(repo.confirm(who, review.token, review.operationId), 'forbidden');
  });
  await t.test('실제 승인 세션 로그아웃은 저장과 과거 receipt 재전송을 모두 차단한다', async () => {
    const who = sender(); await pair(who, f.stranger, otherId);
    const review = await repo.review(who, schedule, 1); await repo.confirm(who, review.token, review.operationId);
    const before = (await f.admin.query('select body from customer_private.travel_documents where trip_id=$1', [otherId])).rows;
    // Auth restricted login performs the same session-row UPDATE as logout, no admin product operation.
    await f.auth.query('update customer_auth.sessions set revoked_at=clock_timestamp() where hash=$1', [f.stranger.sessionHash]);
    await rejected(repo.context(who), 'unauthenticated'); await rejected(repo.confirm(who, review.token, review.operationId), 'unauthenticated');
    assert.deepEqual((await f.admin.query('select body from customer_private.travel_documents where trip_id=$1', [otherId])).rows, before);
  });
  await t.test('confirm 저장이 선행하면 실제 세션 잠금이 commit까지 로그아웃을 대기시킨다', async () => {
    const actor = f.actors[3]!, who = sender(), target = (await f.create(actor)).value.trip.id;
    await pair(who, actor, target); const review = await repo.review(who, schedule, 1);
    let unlock!: () => void, reached!: () => void, writerPid = 0;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const saved = new Promise<void>(resolve => { reached = resolve; });
    const gated = channel(interceptPool(f.app, async (db, sql, args) => {
      if (sql === 'commit') { writerPid = (await db.query('select pg_backend_pid() as pid')).rows[0].pid; reached(); await gate; }
      return db.query(sql, args);
    }));
    const writing = gated.confirm(who, review.token, review.operationId);
    void writing.catch(() => {});
    const auth = await f.auth.connect(); let logout: Promise<unknown> | undefined;
    try {
      await Promise.race([saved, writing.then(() => { throw new Error('commit_gate_missing'); })]);
      await auth.query('begin'); await auth.query("set local statement_timeout='5s'");
      const logoutPid = (await auth.query('select pg_backend_pid() as pid')).rows[0].pid;
      logout = auth.query('update customer_auth.sessions set revoked_at=clock_timestamp() where hash=$1', [actor.sessionHash]);
      void logout.catch(() => {});
      let blocked = false;
      for (let attempt = 0; attempt < 40 && !blocked; attempt++) {
        blocked = (await f.admin.query('select $1::integer=any(pg_catalog.pg_blocking_pids($2::integer)) as blocked',
          [writerPid, logoutPid])).rows[0].blocked;
        if (!blocked) await setTimeout(25);
      }
      assert.equal(blocked, true, '로그아웃이 실제 승인 세션 행 잠금을 기다려야 합니다.');
      unlock(); const result = await writing; await logout; await auth.query('commit');
      assert.equal(result.tripRevision, 2);
      await rejected(repo.confirm(who, review.token, review.operationId), 'unauthenticated');
      const body = (await f.admin.query('select body from customer_private.travel_documents where trip_id=$1', [target])).rows[0].body;
      assert.equal(body.ledger.items.length, 1); assert.equal(body.trip.revision, 2);
    } finally {
      unlock(); await Promise.allSettled([writing, ...(logout ? [logout] : [])]);
      try { await auth.query('rollback'); } finally { auth.release(); }
    }
  });
  await t.test('동시 사용량 예약은 한도만 허용하고 중복 requestId는 period 변경 후에도 거부한다', async () => {
    const scope = `db-test:${f.testRun}:capacity`; f.registerUsageScope(scope);
    const store = createPgProviderUsageStore({ pool: f.app });
    const base = { scope, limit: 2, expiresAt: Date.now() + 60000, periodKey: '2026-11-01' };
    const result = await Promise.all(Array.from({ length: 6 }, () => store.reserve({ ...base, requestId: randomUUID() })));
    assert.equal(result.filter(Boolean).length, 2);
    const duplicateScope = `db-test:${f.testRun}:duplicate`; f.registerUsageScope(duplicateScope);
    const duplicate = { ...base, scope: duplicateScope, requestId: randomUUID() };
    const same = await Promise.all([store.reserve(duplicate), store.reserve(duplicate)]);
    assert.deepEqual(same.sort(), [false, true]);
    assert.equal(await store.reserve({ ...duplicate, periodKey: '2026-11-02' }), false);
    assert.equal(await store.reserve({ ...duplicate, requestId: randomUUID(), periodKey: '2026-11-02' }), true);
    const next = createPgProviderUsageStore({ pool: f.app }); assert.equal(await next.reserve(duplicate), false);
  });
  await t.test('만료 예약과 commit 응답 유실도 같은 requestId의 외부 호출을 다시 허용하지 않는다', async () => {
    const scope = `db-test:${f.testRun}:ambiguous`; f.registerUsageScope(scope);
    const request = { scope, requestId: randomUUID(), limit: 1, expiresAt: Date.now() + 60000 };
    let lost = false;
    const store = createPgProviderUsageStore({ pool: interceptPool(f.app, async (db, sql, args) => {
      const result = await db.query(sql, args);
      if (sql === 'commit' && !lost) { lost = true; throw new Error('synthetic_usage_commit_response_lost'); }
      return result;
    }) });
    await rejected(store.reserve(request), 'unavailable');
    const next = createPgProviderUsageStore({ pool: f.app }); assert.equal(await next.reserve(request), false);
    await f.admin.query(`update customer_private.provider_usage_reservations set expires_at=clock_timestamp()-interval '1 second'
      where scope=$1 and request_id=$2`, [scope, request.requestId]);
    assert.equal(await next.reserve({ ...request, expiresAt: Date.now() + 120000 }), false);
    assert.equal(await next.reserve({ ...request, requestId: randomUUID() }), false);
    const row = (await f.admin.query('select usage_day::text,period_key from customer_private.provider_usage_reservations where scope=$1', [scope])).rows[0];
    assert.equal(row.period_key, row.usage_day, 'period 생략 시 PostgreSQL UTC 날짜로 집계합니다.');
  });
});
