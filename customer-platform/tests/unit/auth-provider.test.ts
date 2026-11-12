import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { IdentityError, type ProviderTokens } from '../../core/contracts.js';
import { createAuthProvider } from '../../server/auth/provider.js';

const URL = 'https://agddopryfqsyfshoowgk.supabase.co';
const KEY = 'sb_publishable_unit_only_not_a_real_key';
const NOW = 1_800_000_000_000;
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
const SECRET = 'synthetic_sensitive_provider_message';
const REFRESH = 'synthetic_refresh_secret';
const EMAIL = 'tester@example.com';
function jwt(patch: Record<string, unknown> = {}) {
  return `e30.${Buffer.from(JSON.stringify({ iss: `${URL}/auth/v1`, sub: USER,
    aud: 'authenticated', exp: 1_800_000_600, session_id: SESSION, ...patch })).toString('base64url')}.c3ludGhldGlj`;
}
function user(patch: Record<string, unknown> = {}) {
  return { id: USER, aud: 'authenticated', role: 'authenticated', email: EMAIL,
    email_confirmed_at: '2026-10-01T00:00:00Z', is_anonymous: false,
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {},
    created_at: '2026-10-01T00:00:00Z', ...patch };
}
function session(patch: Record<string, unknown> = {}) {
  return { access_token: jwt(), refresh_token: REFRESH, expires_at: 1_800_000_600,
    expires_in: 600, token_type: 'bearer', user: user(), ...patch };
}
function tokens(patch: Partial<ProviderTokens> = {}): ProviderTokens {
  return { accessToken: jwt(), refreshToken: REFRESH, expiresAt: 1_800_000_600,
    userId: USER, providerSessionId: SESSION, ...patch };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status,
    headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' } });
}
function provider(fetcher: typeof fetch) {
  return createAuthProvider({ url: URL, publishableKey: KEY, now: () => NOW, fetcher });
}
function failure(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof IdentityError);
    assert.equal(error.code, code);
    for (const secret of [SECRET, REFRESH, jwt(), EMAIL, '123456']) {
      assert.ok(!inspect(error).includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
      assert.ok(!error.message.includes(secret));
    }
    assert.equal(error.cause, undefined);
    return true;
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('OTP 요청은 정규화 이메일과 신규 가입 허용을 한 번 전달한다', async () => {
  let calls = 0;
  await provider(async (input, init) => {
    calls++;
    assert.equal(String(input), `${URL}/auth/v1/otp`);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get('apikey'), KEY);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.email, EMAIL);
    assert.equal(body.create_user, true);
    return response({});
  }).requestCode(' Tester@Example.com ');
  assert.equal(calls, 1);
});

for (const [index, email] of [null, 1, '', 'bad', 'a @b.com', 'a\tb@c.com', 'a\nb@c.com', `${'a'.repeat(250)}@x.com`].entries()) {
  test(`잘못된 이메일 ${index + 1}은 fetch 전에 validation`, async () => {
    let calls = 0;
    const auth = provider(async () => { calls++; return response({}); });
    await assert.rejects(auth.requestCode(email as string), failure('validation'));
    await assert.rejects(auth.verifyCode(email as string, '123456'), failure('validation'));
    assert.equal(calls, 0);
  });
}
for (const [index, code] of [null, 123456, '', '12345', '1234567', '１２３４５６', '12345\n', '12 456'].entries()) {
  test(`OTP ${index + 1}은 ASCII 숫자 6자리만 허용`, async () => {
    let calls = 0;
    await assert.rejects(provider(async () => { calls++; return response({}); })
      .verifyCode(EMAIL, code as string), failure('validation'));
    assert.equal(calls, 0);
  });
}

