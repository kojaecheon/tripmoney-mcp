import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../../core/contracts.js';
import { approvedDevelopmentProjectRef } from './config.js';
import { gatedAuthTestPool, guardAuthTestClient } from './auth-test-recovery.js';

export function guardDurableTestClient(client: PoolClient): PoolClient {
  return guardAuthTestClient(client, { preserveSqlState: true });
}
export const durableTestManifestPath = fileURLToPath(new URL('../../.durable-db-test-manifest.jsonl', import.meta.url));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const fail = (): never => { throw new Error('durable_test_manifest_invalid_or_pending'); };
export type DurableTestManifest = {
  targetId: string; runId: string; gate: string; actors: Actor[]; usageScopes: string[];
  registerActor(index: number, sessionHash: string): Actor; registerUsageScope(scope: string): void;
};
function checkedTarget(target: string) {
  if (![ `db.${approvedDevelopmentProjectRef}.supabase.co:5432/postgres`,
    'aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
    'aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres' ].includes(target)) fail();
}
function actorId(runId: string, index: number) {
  if (!Number.isInteger(index) || index < 0 || index > 15) return fail();
  const bytes = createHash('sha256').update(`tripmoney-durable-test:${runId}:actor:${index}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function protectedFile(path: string, flags: number) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, flags | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 1048576
      || (process.getuid && info.uid !== process.getuid())) fail();
    return fd;
  } catch { if (fd !== undefined) fs.closeSync(fd); return fail(); }
}
export function createDurableTestManifest(targetId: string, path = durableTestManifestPath): DurableTestManifest {
  checkedTarget(targetId); let fd: number | undefined;
  try {
    fd = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify({ projectRef: approvedDevelopmentProjectRef, targetId, runId: randomUUID() }) + '\n');
    fs.fsyncSync(fd);
  } catch { return fail(); } finally { if (fd !== undefined) fs.closeSync(fd); }
  return loadDurableTestManifest(path, targetId);
}
export function loadDurableTestManifest(path = durableTestManifestPath, expectedTarget?: string): DurableTestManifest {
  const fd = protectedFile(path, fs.constants.O_RDONLY); let source: string;
  try { source = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
  try {
    const lines = source.split('\n'); const incomplete = lines.pop();
    // A final incomplete registration cannot have returned before a DB write.
    const header = JSON.parse(lines.shift() ?? '');
    if (Object.keys(header).sort().join(',') !== 'projectRef,runId,targetId'
      || header.projectRef !== approvedDevelopmentProjectRef || typeof header.runId !== 'string' || !uuid.test(header.runId)
      || typeof header.targetId !== 'string' || (expectedTarget !== undefined && header.targetId !== expectedTarget)) fail();
    checkedTarget(header.targetId);
    const actors: Actor[] = [], usageScopes: string[] = [];
    const checkScope = (scope: string) => typeof scope === 'string'
      && scope.startsWith(`db-test:${header.runId}:`) && /^[a-z0-9-]{1,64}$/.test(scope.slice(`db-test:${header.runId}:`.length));
    for (const line of lines) {
      const record = JSON.parse(line);
      if (record.kind === 'actor') {
        if (Object.keys(record).sort().join(',') !== 'index,kind,sessionHash,userId'
          || record.userId !== actorId(header.runId, record.index) || typeof record.sessionHash !== 'string' || !hash.test(record.sessionHash)
          || actors.some(a => a.userId === record.userId || a.sessionHash === record.sessionHash)) fail();
        actors.push({ userId: record.userId, sessionHash: record.sessionHash });
      } else if (record.kind === 'usage') {
        if (Object.keys(record).sort().join(',') !== 'kind,scope' || !checkScope(record.scope) || usageScopes.includes(record.scope)) fail();
        usageScopes.push(record.scope);
      } else fail();
    }
    function append(record: object) {
      if (incomplete) fail(); // Do not append after an interrupted final record.
      const fd = protectedFile(path, fs.constants.O_WRONLY | fs.constants.O_APPEND);
      try { fs.writeFileSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd); }
      catch { fail(); } finally { fs.closeSync(fd); }
    }
    return { runId: header.runId, targetId: header.targetId,
      gate: createHash('sha256').update(`tripmoney-durable-gate:${header.runId}`).digest().readBigInt64BE(0).toString(),
      actors, usageScopes,
      registerActor(index, sessionHash) {
        const userId = actorId(header.runId, index);
        if (typeof sessionHash !== 'string' || !hash.test(sessionHash)) return fail();
        const existing = actors.find(a => a.userId === userId);
        if (existing) { if (existing.sessionHash !== sessionHash) return fail(); return existing; }
        if (actors.some(a => a.sessionHash === sessionHash)) return fail();
        append({ kind: 'actor', index, userId, sessionHash });
        const actor = { userId, sessionHash }; actors.push(actor); return actor;
      },
      registerUsageScope(scope) {
        if (!checkScope(scope)) fail(); if (usageScopes.includes(scope)) return;
        append({ kind: 'usage', scope }); usageScopes.push(scope);
      } };
  } catch { return fail(); }
}

export function gatedDurableTestPool(pool: Pool, manifest: DurableTestManifest): Pool {
  // Reuse the already tested guarded checkout and per-transaction shared gate. No authentication fixture writes.
  return gatedAuthTestPool(pool, { runId: manifest.runId, gate: manifest.gate,
    hashes: { challenge: [], session: [], email: [], client: [] }, register() { fail(); } }, { preserveSqlState: true });
}
type RecoveryClient = {
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
};
/** Caller must first wait for the single writer process and its IPC-bound restart children to terminate. */
export async function recoverDurableTestManifest(path: string, targetId: string,
  connect: () => Promise<RecoveryClient>): Promise<void> {
  let db: RecoveryClient | undefined, failed = false;
  try {
    const manifest = loadDurableTestManifest(path, targetId);
    db = await connect(); await db.query('begin');
    await db.query("set local statement_timeout='30s'"); await db.query("set local lock_timeout='25s'");
    await db.query('select pg_advisory_xact_lock($1::bigint)', [manifest.gate]);
    const actors = manifest.actors.map(a => a.userId);
    const owned = await db.query(`select trip_id from customer_private.travel_documents
      where body->'trip'->>'ownerUserId'=any($1::text[])`, [actors]);
    const trips = owned.rows.map(row => { if (typeof row.trip_id !== 'string' || !uuid.test(row.trip_id)) return fail(); return row.trip_id; });
    const scoped: [string, string, unknown[]][] = [
      ['customer_private.channel_confirmations', `grant_id in (select id from customer_private.channel_grants
        where actor=any($1::uuid[]) or trip_id=any($2::uuid[]))`, [actors, trips]],
      ['customer_private.channel_grants', 'actor=any($1::uuid[]) or trip_id=any($2::uuid[])', [actors, trips]],
      ['customer_private.channel_pairs', 'actor=any($1::uuid[]) or trip_id=any($2::uuid[])', [actors, trips]],
      ['customer_private.travel_receipts', 'actor=any($1::uuid[]) or trip_id=any($2::uuid[])', [actors, trips]],
      ['customer_private.travel_attempts', 'actor=any($1::uuid[])', [actors]],
      ['customer_private.travel_documents', 'trip_id=any($1::uuid[])', [trips]],
      ['customer_private.provider_usage_reservations', 'scope=any($1::text[])', [manifest.usageScopes]],
      ['customer_auth.sessions', 'hash=any($1::text[])', [manifest.actors.map(a => a.sessionHash)]],
    ];
    // Verify each dependency before deleting its parent, so the check still has its scoped keys.
    for (const [table, condition, args] of scoped) {
      await db.query(`delete from ${table} where ${condition}`, args);
      const result = await db.query(`select count(*)::integer as n from ${table} where ${condition}`, args);
      if (result.rows.length !== 1 || result.rows[0]?.n !== 0) throw Error();
    }
    await db.query('commit');
  } catch { failed = true; try { await db?.query('rollback'); } catch { /* Preserve manifest for retry. */ } }
  finally { try { await db?.close(); } catch { failed = true; } }
  if (failed) throw new Error('durable_test_recovery_failed');
  try { fs.unlinkSync(path); } catch { throw new Error('durable_test_recovery_failed'); }
}
