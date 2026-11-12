import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityError } from '../../core/contracts.js';
import { checkCustomerDataApi } from '../../scripts/provider-test/data-api.js';

const config = {
  url: 'https://agddopryfqsyfshoowgk.supabase.co', publishableKey: 'sb_publishable_synthetic_only',
  tokenP: 'synthetic-p', tokenQ: 'synthetic-q',
};
const denied = () => Response.json({ code: 'PGRST106' }, { status: 406 });
const unavailable = (error: unknown) => error instanceof IdentityError && error.code === 'unavailable'
  && !error.message.includes('DO_NOT_LEAK');

test('고객 스키마 3개의 REST·RPC를 익명·정상 인증으로 12건 검사한다', async () => {
  const requests: { path: string; method: string; profile: string | null; auth: string | null; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(url.origin, config.url);
    assert.equal(headers.get('apikey'), config.publishableKey);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    assert.ok(init?.signal);
    requests.push({ path: url.pathname + url.search, method: init?.method ?? 'GET',
      profile: headers.get(init?.method === 'POST' ? 'Content-Profile' : 'Accept-Profile'),
      auth: headers.get('Authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return denied();
  };
  assert.deepEqual(await checkCustomerDataApi(config, config.tokenQ, fetcher), {
    anonymousRest: 3, authenticatedRest: 3, anonymousRpc: 3, authenticatedRpc: 3,
  });
  assert.equal(requests.length, 12);
  const expected = [
    ['/rest/v1/trips?select=created_at&limit=0', 'customer', 'GET'],
    ['/rest/v1/audit_events?select=created_at&limit=0', 'customer_private', 'GET'],
    ['/rest/v1/sessions?select=created_at&limit=0', 'customer_auth', 'GET'],
    ['/rest/v1/rpc/tripmoney_schema_probe_not_a_function', 'customer', 'POST'],
    ['/rest/v1/rpc/is_member', 'customer_private', 'POST'],
    ['/rest/v1/rpc/session_live', 'customer_auth', 'POST'],
  ];
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]!;
    const [path, profile, method] = expected[index % 6]!;
    assert.equal(request.path, path);
    assert.equal(request.profile, profile);
    assert.equal(request.method, method);
    assert.equal(request.auth, index < 6 ? null : 'Bearer synthetic-q');
    if (profile === 'customer_private' && method === 'POST') {
      assert.match((request.body as { t: string }).t, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    } else if (method === 'POST') assert.deepEqual(request.body, {});
  }
});

for (const [status, body] of [[401, { code: 'bad_jwt' }], [404, { code: 'PGRST202' }],
  [200, []], [403, { code: '42501' }], [406, { code: 'PGRST107' }], [200, { code: 'PGRST106' }]] as const) {
  test(`HTTP ${status}·잘못된 오류 코드를 미노출 성공으로 치지 않는다`, async () => {
    await assert.rejects(checkCustomerDataApi(config, config.tokenQ,
      async () => Response.json(body, { status })), unavailable);
  });
}

test('의도적인 customer 미존재 RPC의 404도 실패다', async () => {
  let count = 0;
  await assert.rejects(checkCustomerDataApi(config, config.tokenQ, async () => {
    count++;
    return count === 4 ? Response.json({ code: 'PGRST202' }, { status: 404 }) : denied();
  }), (error: unknown) => {
    assert.ok(unavailable(error));
    assert.deepEqual((error as { report?: unknown }).report, {
      anonymousRest: 3, authenticatedRest: 0, anonymousRpc: 0, authenticatedRpc: 0,
    });
    return true;
  });
  assert.equal(count, 4);
});

test('네트워크·응답 JSON 오류의 원문을 내보내지 않는다', async () => {
  for (const fetcher of [async () => { throw new Error('DO_NOT_LEAK'); },
    async () => new Response('DO_NOT_LEAK', { status: 406 })]) {
    await assert.rejects(checkCustomerDataApi(config, config.tokenQ, fetcher), unavailable);
  }
});

test('응답 본문을 포함해 호출당 5초를 넘기면 중단한다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null | undefined;
  let settled = false;
  const pending = checkCustomerDataApi(config, config.tokenQ, async (_input, init) => {
    signal = init?.signal;
    return { status: 406, json: () => new Promise(() => {}) } as unknown as Response;
  });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  t.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, unavailable);
  assert.equal(signal?.aborted, true);
});