test('OTP 검증은 SDK 요청 뒤 명시 JWT로 getUser를 한 번 호출한다', async () => {
  const calls: string[] = [];
  const result = await provider(async (input, init) => {
    calls.push(String(input));
    if (String(input).endsWith('/verify')) {
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.email, EMAIL);
      assert.equal(body.token, '123456');
      assert.equal(body.type, 'email');
      return response(session());
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${jwt()}`);
    return response(user());
  }).verifyCode(' Tester@Example.com ', '123456');
  assert.deepEqual(calls, [`${URL}/auth/v1/verify`, `${URL}/auth/v1/user`]);
  assert.deepEqual(result, tokens());
});

for (const [label, patch] of Object.entries({ issuer: { iss: 'https://other.invalid/auth/v1' },
  audience: { aud: 'anon' }, user: { sub: OTHER_USER }, session: { session_id: 'bad' },
  expired: { exp: 1_800_000_000 } })) {
  test(`OTP의 JWT ${label} 변조는 인증 거부`, async () => {
    await assert.rejects(provider(async (input) => String(input).endsWith('/verify')
      ? response(session({ access_token: jwt(patch) })) : response(user()))
      .verifyCode(EMAIL, '123456'), failure('unauthenticated'));
  });
}
for (const [index, patch] of [{ email: 'other@example.com' }, { is_anonymous: true }, { email_confirmed_at: null }].entries()) {
  test(`getUser 이메일 사용자 조건 ${index + 1}은 인증 거부`, async () => {
    await assert.rejects(provider(async (input) => String(input).endsWith('/verify')
      ? response(session()) : response(user(patch))).verifyCode(EMAIL, '123456'), failure('unauthenticated'));
  });
}
for (const [index, patch] of [{ expires_at: 1_800_000_601 }, { expires_at: 1_800_000_600_000 },
  { user: user({ id: OTHER_USER }) }, { user: user({ email: 'other@example.com' }) },
  { user: user({ is_anonymous: true }) }, { user: user({ email_confirmed_at: null }) },
  { refresh_token: 'bad\nsecret' }, { access_token: '' }, { expires_at: null }].entries()) {
  test(`SDK 세션 불일치는 unavailable ${index + 1}`, async () => {
    await assert.rejects(provider(async (input) => String(input).endsWith('/verify')
      ? response(session(patch)) : response(user())).verifyCode(EMAIL, '123456'), failure('unavailable'));
  });
}

test('validate는 매번 getUser를 호출하고 저장 기한을 대조한다', async () => {
  let calls = 0;
  const auth = provider(async (input) => {
    calls++;
    assert.equal(String(input), `${URL}/auth/v1/user`);
    return response(user());
  });
  assert.deepEqual(await auth.validate(tokens()), { userId: USER, email: EMAIL });
  await auth.validate(tokens());
  await assert.rejects(auth.validate(tokens({ expiresAt: 1_800_000_601 })), failure('unavailable'));
  assert.equal(calls, 3);
});

test('refresh는 갱신 1회와 getUser 1회로 같은 사용자와 세션의 새 토큰을 반환한다', async () => {
  const urls: string[] = [];
  const refreshed = jwt({ exp: 1_800_001_200 });
  const result = await provider(async (input, init) => {
    urls.push(String(input));
    if (String(input).includes('/token?')) {
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { refresh_token: REFRESH });
      return response(session({ access_token: refreshed, refresh_token: 'rotated_synthetic', expires_at: 1_800_001_200 }));
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${refreshed}`);
    return response(user());
  }).refresh(tokens({ expiresAt: 1_799_999_999 }));
  assert.deepEqual(urls, [`${URL}/auth/v1/token?grant_type=refresh_token`, `${URL}/auth/v1/user`]);
  assert.deepEqual(result, { accessToken: refreshed, refreshToken: 'rotated_synthetic',
    expiresAt: 1_800_001_200, userId: USER, providerSessionId: SESSION });
});
for (const [index, patch] of [{ sub: OTHER_USER }, { session_id: OTHER_SESSION }].entries()) {
  test(`refresh는 저장된 binding 변경 ${index + 1} 거부`, async () => {
    await assert.rejects(provider(async (input) => String(input).includes('/token?')
      ? response(session({ access_token: jwt(patch), user: user({ id: patch.sub ?? USER }) }))
      : response(user({ id: patch.sub ?? USER }))).refresh(tokens()), failure('unauthenticated'));
  });
}

