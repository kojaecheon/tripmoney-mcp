import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { IdentityError, type ProviderTokens } from '../../core/contracts.js';
import { createAuthService } from '../../server/auth/service.js';
import { seal, open } from '../../server/auth/crypto.js';
import { createAuthProvider, type VerifiedAuthProvider } from '../../server/auth/provider.js';
import type { AuthStore, ChallengeInput, StoredAuthSession } from '../../server/auth/store-contract.js';

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'tester@example.com';
const SECRET = 'synthetic_sensitive_error';
const keys = { k1: Buffer.alloc(32, 7) };
const rateKey = Buffer.alloc(32, 9);
const nonce = Buffer.alloc(32, 3).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const tokens = (patch: Partial<ProviderTokens> = {}): ProviderTokens => ({ accessToken: 'e30.e30.c3ludGhldGlj',
  refreshToken: 'synthetic_refresh', expiresAt: 1800000600, userId: USER, providerSessionId: SESSION, ...patch });
const denied = (): never => { throw new IdentityError('unauthenticated', SECRET); };
const unavailable = (): never => { throw new Error(SECRET); };
function failure(code: string) { return (error: unknown) => {
  assert.ok(error instanceof IdentityError); assert.equal(error.code, code);
  for (const secret of [SECRET, EMAIL, nonce, '123456', 'synthetic_refresh']) {
    assert.ok(!inspect(error).includes(secret)); assert.ok(!JSON.stringify(error).includes(secret));
  }
  assert.equal(error.cause, undefined); return true;
}; }

// An in-memory transaction/state model. It is not PostgreSQL or network evidence.
function fixture() {
  const events: string[] = [];
  const challenges = new Map<string, ChallengeInput & { state: string; attempts: number; expired: boolean }>();
  const sessions = new Map<string, StoredAuthSession>();
  const locks = new Map<string, Promise<unknown>>();
  let fail = '';
  async function serial<T>(key: string, work: () => Promise<T>) {
    const previous = locks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(work); locks.set(key, task);
    try { return await task; } finally { if (locks.get(key) === task) locks.delete(key); }
  }
  const checkpoint = (name: string, phase: 'before' | 'after' = 'before') => {
    if (phase === 'before') events.push(name);
    if (fail === (phase === 'before' ? name : `${name}:after`)) unavailable();
  };
  const store: AuthStore = {
    async reserveChallenge(input) { checkpoint('reserve'); challenges.set(input.hash, { ...input, state: 'sending', attempts: 0, expired: false }); },
    async markChallengeReady(key) { checkpoint('ready'); const current = challenges.get(key)!;
      for (const value of challenges.values()) if (value.emailKey === current.emailKey && value.state === 'ready') value.state = 'failed';
      current.state = 'ready'; },
    async markChallengeFailed(key) { checkpoint('failed'); challenges.get(key)!.state = 'failed'; },
    withChallenge(key, work) { return serial(`c:${key}`, async () => {
      const current = () => { const row = challenges.get(key); if (!row || row.state !== 'ready' || row.expired) denied(); return row!; };
      return work({ async reserveAttempt() { checkpoint('attempt'); const row = current(); if (row.attempts >= 5) denied(); row.attempts++; return { emailCipher: row.emailCipher }; },
        async consumeAndCreateSession(input) { checkpoint('consume'); const row = current(); row.state = 'consumed';
          sessions.set(input.hash, { ...input, expiresAt: '2027-01-16T09:00:00.000Z', version: 0,
            revoked: false, refreshPending: false, usable: true, nowSeconds: 1800000000 });
          return { expiresAt: '2027-01-16T09:00:00.000Z' }; } });
    }); },
    withSession(key, work) { return serial(`s:${key}`, async () => work({
      async read() { checkpoint('read'); const row = sessions.get(key); return row ? { ...row } : null; },
      async markRefreshPending(version) { checkpoint('pending'); const row = sessions.get(key)!;
        if (!row.usable || row.revoked || row.refreshPending || row.version !== version) denied(); row.refreshPending = true; },
      async saveRefresh(version, cipher) { checkpoint('save'); const row = sessions.get(key)!;
        assert.equal(row.refreshPending, true); assert.equal(row.version, version); row.tokensCipher = cipher;
        row.version++; checkpoint('save', 'after'); return row.version; },
      async activateRefresh(version) { checkpoint('activate'); const row = sessions.get(key)!;
        assert.equal(row.refreshPending, true); assert.equal(row.version, version); row.refreshPending = false;
        checkpoint('activate', 'after'); },
      async revoke() { checkpoint('revoke'); const row = sessions.get(key); if (!row || row.revoked) return null;
        row.revoked = true; return { tokensCipher: row.tokensCipher, userId: row.userId, providerSessionId: row.providerSessionId }; },
    })); },
  };
  const provider: VerifiedAuthProvider = {
    async requestCode(email) { checkpoint('request'); assert.equal(email, EMAIL); },
    async verifyCode(email, code) { checkpoint('verify'); assert.equal(email, EMAIL); assert.equal(code, '123456'); return tokens(); },
    async validate() { checkpoint('validate'); return { userId: USER, email: EMAIL }; },
    async refresh() { throw new Error('legacy refresh must not run'); },
    async refreshVerified() { checkpoint('refresh'); return { tokens: tokens({ expiresAt: 1800001200 }), identity: { userId: USER, email: EMAIL } }; },
    async revoke() { checkpoint('remoteRevoke'); },
  };
  const make = (keyMap = keys, rate = rateKey, kid = 'k1') => createAuthService({ store, provider, kid, keys: keyMap, rateKey: rate });
  function seed(patch: Partial<StoredAuthSession> = {}, value = tokens()) {
    sessions.set(hash(nonce), { hash: hash(nonce), userId: USER, providerSessionId: SESSION,
      tokensCipher: seal(value, 'k1', keys, `session:${hash(nonce)}`), expiresAt: '2027-01-16T09:00:00.000Z',
      version: 0, revoked: false, refreshPending: false, usable: true, nowSeconds: 1800000000, ...patch });
  }
  return { store, provider, events, challenges, sessions, make, seed, setFail(value: string) { fail = value; } };
}

