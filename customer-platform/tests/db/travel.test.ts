import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import type { ExpenseInput, LedgerCommand } from '../../core/ledger/contracts.js';
import { failCommitPool, input, interceptPool, inviteProof, operation, rejected, travelFixture } from './travel-fixtures.js';

test('전용 DB aggregate 저장·권한·경합·정산과 기존 자료 보존', { timeout: 120000 }, async t => {
  const f = await travelFixture();
  t.after(() => f.cleanup());
  const created = await f.create(), id = created.value.trip.id;
  const ownerId = created.value.members.find(member => member.userId === f.owner.userId)!.id;
  const second = await f.create(f.stranger), secondId = second.value.trip.id;
  let repo = f.repositories;
  const get = () => Promise.resolve(repo.ledgerRepository.get(f.owner, id));
  const write = async (command: LedgerCommand, actor = f.owner) => {
    const expectedRevision = (await get()).revision, fixed = operation();
    return repo.ledgerRepository.execute(actor, id, () => ({ command, expectedRevision, operation: fixed }));
  };

  await t.test('두 계정과 두 여행의 조회·수정 경계를 유지한다', async () => {
    assert.deepEqual((await repo.identityRepository.list(f.owner)).map(s => s.trip.id), [id]);
    assert.deepEqual((await repo.identityRepository.list(f.stranger)).map(s => s.trip.id), [secondId]);
    await rejected(repo.identityRepository.get(f.owner, secondId), 'not_found');
    await rejected(repo.ledgerRepository.get(f.stranger, id), 'not_found');
    await rejected(repo.ledgerRepository.execute(f.owner, secondId, () => ({
      command: { type: 'fx.update', rateMilli: 40000, source: 'manual' }, expectedRevision: 1, operation: operation(),
    })), 'not_found');
    assert.equal((await repo.ledgerRepository.get(f.stranger, secondId)).revision, 1);
  });
  await t.test('여행 생성 재전송은 같은 여행과 receipt를 반환한다', async () => {
    const creation = operation();
    const first = await repo.identityRepository.create(f.actors[3]!, input, creation);
    f.trips.push(first.value.trip.id);
    const replay = await repo.identityRepository.create(f.actors[3]!, input, creation);
    assert.equal(replay.replayed, true); assert.equal(replay.value.trip.id, first.value.trip.id);
    assert.equal((await repo.identityRepository.list(f.actors[3]!)).length, 1);
  });
  await t.test('여행 설정·일정·예산·감사 이력과 응답 유실 후 재전송을 재시작 뒤 보존한다', async () => {
    const { alias: _alias, ...settings } = input;
    await repo.identityRepository.update(f.owner, id, { ...settings, name: '수정한 합성 여행', budgetKrw: 20000 },
      (await get()).revision, operation());
    const command: LedgerCommand = { type: 'schedule.create', input: { date: '2026-11-01', title: '합성 산책',
      place: '직접 입력 장소', budgetKrw: 1000, startTime: '10:00', endTime: '11:00' } };
    const expectedRevision = (await get()).revision, fixed = operation();
    const first = await repo.ledgerRepository.execute(f.owner, id, () => ({ command, expectedRevision, operation: fixed }));
    const history = (await get()).history;
    const previous = repo; repo.close(); repo = f.connect();
    await rejected(previous.identityRepository.get(f.owner, id), 'unavailable');
    assert.equal((await repo.identityRepository.get(f.owner, id)).trip.name, '수정한 합성 여행');
    const dto = await get(); assert.equal(dto.items.length, 1); assert.equal(dto.budgetKrw, 20000);
    assert.deepEqual(dto.history, history);
    // Discarding the first response models the client not knowing whether commit succeeded.
    const replay = await repo.ledgerRepository.execute(f.owner, id, () => ({ command, expectedRevision, operation: fixed }));
    assert.equal(replay.replayed, true); assert.equal(replay.value.targetId, first.value.targetId);
    assert.deepEqual((await get()).history, history);
    await rejected(repo.ledgerRepository.execute(f.owner, id, () => ({ command, expectedRevision,
      operation: { ...fixed, hash: 'f'.repeat(64) } })), 'conflict');
  });
  await t.test('같은 expected revision의 동시 수정은 한 건만 성공한다', async () => {
    const other = f.connect(), before = await get(), expectedRevision = before.revision;
    const results = await Promise.allSettled([repo, other].map((r, index) => r.ledgerRepository.execute(f.owner, id,
      () => ({ command: { type: 'fx.update', rateMilli: 40000 + index * 1000, source: 'manual' },
        expectedRevision, operation: operation() }))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(failure.reason.code, 'conflict');
    const after = await get(); assert.equal(after.revision, expectedRevision + 1);
    assert.equal(after.history.length, before.history.length + 1);
  });
  await t.test('저장 후 PostgreSQL 오류는 원장·revision·receipt·감사를 함께 rollback한다', async () => {
    const before = await get();
    const storedBefore = await f.admin.query(`select body from customer_private.travel_documents where trip_id=$1`, [id]);
    const receiptsBefore = await f.admin.query('select receipt_key,value from customer_private.travel_receipts where trip_id=$1 order by receipt_key', [id]);
    const broken = f.connect(failCommitPool(f.app));
    await rejected(broken.ledgerRepository.execute(f.owner, id, () => ({ command: { type: 'fx.update',
      rateMilli: 42000, source: 'manual' }, expectedRevision: before.revision, operation: operation() })), 'unavailable');
    assert.deepEqual(await get(), before);
    assert.deepEqual((await f.admin.query('select body from customer_private.travel_documents where trip_id=$1', [id])).rows, storedBefore.rows);
    assert.deepEqual((await f.admin.query('select receipt_key,value from customer_private.travel_receipts where trip_id=$1 order by receipt_key', [id])).rows, receiptsBefore.rows);
  });
  const member = await f.add(id);
  const expense: ExpenseInput = { itineraryId: null, title: '합성 식사', occurredLocal: '2026-11-01T12:00',
    currency: 'KRW', amount: '1000', payerId: ownerId, splitIds: [ownerId, member.id], refreshRate: false };
  await t.test('경비·분담·지급 확인·일일 및 종료 정산을 재시작 뒤 보존하고 잠금을 적용한다', async () => {
    await write({ type: 'expense.create', input: expense });
    const payment = await write({ type: 'payment.report', toMemberId: ownerId, amountKrw: 500 }, f.guest);
    const reported = (await get()).settlement.payments.find(p => p.id === payment.value.targetId)!;
    await write({ type: 'payment.confirm', id: reported.id, expectedPaymentRevision: reported.revision });
    await write({ type: 'settlement.finalize', date: '2026-11-01' });
    const daily = await get();
    await rejected(write({ type: 'expense.create', input: expense }), 'validation');
    assert.deepEqual(await get(), daily);
    // Direct restricted SQL must not bypass a settled expense by substituting another ID at the same length.
    const tampered = f.connect(interceptPool(f.app, async (db, sql, args) => {
      if (sql.includes('customer_private.travel_save(')) {
        const after = JSON.parse(args[2] as string);
        // Domain created a valid unlocked 11/2 expense, with a valid appended receipt and audit.
        // Removing the old locked 11/1 expense defeats a check of only new rows and array length.
        after.ledgers[0][1].expenses = after.ledgers[0][1].expenses.filter((row: { id: string }) => row.id !== daily.expenses[0]!.id);
        args = [...args]; args[2] = JSON.stringify(after);
      }
      return db.query(sql, args);
    }));
    await rejected(tampered.ledgerRepository.execute(f.owner, id, () => ({ command: { type: 'expense.create',
      input: { ...expense, occurredLocal: '2026-11-02T12:00' } }, expectedRevision: daily.revision, operation: operation() })), 'forbidden');
    assert.deepEqual(await get(), daily);
    await write({ type: 'settlement.finalize', date: null });
    repo.close(); repo = f.connect();
    const dto = await get(); assert.equal(dto.expenses[0]!.amountKrw, 1000);
    assert.equal(dto.settlement.payments[0]!.status, 'confirmed');
    assert.deepEqual(dto.settlement.final.transfers, []); assert.equal(dto.settlement.snapshots.length, 2);
    await rejected(write({ type: 'expense.create', input: expense }), 'validation');
    await write({ type: 'settlement.reopen', date: null });
    await write({ type: 'settlement.reopen', date: '2026-11-01' });
    await write({ type: 'expense.create', input: expense }); assert.equal((await get()).summary.spentKrw, 2000);
  });
  await t.test('초대 폐기와 멤버 권한 철회는 재시작·재전송에도 적용된다', async () => {
    const proof = inviteProof();
    await repo.identityRepository.issue(f.owner, id, 'viewer', (await get()).revision, operation(), proof);
    await repo.identityRepository.revoke(f.owner, id, proof.id, (await get()).revision, operation());
    await rejected(repo.identityRepository.inspect(f.stranger, proof), 'invite_unavailable');
    await repo.identityRepository.manage(f.owner, id, member.id, 'viewer', true, (await get()).revision, operation());
    await rejected(write({ type: 'fx.update', rateMilli: 43000, source: 'manual' }, f.guest), 'forbidden');
    await repo.identityRepository.manage(f.owner, id, member.id, 'viewer', false, (await get()).revision, operation());
    repo.close(); repo = f.connect(); await rejected(repo.ledgerRepository.get(f.guest, id), 'not_found');
    assert.equal((await repo.ledgerRepository.get(f.stranger, secondId)).revision, 1);
  });
  await t.test('앱 계정의 document·receipt 직접 접근은 차단한다', async () => {
    for (const table of ['travel_documents', 'travel_receipts', 'channel_grants', 'provider_usage_reservations']) {
      await assert.rejects(f.app.query(`select * from customer_private.${table} limit 0`),
        (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501');
    }
  });
  await t.test('쓰기 Node 프로세스 종료 후 새 Node 프로세스가 같은 여행과 일정을 읽는다', async () => {
    type RestartResult = { tripId: string; name: string; revision: number; budgetKrw: number;
      items: { id: string; title: string; budgetKrw: number }[] };
    const run = (mode: 'write' | 'read', tripId?: string) => new Promise<RestartResult>((resolve, reject) => {
      const keys = ['CUSTOMER_DB_TEST_APPROVED', 'CUSTOMER_DB_TEST_ID', 'CUSTOMER_DB_TEST_ADMIN_URL', 'CUSTOMER_DB_TEST_URL', 'CUSTOMER_DB_AUTH_URL'];
      const child = spawn(process.execPath, ['--import', 'tsx', 'tests/db/travel-process.ts'], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: Object.fromEntries(keys.map(key => [key, process.env[key]])), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let result: RestartResult | undefined;
      const timer = globalThis.setTimeout(() => { child.kill('SIGKILL'); }, 25000);
      child.on('message', message => { const response = message as { ok: boolean; result?: RestartResult };
        if (response.ok) result = response.result; });
      child.once('error', () => { clearTimeout(timer); reject(new Error('durable_restart_process_failed')); });
      child.once('close', code => { clearTimeout(timer);
        if (code === 0 && result) resolve(result); else reject(new Error('durable_restart_process_failed')); });
      child.send({ mode, tripId, actor: f.owner });
    });
    const written = await run('write'); f.trips.push(written.tripId);
    // run resolves only after the writer has closed its pools and the OS reports child exit.
    const loaded = await run('read', written.tripId);
    assert.deepEqual(loaded, written); assert.equal(loaded.revision, 2); assert.equal(loaded.budgetKrw, 10000);
    assert.equal(loaded.items.length, 1); assert.equal(loaded.items[0]!.title, '프로세스 재시작 보존 일정');
    assert.equal(loaded.items[0]!.budgetKrw, 1200);
  });
  await t.test('travel_save 성공 후 commit까지 실제 세션 행을 잠그고 동시 로그아웃을 대기시킨다', async () => {
    const actor = f.actors[3]!;
    const target = (await repo.identityRepository.list(actor))[0]!.trip.id;
    let unlock!: () => void, reached!: () => void, writerPid = 0;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const saved = new Promise<void>(resolve => { reached = resolve; });
    const gated = f.connect(interceptPool(f.app, async (db, sql, args) => {
      if (sql === 'commit') { writerPid = (await db.query('select pg_backend_pid() as pid')).rows[0].pid; reached(); await gate; }
      return db.query(sql, args);
    }));
    const expectedRevision = (await repo.ledgerRepository.get(actor, target)).revision;
    const writing = Promise.resolve(gated.ledgerRepository.execute(actor, target, () => ({ command: {
      type: 'fx.update', rateMilli: 45000, source: 'manual' }, expectedRevision, operation: operation() })));
    void writing.catch(() => {});
    const auth = await f.auth.connect(); let logout: Promise<unknown> | undefined;
    try {
      await Promise.race([saved, writing.then(() => { throw new Error('commit_gate_missing'); })]);
      await auth.query('begin'); await auth.query("set local statement_timeout='5s'");
      const logoutPid = (await auth.query('select pg_backend_pid() as pid')).rows[0].pid;
      logout = auth.query('update customer_auth.sessions set revoked_at=clock_timestamp() where hash=$1', [actor.sessionHash]);
      void logout.catch(() => {});
      // Observe the server lock graph, not elapsed time or promise scheduling.
      let blocked = false;
      for (let attempt = 0; attempt < 40 && !blocked; attempt++) {
        const locks = await f.admin.query('select $1::integer=any(pg_catalog.pg_blocking_pids($2::integer)) as blocked', [writerPid, logoutPid]);
        blocked = locks.rows[0].blocked; if (!blocked) await setTimeout(25);
      }
      assert.equal(blocked, true, '로그아웃 UPDATE가 저장 transaction의 실제 세션 잠금을 기다려야 합니다.');
      unlock(); await writing; await logout; await auth.query('commit');
      await rejected(repo.ledgerRepository.get(actor, target), 'unauthenticated');
    } finally {
      unlock(); await Promise.allSettled([writing, ...(logout ? [logout] : [])]);
      try { await auth.query('rollback'); } finally { auth.release(); }
    }
  });
});
