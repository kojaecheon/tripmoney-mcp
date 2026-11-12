import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProviderProbeConfig } from '../../scripts/provider-test/config.js';
import { runProviderProbe, ProviderProbeFailure } from '../../scripts/provider-test/probe.js';

const approved = () => ({
  CUSTOMER_PROVIDER_TEST_APPROVED: 'true',
  CUSTOMER_PROVIDER_TEST_ALLOW_LOCAL_SIGNOUT: 'true',
  CUSTOMER_PROVIDER_TEST_PROJECT_REF: 'agddopryfqsyfshoowgk',
  CUSTOMER_SUPABASE_URL: 'https://agddopryfqsyfshoowgk.supabase.co',
  CUSTOMER_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_only',
  CUSTOMER_PROVIDER_TEST_ACCESS_TOKEN_P: 'synthetic-token-p',
  CUSTOMER_PROVIDER_TEST_ACCESS_TOKEN_Q: 'synthetic-token-q',
});

test('승인된 신규 프로젝트와 서로 다른 시험 토큰만 읽는다', () => {
  assert.deepEqual(readProviderProbeConfig(approved()), {
    url: 'https://agddopryfqsyfshoowgk.supabase.co',
    publishableKey: 'sb_publishable_synthetic_only', tokenP: 'synthetic-token-p', tokenQ: 'synthetic-token-q',
  });
});

for (const key of Object.keys(approved())) {
  test(`시험 설정 ${key} 누락은 네트워크 준비 전에 거부한다`, () => {
    const env: NodeJS.ProcessEnv = approved();
    delete env[key];
    assert.throws(() => readProviderProbeConfig(env), /^Error: customer_provider_configuration$/);
  });
}