const denied = {
  verifyCode: ['otp_expired', 'invalid_credentials', 'user_not_found', 'user_banned'],
  refresh: ['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found',
    'session_expired', 'bad_jwt', 'user_not_found', 'user_banned'],
} as const;
for (const [method, codes] of Object.entries(denied)) {
  for (const code of codes) for (const status of [400, 401, 403, 404, 422]) {
    test(`${method} HTTP${status} ${code}만 인증 거부`, async () => {
      const auth = provider(async () => response({ code, message: SECRET }, status));
      await assert.rejects(method === 'refresh' ? auth.refresh(tokens())
        : auth.verifyCode(EMAIL, '123456'), failure('unauthenticated'));
    });
  }
}
for (const method of ['requestCode', 'verifyCode', 'refresh', 'validate'] as const) {
  for (const status of [429, 500, 503]) {
    test(`${method} HTTP${status}는 provider 코드보다 장애 우선`, async () => {
      let calls = 0;
      const auth = provider(async () => { calls++; return response({ code: 'session_expired', error_code: 'otp_expired', message: SECRET }, status); });
      const pending = method === 'requestCode' ? auth.requestCode(EMAIL) : method === 'verifyCode'
        ? auth.verifyCode(EMAIL, '123456') : auth[method](tokens());
      await assert.rejects(pending, failure(method === 'requestCode' && status === 429 ? 'rate_limited' : 'unavailable'));
      assert.equal(calls, 1);
    });
  }
}
for (const method of ['requestCode', 'verifyCode', 'refresh'] as const) {
  for (const [index, body] of [{ code: 'unknown', message: SECRET }, { message: SECRET },
    { code: 'signup_disabled', message: SECRET }].entries()) {
    test(`${method} 알 수 없는 4xx는 일반 장애 ${index + 1}`, async () => {
      const auth = provider(async () => response(body, 400));
      await assert.rejects(method === 'requestCode' ? auth.requestCode(EMAIL)
        : method === 'verifyCode' ? auth.verifyCode(EMAIL, '123456') : auth.refresh(tokens()), failure('unavailable'));
    });
  }
}

test('revoke는 만료 토큰으로도 local POST만 호출하고 성공 본문을 취소한다', async () => {
  let calls = 0;
  let cancelled = false;
  await provider(async (input, init) => {
    calls++;
    assert.equal(String(input), `${URL}/auth/v1/logout?scope=local`);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('apikey'), KEY);
    assert.equal(headers.get('Authorization'), `Bearer ${jwt()}`);
    assert.equal(headers.get('X-Supabase-Api-Version'), '2024-01-01');
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }).revoke(tokens({ expiresAt: 1_799_999_999 }));
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});
for (const status of [401, 403, 404]) {
  for (const body of [{ code: 'session_not_found' }, { error_code: 'session_not_found' },
    { code: 'session_not_found', error_code: 'session_not_found' }]) {
    test(`revoke HTTP${status} 정확한 재종료 응답은 성공 ${JSON.stringify(body)}`, async () => {
      await provider(async () => response(body, status)).revoke(tokens());
    });
  }
}
for (const body of [null, [], ['session_not_found'], {}, { code: 'bad_jwt' },
  { code: 'session_not_found', error_code: 'bad_jwt' }, { code: null, error_code: 'session_not_found' }]) {
  test(`revoke 비정상 재종료 응답은 장애 ${JSON.stringify(body)}`, async () => {
    await assert.rejects(provider(async () => response(body, 403)).revoke(tokens()), failure('unavailable'));
  });
}
for (const status of [400, 422, 429, 500, 503]) {
  test(`revoke HTTP${status}는 재종료로 바꾸지 않는다`, async () => {
    await assert.rejects(provider(async () => response({ code: 'session_not_found' }, status))
      .revoke(tokens()), failure('unavailable'));
  });
}
for (const method of ['validate', 'refresh', 'revoke'] as const) {
  test(`${method} 잘못된 토큰은 fetch 전에 일반 장애`, async () => {
    let calls = 0;
    const auth = provider(async () => { calls++; return response({}); });
    for (const patch of [{ accessToken: 'bad\r\nsecret' }, { refreshToken: 'bad\nsecret' }, { userId: 'bad' }]) {
      await assert.rejects(auth[method](tokens(patch)), failure('unavailable'));
    }
    assert.equal(calls, 0);
  });
}
for (const method of ['requestCode', 'verifyCode', 'refresh', 'revoke'] as const) {
  for (const kind of ['network', 'json'] as const) {
    test(`${method} ${kind} 장애는 비밀 없는 unavailable`, async () => {
      let calls = 0;
      const auth = provider(async () => {
        calls++;
        if (kind === 'network') throw new Error(`${SECRET} ${EMAIL} ${REFRESH}`);
        return new Response(SECRET, { status: method === 'revoke' ? 403 : 200 });
      });
      await assert.rejects(method === 'requestCode' ? auth.requestCode(EMAIL)
        : method === 'verifyCode' ? auth.verifyCode(EMAIL, '123456') : auth[method](tokens()), failure('unavailable'));
      assert.equal(calls, 1);
    });
  }
}
for (const method of ['requestCode', 'verifyCode', 'refresh', 'validate', 'revoke'] as const) {
  for (const kind of ['fetch', 'body'] as const) {
    test(`${method} ${kind} 정지는 5초 종료 후 실제 추가 요청이 없다`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let calls = 0;
      let signal: AbortSignal | null | undefined;
      let release: ((value: Response) => void) | undefined;
      const auth = provider(async (_input, init) => {
        calls++;
        signal = init?.signal;
        if (kind === 'fetch') return new Promise<Response>((resolve) => { release = resolve; });
        return new Response(new ReadableStream({ cancel() { return new Promise<void>(() => {}); } }));
      });
      const pending = assert.rejects(method === 'requestCode' ? auth.requestCode(EMAIL)
        : method === 'verifyCode' ? auth.verifyCode(EMAIL, '123456') : auth[method](tokens()), failure('unavailable'));
      await flush();
      t.mock.timers.tick(4_999);
      assert.equal(signal?.aborted, false);
      t.mock.timers.tick(1);
      await pending;
      assert.equal(signal?.aborted, true);
      release?.(response({ code: 'session_expired' }, 503));
      await flush();
      t.mock.timers.tick(60_000);
      await flush();
      assert.equal(calls, 1);
    });
  }
}

