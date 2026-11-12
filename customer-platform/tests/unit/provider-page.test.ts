import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PROVIDER_SCRIPT, PROVIDER_STYLE, renderProviderPage } from '../../scripts/provider-test/provider-page.js';
class Element {
  attributes = new Map<string, string>(); listeners = new Map<string, Array<(e: {preventDefault(): void}) => unknown>>();
  textContent = ''; value = ''; type = ''; disabled = false; hidden = false; focused = false;
  constructor(tag: string) {
    for (const m of tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) this.attributes.set(m[1]!, m[2] ?? '');
    this.type = this.attributes.get('type') ?? ''; this.disabled = this.attributes.has('disabled'); this.hidden = this.attributes.has('hidden');
  }
  getAttribute(n: string) { return this.attributes.get(n) ?? null; }
  setAttribute(n: string, v: string) { this.attributes.set(n, v); }
  removeAttribute(n: string) { this.attributes.delete(n); }
  addEventListener(n: string, f: (e: {preventDefault(): void}) => unknown) { this.listeners.set(n, [...this.listeners.get(n) ?? [], f]); }
  focus() { this.focused = true; }
  dispatch(n: string) { return Promise.all((this.listeners.get(n) ?? []).map(f => f({ preventDefault() {} }))); }
}
function harness() {
  const html = renderProviderPage('synthetic-csrf', 'synthetic@example.invalid');
  const elements = new Map<string, Element>();
  for (const m of html.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(m[1]!, new Element(m[0]));
  const requests: Array<{path: string; options: RequestInit; resolve(r: unknown): void; reject(e: Error): void}> = [];
  const get = (id: string) => { assert.ok(elements.has(id), id); return elements.get(id)!; };
  runInNewContext(PROVIDER_SCRIPT, { document: { getElementById: get,
    querySelector: () => new Element(html.match(/<meta name="csrf-token"[^>]*>/)![0]) },
    fetch: (path: string, options: RequestInit) => new Promise((resolve, reject) => requests.push({path, options, resolve, reject})),
  });
  const reply = (n: number, result: unknown) => requests[n]!.resolve({ ok: true, json: async () => result });
  return { get, requests, reply, html };
}
const report = () => ({ normalP: true, normalQ: true, revokedP: true, tokenPStillUnexpired: true,
  otherQStillActive: true, cleanupP: true, cleanupQ: true,
  dataApi: { anonymousRest: 3, authenticatedRest: 3, anonymousRpc: 3, authenticatedRpc: 3 } });
const passed = () => ({ status: 'passed', report: report(), cleanupComplete: true, cleanupUncertain: false });

test('script 전 입력잠금 POST 폼, 승인 email readonly escape, local asset, 360px 스타일', () => {
  const html = renderProviderPage('synthetic-token', '\"><script>@example.invalid');
  assert.match(html, /로그인 검증/); assert.match(html, /tripmoney-customer-dev/);
  assert.match(html, /&quot;&gt;&lt;script&gt;@example.invalid/); assert.doesNotMatch(html, /<script>@/);
  assert.match(html, /id="email"[^>]*readonly/); assert.match(html, /id="password"[^>]*disabled/);
  assert.match(html, /<form[^>]*method="post"/); assert.doesNotMatch(html, /\bname="password"/);
  assert.match(html, /aria-live="polite"/); assert.match(html, /시험 세션/);
  assert.doesNotMatch(html + PROVIDER_SCRIPT + PROVIDER_STYLE, /localStorage|sessionStorage|indexedDB|https?:\/\/|credentials\.store/);
  assert.match(PROVIDER_STYLE, /min-width:0/); assert.match(PROVIDER_STYLE, /box-sizing:border-box/);
});
test('본인 표시전환과 빈값 focus, 제출 즉시 제거 숨김 잠금, 한번만 전송', async () => {
  const h = harness(); assert.equal(h.get('password').type, 'password'); assert.equal(h.get('password').focused, true);
  await h.get('provider-form').dispatch('submit'); assert.equal(h.requests.length, 0);
  assert.equal(h.get('password').getAttribute('aria-invalid'), 'true');
  await h.get('toggle-password').dispatch('click'); assert.equal(h.get('password').type, 'text');
  assert.equal(h.get('toggle-password').getAttribute('aria-pressed'), 'true');
  h.get('password').value = ' synthetic password '; const pending = h.get('provider-form').dispatch('submit');
  assert.equal(h.get('password').value, ''); assert.equal(h.get('password').type, 'password');
  assert.equal(h.get('password').disabled, true); assert.equal(h.get('submit').disabled, true);
  assert.equal(h.get('toggle-password').disabled, true); assert.equal(h.get('cancel').disabled, false);
  await h.get('provider-form').dispatch('submit'); await h.get('toggle-password').dispatch('click'); assert.equal(h.requests.length, 1);
  const request = h.requests[0]!; assert.equal(request.path, '/api/run'); assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(String(request.options.body)), {password: ' synthetic password '});
  assert.equal((request.options.headers as Record<string, string>)['X-TripMoney-Token'], 'synthetic-csrf');
  h.reply(0, passed()); await pending; assert.match(h.get('status-title').textContent, /검증 통과/);
  assert.equal(h.get('status').focused, true); assert.equal(h.get('cancel').disabled, true);
});
test('모든 report boolean/count와 cleanup gate가 맞아야 성공이다', async () => {
  const cases: unknown[] = [{...passed(), report: null}, {...passed(), cleanupComplete: false}, {...passed(), cleanupUncertain: true},
    {...passed(), status: 'saved'}, { ...passed(), status: 'passed', cleanupUncertain: 'false' }];
  for (const key of ['normalP','normalQ','revokedP','tokenPStillUnexpired','otherQStillActive','cleanupP','cleanupQ'])
    cases.push({...passed(), report: {...report(), [key]: false}});
  for (const key of ['anonymousRest','authenticatedRest','anonymousRpc','authenticatedRpc'])
    cases.push({...passed(), report: {...report(), dataApi: {...report().dataApi, [key]: 2}}});
  for (const result of cases) {
    const h = harness(); h.get('password').value = 'synthetic'; const pending = h.get('provider-form').dispatch('submit');
    h.reply(0, result); await pending; assert.doesNotMatch(h.get('status-title').textContent, /검증 통과/);
  }
});
test('고정 실패code만 문구로 바꾸고 unknown code/message를 출력하지 않는다', async () => {
  for (const result of [
    {status:'failed', code:'customer_provider_prepare_login_q', report:null, cleanupComplete:true, cleanupUncertain:false},
    {status:'failed', code:'<img synthetic-secret>', message:'synthetic-secret', report:null, cleanupComplete:false, cleanupUncertain:true},
    {status:'passed', report:{...report(), synthetic:'synthetic-secret'}, cleanupComplete:true, cleanupUncertain:false},
  ]) {
    const h = harness(); h.get('password').value='synthetic'; const pending=h.get('provider-form').dispatch('submit');
    h.reply(0,result); await pending; assert.doesNotMatch(h.get('status-title').textContent+h.get('status-detail').textContent, /synthetic-secret|<img/);
    if (result.cleanupUncertain) { assert.equal(h.get('cleanup-warning').hidden,false); assert.match(h.get('status-title').textContent,/정리 확인 필요/); }
  }
});
test('준비중 취소는 입력 제거, 처리중 취소는 cleanup 대기 후 최초 응답을 고정한다', async () => {
  const idle = harness(); idle.get('password').value='synthetic'; const cancelIdle=idle.get('cancel').dispatch('click');
  assert.equal(idle.get('password').value,''); assert.equal(idle.requests[0]!.path,'/api/cancel');
  assert.deepEqual(JSON.parse(String(idle.requests[0]!.options.body)),{});
  idle.reply(0,{status:'cancelled',report:null,cleanupComplete:true,cleanupUncertain:false}); await cancelIdle;
  assert.match(idle.get('status-title').textContent,/취소/);
  const h=harness(); h.get('password').value='synthetic'; const run=h.get('provider-form').dispatch('submit');
  const cancel=h.get('cancel').dispatch('click'); assert.match(h.get('status-title').textContent,/검증 중/);
  assert.equal(h.get('cancel').disabled,true); await h.get('cancel').dispatch('click'); assert.equal(h.requests.length,2);
  h.reply(1,{status:'cancelled',report:null,cleanupComplete:true,cleanupUncertain:false}); await cancel;
  h.reply(0,passed()); await run; assert.match(h.get('status-title').textContent,/취소/);
});
test('늦은 불확실 cleanup 응답은 경고를 유지하며 요청 실패도 재시도하지 않는다', async () => {
  const h=harness(); h.get('password').value='synthetic'; const run=h.get('provider-form').dispatch('submit'); const cancel=h.get('cancel').dispatch('click');
  h.reply(1,{status:'cancelled',report:null,cleanupComplete:true,cleanupUncertain:false}); await cancel;
  h.reply(0,{status:'failed',report:null,cleanupComplete:false,cleanupUncertain:true}); await run;
  assert.equal(h.get('cleanup-warning').hidden,false); assert.match(h.get('status-title').textContent,/정리 확인 필요/);
  const broken=harness(); broken.get('password').value='synthetic'; const pending=broken.get('provider-form').dispatch('submit');
  broken.requests[0]!.reject(new Error('synthetic-secret')); await pending;
  assert.match(broken.get('status-title').textContent,/정리 확인 필요/);
  assert.doesNotMatch(broken.get('status-detail').textContent,/synthetic-secret/);
  await broken.get('provider-form').dispatch('submit'); assert.equal(broken.requests.length,1);
});

test('passed에 실패 code가 붙은 모순 응답은 확인 필요다', async () => {
  const h=harness(); h.get('password').value='synthetic'; const pending=h.get('provider-form').dispatch('submit');
  h.reply(0,{...passed(),code:'customer_provider_prepare_login_q'}); await pending;
  assert.doesNotMatch(h.get('status-title').textContent,/검증 통과/);
});
