import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { IdentityError } from '../../core/contracts.js';
import {
  createProviderAccessVerifier, ProviderAccessFailure,
} from '../../server/auth/provider-access.js';

const URL = 'https://agddopryfqsyfshoowgk.supabase.co';
const KEY = 'sb_publishable_unit_only_not_a_real_key';
const NOW = 1_800_000_000_000;
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
const NIL = '00000000-0000-0000-0000-000000000000';
const SECRET = 'synthetic_sensitive_provider_message';

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: `${URL}/auth/v1`, sub: USER, aud: 'authenticated', exp: 1_800_000_600,
    session_id: SESSION, is_anonymous: false, ...overrides,
  };
}

function jwt(payload: unknown = claims()) {
  return `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c3ludGhldGlj`;
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: USER, aud: 'authenticated', role: 'authenticated', email: ' Tester@Example.com ',
    email_confirmed_at: '2026-10-01T00:00:00Z', is_anonymous: false,
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {},
    created_at: '2026-10-01T00:00:00Z', ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' },
  });
}

function verifier(fetcher: typeof fetch, now = () => NOW) {
  return createProviderAccessVerifier({ url: URL, publishableKey: KEY, fetcher, now });
}

function denial(reason: string) {
  return (error: unknown) => error instanceof ProviderAccessFailure
    && error.code === 'unauthenticated' && error.reason === reason;
}

function unavailable(error: unknown) {
  return error instanceof IdentityError && error.code === 'unavailable'
    && !(error instanceof ProviderAccessFailure) && !inspect(error).includes(SECRET);
}

test('SDK가 변환한 session_not_found를 인증 거부로 유지', async () => {
  const verify = verifier(async () => response({ code: 'session_not_found', message: SECRET }, 403));
  await assert.rejects(verify(jwt()), denial('session_not_found'));
});

for (const reason of ['session_expired', 'bad_jwt', 'user_not_found', 'user_banned'] as const) {
  test(`알려진 provider 거부 ${reason}을 구분`, async () => {
    await assert.rejects(verifier(async () => response({ code: reason, message: SECRET }, 403))(jwt()), denial(reason));
  });
}

test('구형 error_code 응답의 세션 폐기도 구분', async () => {
  const verify = verifier(async () => new Response(JSON.stringify({ error_code: 'session_not_found' }), { status: 403 }));
  await assert.rejects(verify(jwt()), denial('session_not_found'));
});

for (const audience of ['authenticated', ['authenticated']]) {
  test(`정상 aud ${JSON.stringify(audience)}와 명시 JWT를 검사`, async () => {
    const token = jwt(claims({ aud: audience }));
    let calls = 0;
    const verify = verifier(async (input, init) => {
      calls++;
      assert.equal(String(input), `${URL}/auth/v1/user`);
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
      assert.equal(new Headers(init?.headers).get('apikey'), KEY);
      assert.equal(init?.cache, 'no-store');
      assert.ok(init?.signal instanceof AbortSignal);
      return response(user());
    });
    assert.deepEqual(await verify(token), {
      userId: USER, providerSessionId: SESSION, email: 'tester@example.com', expiresAtSeconds: 1_800_000_600,
    });
    assert.equal(calls, 1);
  });
}

test('user로 감싼 정상 provider 응답도 검사', async () => {
  const result = await verifier(async () => response({ user: user() }))(jwt());
  assert.equal(result.userId, USER);
});

test('동일 토큰을 재검사할 때 성공 결과를 캐시하지 않음', async () => {
  let calls = 0;
  const verify = verifier(async () => ++calls === 1 ? response(user())
    : response({ code: 'session_not_found' }, 403));
  await verify(jwt());
  await assert.rejects(verify(jwt()), denial('session_not_found'));
  assert.equal(calls, 2);
});

test('동시 요청의 JWT와 취소 신호가 서로 격리됨', async () => {
  const tokenP = jwt();
  const tokenQ = jwt(claims({ sub: OTHER_USER, session_id: OTHER_SESSION }));
  const signals: AbortSignal[] = [];
  const releases: Array<() => void> = [];
  const verify = verifier(async (_input, init) => {
    const authorization = new Headers(init?.headers).get('Authorization');
    assert.ok(init?.signal);
    signals.push(init.signal);
    await new Promise<void>((resolve) => releases.push(resolve));
    return response(authorization === `Bearer ${tokenP}` ? user() : user({ id: OTHER_USER }));
  });
  const p = verify(tokenP);
  const q = verify(tokenQ);
  assert.equal(releases.length, 2);
  assert.notEqual(signals[0], signals[1]);
  releases[1]!();
  releases[0]!();
  assert.deepEqual((await Promise.all([p, q])).map((value) => value.userId), [USER, OTHER_USER]);
});

