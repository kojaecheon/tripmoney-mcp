import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { IdentityError, type ErrorCode } from '../../core/contracts.js';
import type { AuthStore, ChallengeInput, ChallengeLease, NewAuthSession, SessionLease, StoredAuthSession } from './store-contract.js';

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX = Number.MAX_SAFE_INTEGER;
const messages = {
  unavailable: '인증 확인을 잠시 사용할 수 없습니다.',
  unauthenticated: '다시 로그인해 주세요.',
  rate_limited: '잠시 뒤 다시 요청해 주세요.',
  validation: '입력 내용을 확인해 주세요.',
} as const;
type StoreCode = keyof typeof messages;
function fail(code: StoreCode = 'unavailable'): never { throw new IdentityError(code, messages[code]); }
function safe(error: unknown): IdentityError {
  const code = error instanceof IdentityError && Object.hasOwn(messages, error.code)
    ? error.code as StoreCode : 'unavailable';
  return new IdentityError(code as ErrorCode, messages[code]);
}
function hashInput(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) fail('unauthenticated');
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_048_576) fail();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail();
  return value;
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+$/.test(value))) fail();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) fail();
  return number;
}
function versionInput(value: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail();
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value; }
function timestamp(value: unknown): string {
  if (!(value instanceof Date) && (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value))) fail();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail();
  return date.toISOString();
}
function one(rows: Record<string, unknown>[]): Record<string, unknown> {
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') fail();
  return rows[0];
}
function affected(rows: Record<string, unknown>[]): Record<string, unknown> {
  if (rows.length === 0) fail('unauthenticated');
  return one(rows);
}
function newSession(value: NewAuthSession): void {
  if (!value || typeof value !== 'object') fail();
  hashInput(value.hash); uuid(value.userId); uuid(value.providerSessionId); text(value.tokensCipher);
}
function lockKey(namespace: string, hash: string): string {
  return createHash('sha256').update(`tripmoney-auth:${namespace}:${hash}`).digest().readBigInt64BE(0).toString();
}
type Connection = { db: PoolClient; discard: boolean; failed: boolean };
async function query(connection: Connection, sql: string, values: unknown[] = []): Promise<QueryResult> {
  if (connection.failed) fail();
  const result = await connection.db.query(sql, values);
  if (connection.failed) fail();
  return result;
}
async function transaction<T>(connection: Connection, work: () => Promise<T>): Promise<T> {
  if (connection.discard) fail();
  let begun = false;
  let committing = false;
  try {
    // A failed BEGIN can leave the connection state uncertain too.
    begun = true;
    await query(connection, 'begin');
    await query(connection, "set local statement_timeout='8s'");
    await query(connection, "set local lock_timeout='2s'");
    await query(connection, "set local idle_in_transaction_session_timeout='15s'");
    const result = await work();
    committing = true;
    await query(connection, 'commit');
    return result;
  } catch (error) {
    if (committing) connection.discard = true;
    if (begun) {
      try { await query(connection, 'rollback'); } catch { connection.discard = true; }
    }
    throw safe(error);
  }
}
async function checkout<T>(pool: Pick<Pool, 'connect'>, work: (connection: Connection) => Promise<T>): Promise<T> {
  let db: PoolClient;
  try { db = await pool.connect(); } catch { fail(); }
  const connection: Connection = { db, discard: false, failed: false };
  const onError = (): void => {
    connection.failed = true;
    connection.discard = true;
  };
  try {
    db.on('error', onError);
    const result = await work(connection);
    if (connection.discard) fail();
    return result;
  }
  catch (error) {
    if (connection.failed) fail();
    throw safe(error);
  }
  finally {
    try {
      // Keep the listener installed until release finishes, including failure.
      db.release(connection.discard ? true : undefined);
      if (connection.failed) fail();
    } catch { fail(); }
    finally { db.removeListener('error', onError); }
  }
}
async function xactLock(connection: Connection, key: string): Promise<void> {
  await query(connection, 'select pg_advisory_xact_lock($1::bigint)', [key]);
}

// A lease never lets overlapping method calls interleave transactions on one client.
async function locked<T, L>(pool: Pick<Pool, 'connect'>, namespace: string, hash: string,
  create: (connection: Connection, run: <R>(work: () => Promise<R>) => Promise<R>) => L,
  work: (lease: L) => Promise<T>): Promise<T> {
  hashInput(hash);
  return checkout(pool, async connection => {
    const key = lockKey(namespace, hash);
    let acquired = false;
    let active = true;
    let inFlight: Promise<unknown> | undefined;
    const run = async <R>(operation: () => Promise<R>): Promise<R> => {
      if (!active || inFlight || connection.discard) fail();
      const promise = Promise.resolve().then(operation);
      inFlight = promise;
      try { return await promise; } catch (error) { throw safe(error); }
      finally { inFlight = undefined; }
    };
    try {
      try {
        await transaction(connection, async () => {
          await query(connection, 'select pg_advisory_lock($1::bigint)', [key]);
          acquired = true;
        });
      } catch (error) {
        // The server may have acquired a session lock before its response was lost.
        connection.discard = true;
        throw error;
      }
      return await work(create(connection, run));
    } finally {
      active = false;
      if (inFlight) {
        try { await inFlight; } catch { /* The lease operation already owns its rejection. */ }
      }
      if (acquired && !connection.discard) {
        try {
          await transaction(connection, async () => {
            const result = await query(connection, 'select pg_advisory_unlock($1::bigint) as unlocked', [key]);
            if (one(result.rows).unlocked !== true) fail();
          });
        } catch {
          connection.discard = true;
          fail();
        }
      }
    }
  });
}