test('병렬 A/B 갱신은 SDK 토큰과 취소 신호를 공유하지 않는다', async () => {
  const signals: AbortSignal[] = [];
  const calls: string[] = [];
  const auth = provider(async (input, init) => {
    const url = String(input);
    assert.ok(init?.signal);
    signals.push(init.signal);
    calls.push(url);
    if (url.includes('/token?')) {
      const other = JSON.parse(String(init?.body)).refresh_token === 'other_synthetic';
      return response(session(other ? { access_token: jwt({ sub: OTHER_USER, session_id: OTHER_SESSION }),
        refresh_token: 'other_rotated', user: user({ id: OTHER_USER }) } : {}));
    }
    const other = new Headers(init?.headers).get('Authorization') === `Bearer ${jwt({ sub: OTHER_USER, session_id: OTHER_SESSION })}`;
    return response(user(other ? { id: OTHER_USER } : {}));
  });
  const result = await Promise.all([auth.refresh(tokens()), auth.refresh(tokens({ refreshToken: 'other_synthetic',
    userId: OTHER_USER, providerSessionId: OTHER_SESSION }))]);
  assert.deepEqual(result.map((value) => value.userId), [USER, OTHER_USER]);
  assert.equal(new Set(signals).size, 4);
  assert.equal(calls.length, 4);
});

for (const method of ['verifyCode', 'refresh'] as const) {
  for (const status of [429, 500]) {
    test(`${method} 뒤 getUser HTTP${status}는 인증 거부로 바꾸지 않는다`, async () => {
      let calls = 0;
      const auth = provider(async (input) => {
        calls++;
        return String(input).endsWith('/user')
          ? response({ code: 'session_not_found', message: SECRET }, status) : response(session());
      });
      await assert.rejects(method === 'verifyCode' ? auth.verifyCode(EMAIL, '123456') : auth.refresh(tokens()), failure('unavailable'));
      assert.equal(calls, 2);
    });
  }
  test(`${method} HTTP200 오류 본문은 성공 세션이 아니다`, async () => {
    let calls = 0;
    const auth = provider(async () => { calls++; return response({ code: 'otp_expired', message: SECRET }); });
    await assert.rejects(method === 'verifyCode' ? auth.verifyCode(EMAIL, '123456') : auth.refresh(tokens()), failure('unavailable'));
    assert.equal(calls, 1);
  });
}

test('구성 객체가 바뀌어도 승인 프로젝트와 키로 요청한다', async () => {
  let calls = 0;
  const config = { url: URL, publishableKey: KEY, fetcher: (async (input, init) => {
    calls++;
    assert.equal(String(input), `${URL}/auth/v1/otp`);
    assert.equal(new Headers(init?.headers).get('apikey'), KEY);
    return response({});
  }) as typeof fetch };
  const auth = createAuthProvider(config);
  config.url = 'https://another-project.invalid';
  config.publishableKey = 'sb_publishable_changed';
  await auth.requestCode(EMAIL);
  assert.equal(calls, 1);
});

