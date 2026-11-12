import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { approvedDevelopmentProjectRef } from './config.js';

export const authTestManifestPath = fileURLToPath(new URL('../../.auth-db-test-manifest.jsonl', import.meta.url));
const kinds = ['challenge', 'session', 'email', 'client'] as const;
type Kind = typeof kinds[number];
type Hashes = Record<Kind, string[]>;
export type AuthTestManifest = {
  runId: string; gate: string; hashes: Hashes; register(kind: Kind, hash: string): void;
};
const fail = (): never => { throw new Error('auth_test_manifest_invalid_or_pending'); };
function protectedFile(path: string, flags: number) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, flags | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1048576
      || (process.getuid && stat.uid !== process.getuid())) fail();
    return fd;
  } catch { if (fd !== undefined) fs.closeSync(fd); return fail(); }
}
export function createAuthTestManifest(path = authTestManifestPath): AuthTestManifest {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify({ projectRef: approvedDevelopmentProjectRef, runId: randomUUID() }) + '\n');
    fs.fsyncSync(fd);
  } catch { return fail(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return loadAuthTestManifest(path);
}
export function loadAuthTestManifest(path = authTestManifestPath): AuthTestManifest {
  const fd = protectedFile(path, fs.constants.O_RDONLY);
  let source: string;
  try { source = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
  try {
    // An interrupted, incomplete final registration cannot have preceded a DB write.
    const lines = source.split('\n'); lines.pop();
    const header = JSON.parse(lines.shift() ?? '');
    if (Object.keys(header).sort().join(',') !== 'projectRef,runId'
      || header.projectRef !== approvedDevelopmentProjectRef
      || typeof header.runId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(header.runId)) fail();
    const hashes: Hashes = { challenge: [], session: [], email: [], client: [] };
    for (const line of lines) {
      const record = JSON.parse(line);
      if (Object.keys(record).sort().join(',') !== 'hash,kind' || !kinds.includes(record.kind)
        || typeof record.hash !== 'string' || !/^[0-9a-f]{64}$/.test(record.hash)) fail();
      const kind = record.kind as Kind;
      if (!hashes[kind].includes(record.hash)) hashes[kind].push(record.hash);
    }
    const gate = createHash('sha256').update(`tripmoney-auth-acceptance:${header.runId}`).digest().readBigInt64BE(0).toString();
    return { runId: header.runId, gate, hashes, register(kind, hash) {
      if (!kinds.includes(kind) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) fail();
      if (hashes[kind].includes(hash)) return;
      const append = protectedFile(path, fs.constants.O_WRONLY | fs.constants.O_APPEND);
      try {
        fs.writeFileSync(append, JSON.stringify({ kind, hash }) + '\n'); fs.fsyncSync(append);
        hashes[kind].push(hash);
      } catch { fail(); } finally { fs.closeSync(append); }
    } };
  } catch { return fail(); }
}

type RecoveryClient = {
  query(query: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
};
/** The caller must await termination of the single writer process before invoking recovery. */
export async function recoverAuthTestManifest(path: string, connect: () => Promise<RecoveryClient>): Promise<void> {
  let db: RecoveryClient | undefined;
  let failed = false;
  try {
    const manifest = loadAuthTestManifest(path);
    db = await connect();
    await db.query('begin');
    await db.query("set local statement_timeout='30s'");
    await db.query("set local lock_timeout='25s'");
    // A terminated writer may have one last SQL command running in its transaction.
    await db.query('select pg_advisory_xact_lock($1::bigint)', [manifest.gate]);
    for (const [table, condition, values] of [
      ['sessions', 'hash=any($1::text[])', [manifest.hashes.session]],
      ['challenges', 'hash=any($1::text[])', [manifest.hashes.challenge]],
      ['rate_buckets', "(scope='email' and subject_hash=any($1::text[])) or (scope='client' and subject_hash=any($2::text[]))",
        [manifest.hashes.email, manifest.hashes.client]],
    ] as const) {
      await db.query(`delete from customer_auth.${table} where ${condition}`, [...values]);
      const result = await db.query(`select count(*)::integer as n from customer_auth.${table} where ${condition}`, [...values]);
      if (result.rows.length !== 1 || result.rows[0]?.n !== 0) throw new Error();
    }
    await db.query('commit');
  } catch {
    failed = true;
    try { await db?.query('rollback'); } catch { /* Keep the manifest for retry. */ }
  } finally {
    try { await db?.close(); } catch { failed = true; }
  }
  if (failed) throw new Error('auth_test_recovery_failed');
  try { fs.unlinkSync(path); } catch { throw new Error('auth_test_recovery_failed'); }
}

const guardedClient = Symbol('auth-test-guarded-client');
/** Keep checkout errors contained until release has completed, including release callbacks. */
export function guardAuthTestClient(client: PoolClient, options: { preserveSqlState?: boolean } = {}): PoolClient {
  if (Reflect.get(client, guardedClient) === true) return client;
  let failed = false, released = false, releasing = false, ending = false;
  const fixed = (cause?: unknown) => {
    const error = new Error('auth_test_client_failed');
    // Durable product tests need domain SQLSTATE mapping. Never copy the original message or metadata.
    if (options.preserveSqlState && !failed && typeof cause === 'object' && cause !== null
      && 'code' in cause && typeof cause.code === 'string' && /^[0-9A-Z]{5}$/.test(cause.code)) {
      Object.assign(error, { code: cause.code });
    }
    return error;
  };
  const endFailedClient = () => {
    if (ending) return;
    ending = true;
    try { void Promise.resolve(client.end()).catch(() => {}); } catch { /* Release still discards the failed client. */ }
  };
  const onError = () => {
    failed = true;
    // pg-pool checks client._ending after its release callbacks. End now if a callback fails.
    if (releasing) endFailedClient();
  };
  client.on('error', onError);
  return new Proxy(client, { get(target, name) {
    if (name === guardedClient) return true;
    if (name === 'query') return async (query: string, values?: unknown[]) => {
      if (failed || released) throw fixed();
      try {
        const result = await target.query(query, values);
        if (failed || released) throw fixed();
        return result;
      } catch (error) { throw fixed(error); }
    };
    if (name === 'release') return (discard?: Error | boolean) => {
      if (released) throw fixed();
      releasing = true;
      try {
        target.release(failed ? true : discard);
        if (failed) { endFailedClient(); throw fixed(); }
      } catch { failed = true; endFailedClient(); throw fixed(); }
      finally {
        released = true; releasing = false;
        target.removeListener('error', onError);
      }
    };
    const value = Reflect.get(target, name);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** Test-only wrapper: every product transaction and direct fixture DML shares the run gate. */
export function gatedAuthTestPool(pool: Pool, manifest: AuthTestManifest,
  options: { preserveSqlState?: boolean } = {}): Pool {
  const acquire = async (): Promise<PoolClient> => {
    const client = guardAuthTestClient(await pool.connect(), options);
    return new Proxy(client, { get(target, name) {
      if (name === 'query') return async (query: string, values?: unknown[]) => {
        const result = await target.query(query, values);
        if (query === 'begin') await target.query('select pg_advisory_xact_lock_shared($1::bigint)', [manifest.gate]);
        return result;
      };
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  return new Proxy(pool, { get(target, name) {
    if (name === 'connect') return acquire;
    if (name === 'query') return async (query: string, values?: unknown[]) => {
      if (!/^\s*(?:insert|update|delete)\b/i.test(query)) return target.query(query, values);
      const client = await acquire();
      let discard = false;
      try {
        await client.query('begin');
        const result = await client.query(query, values);
        await client.query('commit');
        return result;
      } catch {
        try { await client.query('rollback'); } catch { discard = true; }
        throw new Error('auth_test_write_failed');
      } finally { client.release(discard); }
    };
    const value = Reflect.get(target, name);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
