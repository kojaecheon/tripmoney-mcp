import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { IdentityError } from '../../core/contracts.js';
import { withActor } from '../../server/db/actor.js';
import { guardAuthTestClient } from '../../server/db/auth-test-recovery.js';
import { createAuthStore } from '../../server/auth/store.js';
import { open } from '../../server/auth/crypto.js';
import { authFixture, sql, deniedSql, expectCode, digest, deadline, latch, faultPool, type Fault } from './auth-fixtures.js';

// This suite uses synthetic provider responses. It does not prove live provider authentication.
test('전용 개발 DB의 인증 저장소·서비스 인수 시험 (합성 provider)', { timeout: 150000 }, async t => {
  let f: Awaited<ReturnType<typeof authFixture>> | undefined;
  const activeCases = new Set<Promise<void>>();
  try {
    f = await authFixture();
    const db = f;
    const check = async (name: string, work: () => Promise<void>) => {
      let running: Promise<void> | undefined;
      try {
        await t.test(name, { timeout: 12000 }, async () => {
          running = (async () => {
            try { await work(); } catch (error) {
              // Assertions below contain only booleans, counts, known codes and synthetic values.
              if (error instanceof assert.AssertionError) throw error;
              throw new Error('auth_acceptance_case_failed');
            }
          })();
          activeCases.add(running);
          try { await running; } finally { activeCases.delete(running); }
        });
      } finally {
        // node:test timeout does not cancel a database promise. Drain it before the next case or cleanup.
        if (running) await Promise.allSettled([running]);
      }
    };
    const attempts = async (hash: string) => (await sql(db.auth,
      'select attempts from customer_auth.challenges where hash=$1', [hash])).rows[0]?.attempts;
    const allowActor = async (actor: { userId: string; sessionHash: string }) => {
      assert.equal(await withActor(db.app, actor, async client => (await client.query('select 1 as ok')).rows[0].ok), 1);
    };

    await check('1. reserve·ready·verify는 암호문과 DB 600초·86400초 수명을 저장하고 app actor를 허용한다', async () => {
      const s = db.scenario();
      s.provider.requestCode = async email => {
        assert.equal(email === s.email, true); s.calls.request++;
        const row = (await sql(db.auth, `select status,email_cipher as cipher,
          extract(epoch from expires_at-created_at)::integer as ttl from customer_auth.challenges
          where hash=any($1::text[]) order by created_at desc limit 1`, [[...db.challenges]])).rows[0];
        assert.equal(row?.status, 'sending'); assert.equal(row?.ttl, 600);
      };
      const request = await s.service.requestCode(s.email, db.freshClient());
      const challengeHash = digest(request.challengeToken);
      const row = (await sql(db.auth, `select status,email_cipher as cipher,
        extract(epoch from expires_at-created_at)::integer as ttl from customer_auth.challenges where hash=$1`, [challengeHash])).rows[0];
      assert.equal(row.status, 'ready'); assert.equal(row.ttl, 600);
      assert.equal(row.cipher.includes(s.email), false);
      assert.equal(open(row.cipher, db.keys, `challenge:${challengeHash}`) === s.email, true);
      const result = await s.service.verifyCode(request.challengeToken, '123456');
      const hash = digest(result.sessionToken);
      const session = (await sql(db.auth, `select tokens_cipher as cipher,
        extract(epoch from expires_at-created_at)::integer as ttl from customer_auth.sessions where hash=$1`, [hash])).rows[0];
      assert.equal(session.ttl, 86400); assert.equal(session.cipher.includes('synthetic.access.token'), false);
      const tokens = open(session.cipher, db.keys, `session:${hash}`) as { userId: string };
      assert.equal(tokens.userId === s.userId, true);
      const verified = await s.service.authenticate(result.sessionToken);
      assert.equal(verified.actor.sessionHash === hash, true); await allowActor(verified.actor);
      assert.deepEqual(s.calls, { request: 1, verify: 1, refresh: 0, validate: 1, revoke: 0 });
      await expectCode(s.service.verifyCode(request.challengeToken, '123456'), 'unauthenticated');
    });

    await check('2. 같은 이메일 동시 예약은 1건만 성공하고 두 bucket은 1회만 증가한다', async () => {
      const a = await db.input(), b = await db.input(a.emailKey, a.clientHash);
      const results = await Promise.allSettled([db.store.reserveChallenge(a), db.store.reserveChallenge(b)]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      const rejected = results.find(result => result.status === 'rejected');
      assert.equal(rejected?.status === 'rejected' && rejected.reason instanceof IdentityError
        && rejected.reason.code === 'rate_limited', true);
      const row = (await sql(db.auth, `select count(*)::integer as n,sum(hits)::integer as hits
        from customer_auth.rate_buckets where (scope='email' and subject_hash=$1)
        or (scope='client' and subject_hash=$2)`, [a.emailKey, a.clientHash])).rows[0];
      assert.equal(row.n, 2); assert.equal(row.hits, 2);
      assert.equal((await sql(db.auth, 'select count(*)::integer as n from customer_auth.challenges where hash=any($1::text[])',
        [[a.hash, b.hash]])).rows[0].n, 1);
      await expectCode(db.store.reserveChallenge(await db.input(a.emailKey)), 'rate_limited');
    });
    await check('2. 시간당 이메일 5회·client 20회와 이전 시간대 recentEmail 제한을 실제 SQL로 적용한다', async () => {
      for (const [scope, hits, previous, recent] of [
        ['email', 5, false, false], ['client', 20, false, false], ['email', 1, true, true],
      ] as const) {
        const input = await db.input();
        await db.bucket(scope, scope === 'email' ? input.emailKey : input.clientHash, hits, previous, recent);
        await expectCode(db.store.reserveChallenge(input), 'rate_limited');
        assert.equal((await sql(db.auth, 'select count(*)::integer as n from customer_auth.challenges where hash=$1', [input.hash])).rows[0].n, 0);
      }
      // Below both hourly limits and outside 60 seconds, an actual reservation increments each bucket.
      const input = await db.input();
      await db.bucket('email', input.emailKey, 4); await db.bucket('client', input.clientHash, 19);
      await db.store.reserveChallenge(input);
      const rows = (await sql(db.auth, `select scope,hits from customer_auth.rate_buckets
        where (scope='email' and subject_hash=$1) or (scope='client' and subject_hash=$2) order by scope`,
      [input.emailKey, input.clientHash])).rows;
      assert.deepEqual(rows.map(row => [row.scope, row.hits]), [['client', 20], ['email', 5]]);
    });
    await check('2. challenge INSERT 충돌은 먼저 증가한 bucket도 rollback한다', async () => {
      const first = await db.input(); await db.store.reserveChallenge(first);
      const collision = { ...await db.input(), hash: first.hash };
      await expectCode(db.store.reserveChallenge(collision), 'unavailable');
      assert.equal((await sql(db.auth, `select count(*)::integer as n from customer_auth.rate_buckets
        where (scope='email' and subject_hash=$1) or (scope='client' and subject_hash=$2)`,
      [collision.emailKey, collision.clientHash])).rows[0].n, 0);
    });

    await check('3. OTP 거부·provider 장애에도 attempts가 선행 커밋되고 5번째 성공을 허용한다', async () => {
      const s = db.scenario(), request = await s.service.requestCode(s.email, db.freshClient());
      const hash = digest(request.challengeToken);
      const committedAttempts: number[] = [];
      s.provider.verifyCode = async () => {
        s.calls.verify++;
        committedAttempts.push(await attempts(hash));
        if (s.calls.verify <= 4) throw new IdentityError(s.calls.verify % 2 ? 'unauthenticated' : 'unavailable', 'synthetic_provider_failure');
        return s.tokens(Math.floor(Date.now() / 1000) + 3600);
      };
      for (const code of ['unauthenticated', 'unavailable', 'unauthenticated', 'unavailable'])
        await expectCode(s.service.verifyCode(request.challengeToken, '123456'), code);
      const result = await s.service.verifyCode(request.challengeToken, '123456');
      assert.equal(result.me.userId === s.userId, true); assert.equal(await attempts(hash), 5);
      await expectCode(s.service.verifyCode(request.challengeToken, '123456'), 'unauthenticated');
      assert.equal(s.calls.verify, 5);
      assert.deepEqual(committedAttempts, [1, 2, 3, 4, 5]);
    });
    await check('3. 실패 OTP는 provider 최대5회이며 동일 challenge 동시 소비는 한 번만 성공한다', async () => {
      const denied = db.scenario(), request = await denied.service.requestCode(denied.email, db.freshClient());
      denied.provider.verifyCode = async () => { denied.calls.verify++; throw new IdentityError('unavailable', 'synthetic_provider_failure'); };
      for (let i = 0; i < 5; i++) await expectCode(denied.service.verifyCode(request.challengeToken, '123456'), 'unavailable');
      await expectCode(denied.service.verifyCode(request.challengeToken, '123456'), 'unauthenticated');
      assert.equal(denied.calls.verify, 5); assert.equal(await attempts(digest(request.challengeToken)), 5);
      const s = db.scenario(), fresh = await s.service.requestCode(s.email, db.freshClient());
      const results = await Promise.allSettled([s.service.verifyCode(fresh.challengeToken, '123456'), s.service.verifyCode(fresh.challengeToken, '123456')]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(s.calls.verify, 1);
      assert.equal(await attempts(digest(fresh.challengeToken)), 1);
      assert.equal(results.some(result => result.status === 'rejected' && result.reason instanceof IdentityError
        && result.reason.code === 'unauthenticated'), true);
    });

    await check('4. session INSERT 충돌은 challenge 소비만 rollback하고 이전 attempts 커밋을 유지한다', async () => {
      const s = db.scenario(), existing = await db.seedSession(s);
      const input = await db.input(); await db.store.reserveChallenge(input); await db.store.markChallengeReady(input.hash);
      await expectCode(db.store.withChallenge(input.hash, async lease => {
        await lease.reserveAttempt();
        await lease.consumeAndCreateSession({ hash: existing.hash, userId: s.userId,
          providerSessionId: s.providerSessionId, tokensCipher: existing.cipher });
      }), 'unavailable');
      const row = (await sql(db.auth, 'select status,attempts,consumed_at is null as unconsumed from customer_auth.challenges where hash=$1', [input.hash])).rows[0];
      assert.equal(row.status, 'ready'); assert.equal(row.attempts, 1); assert.equal(row.unconsumed, true);
      // Reusing the same lease key after rollback proves the session advisory lock was released.
      await db.store.withChallenge(input.hash, async lease => { await lease.reserveAttempt(); });
      assert.equal(await attempts(input.hash), 2);
      assert.equal((await db.sessionRow(existing.hash)).cipher === existing.cipher, true);
    });

    await check('5·6. 실제 advisory lock은 같은 session을 직렬화하고 다른 session은 진행하며 pending actor를 차단한다', async () => {
      const s = db.scenario(), refresh = await db.seedSession(s, 'refresh'), other = await db.seedSession(s);
      const before = await db.sessionRow(refresh.hash), entered = latch(), release = latch();
      const jobs: Promise<unknown>[] = [];
      const checkoutPids: number[] = [];
      const observedPool = new Proxy(db.auth, { get(target, name) {
        if (name === 'connect') return async () => {
          const client = guardAuthTestClient(await target.connect());
          try {
            checkoutPids.push((await sql(client, 'select pg_backend_pid() as pid')).rows[0].pid);
            return client;
          } catch {
            try { client.release(true); } catch { /* The checkout remains failed and discarded. */ }
            throw new Error('auth_acceptance_pid_observation_failed');
          }
        };
        const value = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const serialService = db.makeService(s.provider, db.tracking(createAuthStore(observedPool)));
      s.provider.refreshVerified = async () => {
        s.calls.refresh++; entered.release(); await release.promise;
        return { tokens: s.tokens(Math.floor(Date.now() / 1000) + 3600), identity: { userId: s.userId, email: s.email } };
      };
      const autoRelease = setTimeout(release.release, 4500);
      try {
        const first = serialService.authenticate(refresh.token); jobs.push(first); void first.catch(() => {});
        await deadline(entered.promise);
        assert.equal((await db.sessionRow(refresh.hash)).pending, true);
        await expectCode(withActor(db.app, refresh.actor, async () => 1), 'unauthenticated');
        const second = serialService.authenticate(refresh.token); jobs.push(second); void second.catch(() => {});
        const lock = createHash('sha256').update(`tripmoney-auth:session:${refresh.hash}`).digest();
        let waiting = false;
        for (let i = 0; i < 20; i++) {
          const row = (await sql(db.admin, `select count(*)::integer as n from pg_catalog.pg_locks waiter
            join pg_catalog.pg_locks holder on holder.locktype=waiter.locktype
              and holder.database=waiter.database and holder.classid=waiter.classid
              and holder.objid=waiter.objid and holder.objsubid=waiter.objsubid
            where waiter.locktype='advisory' and waiter.classid=$1::oid and waiter.objid=$2::oid
              and waiter.objsubid=1 and not waiter.granted and holder.granted
              and holder.pid=$3::integer and waiter.pid=$4::integer
              and holder.pid<>waiter.pid and holder.pid=any(pg_catalog.pg_blocking_pids(waiter.pid))
              and waiter.database=(select oid from pg_catalog.pg_database where datname=current_database())`,
          [lock.readUInt32BE(0), lock.readUInt32BE(4), checkoutPids[0] ?? null, checkoutPids[1] ?? null])).rows[0];
          if (row.n > 0) { waiting = true; break; }
          await delay(20);
        }
        assert.equal(waiting, true, 'auth_acceptance_real_advisory_wait_required');
        const independent = serialService.authenticate(other.token); jobs.push(independent); void independent.catch(() => {});
        await deadline(independent);
        assert.equal(s.calls.refresh, 1); assert.equal(s.calls.validate, 1);
        release.release(); await deadline(Promise.all(jobs));
        assert.equal(s.calls.refresh, 1); assert.equal(s.calls.validate, 2);
        const after = await db.sessionRow(refresh.hash);
        assert.equal(after.version, before.version + 1); assert.equal(after.pending, false);
        assert.equal(after.expires === before.expires, true);
        await allowActor(refresh.actor);
      } finally {
        clearTimeout(autoRelease); release.release(); await Promise.allSettled(jobs);
      }
    });
    await check('6. pending·폐기·만료·다른 user·다른 hash는 withActor를 통과하지 못하고 app은 auth 직접 접근을 거부한다', async () => {
      const s = db.scenario(), active = await db.seedSession(s);
      await allowActor(active.actor);
      for (const state of ['pending', 'revoked', 'expired'] as const) {
        const seeded = await db.seedSession(s, state);
        await expectCode(withActor(db.app, seeded.actor, async () => 1), 'unauthenticated');
        await expectCode(s.service.authenticate(seeded.token), 'unauthenticated');
      }
      for (const actor of [{ ...active.actor, userId: randomUUID() }, { ...active.actor, sessionHash: db.randomHash() }])
        await expectCode(withActor(db.app, actor, async () => 1), 'unauthenticated');
      for (const table of ['challenges', 'sessions', 'rate_buckets']) {
        await deniedSql(db.app, `select * from customer_auth.${table} limit 0`);
        assert.equal((await sql(db.auth, `select * from customer_auth.${table} limit 0`)).rowCount, 0);
      }
      await deniedSql(db.auth, 'select id from customer.trips limit 0');
      assert.equal(s.calls.refresh + s.calls.validate, 0);
    });

    for (const [phase, when, pending, versionDelta, nextCode] of [
      ['A', 'before', false, 0, null], ['A', 'after', true, 0, 'unauthenticated'],
      ['B', 'before', true, 0, 'unauthenticated'], ['B', 'after', true, 1, 'unauthenticated'],
      ['C', 'after', false, 1, null],
    ] as const) {
      await check(`7. 특정 client의 ${phase} COMMIT ${when} 합성 오류로 DB 상태·후속 인증을 확인한다`, async () => {
        const s = db.scenario(), seeded = await db.seedSession(s, 'refresh'), before = await db.sessionRow(seeded.hash);
        const fault: Fault = { phase, when, fired: false };
        const service = db.makeService(s.provider, db.tracking(createAuthStore(faultPool(db.auth, fault))));
        await expectCode(service.authenticate(seeded.token), 'unavailable');
        assert.equal(fault.fired, true);
        const after = await db.sessionRow(seeded.hash);
        assert.equal(after.pending, pending); assert.equal(after.version, before.version + versionDelta);
        assert.equal(after.expires === before.expires, true);
        assert.equal(after.cipher === before.cipher, versionDelta === 0);
        if (versionDelta === 1) {
          const stored = open(after.cipher, db.keys, `session:${seeded.hash}`) as {
            userId: string; providerSessionId: string; expiresAt: number;
          };
          const previous = open(before.cipher, db.keys, `session:${seeded.hash}`) as { expiresAt: number };
          assert.equal(stored.userId === s.userId && stored.providerSessionId === s.providerSessionId, true);
          assert.equal(stored.expiresAt > previous.expiresAt, true);
        }
        assert.equal(s.calls.refresh, phase === 'A' ? 0 : 1);
        if (pending) await expectCode(withActor(db.app, seeded.actor, async () => 1), 'unauthenticated');
        if (nextCode) {
          await expectCode(service.authenticate(seeded.token), nextCode);
          assert.equal(s.calls.refresh, phase === 'A' ? 0 : 1);
        } else {
          await service.authenticate(seeded.token); await allowActor(seeded.actor);
          assert.equal(s.calls.refresh, 1);
          assert.equal(s.calls.validate, phase === 'C' ? 1 : 0);
        }
        // A discarded client and an uncertain commit must not poison the underlying pool.
        assert.equal((await sql(db.auth, 'select 1 as ok')).rows[0].ok, 1);
        await db.store.withSession(seeded.hash, async lease => { assert.equal((await lease.read()) !== null, true); });
      });
    }

    await check('8. logout은 DB를 먼저 폐기하며 provider 실패·pending·만료·반복 호출에서도 다른 session을 유지한다', async () => {
      const s = db.scenario(), other = await db.seedSession(s);
      let targetHash = '';
      const revokedBeforeProvider: boolean[] = [];
      s.provider.revoke = async () => {
        s.calls.revoke++; revokedBeforeProvider.push((await db.sessionRow(targetHash)).revoked === true);
        throw new IdentityError('unavailable', 'synthetic_provider_local_revoke_failure');
      };
      for (const state of ['active', 'pending', 'expired'] as const) {
        const seeded = await db.seedSession(s, state); targetHash = seeded.hash;
        await s.service.logout(seeded.token); await s.service.logout(seeded.token);
        assert.equal((await db.sessionRow(seeded.hash)).revoked, true);
        await expectCode(withActor(db.app, seeded.actor, async () => 1), 'unauthenticated');
      }
      assert.equal(s.calls.revoke, 3); assert.deepEqual(revokedBeforeProvider, [true, true, true]);
      assert.equal((await db.sessionRow(other.hash)).revoked, false); await allowActor(other.actor);
    });

    await check('9. SQL 오류·rollback·unlock 이후 같은 app 연결을 재사용하고 actor context를 남기지 않는다', async () => {
      const s = db.scenario(), active = await db.seedSession(s);
      for (const fail of [false, true]) {
        let pid: number | undefined;
        const operation = withActor(db.app, active.actor, async client => {
          pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid;
          if (fail) await client.query('select 1/0');
          return 1;
        });
        if (fail) await expectCode(operation, 'unavailable'); else assert.equal(await operation, 1);
        const row = (await sql(db.app, `select pg_backend_pid() as pid,
          nullif(current_setting('customer.actor_id',true),'') as actor,
          nullif(current_setting('customer.session_hash',true),'') as session`)).rows[0];
        assert.equal(row.pid === pid, true); assert.equal(row.actor, null); assert.equal(row.session, null);
      }
      await allowActor(active.actor);
      await db.store.withSession(active.hash, async lease => { assert.equal((await lease.read())?.usable, true); });
    });
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    throw new Error('auth_acceptance_run_failed');
  } finally {
    // Runs even when setup, a subtest, a provider latch or a synthetic COMMIT fails.
    await Promise.allSettled([...activeCases]);
    if (f) await f.cleanup();
  }
});
