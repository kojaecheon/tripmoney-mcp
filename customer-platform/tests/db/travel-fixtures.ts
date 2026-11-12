import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg, { type Pool, type PoolClient } from 'pg';
import { IdentityError, type Actor, type TripInput } from '../../core/contracts.js';
import { connectionConfig, readDbTestConfig } from '../../server/db/config.js';
import { createPools } from '../../server/db/pools.js';
import { createPgTravelRepositories } from '../../server/db/travel-repositories.js';
import { adminTransaction } from './fixtures.js';
import { gatedDurableTestPool, loadDurableTestManifest } from '../../server/db/durable-test-recovery.js';

export const input: TripInput = { name: 'DB 합성 여행', destination: '서울', startDate: '2026-11-01',
  endDate: '2026-11-03', timeZone: 'Asia/Seoul', budgetKrw: 10000, alias: '합성 소유자',
  settlementMode: 'daily', dailyTime: '20:00' };
export const operation = () => ({ operationId: randomUUID(), hash: randomBytes(32).toString('hex') });
export const inviteProof = () => ({ id: randomUUID(), kid: 'db_test', hash: randomBytes(32).toString('hex') });
export const rejected = (result: unknown, code: string) => assert.rejects(Promise.resolve(result),
  (error: unknown) => error instanceof IdentityError && error.code === code);

// Only table metadata, counts and digests leave PostgreSQL. Never return existing row contents or tokens.
async function baseline(pool: Pool) {
  const tables = await pool.query<{ schema: string; name: string }>(`select n.nspname as schema,c.relname as name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('customer','customer_private','customer_auth') and c.relkind='r'
    order by n.nspname,c.relname`);
  const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
  const rows = [];
  for (const table of tables.rows) {
    const result = await pool.query(`select count(*)::text as count,
      pg_catalog.md5(coalesce(pg_catalog.string_agg(t::text,E'\\n' order by t::text),'')) as digest
      from ${quote(table.schema)}.${quote(table.name)} t`);
    rows.push({ ...table, ...result.rows[0] });
  }
  return rows;
}

