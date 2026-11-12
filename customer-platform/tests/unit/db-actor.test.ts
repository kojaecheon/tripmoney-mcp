import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';
import { IdentityError } from '../../core/contracts.js';
import { withActor } from '../../server/db/actor.js';

const actor = { userId: '11111111-1111-4111-8111-111111111111', sessionHash: 'a'.repeat(64) };
function transport(failAt?: string, cleanupFails = false) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const releases: (Error | undefined)[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql === failAt) throw Object.assign(new Error('SQL_SECRET_MUST_NOT_LEAK'), { code: 'P0401' });
      if (sql === 'rollback' && cleanupFails) throw new Error('cleanup-failed');
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
    },
    release: (error?: Error) => { releases.push(error); },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, client, calls, releases };
}

test('actor·세션을 transaction-local로 검증한 뒤에만 작업하고 commit한다', async () => {
  const f = transport();
  const result = await withActor(f.pool, actor, async (db) => {
    assert.equal(db, f.client as unknown as PoolClient);
    await db.query('select test_work');
    return 'saved';
  });
  assert.equal(result, 'saved');
  assert.deepEqual(f.calls, [
    { sql: 'begin', values: undefined },
    { sql: "select set_config('customer.actor_id',$1,true)", values: [actor.userId] },
    { sql: "select set_config('customer.session_hash',$1,true)", values: [actor.sessionHash] },
    { sql: 'select customer_private.assert_actor()', values: undefined },
    { sql: 'select test_work', values: undefined },
    { sql: 'commit', values: undefined },
  ]);
  assert.deepEqual(f.releases, [undefined]);
});

test('세션 검증 실패 시 작업을 호출하지 않고 rollback하며 SQL 원문을 감춘다', async () => {
  const f = transport('select customer_private.assert_actor()');
  let workCalled = false;
  await assert.rejects(withActor(f.pool, actor, async () => { workCalled = true; }),
    (error: unknown) => error instanceof IdentityError && error.code === 'unauthenticated'
      && !error.message.includes('SQL_SECRET'));
  assert.equal(workCalled, false);
  assert.equal(f.calls.at(-1)?.sql, 'rollback');
  assert.deepEqual(f.releases, [undefined]);
});

test('작업의 도메인 오류는 rollback 후 같은 오류로 반환한다', async () => {
  const f = transport();
  const error = new IdentityError('not_found', '여행을 찾을 수 없습니다.');
  await assert.rejects(withActor(f.pool, actor, async () => { throw error; }), (caught) => caught === error);
  assert.equal(f.calls.at(-1)?.sql, 'rollback');
});

test('rollback 실패 연결은 release(error)로 폐기한다', async () => {
  const f = transport('select customer_private.assert_actor()', true);
  await assert.rejects(withActor(f.pool, actor, async () => {}), IdentityError);
  assert.equal(f.releases.length, 1);
  assert.ok(f.releases[0] instanceof Error);
});

test('commit 실패를 성공으로 반환하지 않고 rollback한다', async () => {
  const f = transport('commit');
  await assert.rejects(withActor(f.pool, actor, async () => 'not-saved'), IdentityError);
  assert.deepEqual(f.calls.slice(-2).map((call) => call.sql), ['commit', 'rollback']);
});

test('연결 실패는 비밀 URL을 포함하지 않는 unavailable 오류로 반환한다', async () => {
  const pool = { connect: async () => { throw new Error('postgresql://secret:password@host'); } } as unknown as Pool;
  await assert.rejects(withActor(pool, actor, async () => {}),
    (error: unknown) => error instanceof IdentityError && error.code === 'unavailable'
      && !error.message.includes('postgresql'));
});

test('잘못된 actor 형식은 연결 전에 거부한다', async () => {
  let connected = false;
  const pool = { connect: async () => { connected = true; throw new Error(); } } as unknown as Pool;
  await assert.rejects(withActor(pool, { userId: 'invalid', sessionHash: 'invalid' }, async () => {}), IdentityError);
  assert.equal(connected, false);
});
