import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import pg, { type Pool, type PoolClient, type QueryResult } from 'pg';
import { IdentityError, type ProviderTokens } from '../../core/contracts.js';
import { connectionConfig, readDbTestConfig } from '../../server/db/config.js';
import { createPools } from '../../server/db/pools.js';
import { loadAuthTestManifest, gatedAuthTestPool } from '../../server/db/auth-test-recovery.js';
import { createAuthStore } from '../../server/auth/store.js';
import { createAuthService } from '../../server/auth/service.js';
import type { AuthStore, ChallengeInput } from '../../server/auth/store-contract.js';
import type { VerifiedAuthProvider } from '../../server/auth/provider.js';
import { seal } from '../../server/auth/crypto.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function expectCode(work: Promise<unknown>, expected: string): Promise<void> {
  let code = 'resolved';
  try { await work; } catch (error) {
    code = error instanceof IdentityError ? error.code : 'unexpected_fixed_failure';
  }
  assert.equal(code, expected);
}
// Query errors must never reach node:test, including setup and cleanup errors.
export async function sql(db: Pick<Pool, 'query'> | PoolClient, query: string, values: unknown[] = []): Promise<QueryResult> {
  try { return await db.query(query, values); } catch { throw new Error('auth_acceptance_sql_failed'); }
}
export async function deniedSql(db: Pool, query: string): Promise<void> {
  let denied = false;
  try { await db.query(query); } catch (error) {
    denied = typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';
  }
  assert.equal(denied, true, 'auth_acceptance_permission_denial_required');
}
export function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, release: resolve };
}
export async function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('auth_acceptance_wait_timeout')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