/** Every product operation uses inspected restricted pools. Admin is only for fixtures and assertions. */
export async function travelFixture() {
  const config = readDbTestConfig(process.env);
  const manifest = loadDurableTestManifest(undefined, config.targetId);
  const actors = Array.from({ length: 4 }, (_, index) => manifest.registerActor(index,
    createHash('sha256').update(randomBytes(32)).digest('hex')));
  const raw = await createPools({ appUrl: config.appUrl, authUrl: config.authUrl });
  const app = gatedDurableTestPool(raw.app, manifest), auth = gatedDurableTestPool(raw.auth, manifest);
  const admin = gatedDurableTestPool(new pg.Pool(connectionConfig(config.adminUrl, 'admin')), manifest);
  admin.on('error', () => console.error('customer_db_test_admin_connection_error'));
  const testRun = manifest.runId;
  const owner = actors[0]!, guest = actors[1]!, stranger = actors[2]!;
  const trips: string[] = [], usageScopes = manifest.usageScopes;
  const adapters: ReturnType<typeof createPgTravelRepositories>[] = [];
  const connect = (pool = app) => {
    const adapter = createPgTravelRepositories({ pool }); adapters.push(adapter); return adapter;
  };
  let before: Awaited<ReturnType<typeof baseline>> | undefined;
  let closed = false;
  async function cleanup() {
    if (closed) return;
    closed = true;
    for (const adapter of adapters) adapter.close();
    try {
      await adminTransaction(admin, async db => {
        // Includes a committed create whose response was lost, limited to this run's random synthetic actors.
        const owned = await db.query<{ trip_id: string }>(`select trip_id from customer_private.travel_documents
          where body->'trip'->>'ownerUserId'=any($1::text[])`, [actors.map(a => a.userId)]);
        const ids = [...new Set([...trips, ...owned.rows.map(row => row.trip_id)])];
        await db.query(`delete from customer_private.channel_confirmations where grant_id in
          (select id from customer_private.channel_grants where trip_id=any($1::uuid[]) or actor=any($2::uuid[]))`,
        [ids, actors.map(a => a.userId)]);
        await db.query('delete from customer_private.channel_grants where trip_id=any($1::uuid[]) or actor=any($2::uuid[])',
          [ids, actors.map(a => a.userId)]);
        await db.query('delete from customer_private.channel_pairs where trip_id=any($1::uuid[]) or actor=any($2::uuid[])',
          [ids, actors.map(a => a.userId)]);
        await db.query('delete from customer_private.travel_receipts where trip_id=any($1::uuid[]) or actor=any($2::uuid[])',
          [ids, actors.map(a => a.userId)]);
        await db.query('delete from customer_private.travel_attempts where actor=any($1::uuid[])', [actors.map(a => a.userId)]);
        await db.query('delete from customer_private.travel_documents where trip_id=any($1::uuid[])', [ids]);
        await db.query('delete from customer_private.provider_usage_reservations where scope=any($1::text[])', [usageScopes]);
        await db.query('delete from customer_auth.sessions where hash=any($1::text[])', [actors.map(a => a.sessionHash)]);
      });
      if (before) assert.deepEqual(await baseline(admin), before, '기존 자료 건수와 내용, 합성 자료 정리를 확인합니다.');
    } finally { await Promise.allSettled([app.end(), auth.end(), admin.end()]); }
  }
  try {
    const info = await admin.query('select current_user as role,current_database() as database');
    assert.deepEqual(info.rows, [{ role: 'postgres', database: 'postgres' }]);
    // Fail before fixture creation if either reviewed SQL extension is absent.
    const ready = await admin.query(`select pg_catalog.to_regprocedure('customer_private.travel_load(jsonb)') is not null
      and pg_catalog.to_regprocedure('customer_private.channel_web(text,jsonb)') is not null as ready`);
    assert.equal(ready.rows[0]?.ready, true, 'reviewed_sql_required');
    before = await baseline(admin);
    await adminTransaction(admin, async db => {
      for (const actor of actors) await db.query(`insert into customer_auth.sessions
        (hash,user_id,provider_session_id,tokens_cipher,expires_at) values($1,$2,$3,
        'DB_ONLY_SYNTHETIC_NOT_PROVIDER_AUTH',clock_timestamp()+interval '1 hour')`,
      [actor.sessionHash, actor.userId, randomUUID()]);
    });
  } catch {
    try { await cleanup(); } catch { /* Keep setup errors free of connection secrets. */ }
    throw new Error('customer_durable_db_test_setup_failed');
  }
  const repositories = connect();
  async function create(actor = owner) {
    const created = await connect().identityRepository.create(actor, { ...input, name: `합성-${testRun}` }, operation());
    trips.push(created.value.trip.id); return created;
  }
  async function add(tripId: string, role: 'editor' | 'viewer' = 'editor') {
    const repository = connect();
    const proof = inviteProof();
    const revision = (await repository.ledgerRepository.get(owner, tripId)).revision;
    await repository.identityRepository.issue(owner, tripId, role, revision, operation(), proof);
    const joined = await repository.identityRepository.accept(guest, proof, '합성 동행', operation());
    return joined.value.members.find(member => member.userId === guest.userId)!;
  }
  return { app, auth, admin, testRun, actors, owner, guest, stranger, trips, usageScopes,
    repositories, connect, create, add, cleanup, registerUsageScope: manifest.registerUsageScope };
}

/** Real PostgreSQL failure after travel_save, before commit, proves the adapter rolls all writes back. */
export function failCommitPool(pool: Pool): Pool {
  return interceptPool(pool, (db, sql, args) => sql === 'commit' ? db.query('select 1/0') : db.query(sql, args));
}
export function interceptPool(pool: Pool,
  intercept: (db: PoolClient, sql: string, args: unknown[]) => ReturnType<PoolClient['query']>): Pool {
  return { connect: async () => {
    const db = await pool.connect();
    return { query: (sql: string, args: unknown[] = []) => intercept(db, sql, args),
      release: (error?: Error) => db.release(error) } as unknown as PoolClient;
  } } as unknown as Pool;
}