export function createAuthStore(pool: Pick<Pool, 'connect'>): AuthStore {
  return {
    async reserveChallenge(input: ChallengeInput): Promise<void> {
      if (!input || typeof input !== 'object') fail('validation');
      hashInput(input.hash); hashInput(input.emailKey); hashInput(input.clientHash); text(input.emailCipher);
      await checkout(pool, connection => transaction(connection, async () => {
        const keys = [lockKey('send:email', input.emailKey), lockKey('send:client', input.clientHash)]
          .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
        for (const key of keys) await xactLock(connection, key);
        const clock = one((await query(connection, `with t as (select clock_timestamp() as n)
          select n::text as "now", (date_trunc('hour',n at time zone 'UTC') at time zone 'UTC')::text as "windowStart" from t`)).rows);
        timestamp(clock.now); timestamp(clock.windowStart);
        const now = text(clock.now), windowStart = text(clock.windowStart);
        const limits = one((await query(connection, `select
          coalesce(sum(hits) filter(where scope='email' and subject_hash=$1 and window_start=$4::timestamptz),0) as "emailHits",
          coalesce(sum(hits) filter(where scope='client' and subject_hash=$2 and window_start=$4::timestamptz),0) as "clientHits",
          coalesce(bool_or(scope='email' and subject_hash=$1 and last_at>$3::timestamptz-interval '60 seconds'),false) as "recentEmail"
          from customer_auth.rate_buckets
          where ((scope='email' and subject_hash=$1) or (scope='client' and subject_hash=$2))
          and window_start between $4::timestamptz-interval '1 hour' and $4::timestamptz`,
        [input.emailKey, input.clientHash, now, windowStart])).rows);
        if (integer(limits.emailHits) >= 5 || integer(limits.clientHits) >= 20 || bool(limits.recentEmail)) fail('rate_limited');
        for (const [scope, subject] of [['email', input.emailKey], ['client', input.clientHash]]) {
          await query(connection, `insert into customer_auth.rate_buckets(scope,subject_hash,window_start,hits,last_at)
            values($1,$2,$3::timestamptz,1,$4::timestamptz)
            on conflict(scope,subject_hash,window_start) do update
            set hits=customer_auth.rate_buckets.hits+1,last_at=excluded.last_at`, [scope, subject, windowStart, now]);
        }
        await query(connection, `insert into customer_auth.challenges(hash,email_cipher,email_key,status,attempts,created_at,expires_at)
          values($1,$2,$3,'sending',0,$4::timestamptz,$4::timestamptz+interval '600 seconds')`,
        [input.hash, input.emailCipher, input.emailKey, now]);
      }));
    },
    async markChallengeReady(hash: string): Promise<void> {
      hashInput(hash);
      await checkout(pool, connection => transaction(connection, async () => {
        const row = affected((await query(connection, 'select email_key as "emailKey" from customer_auth.challenges where hash=$1', [hash])).rows);
        const emailKey = row.emailKey; hashInput(emailKey);
        await xactLock(connection, lockKey('send:email', emailKey));
        await query(connection, `update customer_auth.challenges set status='failed'
          where email_key=$1 and hash<>$2 and status='ready'`, [emailKey, hash]);
        affected((await query(connection, `update customer_auth.challenges set status='ready'
          where hash=$1 and email_key=$2 and status='sending' and consumed_at is null and expires_at>clock_timestamp()
          returning hash`, [hash, emailKey])).rows);
      }));
    },
    async markChallengeFailed(hash: string): Promise<void> {
      hashInput(hash);
      await checkout(pool, connection => transaction(connection, async () => {
        await query(connection, `update customer_auth.challenges set status='failed' where hash=$1 and status='sending'`, [hash]);
      }));
    },
    withChallenge<T>(hash: string, work: (lease: ChallengeLease) => Promise<T>): Promise<T> {
      return locked(pool, 'challenge', hash, (connection, run): ChallengeLease => {
        let reserved = false;
        let consumed = false;
        return {
          reserveAttempt: () => run(async () => {
            if (reserved || consumed) fail('unauthenticated');
            const emailCipher = await transaction(connection, async () => {
              const row = affected((await query(connection, `update customer_auth.challenges set attempts=attempts+1
                where hash=$1 and status='ready' and consumed_at is null and expires_at>clock_timestamp() and attempts<5
                returning email_cipher as "emailCipher"`, [hash])).rows);
              return text(row.emailCipher);
            });
            reserved = true;
            return { emailCipher };
          }),
          consumeAndCreateSession: session => run(async () => {
            if (!reserved || consumed) fail('unauthenticated');
            newSession(session);
            const result = await transaction(connection, async () => {
              affected((await query(connection, `update customer_auth.challenges set status='consumed',consumed_at=clock_timestamp()
                where hash=$1 and status='ready' and consumed_at is null and expires_at>clock_timestamp() and attempts>=1 and attempts<=5
                returning hash`, [hash])).rows);
              const row = one((await query(connection, `insert into customer_auth.sessions(hash,user_id,provider_session_id,tokens_cipher,created_at,expires_at)
                select $1,$2::uuid,$3::uuid,$4,n,n+interval '86400 seconds' from (select clock_timestamp() as n) t
                returning expires_at as "expiresAt"`, [session.hash, session.userId, session.providerSessionId, session.tokensCipher])).rows);
              return { expiresAt: timestamp(row.expiresAt) };
            });
            consumed = true;
            return result;
          }),
        };
      }, work);
    },
    withSession<T>(hash: string, work: (lease: SessionLease) => Promise<T>): Promise<T> {
      return locked(pool, 'session', hash, (connection, run): SessionLease => {
        let pendingVersion: number | undefined;
        let savedVersion: number | undefined;
        const mutate = async (sql: string, values: unknown[]): Promise<number> => transaction(connection, async () => {
          const row = affected((await query(connection, sql, values)).rows);
          return integer(row.version, 1);
        });
        return {
          read: () => run(() => transaction(connection, async () => {
            const rows = (await query(connection, `select hash as hash,user_id as "userId",provider_session_id as "providerSessionId",
              tokens_cipher as "tokensCipher",expires_at as "expiresAt",version as version,
              revoked_at is not null as revoked,refresh_pending as "refreshPending",
              (revoked_at is null and not refresh_pending and expires_at>clock_timestamp()) as usable,
              floor(extract(epoch from clock_timestamp()))::bigint as "nowSeconds"
              from customer_auth.sessions where hash=$1 for update`, [hash])).rows;
            if (rows.length === 0) return null;
            const row = one(rows);
            if (row.hash !== hash) fail();
            const result: StoredAuthSession = {
              hash, userId: uuid(row.userId), providerSessionId: uuid(row.providerSessionId), tokensCipher: text(row.tokensCipher),
              expiresAt: timestamp(row.expiresAt), version: integer(row.version, 1), revoked: bool(row.revoked),
              refreshPending: bool(row.refreshPending), usable: bool(row.usable), nowSeconds: integer(row.nowSeconds),
            };
            if (result.usable && (result.revoked || result.refreshPending)) fail();
            return result;
          })),
          markRefreshPending: version => run(async () => {
            versionInput(version);
            if (pendingVersion !== undefined || savedVersion !== undefined) fail();
            const actual = await mutate(`update customer_auth.sessions set refresh_pending=true
              where hash=$1 and version=$2 and revoked_at is null and expires_at>clock_timestamp() and not refresh_pending
              returning version as version`, [hash, version]);
            if (actual !== version) fail();
            pendingVersion = version;
          }),
          saveRefresh: (version, tokensCipher) => run(async () => {
            versionInput(version); text(tokensCipher);
            if (version >= MAX || pendingVersion !== version || savedVersion !== undefined) fail();
            const actual = await mutate(`update customer_auth.sessions set tokens_cipher=$3,version=version+1
              where hash=$1 and version=$2 and version<9007199254740991 and revoked_at is null
              and expires_at>clock_timestamp() and refresh_pending returning version as version`, [hash, version, tokensCipher]);
            if (actual !== version + 1) fail();
            savedVersion = actual;
            return actual;
          }),
          activateRefresh: version => run(async () => {
            versionInput(version);
            if (savedVersion !== version) fail();
            const actual = await mutate(`update customer_auth.sessions set refresh_pending=false
              where hash=$1 and version=$2 and revoked_at is null and expires_at>clock_timestamp() and refresh_pending
              returning version as version`, [hash, version]);
            if (actual !== version) fail();
            savedVersion = undefined;
            pendingVersion = undefined;
          }),
          revoke: () => run(async () => {
            // Commit the local revocation even if cleanup data is corrupt.
            const rows = await transaction(connection, async () => (await query(connection, `update customer_auth.sessions set revoked_at=clock_timestamp()
              where hash=$1 and revoked_at is null
              returning tokens_cipher as "tokensCipher",user_id as "userId",provider_session_id as "providerSessionId"`, [hash])).rows);
            if (rows.length === 0) return null;
            const row = one(rows);
            return { tokensCipher: text(row.tokensCipher), userId: uuid(row.userId), providerSessionId: uuid(row.providerSessionId) };
          }),
        };
      }, work);
    },
  };
}
