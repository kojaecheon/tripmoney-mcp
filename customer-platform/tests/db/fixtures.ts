import pg, { type PoolClient } from 'pg';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { connectionConfig, readDbTestConfig } from '../../server/db/config.js';
import { IdentityRepository } from '../../server/db/repository.js';
import { createPools } from '../../server/db/pools.js';

export async function adminTransaction<T>(db: pg.Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let discard: Error | undefined;
  try {
    await client.query('begin');
    const value = await work(client);
    await client.query('commit');
    return value;
  } catch (error) {
    try { await client.query('rollback'); } catch { discard = new Error('test_cleanup_failed'); }
    throw error;
  } finally { client.release(discard); }
}

export async function dbFixture() {
  const config = readDbTestConfig(process.env);
  const { app, auth } = await createPools({ appUrl: config.appUrl, authUrl: config.authUrl });
  const admin = new pg.Pool(connectionConfig(config.adminUrl, 'admin'));
  // max=1로 고정해 withActor 전후에 같은 물리 연결이 재사용되는지도 검사한다.
  app.options.max = 1;
  const testRun = randomUUID();
  const actors = Array.from({ length: 9 }, () => ({ userId: randomUUID(),
    sessionHash: createHash('sha256').update(randomBytes(32)).digest('hex') }));
  const trips: string[] = [];
  const sessionHashes = actors.map((actor) => actor.sessionHash);
  let closed = false;
  async function cleanup() {
    if (closed) return;
    closed = true;
    try {
      await adminTransaction(admin, async (client) => {
        await client.query('delete from customer_private.audit_events where trip_id=any($1::uuid[])', [trips]);
        await client.query('delete from customer_private.command_receipts where trip_id=any($1::uuid[])', [trips]);
        await client.query('delete from customer.invites where trip_id=any($1::uuid[])', [trips]);
        await client.query('delete from customer.memberships where trip_id=any($1::uuid[])', [trips]);
        await client.query('delete from customer.trips where id=any($1::uuid[])', [trips]);
        await client.query('delete from customer_auth.sessions where hash=any($1::text[])', [sessionHashes]);
      });
      const result = await admin.query(`select
        (select count(*)::integer from customer.trips where id=any($1::uuid[])) as trips,
        (select count(*)::integer from customer.memberships where trip_id=any($1::uuid[])) as memberships,
        (select count(*)::integer from customer.invites where trip_id=any($1::uuid[])) as invites,
        (select count(*)::integer from customer_private.command_receipts where trip_id=any($1::uuid[])) as receipts,
        (select count(*)::integer from customer_private.audit_events where trip_id=any($1::uuid[])) as audit,
        (select count(*)::integer from customer_auth.sessions where hash=any($2::text[])) as sessions`,
      [trips, sessionHashes]);
      const counts = result.rows[0];
      if (!counts || ['trips', 'memberships', 'invites', 'receipts', 'audit', 'sessions']
        .some((table) => counts[table] !== 0)) throw new Error('test_rows_remain');
    } finally { await Promise.allSettled([app.end(), auth.end(), admin.end()]); }
  }
  async function createTrip(ownerIndex = 0) {
    const id = randomUUID();
    const ownerId = randomUUID();
    const owner = actors[ownerIndex];
    if (!owner) throw new Error('test_actor_missing');
    trips.push(id);
    await adminTransaction(admin, async (client) => {
      await client.query(`insert into customer.trips(id,owner_user_id,name,destination,start_date,end_date,
        time_zone,budget_krw,settlement_mode,daily_time) values($1,$2,$3,'서울','2026-11-01','2026-11-03',
        'Asia/Seoul',100000,'daily','20:00')`, [id, owner.userId, `합성-${testRun}`]);
      await client.query(`insert into customer.memberships(id,trip_id,user_id,alias,role)
        values($1,$2,$3,'소유자','owner')`, [ownerId, id, owner.userId]);
    });
    return { id, ownerId };
  }
  try {
    const info = await admin.query('select current_user, current_database() as database');
    if (info.rows[0]?.current_user !== 'postgres' || info.rows[0]?.database !== 'postgres') {
      throw new Error('test_admin_role_mismatch');
    }
    await adminTransaction(admin, async (client) => {
      for (const actor of actors) {
        await client.query(`insert into customer_auth.sessions(hash,user_id,provider_session_id,tokens_cipher,expires_at)
          values($1,$2,$3,'DB_ONLY_SYNTHETIC_NOT_PROVIDER_AUTH',clock_timestamp()+interval '1 hour')`,
        [actor.sessionHash, actor.userId, randomUUID()]);
      }
      await client.query('update customer_auth.sessions set revoked_at=clock_timestamp() where hash=$1', [actors[5]!.sessionHash]);
      await client.query(`update customer_auth.sessions set created_at=clock_timestamp()-interval '2 hours',
        expires_at=clock_timestamp()-interval '1 hour' where hash=$1`, [actors[6]!.sessionHash]);
    });
  } catch {
    try { await cleanup(); } catch { /* 초기 연결 실패 시에도 Pool은 닫는다. */ }
    throw new Error('customer_db_test_setup_failed');
  }
  return { app, auth, admin, testRun, actors, trips, owner: actors[0]!,
    repository: new IdentityRepository(app), createTrip, cleanup };
}
