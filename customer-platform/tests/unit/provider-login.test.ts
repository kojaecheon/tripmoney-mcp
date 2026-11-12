import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreparedProviderProbe } from '../../scripts/provider-test/login.js';

const now = 1_800_000_000_000;
const url = 'https://agddopryfqsyfshoowgk.supabase.co';
const userId = '11111111-1111-4111-8111-111111111111';
const sessionP = '22222222-2222-4222-8222-222222222222';
const sessionQ = '33333333-3333-4333-8333-333333333333';
const input = { email: '  TESTER@EXAMPLE.COM ', password: '  DO_NOT_LEAK_password  ',
  publishableKey: 'sb_publishable_synthetic_only' };
function token(session: string, user = userId, seconds = 600) {
  return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({
    sub: user, session_id: session, iss: `${url}/auth/v1`, aud: 'authenticated', exp: now / 1000 + seconds,
  })).toString('base64url')}.c3ludGhldGlj`;
}
const json = (body: unknown, status = 200) => Response.json(body,
  { status, headers: { 'X-Supabase-Api-Version': '2024-01-01' } });
type FixtureOptions = { userQ?: string; sessionQ?: string; emailP?: string; emailQ?: string;
  confirmed?: boolean; anonymous?: boolean; secondsP?: number;
  hook?: (event: string, count: number, signal: AbortSignal) => Response | Promise<Response> | undefined };
function fixture(options: FixtureOptions = {}) {
  const tokens = { P: token(sessionP, userId, options.secondsP),
    Q: token(options.sessionQ ?? sessionQ, options.userQ ?? userId, 601) };
  const events: string[] = [];
  const signals: AbortSignal[] = [];
  const logoutVersions: (string | null)[] = [];
  let revoked = false;
  let loginCount = 0;
  const fetcher: typeof fetch = async (resource, init) => {
    const target = new URL(String(resource));
    assert.equal(target.origin, url);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('apikey'), input.publishableKey);
    assert.equal(init?.cache, 'no-store');
    assert.ok(init?.signal);
    signals.push(init.signal);
    const bearer = headers.get('authorization');
    let who = bearer === `Bearer ${tokens.P}` ? 'P' : bearer === `Bearer ${tokens.Q}` ? 'Q' : 'anon';
    let event: string;
    if (target.pathname === '/auth/v1/token') {
      assert.equal(target.search, '?grant_type=password');
      assert.equal(init.method, 'POST');
      const body = JSON.parse(String(init.body));
      assert.equal(body.email, 'tester@example.com');
      assert.equal(body.password, input.password);
      who = ++loginCount === 1 ? 'P' : 'Q';
      event = `login:${who}`;
    } else if (target.pathname === '/auth/v1/user') event = `user:${who}`;
    else if (target.pathname === '/auth/v1/logout') {
      assert.equal(target.search, '?scope=local');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.notEqual(who, 'anon');
      logoutVersions.push(headers.get('X-Supabase-Api-Version'));
      event = `logout:${who}`;
    } else {
      assert.ok(target.pathname.startsWith('/rest/v1/'));
      event = `data:${who}`;
    }
    events.push(event);
    const replacement = options.hook?.(event, events.filter(value => value === event).length, init.signal);
    if (replacement !== undefined) return replacement;
    if (event === 'logout:P') {
      if (revoked) return json(headers.get('X-Supabase-Api-Version') === '2024-01-01'
        ? { code: 'session_not_found' } : { code: 403, error_code: 'session_not_found' }, 403);
      revoked = true;
      return new Response(null, { status: 204 });
    }
    if (event === 'logout:Q') return new Response(null, { status: 204 });
    if (event.startsWith('data:')) return json({ code: 'PGRST106' }, 406);
    if (event === 'user:P' && revoked) return json({ code: 'session_not_found' }, 403);
    const user = { id: who === 'Q' ? options.userQ ?? userId : userId, aud: 'authenticated',
      email: who === 'Q' ? options.emailQ ?? 'tester@example.com' : options.emailP ?? 'tester@example.com',
      role: 'authenticated', is_anonymous: options.anonymous ?? false,
      email_confirmed_at: options.confirmed === false ? null : '2026-10-01T00:00:00Z',
      created_at: '2026-10-01T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {} };
    if (event.startsWith('login:')) return json({ access_token: tokens[who as 'P' | 'Q'],
      refresh_token: `synthetic-refresh-${who}`, token_type: 'bearer', expires_in: 600, user });
    return json(user);
  };
  return { events, signals, fetcher, logoutVersions };
}
const run = (f: ReturnType<typeof fixture>, signal?: AbortSignal) =>
  runPreparedProviderProbe({ ...input, signal }, { fetcher: f.fetcher, now: () => now });
const safe = (result: unknown) => assert.doesNotMatch(JSON.stringify(result),
  /DO_NOT_LEAK|tester@example|sb_publishable|synthetic-refresh|Bearer|eyJ|supabase\.co/);

test('실제 SDK 로그인 두 번과 기존 verifier/probe로 12건 검증 후 두 세션을 정리한다', async () => {
  const f = fixture();
  const result = await run(f);
  assert.deepEqual(result, { status: 'passed', report: { normalP: true, normalQ: true,
    dataApi: { anonymousRest: 3, authenticatedRest: 3, anonymousRpc: 3, authenticatedRpc: 3 },
    revokedP: true, tokenPStillUnexpired: true, otherQStillActive: true, cleanupP: true, cleanupQ: true },
    cleanupComplete: true, cleanupUncertain: false });
  assert.deepEqual(f.events, ['login:P', 'user:P', 'login:Q', 'user:Q', 'user:P', 'user:Q',
    ...Array(6).fill('data:anon'), ...Array(6).fill('data:Q'), 'logout:P', 'user:P', 'user:Q', 'logout:P', 'logout:Q']);
  assert.deepEqual(f.logoutVersions, ['2024-01-01', '2024-01-01', '2024-01-01']);
  safe(result);
});

for (const patch of [{ email: '' }, { email: 'bad email@example.com' }, { email: 'invalid' },
  { password: '' }, { publishableKey: 'sb_secret_DO_NOT_LEAK' }, { publishableKey: 'sb_publishable_' }]) {
  test(`입력 ${Object.keys(patch)[0]} 오류는 네트워크 전에 고정 코드로 거부한다`, async () => {
    const f = fixture();
    const result = await runPreparedProviderProbe({ ...input, ...patch }, { fetcher: f.fetcher });
    assert.equal(result.code, 'customer_provider_prepare_configuration');
    assert.deepEqual(f.events, []);
    safe(result);
  });
}

for (const phase of ['P', 'Q']) {
  test(`${phase} 로그인 거부는 재시도 없이 확인한 P만 정리한다`, async () => {
    const f = fixture({ hook: event => event === `login:${phase}`
      ? json({ code: 'invalid_credentials', message: 'DO_NOT_LEAK' }, 400) : undefined });
    const result = await run(f);
    assert.equal(result.code, `customer_provider_prepare_login_${phase.toLowerCase()}`);
    assert.equal(result.cleanupComplete, true);
    assert.equal(result.cleanupUncertain, false);
    assert.deepEqual(f.events, phase === 'P' ? ['login:P'] : ['login:P', 'user:P', 'login:Q', 'logout:P']);
    assert.deepEqual(f.logoutVersions, phase === 'P' ? [] : ['2024-01-01']);
    safe(result);
  });
}

test('로그인 응답 헤더 뒤 본문이 멈춰도 같은 5초 deadline으로 종료한다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let blocked: AbortSignal | undefined;
  const f = fixture({ hook: (event, _count, signal) => {
    if (event === 'login:P') {
      blocked = signal;
      return new Response(new ReadableStream(), { headers: { 'Content-Type': 'application/json' } });
    }
    return undefined;
  } });
  const pending = run(f);
  for (let i = 0; i < 500 && !blocked; i++) await Promise.resolve();
  assert.ok(blocked);
  t.mock.timers.tick(5000);
  const result = await pending;
  assert.equal(blocked.aborted, true);
  assert.equal(result.code, 'customer_provider_prepare_login_p');
  assert.equal(result.cleanupUncertain, true);
  assert.equal(result.cleanupComplete, false);
  assert.deepEqual(f.events, ['login:P']);
});

test('Q 로그인 중 취소는 즉시 전파하고 별도 cleanup signal로 P만 종료한다', async () => {
  const controller = new AbortController();
  let qSignal: AbortSignal | undefined;
  const f = fixture({ hook: (event, _count, signal) => {
    if (event === 'login:Q') { qSignal = signal; controller.abort(); return new Promise<Response>(() => {}); }
    if (event === 'logout:P') assert.equal(signal.aborted, false);
    return undefined;
  } });
  const result = await run(f, controller.signal);
  assert.equal(qSignal?.aborted, true);
  assert.equal(result.code, 'customer_provider_prepare_cancelled');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cleanupUncertain, true);
  assert.equal(result.cleanupComplete, false);
  assert.deepEqual(f.events, ['login:P', 'user:P', 'login:Q', 'logout:P']);
});

for (const [name, options] of [
  ['다른 사용자', { userQ: '44444444-4444-4444-8444-444444444444' }],
  ['같은 세션', { sessionQ: sessionP }], ['다른 email', { emailQ: 'other@example.com' }],
  ['미확인 이메일', { confirmed: false }], ['익명 사용자', { anonymous: true }],
  ['P 5분 미만', { secondsP: 299 }],
] as const) {
  test(`${name}는 probe 시작을 거부하고 안전하게 확인한 세션만 정리한다`, async () => {
    const f = fixture(options);
    const result = await run(f);
    assert.equal(result.status, 'failed');
    assert.equal(result.report, null);
    assert.equal(result.code, `customer_provider_prepare_${name === 'P 5분 미만' || name === '같은 세션'
      || name === '다른 사용자' ? 'session_pair' : name === '다른 email' ? 'login_q' : 'login_p'}`);
    assert.equal(result.cleanupUncertain, !['같은 세션', 'P 5분 미만'].includes(name));
    assert.equal(f.events.includes('logout:P'), ['다른 사용자', '같은 세션', '다른 email', 'P 5분 미만'].includes(name));
    assert.equal(f.events.some(event => event.startsWith('data:')), false);
    assert.equal(f.events.includes('logout:Q'), false);
    safe(result);
  });
}

test('선행 취소는 네트워크를 시작하지 않는다', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture();
  const result = await run(f, controller.signal);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cleanupComplete, true);
  assert.deepEqual(f.events, []);
});

test('P 확인 응답과 동시 취소는 Q 로그인 없이 발급 불확실을 유지한다', async () => {
  const controller = new AbortController();
  const f = fixture({ hook: event => { if (event === 'user:P') controller.abort(); return undefined; } });
  const result = await run(f, controller.signal);
  assert.equal(result.status, 'cancelled');
  assert.equal(f.events.includes('login:Q'), false);
  // 취소와 동시에 끝난 확인 응답은 신뢰하지 않으므로 알려지지 않은 발급으로 남긴다.
  assert.equal(result.cleanupUncertain, true);
});

test('확인한 P 뒤 취소는 Q 로그인 없이 별도 signal로 P를 정리한다', async () => {
  const controller = new AbortController();
  const f = fixture({ hook: (event, _count, signal) => {
    if (event === 'logout:P') assert.equal(signal.aborted, false);
    return undefined;
  } });
  let reads = 0;
  const result = await runPreparedProviderProbe({ ...input, signal: controller.signal }, {
    fetcher: f.fetcher, now: () => { if (++reads === 2) controller.abort(); return now; },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cleanupComplete, true);
  assert.equal(result.cleanupUncertain, false);
  assert.deepEqual(f.events, ['login:P', 'user:P', 'logout:P']);
});

test('P 잔여 정확히 5분도 기존 probe를 실행한다', async () => {
  const f = fixture({ secondsP: 300 });
  assert.equal((await run(f)).status, 'passed');
});

test('원문 transport 오류는 재시도나 SDK 로그 없이 발급 불확실 결과만 반환한다', async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args); });
  const f = fixture({ hook: () => { throw new Error(`DO_NOT_LEAK ${input.email} ${input.password}`); } });
  const result = await run(f);
  assert.equal(result.code, 'customer_provider_prepare_login_p');
  assert.equal(result.cleanupUncertain, true);
  assert.equal(result.cleanupComplete, false);
  assert.deepEqual(f.events, ['login:P']);
  assert.deepEqual(logs, []);
  safe(result);
});

test('Q 로그인 5xx는 발급 여부가 불확실하며 이미 확인한 P만 정리한다', async () => {
  const f = fixture({ hook: event => event === 'login:Q'
    ? json({ code: 'unexpected_failure', message: 'DO_NOT_LEAK' }, 503) : undefined });
  const result = await run(f);
  assert.equal(result.code, 'customer_provider_prepare_login_q');
  assert.equal(result.cleanupUncertain, true);
  assert.equal(result.cleanupComplete, false);
  assert.deepEqual(f.events, ['login:P', 'user:P', 'login:Q', 'logout:P']);
  safe(result);
});

test('cleanup의 명확한 거부는 불확실 발급과 구분하고 고정 cleanup 코드로 반환한다', async () => {
  const f = fixture({ hook: event => event === 'logout:Q'
    ? json({ code: 'bad_jwt', message: 'DO_NOT_LEAK' }, 401) : undefined });
  const result = await run(f);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'customer_provider_prepare_cleanup');
  assert.equal(result.cleanupUncertain, false);
  assert.equal(result.cleanupComplete, false);
  assert.equal(result.report?.cleanupQ, false);
  assert.equal(f.events.filter(event => event === 'logout:Q').length, 1);
  safe(result);
});

test('probe 재확인 실패도 준비 단계에서 확인한 두 세션을 정리하고 실제 cleanup 완료를 보고한다', async () => {
  const f = fixture({ hook: (event, count) => event === 'user:P' && count === 2
    ? json({ code: 'unexpected_failure', message: 'DO_NOT_LEAK' }, 503) : undefined });
  const result = await run(f);
  assert.equal(result.code, 'customer_provider_prepare_probe');
  assert.equal(result.cleanupComplete, true);
  assert.equal(result.cleanupUncertain, false);
  // 기존 probe 보고서는 수정하지 않는다. 준비 단계 소유 세션 정리는 바깥 상태에 반영한다.
  assert.equal(result.report?.cleanupP, false);
  assert.equal(result.report?.cleanupQ, false);
  assert.deepEqual(f.events.slice(-2), ['logout:P', 'logout:Q']);
});

test('probe 도중 취소도 두 세션 cleanup을 계속한다', async () => {
  const controller = new AbortController();
  const f = fixture({ hook: event => { if (event === 'data:anon') controller.abort(); return undefined; } });
  const result = await run(f, controller.signal);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cleanupComplete, true);
  assert.equal(result.cleanupUncertain, false);
  assert.equal(f.events.filter(event => event.startsWith('data:')).length, 1);
  assert.deepEqual(f.events.slice(-2), ['logout:P', 'logout:Q']);
});

test('Q 거부가 먼저 발생하면 cleanup 중 취소가 최초 실패를 덮지 않는다', async () => {
  const controller = new AbortController();
  const f = fixture({ hook: event => {
    if (event === 'login:Q') return json({ code: 'invalid_credentials', message: 'DO_NOT_LEAK' }, 400);
    if (event === 'logout:P') controller.abort();
    return undefined;
  } });
  const result = await run(f, controller.signal);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'customer_provider_prepare_login_q');
  assert.equal(result.cleanupComplete, true);
});

for (const phase of ['P', 'Q']) {
  test(`${phase} 로그인 timeout은 5초에 취소하고 발급 불확실을 유지한다`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let blocked: AbortSignal | undefined;
    const f = fixture({ hook: (event, _count, signal) => {
      if (event === `login:${phase}`) { blocked = signal; return new Promise<Response>(() => {}); }
      return undefined;
    } });
    const pending = run(f);
    for (let i = 0; i < 500 && !blocked; i++) await Promise.resolve();
    assert.ok(blocked);
    t.mock.timers.tick(5000);
    const result = await pending;
    assert.equal(blocked.aborted, true);
    assert.equal(result.code, `customer_provider_prepare_login_${phase.toLowerCase()}`);
    assert.equal(result.cleanupUncertain, true);
    assert.equal(result.cleanupComplete, false);
    assert.equal(f.events.filter(event => event === `login:${phase}`).length, 1);
    if (phase === 'Q') assert.equal(f.events.at(-1), 'logout:P');
  });
}

test('부분 cleanup timeout은 5초 뒤에도 Q 정리를 진행하고 최초 probe 오류를 유지한다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let blocked = false;
  const f = fixture({ hook: event => {
    if (event.startsWith('data:')) return json({ code: 'DO_NOT_LEAK' }, 500);
    if (event === 'logout:P') { blocked = true; return new Promise<Response>(() => {}); }
    return undefined;
  } });
  const pending = run(f);
  for (let i = 0; i < 1000 && !blocked; i++) await Promise.resolve();
  assert.equal(blocked, true);
  t.mock.timers.tick(5000);
  const result = await pending;
  assert.equal(result.code, 'customer_provider_prepare_probe');
  assert.equal(result.cleanupComplete, false);
  assert.equal(result.cleanupUncertain, true);
  assert.equal(result.report?.cleanupQ, true);
  assert.equal(f.events.filter(event => event === 'logout:P').length, 1);
  safe(result);
});
