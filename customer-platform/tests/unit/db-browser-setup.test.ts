import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as browser from '../../scripts/db-browser-setup.js';
import { AutoDbSetupError } from '../../scripts/db-auto-setup.js';

type Handle = Awaited<ReturnType<typeof browser.startDbBrowserSetup>>;
function request(server: Handle, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = http.request(new URL(path, server.url), { method: options.method ?? 'GET', headers: options.headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', value => { text += value; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(options.body);
  });
}
async function fixture(t: { after(fn: () => Promise<void>): void }, runSetup: NonNullable<Parameters<typeof browser.startDbBrowserSetup>[0]['runSetup']>) {
  const server = await browser.startDbBrowserSetup({ path: '/synthetic/unused', runSetup });
  t.after(() => server.close());
  const page = await request(server, '/');
  const token = /<meta\s+name="csrf-token"\s+content="([a-f0-9]+)"/.exec(page.text)?.[1];
  assert.ok(token);
  const headers = { Origin: new URL(server.url).origin, Host: new URL(server.url).host,
    'Content-Type': 'application/json', 'X-TripMoney-Token': token };
  return { server, page, headers };
}
test('loopback 화면과 자산은 같은 origin만 사용하고 캐시·프레임·리퍼러를 차단한다', async t => {
  const f = await fixture(t, async () => {});
  assert.equal(new URL(f.server.url).hostname, '127.0.0.1');
  assert.equal(new URL(f.server.url).search, '');
  for (const path of ['/', '/app.js', '/style.css']) {
    const result = await request(f.server, path);
    assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.equal(result.headers['referrer-policy'], 'no-referrer');
    assert.match(String(result.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
});
for (const violation of ['host', 'origin', 'token', 'mime', 'path', 'method', 'body', 'shape', 'password', 'large']) {
  test('HTTP 경계는 거부된 요청에서 처리를 시작하지 않는다 ' + violation, async t => {
    let calls = 0;
    const f = await fixture(t, async () => { calls++; });
    const headers = { ...f.headers }; let path = '/api/setup', method = 'POST', body = '{"password":"SYNTHETIC-only"}';
    if (violation === 'host') headers.Host = 'localhost:1';
    if (violation === 'origin') headers.Origin = 'https://example.invalid';
    if (violation === 'token') headers['X-TripMoney-Token'] = 'bad';
    if (violation === 'mime') headers['Content-Type'] = 'text/plain';
    if (violation === 'path') path = '/api/setup?token=bad';
    if (violation === 'method') method = 'PUT';
    if (violation === 'body') body = '{bad';
    if (violation === 'shape') body = '{"password":"SYNTHETIC-only","extra":true}';
    if (violation === 'password') body = '{"password":""}';
    if (violation === 'large') body = 'x'.repeat(10000);
    const result = await request(f.server, path, { headers, method, body });
    assert.ok(result.status >= 400); assert.equal(calls, 0);
    assert.equal(result.text.includes('SYNTHETIC-only'), false);
    const success = await request(f.server, '/api/setup', { headers: f.headers, method: 'POST', body: '{"password":"SYNTHETIC-only"}' });
    assert.equal(success.status, 200); assert.equal(calls, 1);
  });
}
test('유효한 제출 한 번만 허용하고 결과는 비밀 없는 저장 상태로 응답한다', async t => {
  let finish!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture(t, async options => { assert.equal(options.password, 'SYNTHETIC-only'); began(); await pending; });
  const first = request(f.server, '/api/setup', { method: 'POST', headers: f.headers, body: '{"password":"SYNTHETIC-only"}' });
  await started;
  const second = await request(f.server, '/api/setup', { method: 'POST', headers: f.headers, body: '{"password":"SYNTHETIC-only"}' });
  assert.equal(second.status, 409); finish();
  assert.deepEqual(JSON.parse((await first).text), { status: 'saved', fileSaved: true });
});
for (const saved of [false, true]) {
  test('실패는 저장 여부와 고정 오류 코드만 응답한다 ' + saved, async t => {
    const f = await fixture(t, async () => { throw new AutoDbSetupError('commit', saved); });
    const result = await request(f.server, '/api/setup', { method: 'POST', headers: f.headers, body: '{"password":"SYNTHETIC-only"}' });
    assert.deepEqual(JSON.parse(result.text), { status: 'failed', code: `customer_db_auto_commit_failed${saved ? '_file_saved' : ''}`, fileSaved: saved });
  });
}
test('알 수 없는 오류 원문은 응답에 포함하지 않는다', async t => {
  const f = await fixture(t, async () => { throw new Error('SYNTHETIC-PRIVATE-ERROR'); });
  const result = await request(f.server, '/api/setup', { method: 'POST', headers: f.headers, body: '{"password":"SYNTHETIC-only"}' });
  assert.deepEqual(JSON.parse(result.text), { status: 'failed', code: 'customer_db_browser_setup_failed', fileSaved: false });
});
test('역할 사전검사 외 단계의 상세 suffix는 고정 fallback으로 제한한다', async t => {
  const error = new AutoDbSetupError('admin_auth', false);
  error.message = 'customer_db_auto_admin_auth_failed_role_guard';
  const f = await fixture(t, async () => { throw error; });
  const result = await request(f.server, '/api/setup', { method: 'POST', headers: f.headers, body: '{"password":"SYNTHETIC-only"}' });
  assert.equal(JSON.parse(result.text).code, 'customer_db_browser_setup_failed');
});
for (const running of [false, true]) {
  test('취소는 준비·실행 상태를 종료하고 AbortSignal을 전달한다 ' + running, async t => {
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    const f = await fixture(t, async options => {
      began(); await new Promise<void>((_, reject) => options.signal!.addEventListener('abort', () => reject(new AutoDbSetupError('local_save', true, undefined, true)), { once: true }));
    });
    const setup = running ? request(f.server, '/api/setup', { method: 'POST', headers: f.headers, body: '{"password":"SYNTHETIC-only"}' }) : undefined;
    if (running) await started;
    const cancelled = await request(f.server, '/api/cancel', { method: 'POST', headers: f.headers, body: '{}' });
    assert.equal(JSON.parse(cancelled.text).status, 'cancelled');
    assert.equal(JSON.parse(cancelled.text).fileSaved, running);
    if (setup) assert.equal(JSON.parse((await setup).text).status, 'cancelled');
  });
}
test('close는 실행을 취소하고 loopback listener를 닫는다', async t => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  const f = await fixture(t, async options => {
    began(); await new Promise<void>((_, reject) => options.signal!.addEventListener('abort', () => reject(new AutoDbSetupError('admin_connect', false, undefined, true)), { once: true }));
  });
  const setup = request(f.server, '/api/setup', { method: 'POST', headers: f.headers, body: '{"password":"SYNTHETIC-only"}' });
  await started; await f.server.close();
  assert.equal(JSON.parse((await setup).text).status, 'cancelled');
  await assert.rejects(request(f.server, '/'));
});
test('응답 없는 실행도 close 상한 뒤에는 listener를 남기지 않는다', async () => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  const server = await browser.startDbBrowserSetup({ path: '/synthetic/unused',
    testTimeouts: { closeTimeoutMs: 30 }, runSetup: async () => { began(); await new Promise(() => {}); } });
  const page = await request(server, '/');
  const token = /name="csrf-token"\s+content="([a-f0-9]+)"/.exec(page.text)![1]!;
  const setup = request(server, '/api/setup', { method: 'POST', headers: {
    Origin: new URL(server.url).origin, 'Content-Type': 'application/json', 'X-TripMoney-Token': token },
    body: '{"password":"SYNTHETIC-only"}' }).catch(() => undefined);
  await started; await server.close(); await setup;
  assert.deepEqual(await server.completed, { status: 'failed', code: 'customer_db_browser_cleanup_incomplete', fileSaved: null });
  // 종료되지 않는 listener가 있으면 테스트 자체에 남지 않도록 요청을 취소한다.
  await assert.rejects(request(server, '/'));
});
test('취소 요청도 비응답 실행의 종료 상한을 시작하고 저장 미확인 결과를 응답한다', { timeout: 300 }, async t => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  const server = await browser.startDbBrowserSetup({ path: '/synthetic/unused',
    testTimeouts: { closeTimeoutMs: 25 }, runSetup: async () => { began(); await new Promise(() => {}); } });
  t.after(() => server.close());
  const page = await request(server, '/');
  const token = /name="csrf-token"\s+content="([a-f0-9]+)"/.exec(page.text)![1]!;
  const headers = { Origin: new URL(server.url).origin, 'Content-Type': 'application/json', 'X-TripMoney-Token': token };
  const setup = request(server, '/api/setup', { method: 'POST', headers, body: '{"password":"SYNTHETIC-only"}' }).catch(() => undefined);
  await started;
  const cancel = await request(server, '/api/cancel', { method: 'POST', headers, body: '{}' });
  assert.deepEqual(JSON.parse(cancel.text), { status: 'failed', code: 'customer_db_browser_cleanup_incomplete', fileSaved: null });
  await setup; await server.completed; await assert.rejects(request(server, '/'));
});
test('본문 전송이 멈추면 상한에 요청을 거부하고 다음 유효한 제출을 허용한다', async t => {
  let calls = 0;
  const server = await browser.startDbBrowserSetup({ path: '/synthetic/unused',
    testTimeouts: { bodyTimeoutMs: 25 }, runSetup: async () => { calls++; } });
  t.after(() => server.close());
  const page = await request(server, '/');
  const token = /name="csrf-token"\s+content="([a-f0-9]+)"/.exec(page.text)![1]!;
  const headers = { Origin: new URL(server.url).origin, 'Content-Type': 'application/json', 'X-TripMoney-Token': token };
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(new URL('/api/setup', server.url), { method: 'POST', headers }, res => {
      res.resume(); res.on('end', () => { resolve(res.statusCode!); req.destroy(); });
    });
    req.on('error', reject); req.write('{"password":');
  });
  assert.equal(status, 400); assert.equal(calls, 0);
  const valid = await request(server, '/api/setup', { method: 'POST', headers, body: '{"password":"SYNTHETIC-only"}' });
  assert.equal(valid.status, 200); assert.equal(calls, 1);
});
test('유휴 상한은 제출 없이 취소 결과를 내고 listener를 닫는다', async () => {
  let calls = 0;
  const server = await browser.startDbBrowserSetup({ path: '/synthetic/unused', idleTimeoutMs: 25,
    runSetup: async () => { calls++; } });
  assert.deepEqual(await server.completed, { status: 'cancelled', fileSaved: false });
  await assert.rejects(request(server, '/')); assert.equal(calls, 0);
});
test('사용자 취소는 이미 발생한 최초 실패 상태를 덮어쓰지 않는다', async t => {
  let began!: () => void, finish!: () => void, observeCancel!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  const cancellation = new Promise<void>(resolve => { observeCancel = resolve; });
  const f = await fixture(t, async options => {
    options.signal!.addEventListener('abort', observeCancel, { once: true });
    began(); await cleanup; throw new AutoDbSetupError('commit', true);
  });
  const setup = request(f.server, '/api/setup', { method: 'POST', headers: f.headers, body: '{"password":"SYNTHETIC-only"}' });
  await started;
  const cancel = request(f.server, '/api/cancel', { method: 'POST', headers: f.headers, body: '{}' });
  await cancellation; finish();
  const original = JSON.parse((await setup).text);
  assert.equal(original.status, 'failed'); assert.equal(original.fileSaved, true);
  const cancelledResponse = await cancel;
  if (cancelledResponse.status === 200) assert.deepEqual(JSON.parse(cancelledResponse.text), original);
  else assert.equal(cancelledResponse.status, 409);
});
for (const args of [[], ['--unexpected']]) {
  test('브라우저 CLI는 승인 없이 실제 설정을 시작하지 않는다 ' + args.length, () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/setup-db-browser.ts', ...args], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), env: {}, encoding: 'utf8', timeout: 2000,
    });
    assert.equal(result.status, 78); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'customer_db_browser_setup_not_started\n');
  });
}
for (const [status, fileSaved, exitCode] of [
  ['saved', true, 0], ['failed', false, 78], ['failed', true, 1], ['failed', null, 1], ['cancelled', false, 130],
] as const) {
  test('브라우저 CLI 결과는 출력 flush와 ref handle 종료 상한을 지킨다 ' + status + '/' + fileSaved, () => {
    const source = `
      import { runDbBrowserSetupCli } from './scripts/setup-db-browser.ts';
      process.argv = ['synthetic-node', 'synthetic-entry'];
      setInterval(() => {}, 1000);
      const writes = [];
      for (const stream of [process.stdout, process.stderr]) {
        const write = stream.write.bind(stream);
        stream.write = (chunk, encoding, callback) => {
          const done = typeof encoding === 'function' ? encoding : callback;
          setTimeout(() => write(chunk, typeof encoding === 'string' ? encoding : undefined, done), 10);
          return true;
        };
      }
      await runDbBrowserSetupCli(async () => ({ url: 'http://127.0.0.1:12345/',
        close: async () => {}, completed: Promise.resolve(${JSON.stringify({ status, fileSaved })}) }));
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { CUSTOMER_DB_AUTO_SETUP_APPROVED: 'true' },
      encoding: 'utf8', timeout: 2000,
    });
    assert.equal(result.signal, null); assert.equal(result.status, exitCode);
    assert.equal(result.stdout, 'http://127.0.0.1:12345/\n');
    assert.equal(result.stderr, status === 'saved' ? '' : `customer_db_browser_${status === 'cancelled' ? 'cancelled' : 'setup_failed'}\n`);
  });
}
test('브라우저 CLI는 출력 callback이 멈춰도 1000ms 상한에 종료한다', () => {
  const source = `
    import { mock } from 'node:test';
    import { runDbBrowserSetupCli } from './scripts/setup-db-browser.ts';
    process.argv = ['synthetic-node', 'synthetic-entry'];
    mock.timers.enable({ apis: ['setTimeout'] });
    setInterval(() => {}, 1000);
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      stream.write = (chunk, encoding, callback) => {
        if (chunk === '') {
          setImmediate(() => { mock.timers.tick(999); process.stdout.write('synthetic_before_limit\\n'); mock.timers.tick(1); });
          return true;
        }
        return write(chunk, encoding, callback);
      };
    }
    await runDbBrowserSetupCli(async () => ({ url: 'http://127.0.0.1:12345/', close: async () => {},
      completed: Promise.resolve({ status: 'failed', fileSaved: true }) }));
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { CUSTOMER_DB_AUTO_SETUP_APPROVED: 'true' },
    encoding: 'utf8', timeout: 2000,
  });
  assert.equal(result.signal, null); assert.equal(result.status, 1);
  assert.equal(result.stdout, 'http://127.0.0.1:12345/\nsynthetic_before_limit\n');
});
test('브라우저 CLI는 서버가 확정한 안전한 실패 단계 코드만 출력한다', () => {
  const source = `
    import { runDbBrowserSetupCli } from './scripts/setup-db-browser.ts';
    process.argv = ['synthetic-node', 'synthetic-entry'];
    await runDbBrowserSetupCli(async () => ({ url: 'http://127.0.0.1:12345/', close: async () => {},
      completed: Promise.resolve({ status: 'failed', fileSaved: false, code: 'customer_db_auto_admin_auth_failed' }) }));
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { CUSTOMER_DB_AUTO_SETUP_APPROVED: 'true' },
    encoding: 'utf8', timeout: 2000,
  });
  assert.equal(result.status, 78); assert.equal(result.stderr, 'customer_db_auto_admin_auth_failed\n');
});
test('브라우저 CLI import는 서버와 설정 파일을 열지 않는다', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "await import('./scripts/setup-db-browser.ts'); process.stdout.write('synthetic_import_only\\n');"], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: {}, encoding: 'utf8', timeout: 2000,
  });
  assert.equal(result.status, 0); assert.equal(result.stderr, ''); assert.equal(result.stdout, 'synthetic_import_only\n');
});
