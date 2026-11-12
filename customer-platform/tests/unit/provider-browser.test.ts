import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startProviderBrowser } from '../../scripts/provider-test/provider-browser.js';
import type { PreparedProviderResult } from '../../scripts/provider-test/login.js';

// 합성 보고서: 실제 provider나 사용자 데이터에 접근하지 않는다.
const passed = (): PreparedProviderResult => ({ status: 'passed', cleanupComplete: true, cleanupUncertain: false,
  report: { normalP: true, normalQ: true, revokedP: true, tokenPStillUnexpired: true,
    otherQStillActive: true, cleanupP: true, cleanupQ: true,
    dataApi: { anonymousRest: 3, authenticatedRest: 3, anonymousRpc: 3, authenticatedRpc: 3 } } });
async function fixture(run: Parameters<typeof startProviderBrowser>[0]['run'] = async () => passed(),
  extra: Partial<Parameters<typeof startProviderBrowser>[0]> = {}) {
  const server = await startProviderBrowser({ email: 'synthetic@example.invalid', run, ...extra });
  const html = await (await fetch(server.url)).text();
  const token = html.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  assert.ok(token);
  const headers = { Origin: new URL(server.url).origin, 'X-TripMoney-Token': token, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown = {}, change: Record<string, string> = {}) =>
    fetch(new URL(path, server.url), { method: 'POST', headers: { ...headers, ...change }, body: JSON.stringify(body) });
  return { ...server, html, token, headers, post };
}

test('loopback만 listen하고 HTML을 escape하며 token을 URL에 노출하지 않는다', async () => {
  const s = await startProviderBrowser({ email: '\"><img src=x>@example.invalid', run: async () => passed() });
  try {
    assert.equal(new URL(s.url).hostname, '127.0.0.1');
    assert.equal(new URL(s.url).search, '');
    const response = await fetch(s.url); const html = await response.text();
    assert.match(html, /&quot;&gt;&lt;img src=x&gt;@example.invalid/);
    assert.doesNotMatch(html, /<img/);
    for (const [name, value] of [['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'],
      ['referrer-policy', 'no-referrer'], ['x-frame-options', 'DENY']]) assert.equal(response.headers.get(name!), value);
    assert.match(response.headers.get('content-security-policy')!, /default-src 'self'/);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(new URL('/app.js', s.url))).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(new URL('/style.css', s.url))).status, 200);
  } finally { await s.close(); }
});

test('Host Origin token MIME 경로 key와 빈 password를 거부하고 runner를 호출하지 않는다', async () => {
  let calls = 0; const s = await fixture(async () => { calls++; return passed(); });
  try {
    // Node fetch는 Host를 정규화하므로 Host 검사는 실제 HTTP 클라이언트를 사용한다.
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const req = http.request(new URL('/api/run', s.url), { method: 'POST', headers: { ...s.headers, Host: 'localhost:99' } },
        res => { resolve(res.statusCode!); res.resume(); });
      req.on('error', reject); req.end(JSON.stringify({ password: 'synthetic' }));
    });
    assert.equal(wrongHost, 403);
    const rejected = [
      await s.post('/api/run', { password: 'synthetic' }, { Origin: 'http://evil.invalid' }),
      await s.post('/api/run', { password: 'synthetic' }, { 'X-TripMoney-Token': 'bad' }),
      await s.post('/api/run', { password: 'synthetic' }, { 'Content-Type': 'text/plain' }),
      await s.post('/api/run', { password: 'synthetic', email: 'other@example.invalid' }),
      await s.post('/api/run', { password: '' }), await s.post('/api/run', []),
      await s.post('/api/cancel', { password: 'synthetic' }), await s.post('/other', {}),
      await fetch(new URL('/?extra=1', s.url)),
    ];
    for (const response of rejected) { assert.ok(response.status >= 400); await response.text(); }
    assert.equal(calls, 0);
  } finally { await s.close(); }
});

test('8192바이트 초과와 중복 헤더는 실제 HTTP에서 runner0이다', async () => {
  let calls = 0; const s = await fixture(async () => { calls++; return passed(); });
  try {
    assert.equal((await s.post('/api/run', { password: 'x'.repeat(8192) })).status, 413);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(new URL('/api/run', s.url), { method: 'POST', headers: [
        'Host', new URL(s.url).host, 'Origin', s.headers.Origin, 'Origin', s.headers.Origin,
        'X-TripMoney-Token', s.token, 'Content-Type', 'application/json',
      ] }, (res) => { resolve(res.statusCode!); res.resume(); });
      req.on('error', reject); req.end(JSON.stringify({ password: 'synthetic' }));
    });
    assert.equal(status, 400); assert.equal(calls, 0);
  } finally { await s.close(); }
});