for (const patch of [
  { CUSTOMER_PROVIDER_TEST_APPROVED: 'TRUE' },
  { CUSTOMER_PROVIDER_TEST_ALLOW_LOCAL_SIGNOUT: '1' },
  { CUSTOMER_PROVIDER_TEST_PROJECT_REF: 'another-project' },
  { CUSTOMER_SUPABASE_URL: 'https://another-project.supabase.co' },
  { CUSTOMER_SUPABASE_URL: 'https://user:DO_NOT_LEAK@agddopryfqsyfshoowgk.supabase.co' },
  { CUSTOMER_SUPABASE_URL: 'https://agddopryfqsyfshoowgk.supabase.co/' },
  { CUSTOMER_SUPABASE_URL: 'https://agddopryfqsyfshoowgk.supabase.co?secret=DO_NOT_LEAK' },
  { CUSTOMER_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_DO_NOT_LEAK' },
  { CUSTOMER_SUPABASE_PUBLISHABLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.service_role.DO_NOT_LEAK' },
  { CUSTOMER_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' },
  { CUSTOMER_PROVIDER_TEST_ACCESS_TOKEN_P: ' ' },
  { CUSTOMER_PROVIDER_TEST_ACCESS_TOKEN_Q: 'synthetic-token-p' },
  { CUSTOMER_PROVIDER_TEST_ACCESS_TOKEN_Q: 'token\r\nDO_NOT_LEAK' },
]) {
  test(`미승인·비밀키·잘못된 시험값 거부: ${Object.keys(patch)[0]}`, () => {
    assert.throws(() => readProviderProbeConfig({ ...approved(), ...patch }),
      /^Error: customer_provider_configuration$/);
  });
}

test('실제 CLI는 승인·토큰 부재 시 네트워크 import·fetch 없이 exit78이다', () => {
  const code = `
    import { registerHooks } from 'node:module';
    let requests = 0;
    globalThis.fetch = () => { requests++; throw new Error('NETWORK_ATTEMPT'); };
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.includes('provider-test/probe') || specifier.includes('supabase-js')) {
        throw new Error('NETWORK_MODULE_IMPORTED');
      }
      return next(specifier, context);
    }});
    process.on('exit', () => console.log('requests=' + requests));
    await import('./scripts/test-provider-session.ts');
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: {}, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 78);
  assert.equal(result.stdout.trim(), 'requests=0');
  assert.equal(result.stderr.trim(), 'customer_provider_configuration');
});

const now = 1_800_000_000_000;
const userId = '11111111-1111-4111-8111-111111111111';
const sessionP = '22222222-2222-4222-8222-222222222222';
const sessionQ = '33333333-3333-4333-8333-333333333333';
function token(session: string, user = userId, seconds = 600) {
  return `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({
    sub: user, session_id: session, iss: 'https://agddopryfqsyfshoowgk.supabase.co/auth/v1',
    aud: 'authenticated', exp: now / 1000 + seconds, is_anonymous: false,
  })).toString('base64url')}.c3ludGhldGlj`;
}
function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'X-Supabase-Api-Version': '2024-01-01' } });
}
function fixture(options: { userQ?: string; sessionQ?: string; secondsP?: number;
  hook?: (event: string, count: number) => Response | Promise<Response> | undefined } = {}) {
  const config = { ...readProviderProbeConfig(approved()), tokenP: token(sessionP, userId, options.secondsP),
    tokenQ: token(options.sessionQ ?? sessionQ, options.userQ ?? userId) };
  const events: string[] = [];
  const logoutVersions: (string | null)[] = [];
  let revoked = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const bearer = headers.get('Authorization');
    const who = bearer === `Bearer ${config.tokenP}` ? 'P' : bearer === `Bearer ${config.tokenQ}` ? 'Q' : 'anon';
    assert.equal(url.origin, config.url);
    assert.equal(headers.get('apikey'), config.publishableKey);
    assert.ok(init?.signal);
    let event: string;
    if (url.pathname === '/auth/v1/user') event = `user:${who}`;
    else if (url.pathname === '/auth/v1/logout') {
      assert.equal(url.search, '?scope=local');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.body, undefined);
      assert.notEqual(who, 'anon');
      logoutVersions.push(headers.get('X-Supabase-Api-Version'));
      event = `logout:${who}`;
    } else {
      assert.ok(url.pathname.startsWith('/rest/v1/'));
      event = `data:${who}`;
    }
    events.push(event);
    const replacement = options.hook?.(event, events.filter((value) => value === event).length);
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
    return json({ id: who === 'Q' ? options.userQ ?? userId : userId, aud: 'authenticated',
      email: 'tester@example.com', role: 'authenticated', is_anonymous: false,
      email_confirmed_at: '2026-10-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z',
      app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {} });
  };
  return { config, events, fetcher, logoutVersions };
}

const failure = (phase: string, inspect?: (error: ProviderProbeFailure) => void) => (error: unknown) => {
  assert.ok(error instanceof ProviderProbeFailure);
  assert.equal(error.phase, phase);
  assert.doesNotMatch(JSON.stringify(error), /DO_NOT_LEAK|Bearer|eyJ/);
  inspect?.(error);
  return true;
};

test('정상 P/Q·12건 비노출·P local 폐기·미만료 P 거부·Q 유지 후 시험 세션만 정리한다', async () => {
  const f = fixture();
  const report = await runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now });
  assert.deepEqual(report, { normalP: true, normalQ: true,
    dataApi: { anonymousRest: 3, authenticatedRest: 3, anonymousRpc: 3, authenticatedRpc: 3 },
    revokedP: true, tokenPStillUnexpired: true, otherQStillActive: true, cleanupP: true, cleanupQ: true });
  assert.deepEqual(f.events, ['user:P', 'user:Q', ...Array(6).fill('data:anon'), ...Array(6).fill('data:Q'),
    'logout:P', 'user:P', 'user:Q', 'logout:P', 'logout:Q']);
  assert.deepEqual(f.logoutVersions, ['2024-01-01', '2024-01-01', '2024-01-01']);
});

test('P 정상 검증 실패 시 어떤 세션도 종료하지 않는다', async () => {
  const f = fixture({ hook: () => json({ code: 'bad_jwt', message: 'DO_NOT_LEAK' }, 403) });
  await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now }), failure('normal_p'));
  assert.deepEqual(f.events, ['user:P']);
});

test('Q 검증 실패 시 이미 검증한 P만 정리한다', async () => {
  const f = fixture({ hook: (event) => event === 'user:Q' ? json({ code: 'bad_jwt' }, 403) : undefined });
  await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now }), failure('normal_q', (e) => {
    assert.equal(e.report.cleanupP, true);
    assert.equal(e.report.cleanupQ, false);
  }));
  assert.deepEqual(f.events, ['user:P', 'user:Q', 'logout:P']);
});

for (const [name, options] of [
  ['다른 사용자', { userQ: '44444444-4444-4444-8444-444444444444' }],
  ['같은 세션', { sessionQ: sessionP }],
] as const) {
  test(`${name} Q로 독립 세션 인수를 통과시키지 않는다`, async () => {
    const f = fixture(options);
    // 같은 세션이어도 별도 문자열인 토큰을 사용해 config 중복 검사를 우회한 상황을 재현한다.
    if ('sessionQ' in options && options.sessionQ === sessionP) f.config.tokenQ = token(sessionP, userId, 601);
    await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now }), failure('session_pair'));
    assert.equal(f.events.some((event) => event.startsWith('data:')), false);
    assert.equal(f.events.includes('logout:Q'), false);
  });
}

test('P 잔여 5분 미만은 provider 폐기 인수를 실행하지 않는다', async () => {
  const f = fixture({ secondsP: 299 });
  await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now }), failure('session_pair'));
  assert.equal(f.events.some((event) => event.startsWith('data:')), false);
});

test('P 잔여 정확히 5분은 시험 시작 조건을 충족한다', async () => {
  const f = fixture({ secondsP: 300 });
  assert.equal((await runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now })).revokedP, true);
});

test('Data API 실패를 cleanup 장애로 덮어쓰지 않고 Q 정리를 계속한다', async () => {
  const f = fixture({ hook: (event) => event.startsWith('data:') ? json({ code: 'bad_jwt' }, 401)
    : event === 'logout:P' ? json({ code: 'session_not_found', message: 'DO_NOT_LEAK' }, 503) : undefined });
  await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now }), failure('data_api', (e) => {
    assert.equal(e.report.cleanupP, false);
    assert.equal(e.report.cleanupQ, true);
  }));
  assert.deepEqual(f.events, ['user:P', 'user:Q', 'data:anon', 'logout:P', 'logout:Q']);
});

test('Data API 중간 실패도 이미 통과한 프로필별 건수를 보존한다', async () => {
  const f = fixture({ hook: (event, count) => event === 'data:Q' && count === 4
    ? json({ code: 'PGRST202' }, 404) : undefined });
  await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now }), failure('data_api', (e) => {
    assert.deepEqual(e.report.dataApi, { anonymousRest: 3, authenticatedRest: 3, anonymousRpc: 3, authenticatedRpc: 0 });
  }));
});

test('최초 P 종료의 이미 없는 세션 응답은 2xx 성공으로 치지 않는다', async () => {
  const f = fixture({ hook: (event) => event === 'logout:P' ? json({ code: 'session_not_found' }, 403) : undefined });
  await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now }), failure('revoke_p', (e) => {
    assert.equal(e.report.revokedP, false);
    assert.equal(e.report.cleanupP, true);
  }));
});

for (const reason of ['bad_jwt', 'session_expired', 'user_not_found', 'user_banned', 'unknown']) {
  test(`폐기 후 ${reason} 응답은 session_not_found 증거가 아니다`, async () => {
    const f = fixture({ hook: (event, count) => event === 'user:P' && count === 2
      ? json({ code: reason, message: 'DO_NOT_LEAK' }, 403) : undefined });
    await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now }), failure('revoked_p'));
  });
}

test('P 폐기 후에도 정상 getUser가 성공하면 인수 실패다', async () => {
  const f = fixture({ hook: (event, count) => event === 'logout:P' && count === 1
    ? new Response(null, { status: 204 }) : undefined });
  await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now }), failure('revoked_p'));
});

test('P 폐기 후 토큰이 만료됐으면 거부 응답으로 통과시키지 않는다', async () => {
  let clock = now;
  const f = fixture({ hook: (event) => { if (event === 'logout:P') clock = now + 601_000; return undefined; } });
  await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => clock }), failure('revoked_p', (e) => {
    assert.equal(e.report.tokenPStillUnexpired, false);
  }));
});

test('Q 정상 유지 검증이 실패하면 전체 성공을 반환하지 않는다', async () => {
  const f = fixture({ hook: (event, count) => event === 'user:Q' && count === 2
    ? json({ code: 'session_not_found' }, 403) : undefined });
  await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now }), failure('q_active'));
});

test('본 시험이 통과해도 모호한 cleanup 실패는 부분 report와 실패를 반환한다', async () => {
  const f = fixture({ hook: (event) => event === 'logout:Q'
    ? json({ message: 'DO_NOT_LEAK', code: 'bad_jwt' }, 401) : undefined });
  await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now }), failure('cleanup', (e) => {
    assert.equal(e.report.revokedP, true);
    assert.equal(e.report.otherQStillActive, true);
    assert.equal(e.report.cleanupQ, false);
  }));
});

test('서로 충돌하는 cleanup 오류 코드는 이미 없는 세션으로 인정하지 않는다', async () => {
  const f = fixture({ hook: (event, count) => event === 'logout:P' && count === 2
    ? json({ code: 'bad_jwt', error_code: 'session_not_found' }, 403) : undefined });
  await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now }), failure('cleanup', (e) => {
    assert.equal(e.report.cleanupP, false);
    assert.equal(e.report.cleanupQ, true);
  }));
});

test('Data API 검사 도중 Q가 만료되면 P 폐기 시험을 진행하지 않는다', async () => {
  let clock = now;
  const f = fixture({ hook: (event, count) => {
    if (event === 'data:Q' && count === 6) clock += 601_000;
    return undefined;
  } });
  await assert.rejects(runProviderProbe(f.config, { fetcher: f.fetcher, now: () => clock }), failure('data_api'));
  assert.equal(f.events.filter((event) => event === 'user:P').length, 1);
});

test('P 종료 요청이 지연되면 5초에 취소하고 cleanup 오류보다 최초 실패를 유지한다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let blocked = false;
  const f = fixture({ hook: (event, count) => {
    if (event === 'logout:P' && count === 1) {
      blocked = true;
      return new Promise<Response>(() => {});
    }
    return undefined;
  } });
  const pending = runProviderProbe(f.config, { fetcher: f.fetcher, now: () => now });
  const rejected = assert.rejects(pending, failure('revoke_p'));
  for (let i = 0; i < 300 && !blocked; i++) await Promise.resolve();
  assert.equal(blocked, true);
  t.mock.timers.tick(5000);
  await rejected;
});

function cliWithSyntheticInput(t: { after(fn: () => void): void }, fileMode: number,
  outcome: 'success' | 'data' | 'cleanup' = 'success', filePatch: Record<string, string> = {}, parentApproved = true) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'tripmoney-provider-cli-'));
  const path = join(directory, 'synthetic.env');
  const values = { ...approved(), CUSTOMER_PROVIDER_TEST_ACCESS_TOKEN_P: token(sessionP),
    CUSTOMER_PROVIDER_TEST_ACCESS_TOKEN_Q: token(sessionQ), ...filePatch };
  fs.writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 });
  fs.chmodSync(path, fileMode & 0o7777);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const gateShouldFail = fileMode !== 0o100600 || Object.keys(filePatch).length > 0 || !parentApproved;
  // 고정 파일 경로만 합성 임시 파일로 연결하고 외부 fetch는 mock으로 대체한다.
  const code = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports, registerHooks } from 'node:module';
    const originalStat = fs.lstatSync;
    const originalOpen = fs.openSync;
    let secretOpens = 0;
    const mapped = (path) => {
      if (String(path).endsWith('/.env.provider-test')) { secretOpens++; return process.env.SYNTHETIC_SECRET_FILE; }
      return path;
    };
    fs.lstatSync = (path, ...args) => originalStat(mapped(path), ...args);
    fs.openSync = (path, ...args) => originalOpen(mapped(path), ...args);
    syncBuiltinESMExports();
    Date.now = () => ${now};
    let revoked = false;
    let requests = 0;
    const response = (body, status = 200) => Response.json(body, { status,
      headers: { 'X-Supabase-Api-Version': '2024-01-01' } });
    registerHooks({ resolve(specifier, context, next) {
      if (${gateShouldFail} && specifier.includes('provider-test/probe')) throw new Error('NETWORK_MODULE_IMPORTED');
      return next(specifier, context);
    }});
    globalThis.fetch = async (input, init) => {
      requests++;
      const url = new URL(String(input));
      const isP = new Headers(init.headers).get('Authorization') === 'Bearer ' + ${JSON.stringify(token(sessionP))};
      if (url.pathname.startsWith('/rest/')) return response({code: '${outcome === 'data' ? 'PGRST202' : 'PGRST106'}', message: 'DO_NOT_LEAK'}, ${outcome === 'data' ? 404 : 406});
      if (url.pathname.endsWith('/logout')) {
        if (!isP && '${outcome}' === 'cleanup') return response({code: 'bad_jwt', message: 'DO_NOT_LEAK'}, 401);
        if (isP && revoked) return response({code: 'session_not_found', message: 'DO_NOT_LEAK'}, 403);
        if (isP) revoked = true;
        return new Response(null, {status: 204});
      }
      if (isP && revoked) return response({code: 'session_not_found', message: 'DO_NOT_LEAK'}, 403);
      return response({ id: '${userId}', aud: 'authenticated', role: 'authenticated', email: 'tester@example.com',
        is_anonymous: false, email_confirmed_at: '2026-10-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z',
        app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {} });
    };
    process.on('exit', () => {
      if ((${gateShouldFail} && requests !== 0) || globalThis.secretFileExecuted
        || (process.env.CUSTOMER_PROVIDER_TEST_APPROVED !== 'true' && secretOpens > 0)) process.exitCode = 99;
    });
    await import('./scripts/test-provider-session.ts');
  `;
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { CUSTOMER_PROVIDER_TEST_APPROVED: parentApproved ? 'true' : 'false',
      SYNTHETIC_SECRET_FILE: path, CUSTOMER_PROVIDER_TEST_ACCESS_TOKEN_P: 'DO_NOT_LEAK_PARENT_P' },
    encoding: 'utf8', timeout: 10000,
  });
}