for (const token of ['', ' ', 'a.b', 'a.b.c.d', 'a..c', 'a.b.c\n', jwt(claims({ padding: 'x'.repeat(16_384) }))]) {
  test(`잘못된 JWT 형태나 크기를 SDK 호출 전에 거부 (${JSON.stringify(token.slice(0, 12))})`, async () => {
    let calls = 0;
    const verify = verifier(async () => { calls++; return response(user()); });
    await assert.rejects(verify(token), denial('invalid_claims'));
    assert.equal(calls, 0);
  });
}

test('16KiB 크기 경계의 JWT는 provider 검증으로 전달', async () => {
  const base = jwt();
  const token = base + 'x'.repeat(16_384 - base.length);
  let calls = 0;
  const result = await verifier(async () => { calls++; return response(user()); })(token);
  assert.equal(calls, 1);
  assert.equal(result.userId, USER);
});

test('JSON에서 무한대로 해석되는 exp를 거부', async () => {
  const raw = JSON.stringify(claims()).replace('1800000600', '1e309');
  const token = `e30.${Buffer.from(raw).toString('base64url')}.c3ludGhldGlj`;
  await assert.rejects(verifier(async () => response(user()))(token), denial('invalid_claims'));
});

for (const [label, patch] of Object.entries({
  issuer: { iss: 'https://another-project.invalid/auth/v1' },
  issuerSuffix: { iss: `${URL}/auth/v1/` },
  sub: { sub: OTHER_USER },
  invalidSub: { sub: 'not-a-uuid' },
  missingSub: { sub: undefined },
  nilSession: { session_id: NIL },
  missingSession: { session_id: undefined },
  invalidSession: { session_id: 'not-a-uuid' },
  missingAud: { aud: undefined },
  wrongAud: { aud: 'anon' },
  multipleAud: { aud: ['authenticated', 'another'] },
  duplicateAud: { aud: ['authenticated', 'authenticated'] },
  emptyAud: { aud: [] },
  missingExp: { exp: undefined },
  stringExp: { exp: '1800000600' },
  expired: { exp: 1_799_999_999 },
  boundaryExp: { exp: 1_800_000_000 },
  nullExp: { exp: null },
})) {
  test(`claim 불일치 ${label}을 거부`, async () => {
    await assert.rejects(verifier(async () => response(user()))(jwt(claims(patch))), denial('invalid_claims'));
  });
}

for (const payload of [null, [], 'payload', 123, false]) {
  test(`객체가 아닌 JWT payload ${JSON.stringify(payload)}를 거부`, async () => {
    await assert.rejects(verifier(async () => response(user()))(jwt(payload)), denial('invalid_claims'));
  });
}

test('provider 성공 후 잘못된 payload JSON을 거부', async () => {
  await assert.rejects(verifier(async () => response(user()))('e30.bm90LWpzb24.c3ludGhldGlj'), denial('invalid_claims'));
});

test('payload를 해석하기 전에 provider 거부를 우선 확인', async () => {
  await assert.rejects(verifier(async () => response({ code: 'session_not_found' }, 403))('e30.bm90LWpzb24.c3ludGhldGlj'), denial('session_not_found'));
});

test('exp가 응답 대기 중 만료되면 거부', async () => {
  let clock = NOW;
  const verify = verifier(async () => { clock += 601_000; return response(user()); }, () => clock);
  await assert.rejects(verify(jwt()), denial('invalid_claims'));
});

for (const [label, patch] of Object.entries({
  anonymous: { is_anonymous: true },
  unconfirmed: { email_confirmed_at: null },
  missingConfirmation: { email_confirmed_at: undefined },
  emptyEmail: { email: '' },
  missingEmail: { email: undefined },
})) {
  test(`이메일 사용자 조건 ${label}을 거부`, async () => {
    await assert.rejects(verifier(async () => response(user(patch)))(jwt()), denial('invalid_claims'));
  });
}

test('login 이메일과 session binding을 대조', async () => {
  const verify = verifier(async () => response(user()));
  await verify(jwt(), { kind: 'login', normalizedEmail: ' TESTER@Example.com ' });
  await verify(jwt(), { kind: 'session', userId: USER, providerSessionId: SESSION });
  await assert.rejects(verify(jwt(), { kind: 'login', normalizedEmail: 'other@example.com' }), denial('invalid_claims'));
  await assert.rejects(verify(jwt(), { kind: 'session', userId: OTHER_USER, providerSessionId: SESSION }), denial('invalid_claims'));
  await assert.rejects(verify(jwt(), { kind: 'session', userId: USER, providerSessionId: OTHER_SESSION }), denial('invalid_claims'));
});