export type Fault = { phase: 'A' | 'B' | 'C'; when: 'before' | 'after'; fired: boolean };
// Only clients checked out by this test store are wrapped. SQL still reaches the real database.
export function faultPool(pool: Pool, fault: Fault): Pick<Pool, 'connect'> {
  return { connect: async () => {
    const client = await pool.connect();
    let phase: Fault['phase'] | undefined;
    return new Proxy(client, { get(target, name) {
      if (name === 'query') return async (query: string, values?: unknown[]) => {
        if (query.includes('set refresh_pending=true')) phase = 'A';
        if (query.includes('set tokens_cipher=$3,version=version+1')) phase = 'B';
        if (query.includes('set refresh_pending=false')) phase = 'C';
        const inject = query === 'commit' && phase === fault.phase && !fault.fired;
        if (inject && fault.when === 'before') { fault.fired = true; throw new Error('synthetic_commit_failure'); }
        const result = await target.query(query, values);
        if (query === 'commit' || query === 'rollback') phase = undefined;
        if (inject && fault.when === 'after') { fault.fired = true; throw new Error('synthetic_commit_response_lost'); }
        return result;
      };
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } } as unknown as Pick<Pool, 'connect'>;
}

export async function authFixture() {
  const config = readDbTestConfig(process.env);
  let app: Pool | undefined, auth: Pool | undefined, admin: Pool | undefined;
  const manifest = loadAuthTestManifest();
  const runId = manifest.runId;
  const challenges = new Set<string>(), sessions = new Set<string>();
  const emails = new Set<string>(), clients = new Set<string>();
  const keys = { acceptance: randomBytes(32) }, rateKey = randomBytes(32);
  let sequence = 0;
  let closed = false;
  // All mutations register their identifiers before the first actual DB call.
  const randomHash = () => digest(`${runId}:${++sequence}:${randomBytes(32).toString('hex')}`);
  const freshEmail = () => `auth-${runId}-${++sequence}@example.invalid`;
  const freshClient = () => { const value = randomHash(); manifest.register('client', value); clients.add(value); return value; };
  const tracking = (store: AuthStore): AuthStore => ({
    ...store,
    async reserveChallenge(input) {
      manifest.register('challenge', input.hash); manifest.register('email', input.emailKey); manifest.register('client', input.clientHash);
      challenges.add(input.hash); emails.add(input.emailKey); clients.add(input.clientHash);
      await store.reserveChallenge(input);
    },
    withChallenge(hash, work) {
      manifest.register('challenge', hash); challenges.add(hash);
      return store.withChallenge(hash, lease => work({
        reserveAttempt: () => lease.reserveAttempt(),
        consumeAndCreateSession: async session => {
          manifest.register('session', session.hash); sessions.add(session.hash);
          return lease.consumeAndCreateSession(session);
        },
      }));
    },
  });
  async function cleanup() {
    if (closed) return;
    closed = true;
    let failure = false;
    try {
      if (admin) {
        // Exactly three auth tables, restricted to this run's pre-registered hashes.
        for (const [query, values] of [
          ['delete from customer_auth.sessions where hash=any($1::text[])', [[...sessions]]],
          ['delete from customer_auth.challenges where hash=any($1::text[])', [[...challenges]]],
          ["delete from customer_auth.rate_buckets where (scope='email' and subject_hash=any($1::text[])) or (scope='client' and subject_hash=any($2::text[]))",
            [[...emails], [...clients]]],
        ] as const) {
          try { await sql(admin, query, [...values]); } catch { failure = true; }
        }
        const row = (await sql(admin, `select
          (select count(*)::integer from customer_auth.sessions where hash=any($1::text[])) as sessions,
          (select count(*)::integer from customer_auth.challenges where hash=any($2::text[])) as challenges,
          (select count(*)::integer from customer_auth.rate_buckets where
            (scope='email' and subject_hash=any($3::text[])) or (scope='client' and subject_hash=any($4::text[]))) as buckets`,
        [[...sessions], [...challenges], [...emails], [...clients]])).rows[0];
        assert.equal(row?.sessions, 0); assert.equal(row?.challenges, 0); assert.equal(row?.buckets, 0);
      }
    } catch { failure = true; }
    finally {
      const results = await Promise.allSettled([app?.end(), auth?.end(), admin?.end()]);
      if (results.some(result => result.status === 'rejected')) failure = true;
      keys.acceptance.fill(0); rateKey.fill(0);
    }
    if (failure) throw new Error('auth_acceptance_cleanup_failed');
  }
  try {
    ({ app, auth } = await createPools(config));
    auth = gatedAuthTestPool(auth, manifest);
    app.options.max = 1;
    admin = gatedAuthTestPool(new pg.Pool(connectionConfig(config.adminUrl, 'admin')), manifest);
    admin.on('error', () => { /* Prevent raw idle PG errors from reaching the test runner. */ });
    for (const [pool, expected] of [[app, 'customer_app_login'], [auth, 'customer_auth_login'], [admin, 'postgres']] as const) {
      const row = (await sql(pool, 'select current_user as role,current_database() as database')).rows[0];
      assert.equal(row?.role, expected); assert.equal(row?.database, 'postgres');
    }
    const column = (await sql(admin, `select count(*)::integer as n from information_schema.columns
      where table_schema='customer_auth' and table_name='sessions' and column_name='refresh_pending'
      and data_type='boolean' and is_nullable='NO'`)).rows[0];
    assert.equal(column?.n, 1, 'auth_acceptance_refresh_pending_required');
    const store = tracking(createAuthStore(auth));
    function makeService(provider: VerifiedAuthProvider, customStore = store) {
      return createAuthService({ store: customStore, provider, kid: 'acceptance', keys, rateKey });
    }
    function scenario() {
      const email = freshEmail(), userId = randomUUID(), providerSessionId = randomUUID();
      const calls = { request: 0, verify: 0, refresh: 0, validate: 0, revoke: 0 };
      const tokens = (expiresAt: number): ProviderTokens => ({
        accessToken: 'synthetic.access.token', refreshToken: randomBytes(32).toString('base64url'),
        userId, providerSessionId, expiresAt,
      });
      const provider: VerifiedAuthProvider = {
        async requestCode(value) { assert.equal(value === email, true); calls.request++; },
        async verifyCode(value, code) { assert.equal(value === email && code === '123456', true); calls.verify++;
          return tokens(Math.floor(Date.now() / 1000) + 3600); },
        async validate(value) { calls.validate++; assert.equal(value.userId === userId && value.providerSessionId === providerSessionId, true);
          return { userId, email }; },
        async refresh() { throw new Error('auth_acceptance_legacy_refresh_forbidden'); },
        async refreshVerified(value) { calls.refresh++;
          assert.equal(value.userId === userId && value.providerSessionId === providerSessionId, true);
          return { tokens: tokens(Math.floor(Date.now() / 1000) + 3600), identity: { userId, email } }; },
        async revoke() { calls.revoke++; },
      };
      return { email, userId, providerSessionId, provider, tokens, calls, service: makeService(provider) };
    }
    async function input(emailKey = randomHash(), clientHash = freshClient()): Promise<ChallengeInput> {
      const hash = randomHash();
      manifest.register('challenge', hash); manifest.register('email', emailKey); manifest.register('client', clientHash);
      challenges.add(hash); emails.add(emailKey); clients.add(clientHash);
      return { hash, emailKey, clientHash, emailCipher: seal(freshEmail(), 'acceptance', keys, `challenge:${hash}`) };
    }
    async function seedSession(s: ReturnType<typeof scenario>, state: 'active' | 'refresh' | 'pending' | 'expired' | 'revoked' = 'active') {
      const token = randomBytes(32).toString('base64url'), hash = digest(token); manifest.register('session', hash); sessions.add(hash);
      const now = Number((await sql(auth!, 'select floor(extract(epoch from clock_timestamp()))::bigint as n')).rows[0].n);
      const tokens = s.tokens(state === 'refresh' ? now - 1 : now + 3600);
      const cipher = seal(tokens, 'acceptance', keys, `session:${hash}`);
      await sql(admin!, `insert into customer_auth.sessions
        (hash,user_id,provider_session_id,tokens_cipher,created_at,expires_at,refresh_pending,revoked_at)
        values($1,$2,$3,$4,clock_timestamp()-interval '2 days',
          clock_timestamp()+case when $5='expired' then interval '-1 day' else interval '1 day' end,
          $5='pending',case when $5='revoked' then clock_timestamp() else null end)`,
      [hash, s.userId, s.providerSessionId, cipher, state]);
      return { token, hash, actor: { userId: s.userId, sessionHash: hash }, cipher };
    }
    async function bucket(scope: 'email' | 'client', subject: string, hits: number, previous = false, recent = false) {
      manifest.register(scope, subject); (scope === 'email' ? emails : clients).add(subject);
      await sql(admin!, `insert into customer_auth.rate_buckets(scope,subject_hash,window_start,hits,last_at)
        select $1,$2,date_trunc('hour',n at time zone 'UTC') at time zone 'UTC'
          -case when $4 then interval '1 hour' else interval '0' end,$3,
          n-case when $5 then interval '0' else interval '61 seconds' end from (select clock_timestamp() as n) t`,
      [scope, subject, hits, previous, recent]);
    }
    const sessionRow = async (hash: string) => (await sql(auth!, `select version::integer,refresh_pending as pending,
      revoked_at is not null as revoked,expires_at::text as expires,tokens_cipher as cipher from customer_auth.sessions where hash=$1`, [hash])).rows[0];
    return { app, auth, admin, store, tracking, makeService, scenario, input, seedSession, bucket, sessionRow,
      freshClient, randomHash, cleanup, keys, challenges, sessions };
  } catch {
    try { await cleanup(); } catch { throw new Error('auth_acceptance_setup_and_cleanup_failed'); }
    throw new Error('auth_acceptance_setup_failed');
  }
}