test('CLI의 승인된 환경도 비밀 파일 모드가 0644이면 import·요청 전에 exit78이다', (t) => {
  const result = cliWithSyntheticInput(t, 0o100644);
  assert.equal(result.status, 78);
  assert.equal(result.stderr.trim(), 'customer_provider_configuration');
  assert.equal(result.stdout, '');
});

test('CLI의 실제 실행 경로는 mock 인수 성공에만 boolean·건수 report와 exit0을 출력한다', (t) => {
  const result = cliWithSyntheticInput(t, 0o100600);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.normalP, true);
  assert.equal(report.revokedP, true);
  assert.equal(report.cleanupQ, true);
  assert.deepEqual(report.dataApi, { anonymousRest: 3, authenticatedRest: 3, anonymousRpc: 3, authenticatedRpc: 3 });
  assert.doesNotMatch(result.stdout, /DO_NOT_LEAK|Bearer|eyJ|tester@example|sb_publishable/);
});

for (const phase of ['data', 'cleanup'] as const) {
  test(`CLI의 ${phase} 실패는 부분 report·고정 코드·exit1이며 원문 비밀을 출력하지 않는다`, (t) => {
    const result = cliWithSyntheticInput(t, 0o100600, phase);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), `customer_provider_probe_${phase === 'data' ? 'data_api' : phase}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.cleanupQ, phase !== 'cleanup');
    assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_LEAK|Bearer|eyJ|tester@example|sb_publishable/);
  });
}

const rejectedFileValues: Record<string, string>[] = [
  { NODE_OPTIONS: '--import=data:text/javascript,globalThis.secretFileExecuted=true' },
  { CUSTOMER_PROVIDER_TEST_APPROVED: 'false' }, { CUSTOMER_OTHER: 'DO_NOT_LEAK' },
];
for (const patch of rejectedFileValues) {
  test(`provider 파일의 미허용 키·승인 값 ${Object.keys(patch)[0]}는 exit78이며 코드가 실행되지 않는다`, (t) => {
    const result = cliWithSyntheticInput(t, 0o100600, 'success', patch);
    assert.equal(result.status, 78);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'customer_provider_configuration');
  });
}

test('provider 상위 승인 부재는 유효한 합성 파일도 열지 않고 exit78이다', (t) => {
  const result = cliWithSyntheticInput(t, 0o100600, 'success', {}, false);
  assert.equal(result.status, 78);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'customer_provider_configuration');
});
