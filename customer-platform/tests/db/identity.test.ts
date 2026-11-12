import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { IdentityError } from '../../core/contracts.js';
import { withActor } from '../../server/db/actor.js';
import { dbFixture, adminTransaction } from './fixtures.js';

const sqlState = (expected: string) => (error: unknown) => typeof error === 'object' && error !== null
  && 'code' in error && error.code === expected;

test('전용 DB의 실제 로그인·RLS·actor·owner·pool·provider 경계', { timeout: 120000 }, async (t) => {
  const f = await dbFixture();
  t.after(() => f.cleanup());
  const trip = await f.createTrip();
  await adminTransaction(f.admin, async (db) => {
    for (const [index, role, active] of [[1, 'editor', true], [2, 'viewer', true], [3, 'editor', false]] as const) {
      await db.query(`insert into customer.memberships(id,trip_id,user_id,alias,role,active)
        values($1,$2,$3,$4,$5,$6)`, [randomUUID(), trip.id, f.actors[index]!.userId, `S${index}`, role, active]);
    }
    // 정리할 6종 모두에 합성 행을 남겨 cleanup의 잔여 검사를 실제로 거치게 한다.
    await db.query(`insert into customer.invites(id,trip_id,role,token_hash,key_id,expires_at,created_by)
      values($1,$2,'viewer',$3,'db_test',clock_timestamp()+interval '1 hour',$4)`,
    [randomUUID(), trip.id, randomBytes(32).toString('hex'), f.owner.userId]);
    await db.query(`insert into customer_private.command_receipts(actor,action,operation_id,trip_id,payload_hash,result)
      values($1,'test:cleanup',$2,$3,$4,'{}')`,
    [f.owner.userId, randomUUID(), trip.id, randomBytes(32).toString('hex')]);
    await db.query(`insert into customer_private.audit_events(id,actor,trip_id,action,target_id,revision)
      values($1,$2,$3,'test:cleanup',$3,1)`, [randomUUID(), f.owner.userId, trip.id]);
  });

  await t.test('context 없는 조회 0행, 앱의 직접 쓰기·인증 행 읽기 차단', async () => {
    assert.equal((await f.app.query('select id from customer.trips')).rowCount, 0);
    await assert.rejects(f.app.query('update customer.trips set budget_krw=0 where id=$1', [trip.id]), sqlState('42501'));
    await assert.rejects(f.app.query('select hash from customer_auth.sessions'), sqlState('42501'));
  });
  await t.test('소유자·편집자·조회자만 같은 여행을 읽고 비활성·비멤버는 404', async () => {
    for (const index of [0, 1, 2]) assert.equal((await f.repository.getTrip(f.actors[index]!, trip.id)).id, trip.id);
    for (const index of [3, 8]) await assert.rejects(f.repository.getTrip(f.actors[index]!, trip.id),
      (error: unknown) => error instanceof IdentityError && error.code === 'not_found');
    assert.equal((await f.repository.listMembers(f.owner, trip.id)).length, 4);
  });
  await t.test('세션 위조·다른 actor·폐기·만료 세션을 거부', async () => {
    const denied = [ { ...f.owner, sessionHash: '0'.repeat(64) },
      { ...f.owner, sessionHash: f.actors[1]!.sessionHash }, f.actors[5]!, f.actors[6]! ];
    for (const actor of denied) await assert.rejects(f.repository.listTrips(actor),
      (error: unknown) => error instanceof IdentityError && error.code === 'unauthenticated');
  });
  for (const kind of ['app', 'auth'] as const) {
    await t.test(`${kind} LOGIN은 자기 runtime·반대 runtime·소유자·관리자 역할로 전환 불가`, async () => {
      const db = await f[kind].connect();
      try {
        for (const role of ['customer_app', 'customer_auth_runtime', 'customer_writer', 'customer_auth_owner', 'postgres']) {
          await assert.rejects(db.query(`set role ${role}`), sqlState('42501'));
        }
      } finally {
        // 잘못된 권한 때문에 SET ROLE이 성공해도 그 상태를 pool에 돌려주지 않는다.
        try { await db.query('reset role'); } catch (error) { db.release(error as Error); throw error; }
        db.release();
      }
    });
  }
  await t.test('인증 LOGIN은 합성 앱 인증 행을 읽고 여행 조회는 거부된다', async () => {
    const result = await f.auth.query('select user_id from customer_auth.sessions where hash=$1', [f.owner.sessionHash]);
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].user_id, f.owner.userId);
    await assert.rejects(f.auth.query('select id from customer.trips where id=$1', [trip.id]), sqlState('42501'));
  });
  await t.test('같은 물리 연결의 commit 직후 actor와 세션 context가 남지 않음', async () => {
    const pid = await withActor(f.app, f.owner, async (db) => (await db.query('select pg_backend_pid() as pid')).rows[0].pid);
    const result = await f.app.query(`select pg_backend_pid() as pid,
      nullif(current_setting('customer.actor_id',true),'') as actor,
      nullif(current_setting('customer.session_hash',true),'') as session`);
    assert.equal(result.rows[0].pid, pid);
    assert.equal(result.rows[0].actor, null);
    assert.equal(result.rows[0].session, null);
  });
  await t.test('같은 물리 연결의 rollback 직후 actor와 세션 context가 남지 않음', async () => {
    let pid: number | undefined;
    const failure = new IdentityError('conflict', '합성 실패');
    await assert.rejects(withActor(f.app, f.owner, async (db) => {
      pid = (await db.query('select pg_backend_pid() as pid')).rows[0].pid;
      throw failure;
    }), (error: unknown) => error === failure);
    assert.equal(typeof pid, 'number');
    const result = await f.app.query(`select pg_backend_pid() as pid,
      nullif(current_setting('customer.actor_id',true),'') as actor,
      nullif(current_setting('customer.session_hash',true),'') as session`);
    assert.equal(result.rows[0].pid, pid);
    assert.equal(result.rows[0].actor, null);
    assert.equal(result.rows[0].session, null);
  });
  await t.test('소유자가 없는 여행은 실제 commit에서 거부', async () => {
    const id = randomUUID();
    f.trips.push(id);
    let bodyCompleted = false;
    await assert.rejects(adminTransaction(f.admin, async (db) => {
      await db.query(`insert into customer.trips(id,owner_user_id,name,destination,start_date,end_date,
        time_zone,budget_krw,settlement_mode,daily_time) values($1,$2,'합성','서울','2026-11-01','2026-11-02',
        'Asia/Seoul',0,'daily','20:00')`, [id, f.owner.userId]);
      bodyCompleted = true;
    }), sqlState('P0422'));
    assert.equal(bodyCompleted, true);
    assert.equal((await f.admin.query('select id from customer.trips where id=$1', [id])).rowCount, 0);
  });
  await t.test('여행 소유자와 다른 계정의 owner 멤버십은 실제 commit에서 거부', async () => {
    const id = randomUUID();
    f.trips.push(id);
    let bodyCompleted = false;
    await assert.rejects(adminTransaction(f.admin, async (db) => {
      await db.query(`insert into customer.trips(id,owner_user_id,name,destination,start_date,end_date,
        time_zone,budget_krw,settlement_mode,daily_time) values($1,$2,'합성','서울','2026-11-01','2026-11-02',
        'Asia/Seoul',0,'daily','20:00')`, [id, f.owner.userId]);
      await db.query(`insert into customer.memberships(id,trip_id,user_id,alias,role)
        values($1,$2,$3,'다른 소유자','owner')`, [randomUUID(), id, f.actors[1]!.userId]);
      bodyCompleted = true;
    }), sqlState('P0422'));
    assert.equal(bodyCompleted, true);
    assert.equal((await f.admin.query('select id from customer.trips where id=$1', [id])).rowCount, 0);
    assert.equal((await f.admin.query('select id from customer.memberships where trip_id=$1', [id])).rowCount, 0);
  });
  await t.test('provider SQL helper가 없고 소유 역할·runtime·LOGIN의 실효 SELECT가 없다', async () => {
    const helper = await f.admin.query(`select
      pg_catalog.to_regprocedure('customer_auth.provider_session_exists(uuid,uuid)') as helper`);
    assert.equal(helper.rows[0].helper, null);
    const roles = ['customer_auth_owner', 'customer_auth_runtime', 'customer_app', 'customer_app_login', 'customer_auth_login'];
    const permissions = await f.admin.query(`select r.rolname,
      pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT') as provider_read
      from pg_catalog.pg_roles r cross join pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where r.rolname=any($1::text[]) and n.nspname='auth' and c.relname='sessions'
      order by r.rolname`, [roles]);
    assert.deepEqual(permissions.rows.map((row) => row.rolname), [...roles].sort());
    for (const row of permissions.rows) assert.equal(row.provider_read, false, row.rolname);
    for (const pool of [f.app, f.auth]) {
      await assert.rejects(pool.query('select id,user_id from auth.sessions limit 0'), sqlState('42501'));
    }
  });
});
