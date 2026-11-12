import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { IdentityRepository } from '../../server/db/repository.js';
import { IdentityError } from '../../core/contracts.js';

const actor = { userId: '11111111-1111-4111-8111-111111111111', sessionHash: 'a'.repeat(64) };
const tripId = '22222222-2222-4222-8222-222222222222';
const row = () => ({ id: tripId, owner_user_id: actor.userId, name: '합성 여행', destination: '서울',
  start_date: '2026-11-01', end_date: '2026-11-03', time_zone: 'Asia/Seoul',
  budget_krw: '9007199254740991', settlement_mode: 'daily', daily_time: '20:00', revision: '12',
  status: 'active', created_at: new Date('2026-10-20T00:00:00Z'),
  owner_member_id: '33333333-3333-4333-8333-333333333333', my_role: 'editor' });
function boundary(trips: Record<string, unknown>[], members: Record<string, unknown>[] = []) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const pool = { connect: async () => ({ query: async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    const rows = sql.includes('from customer.trips t') ? trips
      : sql.includes('from customer.memberships m') ? members : [];
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
  }, release: () => {} }) } as unknown as Pool;
  return { repository: new IdentityRepository(pool), calls };
}

test('DB의 bigint·날짜·소유자 멤버·현재 권한을 내부 여행 계약으로 매핑한다', async () => {
  const f = boundary([row()]);
  assert.deepEqual(await f.repository.getTrip(actor, tripId), {
    id: tripId, ownerUserId: actor.userId, name: '합성 여행', destination: '서울',
    startDate: '2026-11-01', endDate: '2026-11-03', timeZone: 'Asia/Seoul',
    budgetKrw: 9007199254740991, settlementMode: 'daily', dailyTime: '20:00', revision: 12,
    status: 'active', createdAt: '2026-10-20T00:00:00.000Z',
    ownerMemberId: '33333333-3333-4333-8333-333333333333', role: 'editor',
  });
  const select = f.calls.find((call) => call.sql.includes('from customer.trips t'))!;
  assert.deepEqual(select.values, [tripId]);
  assert.match(select.sql, /owner\.active/);
  assert.match(select.sql, /me\.active/);
  assert.match(select.sql, /me\.user_id=customer_private\.actor_id\(\)/);
});

test('여행 목록은 최신 생성일·동순위 ID 순서의 parameter 없는 조회를 사용한다', async () => {
  const f = boundary([row()]);
  assert.equal((await f.repository.listTrips(actor)).length, 1);
  const select = f.calls.find((call) => call.sql.includes('from customer.trips t'))!;
  assert.match(select.sql, /order by t\.created_at desc,t\.id asc/);
  assert.deepEqual(select.values, []);
});

test('멤버 목록 전에 같은 transaction에서 여행 접근을 확인한다', async () => {
  const f = boundary([row()], [{ id: '33333333-3333-4333-8333-333333333333', trip_id: tripId,
    user_id: actor.userId, alias: 'A', role: 'owner', active: true }]);
  assert.deepEqual(await f.repository.listMembers(actor, tripId), [{
    id: '33333333-3333-4333-8333-333333333333', tripId, userId: actor.userId,
    alias: 'A', role: 'owner', active: true,
  }]);
  const queries = f.calls.filter((call) => call.sql.includes('from customer.'));
  assert.match(queries[0]!.sql, /from customer.trips t/);
  assert.match(queries[1]!.sql, /order by m\.created_at asc,m\.id asc/);
  assert.deepEqual(queries[1]!.values, [tripId]);
  assert.equal(f.calls.filter((call) => call.sql === 'begin').length, 1);
});

for (const method of ['getTrip', 'listMembers'] as const) {
  test(`RLS에서 여행이 보이지 않으면 ${method}은 not_found를 반환한다`, async () => {
    const f = boundary([]);
    await assert.rejects(f.repository[method](actor, tripId),
      (error: unknown) => error instanceof IdentityError && error.code === 'not_found');
    assert.ok(!f.calls.some((call) => call.sql.includes('from customer.memberships m')));
  });
}
for (const patch of [{ budget_krw: '9007199254740992' }, { budget_krw: '-1' },
  { budget_krw: '1.5' }, { revision: '0' }, { revision: '9007199254740992' },
  { my_role: 'admin' }, { settlement_mode: 'weekly' }, { created_at: new Date('invalid') }]) {
  test(`잘못된 DB 값은 조용히 변환하지 않고 조회를 실패시킨다: ${Object.keys(patch)[0]}`, async () => {
    const f = boundary([{ ...row(), ...patch }]);
    await assert.rejects(f.repository.getTrip(actor, tripId),
      (error: unknown) => error instanceof IdentityError && error.code === 'unavailable');
    assert.equal(f.calls.at(-1)?.sql, 'rollback');
  });
}