for (const config of [{ url: 'https://another-project.invalid', publishableKey: KEY },
  { url: URL, publishableKey: 'sb_secret_synthetic' }]) {
  test('잘못된 프로젝트와 키는 요청 전에 고정 장애', () => {
    assert.throws(() => createAuthProvider({ ...config,
      fetcher: async () => { throw new Error('must not fetch'); } }), failure('unavailable'));
  });
}

test('OTP 끝의 줄바꿈도 검증 요청 전에 거부한다', async () => {
  let calls = 0;
  const auth = provider(async () => { calls++; return response(session()); });
  await assert.rejects(auth.verifyCode(EMAIL, '123456\n'), failure('validation'));
  assert.equal(calls, 0);
});

for (const method of ['verifyCode', 'refresh'] as const) {
  test(`${method}의 getUser는 첫 작업 뒤 별도 5초 기한을 갖는다`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    let userSignal: AbortSignal | null | undefined;
    const auth = provider(async (input, init) => {
      calls++;
      if (!String(input).endsWith('/user')) {
        await new Promise<void>((resolve) => setTimeout(resolve, 4_000));
        return response(session());
      }
      userSignal = init?.signal;
      return new Promise<Response>(() => {});
    });
    const pending = assert.rejects(method === 'verifyCode' ? auth.verifyCode(EMAIL, '123456')
      : auth.refresh(tokens()), failure('unavailable'));
    await flush();
    t.mock.timers.tick(4_000);
    await flush();
    assert.equal(calls, 2);
    t.mock.timers.tick(4_999);
    assert.equal(userSignal?.aborted, false);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(userSignal?.aborted, true);
  });
}

test('requestCode HTTP429라도 본문 정리 실패가 있으면 일반 장애를 우선한다', async () => {
  await assert.rejects(provider(async () => new Response(new ReadableStream({
    cancel() { throw new Error(SECRET); },
  }), { status: 429 })).requestCode(EMAIL), failure('unavailable'));
});

for (const method of ['verifyCode', 'refresh'] as const) {
  const malformedFields: Array<[string, Record<string, unknown>]> = [
    ['JWT 형식', { access_token: 'bad-format' }],
    ['JWT 크기 상한', { access_token: `${jwt()}${'x'.repeat(16_384)}` }],
    ['JWT CR', { access_token: `${jwt()}\r` }],
    ['JWT LF', { access_token: `${jwt()}\n` }],
    ['갱신 토큰 타입', { refresh_token: 123 }],
    ['갱신 토큰 공백', { refresh_token: 'synthetic token' }],
    ['갱신 토큰 크기 상한', { refresh_token: 'x'.repeat(16_385) }],
    ['갱신 토큰 CR', { refresh_token: `${REFRESH}\r` }],
    ['갱신 토큰 LF', { refresh_token: `${REFRESH}\n` }],
    ['만료 시각 타입', { expires_at: '1800000600' }],
    ['만료 시각 소수', { expires_at: 1_800_000_600.5 }],
    ['만료 시각 안전 정수', { expires_at: Number.MAX_SAFE_INTEGER + 1 }],
    ['원문 만료 시각 null', { expires_at: null }],
    ['원문 만료 시각 0', { expires_at: 0 }],
  ];
  for (const [label, patch] of malformedFields) {
    test(`Fix1 ${method} ${label} 오류는 getUser 없이 unavailable`, async () => {
      let calls = 0;
      let userCalls = 0;
      const auth = provider(async (input) => {
        calls++;
        if (String(input).endsWith('/user')) {
          userCalls++;
          return response(user());
        }
        return response(session(patch));
      });
      await assert.rejects(method === 'verifyCode' ? auth.verifyCode(EMAIL, '123456') : auth.refresh(tokens()), failure('unavailable'));
      assert.equal(userCalls, 0);
      assert.equal(calls, 1);
    });
  }
}

for (const method of ['verifyCode', 'refresh'] as const) {
  test(`Fix1 ${method} 원문 만료 시각 누락은 SDK의 정상 expires_in 보정을 허용한다`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    let calls = 0;
    const auth = provider(async (input) => {
      calls++;
      return String(input).endsWith('/user') ? response(user()) : response(session({ expires_at: undefined }));
    });
    const result = await (method === 'verifyCode' ? auth.verifyCode(EMAIL, '123456') : auth.refresh(tokens()));
    assert.deepEqual(result, tokens());
    assert.equal(calls, 2);
  });
}