test('유효 제출은 한 번이며 승인 email은 클라이언트에서 받지 않는다', async () => {
  let calls = 0; let finish!: (r: PreparedProviderResult) => void;
  const s = await fixture(async (password) => { calls++; assert.equal(password, ' synthetic '); return new Promise(r => { finish = r; }); });
  try {
    const first = s.post('/api/run', { password: ' synthetic ' });
    while (!finish) await new Promise(r => setTimeout(r, 1));
    assert.equal((await s.post('/api/run', { password: 'second' })).status, 409);
    finish(passed()); assert.deepEqual(await (await first).json(), passed());
    assert.deepEqual(await s.completed, passed()); assert.equal(calls, 1);
  } finally { await s.close(); }
});

test('취소 signal은 즉시 전파하고 실제 cleanup 결과와 최초 실패를 보존한다', async () => {
  let signal!: AbortSignal; let finish!: (r: PreparedProviderResult) => void;
  const s = await fixture(async (_password, current) => { signal = current; return new Promise(r => { finish = r; }); });
  const first = s.post('/api/run', { password: 'synthetic' });
  while (!finish) await new Promise(r => setTimeout(r, 1));
  const cancel = s.post('/api/cancel');
  while (!signal.aborted) await new Promise(r => setTimeout(r, 1));
  let settled = false; void s.completed.then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(settled, false);
  const failure: PreparedProviderResult = { status: 'failed', code: 'customer_provider_prepare_login_q', report: null,
    cleanupComplete: true, cleanupUncertain: false };
  finish(failure);
  assert.deepEqual(await (await cancel).json(), failure); assert.deepEqual(await (await first).json(), failure);
  assert.deepEqual(await s.completed, failure); await s.close();
});

test('취소 전 제출이 없으면 정리할 세션이 없고 idle도 닫힌다', async () => {
  const s = await fixture();
  assert.deepEqual(await (await s.post('/api/cancel')).json(), { status: 'cancelled',
    code: 'customer_provider_prepare_cancelled', report: null, cleanupComplete: true, cleanupUncertain: false });
  await s.close();
  const idle = await startProviderBrowser({ email: 'synthetic@example.invalid', run: async () => passed(), idleTimeoutMs: 15 });
  assert.equal((await idle.completed).status, 'cancelled'); await idle.close();
  await assert.rejects(fetch(idle.url));
});

test('비응답 runner close는 bounded fallback이고 늦은 성공은 무시한다', async () => {
  let finish!: (r: PreparedProviderResult) => void;
  const s = await fixture(async () => new Promise(r => { finish = r; }), { testTimeouts: { closeTimeoutMs: 25 } });
  const response = s.post('/api/run', { password: 'synthetic' }).catch(() => null);
  while (!finish) await new Promise(r => setTimeout(r, 1));
  const started = Date.now(); await s.close(); assert.ok(Date.now() - started < 1000);
  const fallback = { status: 'failed', code: 'customer_provider_prepare_cleanup_unknown', report: null,
    cleanupComplete: false, cleanupUncertain: true };
  assert.deepEqual(await s.completed, fallback); finish(passed());
  await new Promise(r => setTimeout(r, 5)); assert.deepEqual(await s.completed, fallback);
  await response; await assert.rejects(fetch(s.url));
});

test('느린 body를 408로 종료하고 runner를 호출하지 않는다', async () => {
  let calls = 0; const s = await fixture(async () => { calls++; return passed(); }, { testTimeouts: { bodyTimeoutMs: 25 } });
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(new URL(s.url).port), '127.0.0.1'); let data = '';
      socket.on('error', reject); socket.on('data', chunk => { data += chunk; if (data.includes('408')) { socket.destroy(); resolve(data); } });
      socket.on('connect', () => socket.write(`POST /api/run HTTP/1.1\r\nHost: ${new URL(s.url).host}\r\nOrigin: ${s.headers.Origin}\r\nX-TripMoney-Token: ${s.token}\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{`));
    });
    assert.match(raw, /408/); assert.equal(calls, 0);
  } finally { await s.close(); }
});

