import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError } from '../../web/api.mjs';
import type { CustomerApi } from '../../web/api.mjs';
import { createAuthController } from '../../web/auth/controller.mjs';

const me = { userId: '8ca2f81a-97c1-4bf5-a219-53a98e70f6cd', email: 'traveler@example.invalid', expiresAt: '2026-11-03T00:00:00.000Z' };
const config = { mode: 'local-demo', mailDelivery: false, code: '123456' } as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const errorResponse = (status: number, code: string, field?: string) => json({ error: { code, message: 'unsafe upstream detail', ...(field ? { field } : {}) }, requestId: 'request-1' }, status);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fakeApi(overrides: Partial<CustomerApi> = {}): CustomerApi {
  return { publicConfig: async () => config, me: async () => { throw new ApiError(401, 'unauthenticated'); }, requestCode: async () => ({ message: '로컬 인증번호를 입력해 주세요.' }), verifyCode: async () => ({ me }), logout: async () => undefined, ...overrides };
}

test('API sends only allowed request keys with same-origin cookies and write guards', async () => {
  const calls: [string, RequestInit][] = [];
  const responses = [json(config), json({ me }), json({ message: '로컬 인증번호를 입력해 주세요.' }), json({ me }), new Response(null, { status: 204 })];
  const api = createApi(async (url: string, init: RequestInit) => { calls.push([url, init]); return responses.shift()!; });
  await api.publicConfig(); await api.me(); await api.requestCode('a@example.invalid'); await api.verifyCode('123456'); await api.logout();
  assert.deepEqual(calls.map(([url]) => url), ['/api/customer/public-config', '/api/customer/me', '/api/customer/auth/request-code', '/api/customer/auth/verify-code', '/api/customer/auth/logout']);
  for (const [, init] of calls) assert.equal(init.credentials, 'same-origin');
  assert.deepEqual(calls.slice(2).map(([, init]) => JSON.parse(init.body as string)), [{ email: 'a@example.invalid' }, { code: '123456' }, {}]);
  for (const [, init] of calls.slice(2)) { assert.equal(init.method, 'POST'); assert.equal((init.headers as Record<string, string>)['X-TripMoney-Request'], '1'); assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json'); }
});

test('API maps 401, 429, 503 and validation to fixed safe errors', async () => {
  for (const [status, code] of [[401, 'unauthenticated'], [429, 'rate_limited'], [503, 'unavailable'], [422, 'validation']] as const) {
    const api = createApi(async () => errorResponse(status, code, 'code'));
    await assert.rejects(api.verifyCode('000000'), (error: unknown) => error instanceof ApiError && error.status === status && error.code === code && !error.message.includes('unsafe') && (status !== 422 || error.field === 'code'));
  }
});

test('API rejects network, malformed JSON, unknown errors and incorrect success DTOs', async () => {
  const cases = [async () => { throw new Error('secret connection'); }, async () => new Response('{'), async () => errorResponse(418, 'unknown'), async () => json({ me: { ...me, expiresAt: 'tomorrow' } }), async () => json({ me: { ...me, userId: 7 } }), async () => json({ me: { ...me, email: '<script>bad</script>' } })];
  for (const fetcher of cases) await assert.rejects(createApi(fetcher).me(), (e: unknown) => e instanceof ApiError && !e.message.includes('secret'));
  await assert.rejects(createApi(async () => json({ mode: 'production', mailDelivery: true, code: '123456' })).publicConfig());
  await assert.rejects(createApi(async () => json({ nonce: 'forbidden' })).requestCode('a@example.invalid'));
  await assert.rejects(createApi(async () => json({ message: 'ok' })).logout());
  const result = await createApi(async () => json({ me: { ...me, token: 'must not escape' }, token: 'hidden' })).me();
  assert.deepEqual(result, { me });
});

test('bootstrap treats initial 401 as email, retries failed status and requires config', async () => {
  let fail = true;
  const controller = createAuthController(fakeApi({ me: async () => { if (fail) throw new ApiError(503, 'unavailable'); throw new ApiError(401, 'unauthenticated'); } }));
  await controller.bootstrap(); assert.equal(controller.state.phase, 'checking'); assert.ok(controller.state.error);
  fail = false; await controller.bootstrap(); assert.equal(controller.state.phase, 'email'); assert.equal(controller.state.error, null);
  controller.destroy();
  const invalid = createAuthController(fakeApi({ publicConfig: async () => { throw new ApiError(503, 'unavailable'); }, me: async () => ({ me }) }));
  await invalid.bootstrap(); assert.equal(invalid.state.phase, 'checking'); assert.equal(invalid.state.me, null); invalid.destroy();
});

test('request and verification preserve inputs on failure, prevent duplicates, and enforce resend wait', async () => {
  let now = 1000; let requests = 0; let verifies = 0; const pending = deferred<{ message: string }>();
  const controller = createAuthController(fakeApi({ requestCode: async () => { requests++; return requests === 1 ? pending.promise : { message: '로컬 인증번호를 입력해 주세요.' }; }, verifyCode: async () => { verifies++; throw new ApiError(422, 'validation', 'code'); } }), { now: () => now });
  await controller.bootstrap(); controller.setEmail('person@example.invalid');
  const first = controller.requestCode(); await controller.requestCode(); assert.equal(requests, 1); assert.equal(controller.state.busy, 'request');
  pending.resolve({ message: '로컬 인증번호를 입력해 주세요.' }); await first;
  assert.equal(controller.state.phase, 'code'); assert.equal(controller.state.resendAt, 61000);
  controller.setCode('000000'); await controller.verifyCode(); assert.equal(verifies, 1); assert.equal(controller.state.phase, 'code'); assert.equal(controller.state.code, '000000'); assert.equal(controller.state.email, 'person@example.invalid');
  await controller.resendCode(); assert.equal(requests, 1);
  now = 62000; await controller.resendCode(); assert.equal(requests, 2); assert.equal(controller.state.code, '');
  controller.destroy();
});

test('request failure retains email, code expiry and rate limit retain code for correction', async () => {
  let fail = true;
  const controller = createAuthController(fakeApi({ requestCode: async () => { if (fail) throw new ApiError(429, 'rate_limited'); return { message: '로컬 인증번호를 입력해 주세요.' }; }, verifyCode: async () => { throw new ApiError(401, 'unauthenticated'); } }));
  await controller.bootstrap(); controller.setEmail('person@example.invalid'); await controller.requestCode();
  assert.equal(controller.state.email, 'person@example.invalid'); assert.equal(controller.state.phase, 'email'); assert.equal(controller.state.error?.code, 'rate_limited');
  fail = false; await controller.requestCode(); controller.setCode('123450'); await controller.verifyCode();
  assert.equal(controller.state.phase, 'code'); assert.equal(controller.state.code, '123450'); assert.equal(controller.state.error?.field, 'code'); controller.destroy();
});

test('successful verify clears code; logout 503 retains identity and success removes personal data', async () => {
  let fail = true;
  const controller = createAuthController(fakeApi({ logout: async () => { if (fail) throw new ApiError(503, 'unavailable'); } }));
  await controller.bootstrap(); controller.setEmail('person@example.invalid'); await controller.requestCode(); controller.setCode('123456'); await controller.verifyCode();
  assert.equal(controller.state.phase, 'authenticated'); assert.deepEqual(controller.state.me, me); assert.equal(controller.state.code, '');
  await controller.logout(); assert.equal(controller.state.phase, 'authenticated'); assert.deepEqual(controller.state.me, me);
  fail = false; await controller.logout(); assert.equal(controller.state.phase, 'email'); assert.equal(controller.state.me, null); assert.equal(controller.state.email, 'traveler@example.invalid'); assert.equal(controller.state.code, ''); controller.destroy();
});

test('session check keeps identity on 503 and clears it on 401', async () => {
  let response = 200;
  const controller = createAuthController(fakeApi({ me: async () => { if (response !== 200) throw new ApiError(response, response === 401 ? 'unauthenticated' : 'unavailable'); return { me }; } }));
  await controller.bootstrap(); response = 503; await controller.checkSession(); assert.deepEqual(controller.state.me, me); assert.equal(controller.state.phase, 'authenticated');
  response = 401; await controller.checkSession(); assert.equal(controller.state.me, null); assert.equal(controller.state.phase, 'email'); assert.equal(controller.state.code, ''); controller.destroy();
});

test('email change and destroy ignore late responses and stop subscriptions', async () => {
  const pending = deferred<{ message: string }>(); const controller = createAuthController(fakeApi({ requestCode: () => pending.promise }));
  let notifications = 0; const unsubscribe = controller.subscribe(() => { notifications++; });
  await controller.bootstrap(); const request = controller.requestCode(); controller.changeEmail(); pending.resolve({ message: '로컬 인증번호를 입력해 주세요.' }); await request;
  assert.equal(controller.state.phase, 'email'); assert.equal(controller.state.busy, null);
  unsubscribe(); const count = notifications; controller.setEmail('new@example.invalid'); assert.equal(notifications, count); controller.destroy();
  const slow = deferred<{ me: typeof me }>(); const destroyed = createAuthController(fakeApi({ me: () => slow.promise })); const boot = destroyed.bootstrap(); destroyed.destroy(); slow.resolve({ me }); await boot; assert.equal(destroyed.state.me, null);
});

test('client validation avoids requests and preserves safe errors without echoing upstream messages', async () => {
  let calls = 0; const controller = createAuthController(fakeApi({ requestCode: async () => { calls++; throw new Error('private diagnostic'); } }));
  await controller.bootstrap(); controller.setEmail('bad'); await controller.requestCode(); assert.equal(calls, 0); assert.equal(controller.state.error?.field, 'email');
  controller.setEmail('person@example.invalid'); await controller.requestCode(); assert.equal(calls, 1); assert.ok(!controller.state.error?.message.includes('private')); controller.destroy();
});

test('countdown updates at the clock boundary and destroy releases its interval', async t => {
  let now = 0; let callback: (() => void) | undefined; let cleared = 0;
  const handle = { unref() {} };
  t.mock.method(globalThis, 'setInterval', (fn: () => void) => { callback = fn; return handle; });
  t.mock.method(globalThis, 'clearInterval', (value: unknown) => { assert.equal(value, handle); cleared++; });
  const controller = createAuthController(fakeApi(), { now: () => now });
  await controller.bootstrap(); await controller.requestCode(); assert.equal(controller.state.remainingSeconds, 60);
  now = 59001; callback!(); assert.equal(controller.state.remainingSeconds, 1);
  now = 60000; callback!(); assert.equal(controller.state.remainingSeconds, 0); assert.equal(cleared, 1);
  await controller.resendCode(); let notifications = 0; controller.subscribe(() => { notifications++; }); controller.destroy();
  assert.equal(cleared, 2); const count = notifications; callback!(); assert.equal(notifications, count);
});

test('verification response arriving after email change cannot restore authentication', async () => {
  const pending = deferred<{ me: typeof me }>(); let calls = 0;
  const controller = createAuthController(fakeApi({ verifyCode: async () => { calls++; return pending.promise; } }));
  await controller.bootstrap(); await controller.requestCode(); controller.setCode('123456'); const verifying = controller.verifyCode(); await controller.verifyCode(); assert.equal(calls, 1);
  controller.changeEmail(); pending.resolve({ me }); await verifying; assert.equal(controller.state.phase, 'email'); assert.equal(controller.state.me, null); assert.equal(controller.state.code, ''); controller.destroy();
});