test('requestCode는 이메일 암호화와 HMAC 예약 후 발송하고 ready 성공만 nonce를 반환한다', async () => {
  const f = fixture(); const result = await f.make().requestCode(' Tester@Example.com ', 'a'.repeat(64));
  assert.match(result.challengeToken, /^[A-Za-z0-9_-]{43}$/); assert.equal(Buffer.from(result.challengeToken, 'base64url').length, 32);
  const row = f.challenges.get(hash(result.challengeToken))!;
  assert.equal(open(row.emailCipher, keys, `challenge:${row.hash}`), EMAIL);
  assert.equal(row.emailKey, createHmac('sha256', rateKey).update(`auth-email:${EMAIL}`).digest('hex'));
  assert.deepEqual(f.events, ['reserve', 'request', 'ready']); assert.equal(row.state, 'ready');
});
for (const stage of ['reserve', 'request', 'ready']) test(`발송 ${stage} 장애는 성공 nonce를 반환하지 않는다`, async () => {
  const f = fixture(); f.setFail(stage); await assert.rejects(f.make().requestCode(EMAIL, 'a'.repeat(64)), failure('unavailable'));
  assert.equal(f.events.includes('request'), stage !== 'reserve');
  assert.equal(f.events.includes('failed'), stage !== 'reserve');
});
test('입력 형식 오류는 저장소와 provider 호출 전에 거부한다', async () => {
  const f = fixture(); const auth = f.make();
  for (const email of ['', 'bad', 'a b@c.com', 'a\nb@c.com', `${'x'.repeat(250)}@x.com`])
    await assert.rejects(auth.requestCode(email, 'a'.repeat(64)), failure('validation'));
  for (const token of ['', 'a'.repeat(42), `${nonce}\n`, 'a'.repeat(43)]) {
    await assert.rejects(auth.authenticate(token), failure('unauthenticated'));
    await assert.rejects(auth.logout(token), failure('unauthenticated'));
    await assert.rejects(auth.verifyCode(token, '123456'), failure('unauthenticated'));
  }
  for (const code of ['12345', '123456\n', '１２３４５６', '12 456'])
    await assert.rejects(auth.verifyCode(nonce, code), failure('validation'));
  for (const client of ['', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}\n`])
    await assert.rejects(auth.requestCode(EMAIL, client), failure('validation'));
  assert.deepEqual(f.events, []);
});
test('키와 kid는 생성 시 검사하며 호출자 키 변경은 암호화에 영향을 주지 않는다', async () => {
  const f = fixture();
  for (const [map, rate, kid] of [[{ k1: Buffer.alloc(31) }, rateKey, 'k1'], [keys, Buffer.alloc(31), 'k1'],
    [keys, rateKey, 'missing'], [keys, rateKey, 'bad.kid']] as const)
    assert.throws(() => f.make(map, rate, kid), failure('unavailable'));
  const map = { k1: Buffer.from(keys.k1) }; const rate = Buffer.from(rateKey); const auth = f.make(map, rate);
  map.k1.fill(0); rate.fill(0); map.k1 = Buffer.alloc(32, 1);
  const result = await auth.requestCode(EMAIL, 'a'.repeat(64)); const row = f.challenges.get(hash(result.challengeToken))!;
  assert.equal(open(row.emailCipher, keys, `challenge:${row.hash}`), EMAIL);
  assert.equal(row.emailKey, createHmac('sha256', rateKey).update(`auth-email:${EMAIL}`).digest('hex'));
});
test('verifyCode는 시도를 먼저 소비하고 challenge 소비와 session 생성 후에만 성공한다', async () => {
  const f = fixture(); const auth = f.make(); const challenge = await auth.requestCode(EMAIL, 'a'.repeat(64)); f.events.length = 0;
  const result = await auth.verifyCode(challenge.challengeToken, '123456');
  assert.deepEqual(f.events, ['attempt', 'verify', 'consume']); assert.notEqual(result.sessionToken, challenge.challengeToken);
  assert.deepEqual(result.me, { userId: USER, email: EMAIL, expiresAt: '2027-01-16T09:00:00.000Z' });
  const row = f.sessions.get(hash(result.sessionToken))!;
  assert.deepEqual(open(row.tokensCipher, keys, `session:${row.hash}`), tokens());
  await assert.rejects(auth.verifyCode(challenge.challengeToken, '123456'), failure('unauthenticated'));
});
test('검증 5번째 성공을 허용하고 provider 실패도 시도를 복구하지 않는다', async () => {
  const f = fixture(); const auth = f.make(); const { challengeToken } = await auth.requestCode(EMAIL, 'a'.repeat(64));
  f.provider.verifyCode = async () => denied();
  for (let i = 0; i < 4; i++) await assert.rejects(auth.verifyCode(challengeToken, '123456'), failure('unauthenticated'));
  f.provider.verifyCode = async () => tokens(); assert.ok(await auth.verifyCode(challengeToken, '123456'));
  const other = await auth.requestCode(EMAIL, 'a'.repeat(64)); let calls = 0;
  f.provider.verifyCode = async () => { calls++; return unavailable(); };
  for (let i = 0; i < 5; i++) await assert.rejects(auth.verifyCode(other.challengeToken, '123456'), failure('unavailable'));
  await assert.rejects(auth.verifyCode(other.challengeToken, '123456'), failure('unauthenticated')); assert.equal(calls, 5);
});
test('검증 후 저장 실패는 provider 세션을 최선 노력으로 폐기하고 원래 오류를 보존한다', async () => {
  const f = fixture(); const auth = f.make(); const challenge = await auth.requestCode(EMAIL, 'a'.repeat(64));
  f.setFail('consume'); f.provider.revoke = async () => { f.events.push('remoteRevoke'); denied(); };
  await assert.rejects(auth.verifyCode(challenge.challengeToken, '123456'), failure('unavailable'));
  assert.equal(f.sessions.size, 0); assert.equal(f.events.at(-1), 'remoteRevoke');
});
test('authenticate는 정상 토큰을 매번 validate하고 원격 호출 뒤 DB 수명을 다시 확인한다', async () => {
  const f = fixture(); f.seed(); const auth = f.make();
  assert.deepEqual(await auth.authenticate(nonce), { actor: { userId: USER, sessionHash: hash(nonce) }, email: EMAIL, expiresAt: '2027-01-16T09:00:00.000Z' });
  await auth.authenticate(nonce); assert.deepEqual(f.events, ['read', 'validate', 'read', 'read', 'validate', 'read']);
  f.provider.validate = async () => { f.sessions.get(hash(nonce))!.usable = false; return { userId: USER, email: EMAIL }; };
  await assert.rejects(auth.authenticate(nonce), failure('unauthenticated'));
});
test('validate unavailable는 세션을 유지하고 명확한 거부는 먼저 DB 폐기한다', async () => {
  const f = fixture(); f.seed(); const auth = f.make(); f.provider.validate = async () => unavailable();
  await assert.rejects(auth.authenticate(nonce), failure('unavailable')); assert.equal(f.sessions.get(hash(nonce))!.revoked, false);
  f.provider.validate = async () => denied(); await assert.rejects(auth.authenticate(nonce), failure('unauthenticated'));
  assert.equal(f.sessions.get(hash(nonce))!.revoked, true);
});
for (const offset of [59, 60, 61]) test(`DB nowSeconds + ${offset} 경계에 따라 갱신한다`, async () => {
  const f = fixture(); f.seed({}, tokens({ expiresAt: 1800000000 + offset })); await f.make().authenticate(nonce);
  assert.deepEqual(f.events, offset <= 60 ? ['read', 'pending', 'refresh', 'save', 'activate', 'read'] : ['read', 'validate', 'read']);
  assert.equal(f.sessions.get(hash(nonce))!.expiresAt, '2027-01-16T09:00:00.000Z');
});
for (const stage of ['pending', 'refresh', 'save', 'activate']) test(`갱신 ${stage} 실패는 성공을 추측하거나 pending을 복구하지 않는다`, async () => {
  const f = fixture(); f.seed({}, tokens({ expiresAt: 1800000060 })); const auth = f.make(); f.setFail(stage);
  await assert.rejects(auth.authenticate(nonce), failure('unavailable'));
  assert.equal(f.events.includes('refresh'), stage !== 'pending');
  if (stage !== 'pending') {
    assert.equal(f.sessions.get(hash(nonce))!.refreshPending, true); f.setFail(''); f.events.length = 0;
    await assert.rejects(auth.authenticate(nonce), failure('unauthenticated')); assert.deepEqual(f.events, ['read']);
  }
});
test('B 저장 반영 후 응답 유실은 현재 unavailable과 다음 unauthenticated를 반환하고 C를 호출하지 않는다', async () => {
  const f = fixture(); f.seed({}, tokens({ expiresAt: 1800000060 })); const auth = f.make();
  const oldCipher = f.sessions.get(hash(nonce))!.tokensCipher;
  f.setFail('save:after');
  await assert.rejects(auth.authenticate(nonce), failure('unavailable'));
  const saved = f.sessions.get(hash(nonce))!;
  assert.equal(saved.version, 1); assert.equal(saved.refreshPending, true);
  assert.notEqual(saved.tokensCipher, oldCipher);
  assert.equal((open(saved.tokensCipher, keys, `session:${hash(nonce)}`) as ProviderTokens).expiresAt, 1800001200);
  assert.deepEqual(f.events, ['read', 'pending', 'refresh', 'save']);
  f.setFail(''); f.events.length = 0;
  await assert.rejects(auth.authenticate(nonce), failure('unauthenticated'));
  assert.deepEqual(f.events, ['read']); assert.equal(saved.refreshPending, true);
});
test('C 활성화 반영 후 응답 유실은 현재 unavailable이고 다음 요청은 실제 활성 상태로 validate한다', async () => {
  const f = fixture(); f.seed({}, tokens({ expiresAt: 1800000060 })); const auth = f.make();
  f.setFail('activate:after');
  await assert.rejects(auth.authenticate(nonce), failure('unavailable'));
  const saved = f.sessions.get(hash(nonce))!;
  assert.equal(saved.version, 1); assert.equal(saved.refreshPending, false); assert.equal(saved.revoked, false);
  assert.deepEqual(f.events, ['read', 'pending', 'refresh', 'save', 'activate']);
  f.setFail(''); f.events.length = 0;
  f.provider.validate = async (value) => { f.events.push('validate');
    assert.deepEqual(value, tokens({ expiresAt: 1800001200 })); return { userId: USER, email: EMAIL }; };
  assert.deepEqual(await auth.authenticate(nonce), { actor: { userId: USER, sessionHash: hash(nonce) },
    email: EMAIL, expiresAt: '2027-01-16T09:00:00.000Z' });
  assert.deepEqual(f.events, ['read', 'validate', 'read']);
});
test('동일 세션의 두 authenticate는 직렬화해 refresh 1회 뒤 새 토큰을 validate한다', async () => {
  const f = fixture(); f.seed({}, tokens({ expiresAt: 1800000060 })); const auth = f.make();
  const results = await Promise.all([auth.authenticate(nonce), auth.authenticate(nonce)]);
  assert.equal(results.length, 2); assert.deepEqual(f.events, ['read', 'pending', 'refresh', 'save', 'activate', 'read', 'read', 'validate', 'read']);
  assert.equal(f.sessions.get(hash(nonce))!.version, 1);
});
for (const state of [{ revoked: true }, { refreshPending: true }, { usable: false }]) test(`비활성 session ${JSON.stringify(state)}는 provider 없이 거부한다`, async () => {
  const f = fixture(); f.seed(state); await assert.rejects(f.make().authenticate(nonce), failure('unauthenticated')); assert.deepEqual(f.events, ['read']);
});
test('변조 암호문과 저장 행 token binding 불일치는 provider 없이 고정 장애다', async () => {
  for (const patch of [{ tokensCipher: 'broken' }, { userId: '33333333-3333-4333-8333-333333333333' }]) {
    const f = fixture(); f.seed(patch); await assert.rejects(f.make().authenticate(nonce), failure('unavailable')); assert.deepEqual(f.events, ['read']);
  }
});
test('갱신 token과 identity binding 오류는 pending 상태를 유지한다', async () => {
  for (const kind of ['token', 'identity', 'email']) {
    const f = fixture(); f.seed({}, tokens({ expiresAt: 1800000060 }));
    f.provider.refreshVerified = async () => ({ tokens: tokens(kind === 'token' ? { providerSessionId: '33333333-3333-4333-8333-333333333333' } : {}),
      identity: { userId: kind === 'identity' ? 'other' : USER, email: kind === 'email' ? 'bad' : EMAIL } });
    await assert.rejects(f.make().authenticate(nonce), failure('unavailable')); assert.equal(f.sessions.get(hash(nonce))!.refreshPending, true);
    assert.ok(!f.events.includes('save'));
  }
});
test('logout은 pending과 만료 session도 DB부터 폐기하고 provider 실패와 손상을 무시한다', async () => {
  for (const corrupted of [false, true]) {
    const f = fixture(); f.seed({ refreshPending: true, usable: false, ...(corrupted ? { tokensCipher: 'broken' } : {}) });
    f.provider.revoke = async () => { f.events.push('remoteRevoke'); unavailable(); };
    await f.make().logout(nonce); assert.equal(f.sessions.get(hash(nonce))!.revoked, true);
    assert.deepEqual(f.events, corrupted ? ['revoke'] : ['revoke', 'remoteRevoke']);
    await f.make().logout(nonce);
  }
});
test('logout은 없는 nonce에 멱등 성공하고 DB 폐기 실패는 오류이며 다른 session을 유지한다', async () => {
  const f = fixture(); const auth = f.make(); await auth.logout(nonce); f.seed(); f.setFail('revoke');
  await assert.rejects(auth.logout(nonce), failure('unavailable')); assert.equal(f.sessions.get(hash(nonce))!.revoked, false);
  f.setFail(''); await auth.logout(Buffer.alloc(32, 4).toString('base64url')); assert.equal(f.sessions.get(hash(nonce))!.revoked, false);
});
test('허용하지 않은 IdentityError 코드와 오류 원문은 고정 unavailable로 변환한다', async () => {
  const f = fixture(); f.seed(); f.provider.validate = async () => { throw new IdentityError('forbidden', SECRET); };
  await assert.rejects(f.make().authenticate(nonce), failure('unavailable'));
});
test('동일 challenge의 동시 검증은 세션 하나만 생성하고 두 번째 provider 호출을 막는다', async () => {
  const f = fixture(); const auth = f.make(); const { challengeToken } = await auth.requestCode(EMAIL, 'a'.repeat(64));
  f.events.length = 0;
  const results = await Promise.allSettled([auth.verifyCode(challengeToken, '123456'), auth.verifyCode(challengeToken, '123456')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.sessions.size, 1); assert.deepEqual(f.events, ['attempt', 'verify', 'consume', 'attempt']);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected'); failure('unauthenticated')(rejected.reason);
});
test('만료 challenge는 provider 없이 거부하고 새 ready는 이전 ready를 무효화한다', async () => {
  const f = fixture(); const auth = f.make(); const first = await auth.requestCode(EMAIL, 'a'.repeat(64));
  f.challenges.get(hash(first.challengeToken))!.expired = true; f.events.length = 0;
  await assert.rejects(auth.verifyCode(first.challengeToken, '123456'), failure('unauthenticated'));
  assert.deepEqual(f.events, ['attempt']);
  const second = await auth.requestCode(EMAIL, 'a'.repeat(64));
  const third = await auth.requestCode(EMAIL, 'a'.repeat(64));
  await assert.rejects(auth.verifyCode(second.challengeToken, '123456'), failure('unauthenticated'));
  assert.ok(await auth.verifyCode(third.challengeToken, '123456'));
});
test('challenge 복호화와 복호화 이메일 검사는 provider 전에 실행한다', async () => {
  for (const value of ['broken', seal('bad', 'k1', keys, `challenge:${hash(nonce)}`),
    seal(' Tester@Example.com ', 'k1', keys, `challenge:${hash(nonce)}`)]) {
    const f = fixture(); f.challenges.set(hash(nonce), { hash: hash(nonce), emailCipher: value,
      emailKey: 'a'.repeat(64), clientHash: 'b'.repeat(64), state: 'ready', attempts: 0, expired: false });
    await assert.rejects(f.make().verifyCode(nonce, '123456'), failure('unavailable'));
    assert.deepEqual(f.events, ['attempt']); assert.equal(f.challenges.get(hash(nonce))!.attempts, 1);
  }
});
test('잘못된 provider 검증 토큰은 session 저장 전에 거부한다', async () => {
  const f = fixture(); const auth = f.make(); const challenge = await auth.requestCode(EMAIL, 'a'.repeat(64));
  f.provider.verifyCode = async () => tokens({ userId: 'bad' }); f.events.length = 0;
  await assert.rejects(auth.verifyCode(challenge.challengeToken, '123456'), failure('unavailable'));
  assert.equal(f.sessions.size, 0); assert.deepEqual(f.events, ['attempt']);
});
test('refresh save 실패와 대기 중인 다음 authenticate는 이전 토큰으로 성공하지 않는다', async () => {
  const f = fixture(); f.seed({}, tokens({ expiresAt: 1800000060 })); f.setFail('save'); const auth = f.make();
  const results = await Promise.allSettled([auth.authenticate(nonce), auth.authenticate(nonce)]);
  assert.equal(results[0]!.status, 'rejected'); assert.equal(results[1]!.status, 'rejected');
  if (results[0]!.status === 'rejected') failure('unavailable')(results[0]!.reason);
  if (results[1]!.status === 'rejected') failure('unauthenticated')(results[1]!.reason);
  assert.deepEqual(f.events, ['read', 'pending', 'refresh', 'save', 'read']);
});
test('갱신 provider 거부는 DB 폐기하고 원격 작업 중 앱 기한 종료도 성공하지 않는다', async () => {
  const f = fixture(); f.seed({}, tokens({ expiresAt: 1800000060 })); f.provider.refreshVerified = async () => denied();
  await assert.rejects(f.make().authenticate(nonce), failure('unauthenticated'));
  assert.equal(f.sessions.get(hash(nonce))!.revoked, true);
  const g = fixture(); g.seed({}, tokens({ expiresAt: 1800000060 }));
  g.provider.refreshVerified = async () => { g.sessions.get(hash(nonce))!.usable = false;
    return { tokens: tokens(), identity: { userId: USER, email: EMAIL } }; };
  await assert.rejects(g.make().authenticate(nonce), failure('unauthenticated'));
});
test('provider IdentityError의 message field cause와 DB 원문은 반환 오류에 남지 않는다', async () => {
  const f = fixture(); const auth = f.make();
  f.provider.requestCode = async () => { const error = new IdentityError('rate_limited', SECRET, EMAIL);
    error.cause = new Error(SECRET); throw error; };
  await assert.rejects(auth.requestCode(EMAIL, 'a'.repeat(64)), failure('rate_limited'));
  assert.equal([...f.challenges.values()][0]!.state, 'failed');
  f.seed(); f.provider.validate = async () => denied(); f.setFail('revoke');
  await assert.rejects(auth.authenticate(nonce), failure('unavailable'));
});

test('이메일 링크는 저장된 challenge 이메일 검증 후 한 번만 세션을 만들고 authenticate와 호환된다', async () => {
 const f=fixture();const auth=f.make();const {challengeToken}=await auth.requestCode(EMAIL,'a'.repeat(64));
 f.provider.verifyEmailLink=async(email,value)=>{f.events.push('link');assert.equal(email,EMAIL);assert.equal(value.refreshToken,'synthetic_refresh');return tokens();};
 assert.equal(typeof auth.verifyEmailLink,'function');f.events.length=0;
 const result=await auth.verifyEmailLink!(challengeToken,{accessToken:tokens().accessToken,refreshToken:'synthetic_refresh'});
 assert.deepEqual(f.events,['attempt','link','consume']);
 const row=f.sessions.get(hash(result.sessionToken))!;
 assert.deepEqual(open(row.tokensCipher,keys,`session:${row.hash}`),tokens());
 assert.equal((await auth.authenticate(result.sessionToken)).actor.userId,USER);
 await assert.rejects(auth.verifyEmailLink!(challengeToken,{accessToken:tokens().accessToken,refreshToken:'synthetic_refresh'}),failure('unauthenticated'));
 assert.equal(f.sessions.size,1);
});
test('이메일 링크의 만료와 재발송 challenge는 provider 전에 거절된다',async()=>{
 const f=fixture();const auth=f.make();assert.equal(typeof auth.verifyEmailLink,'function');
 let calls=0;f.provider.verifyEmailLink=async()=>{calls++;return tokens();};
 const first=await auth.requestCode(EMAIL,'a'.repeat(64));f.challenges.get(hash(first.challengeToken))!.expired=true;
 await assert.rejects(auth.verifyEmailLink!(first.challengeToken,{accessToken:tokens().accessToken,refreshToken:'synthetic_refresh'}),failure('unauthenticated'));
 const second=await auth.requestCode(EMAIL,'a'.repeat(64));await auth.requestCode(EMAIL,'a'.repeat(64));
 await assert.rejects(auth.verifyEmailLink!(second.challengeToken,{accessToken:tokens().accessToken,refreshToken:'synthetic_refresh'}),failure('unauthenticated'));
 assert.equal(calls,0);assert.equal(f.sessions.size,0);
});
test('이메일 링크 검증 거절은 challenge 시도를 소비하고 원문 오류를 숨긴다',async()=>{
 const f=fixture();const auth=f.make();assert.equal(typeof auth.verifyEmailLink,'function');
 f.provider.verifyEmailLink=async()=>denied();const {challengeToken}=await auth.requestCode(EMAIL,'a'.repeat(64));
 await assert.rejects(auth.verifyEmailLink!(challengeToken,{accessToken:tokens().accessToken,refreshToken:'synthetic_refresh'}),failure('unauthenticated'));
 assert.equal(f.challenges.get(hash(challengeToken))!.attempts,1);assert.equal(f.sessions.size,0);
});


test('이메일 링크 실제 provider와 저장소 모형은 이메일 바인딩과 암호화 세션의 갱신을 함께 검증한다',async()=>{
 const f=fixture();const auth=f.make();const url='https://agddopryfqsyfshoowgk.supabase.co';
 const jwt=(expiresAt:number)=>`e30.${Buffer.from(JSON.stringify({iss:`${url}/auth/v1`,sub:USER,aud:'authenticated',exp:expiresAt,session_id:SESSION})).toString('base64url')}.c3ludGhldGlj`;
 const remoteUser={id:USER,email:EMAIL,is_anonymous:false,email_confirmed_at:'2026-10-01T00:00:00Z'};
 let wrongEmail=true;const paths:string[]=[];
 Object.assign(f.provider,createAuthProvider({url,publishableKey:'sb_publishable_unit_only_not_a_real_key',now:()=>1800000000000,fetcher:async(input)=>{
  paths.push(String(input));
  const body=String(input).includes('/token?')?{access_token:jwt(1800001200),refresh_token:'synthetic_rotated',expires_at:1800001200,expires_in:1200,token_type:'bearer',user:remoteUser}:String(input).endsWith('/user')?{...remoteUser,email:wrongEmail?'other@example.com':EMAIL}:{};
  return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
 }}));
 const {challengeToken}=await auth.requestCode(EMAIL,'a'.repeat(64));
 await assert.rejects(auth.verifyEmailLink!(challengeToken,{accessToken:jwt(1800000060),refreshToken:'synthetic_refresh'}),failure('unauthenticated'));
 assert.equal(f.sessions.size,0);wrongEmail=false;
 const logged=await auth.verifyEmailLink!(challengeToken,{accessToken:jwt(1800000060),refreshToken:'synthetic_refresh'});
 const stored=f.sessions.get(hash(logged.sessionToken))!;
 assert.deepEqual(open(stored.tokensCipher,keys,`session:${stored.hash}`),{accessToken:jwt(1800000060),refreshToken:'synthetic_refresh',expiresAt:1800000060,userId:USER,providerSessionId:SESSION});
 assert.equal((await auth.authenticate(logged.sessionToken)).actor.userId,USER);
 assert.equal(stored.version,1);assert.equal(stored.refreshPending,false);
 assert.deepEqual(paths,[`${url}/auth/v1/otp`,`${url}/auth/v1/user`,`${url}/auth/v1/user`,`${url}/auth/v1/token?grant_type=refresh_token`,`${url}/auth/v1/user`]);
});

test('이메일 링크 동시 소비는 한 세션만 만들고 원격 검증 뒤 만료도 거절한다',async()=>{
 const f=fixture();const auth=f.make();let calls=0;
 f.provider.verifyEmailLink=async()=>{calls++;return tokens();};
 const {challengeToken}=await auth.requestCode(EMAIL,'a'.repeat(64));
 const results=await Promise.allSettled([auth.verifyEmailLink!(challengeToken,{accessToken:tokens().accessToken,refreshToken:'synthetic_refresh'}),auth.verifyEmailLink!(challengeToken,{accessToken:tokens().accessToken,refreshToken:'synthetic_refresh'})]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(f.sessions.size,1);assert.equal(calls,1);
 const later=await auth.requestCode(EMAIL,'a'.repeat(64));
 f.provider.verifyEmailLink=async()=>{f.challenges.get(hash(later.challengeToken))!.expired=true;return tokens();};
 await assert.rejects(auth.verifyEmailLink!(later.challengeToken,{accessToken:tokens().accessToken,refreshToken:'synthetic_refresh'}),failure('unauthenticated'));
 assert.equal(f.sessions.size,1);assert.equal(f.events.at(-1),'remoteRevoke');
});