test('부분 binding이나 알 수 없는 binding을 허용하지 않음', async () => {
  const verify = verifier(async () => response(user()));
  for (const binding of [{}, { kind: 'login' }, { kind: 'session', userId: USER }, { kind: 'unknown' }, null]) {
    await assert.rejects(verify(jwt(), binding as never), denial('invalid_claims'));
  }
});

for (const body of [{}, null, [], 'unexpected', { user: null }, user({ id: 'invalid' }),
  user({ is_anonymous: undefined }), user({ is_anonymous: 'false' }), user({ email: 123 }),
  user({ email_confirmed_at: {} }), user({ email_confirmed_at: 'invalid-date' })]) {
  test(`예상 밖 성공 응답을 503으로 처리 (${JSON.stringify(body).slice(0, 60)})`, async () => {
    await assert.rejects(verifier(async () => response(body))(jwt()), unavailable);
  });
}

test('잘못된 성공 JSON은 503이며 원문을 보존하지 않음', async () => {
  await assert.rejects(verifier(async () => new Response(SECRET, { status: 200 }))(jwt()), unavailable);
});

for (const status of [429, ...Array.from({ length: 100 }, (_, index) => 500 + index)]) {
  test(`HTTP ${status}는 알려진 세션 거부 코드보다 503 우선`, async () => {
    await assert.rejects(verifier(async () => response({ code: 'session_not_found', message: SECRET }, status))(jwt()), unavailable);
  });
}

for (const [label, fetcher] of [
  ['network', async () => { throw new Error(SECRET); }],
  ['key', async () => response({ message: SECRET }, 401)],
  ['unknown', async () => response({ code: 'unknown_provider_code', message: SECRET }, 403)],
  ['nonJson', async () => new Response(SECRET, { status: 403 })],
] as const) {
  test(`장애 ${label}은 고정된 503으로 처리`, async () => {
    await assert.rejects(verifier(fetcher)(jwt()), unavailable);
  });
}

test('알려진 거부에서도 provider 원문과 JWT를 오류에 보존하지 않음', async () => {
  const token = jwt();
  await assert.rejects(verifier(async () => response({ code: 'bad_jwt', message: `${SECRET} ${token}` }, 403))(token), (error: unknown) => {
    assert.ok(denial('bad_jwt')(error));
    assert.ok(!inspect(error).includes(SECRET));
    assert.ok(!inspect(error).includes(token));
    assert.ok(!JSON.stringify(error).includes(SECRET));
    return true;
  });
});

test('5초가 지나면 응답 대기 fetch를 취소하고 503 반환', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  const verify = verifier(async (_input, init) => new Promise<Response>((_resolve, reject) => {
    signal = init?.signal ?? undefined;
    signal?.addEventListener('abort', () => reject(new Error(SECRET)), { once: true });
  }));
  const pending = verify(jwt());
  const rejected = assert.rejects(pending, unavailable);
  t.mock.timers.tick(4_999);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal?.aborted, true);
});

test('헤더 수신 뒤 본문이 지연되어도 같은 5초 제한으로 취소', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  let reading = false;
  const verify = verifier(async (_input, init) => {
    signal = init?.signal ?? undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    return new Response(new ReadableStream({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(new Error(SECRET)), { once: true });
      },
      pull() { reading = true; },
    }), { headers: { 'Content-Type': 'application/json' } });
  });
  const pending = verify(jwt());
  const rejected = assert.rejects(pending, unavailable);
  t.mock.timers.tick(3_000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(reading, true);
  t.mock.timers.tick(1_999);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal?.aborted, true);
});

test('완료한 호출의 타이머가 이후 요청의 신호를 취소하지 않음', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  await verifier(async (_input, init) => { signal = init?.signal ?? undefined; return response(user()); })(jwt());
  t.mock.timers.tick(5_000);
  assert.equal(signal?.aborted, false);
});

for (const config of [
  { url: 'https://another-project.invalid', publishableKey: KEY },
  { url: `${URL}/auth/v1`, publishableKey: KEY },
  { url: URL, publishableKey: '' },
  { url: URL, publishableKey: 'sb_secret_synthetic' },
  { url: URL, publishableKey: 'legacy.jwt.synthetic' },
]) {
  test('프로젝트나 publishable key 설정 오류에 비밀 없는 unavailable 반환', () => {
    assert.throws(() => createProviderAccessVerifier({ ...config, fetcher: async () => { throw new Error('must not fetch'); } }), unavailable);
  });
}