test('원문 에러와 추가 필드를 내보내지 않고 불완전한 passed를 통과시키지 않는다', async () => {
  for (const unsafe of [
    { ...passed(), report: null, message: 'synthetic-secret' },
    { ...passed(), cleanupUncertain: true },
    { ...passed(), report: { ...passed().report!, dataApi: { anonymousRest: 2, authenticatedRest: 3, anonymousRpc: 3, authenticatedRpc: 3 } } },
    { ...passed(), status: 'failed', code: 'synthetic-secret', email: 'synthetic-secret' },
  ]) {
    const s = await fixture(async () => unsafe as PreparedProviderResult);
    const result = await (await s.post('/api/run', { password: 'synthetic' })).json() as PreparedProviderResult;
    assert.notEqual(result.status, 'passed'); assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|message|email/);
    await s.close();
  }
  const s = await fixture(async () => { throw new Error('synthetic-secret'); });
  const text = await (await s.post('/api/run', { password: 'synthetic' })).text();
  assert.doesNotMatch(text, /synthetic-secret/); assert.match(text, /cleanup_unknown/); await s.close();
});

test('서로 모순되는 passed code나 cleanup_unknown을 성공으로 표시하지 않는다', async () => {
  for (const code of ['customer_provider_prepare_login_q', 'customer_provider_prepare_cleanup_unknown']) {
    const s = await fixture(async () => ({ ...passed(), code }));
    try {
      const result = await (await s.post('/api/run', { password: 'synthetic' })).json() as PreparedProviderResult;
      assert.notEqual(result.status, 'passed');
    } finally { await s.close(); }
  }
});

test('cancel 자체도 비응답 runner를 상한 내 닫고 fallback을 전달한다', async () => {
  let called = false; let signal!: AbortSignal;
  const s = await fixture(async (_password, current) => { called = true; signal = current; return new Promise(() => {}); },
    { testTimeouts: { closeTimeoutMs: 35 } });
  const running = s.post('/api/run', { password: 'synthetic' }).catch(() => null);
  while (!called) await new Promise(r => setTimeout(r, 1));
  const started = Date.now(); const cancelledResponse = await s.post('/api/cancel');
  assert.equal(signal.aborted, true);
  const result = await cancelledResponse.json() as PreparedProviderResult;
  assert.equal(result.code, 'customer_provider_prepare_cleanup_unknown'); assert.equal(result.cleanupUncertain, true);
  await s.close(); assert.ok(Date.now() - started < 1000); await running;
  await assert.rejects(fetch(s.url));
});

test('모든 보호 헤더 중복과 missing Origin/token, malformed JSON은 runner0이다', async () => {
  let calls = 0; const s = await fixture(async () => { calls++; return passed(); });
  try {
    for (const duplicate of ['Host', 'Origin', 'X-TripMoney-Token', 'Content-Type']) {
      const values: Record<string, string> = { Host: new URL(s.url).host, ...s.headers };
      const headers = Object.entries(values).flatMap(([key,value]) => [key,value]); headers.push(duplicate, values[duplicate]!);
      const status = await new Promise<number>((resolve,reject) => {
        const req = http.request(new URL('/api/run',s.url), {method:'POST',headers}, res => { resolve(res.statusCode!); res.resume(); });
        req.on('error',reject); req.end(JSON.stringify({password:'synthetic'}));
      });
      assert.equal(status,400);
    }
    for (const missing of ['Origin','X-TripMoney-Token']) {
      const headers: Record<string,string> = {...s.headers}; delete headers[missing];
      assert.equal((await fetch(new URL('/api/run',s.url),{method:'POST',headers,body:'{"password":"synthetic"}'})).status,403);
    }
    assert.equal((await fetch(new URL('/api/run',s.url),{method:'POST',headers:s.headers,body:'{' })).status,400);
    assert.equal((await fetch(new URL('/api/run',s.url),{method:'PUT',headers:s.headers,body:'{}'})).status,404);
    assert.equal(calls,0);
  } finally { await s.close(); }
});

test('8192바이트 경계는 허용하고 정상 응답 뒤 listener가 닫힌다', async () => {
  const password = '가'.repeat(2725) + 'ab';
  assert.equal(Buffer.byteLength(JSON.stringify({password})),8192);
  const s = await fixture(async received => { assert.equal(received,password); return passed(); });
  assert.equal((await s.post('/api/run',{password})).status,200);
  await s.completed; await s.close(); await assert.rejects(fetch(s.url));
});
