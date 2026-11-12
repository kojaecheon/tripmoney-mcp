import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { DB_SETUP_SCRIPT, renderDbSetupPage } from '../../scripts/db-browser-page.js';

class Element {
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<() => unknown>>();
  textContent = '';
  value = '';
  type = '';
  disabled = false;
  hidden = false;
  focused = false;
  constructor(attributes: string) {
    for (const match of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      this.attributes.set(match[1]!, match[2] ?? '');
    }
    this.type = this.attributes.get('type') ?? '';
    this.hidden = this.attributes.has('hidden');
    this.disabled = this.attributes.has('disabled');
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, listener: () => unknown) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  focus() { this.focused = true; }
  dispatch(name: string) {
    return Promise.all((this.listeners.get(name) ?? []).map((listener) =>
      (listener as (event: { preventDefault(): void }) => unknown)({ preventDefault() {} })));
  }
}

function harness() {
  const elements = new Map<string, Element>();
  const html = renderDbSetupPage('synthetic-csrf-token');
  for (const match of html.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1]!, new Element(match[0]));
  }
  const tokenTag = html.match(/<meta\b[^>]*name="csrf-token"[^>]*>/)?.[0];
  assert.ok(tokenTag);
  const requests: Array<{ path: string; options: RequestInit; resolve(value: unknown): void; reject(error: Error): void }> = [];
  const document = {
    getElementById(id: string) { assert.ok(elements.has(id), `missing ${id}`); return elements.get(id)!; },
    querySelector(selector: string) { assert.equal(selector, 'meta[name="csrf-token"]'); return new Element(tokenTag); },
  };
  runInNewContext(DB_SETUP_SCRIPT, {
    document,
    fetch(path: string, options: RequestInit) {
      return new Promise((resolve, reject) => requests.push({ path, options, resolve, reject }));
    },
  });
  const get = (id: string) => document.getElementById(id);
  const reply = (index: number, data: unknown, ok = true) => requests[index]!.resolve({ ok, json: async () => data });
  return { html, get, requests, reply };
}

test('기본 숨김 입력은 사용자가 표시와 숨김을 직접 선택한다', async () => {
  const h = harness();
  assert.equal(h.get('password').type, 'password');
  assert.equal(h.get('toggle-password').getAttribute('aria-pressed'), 'false');
  await h.get('toggle-password').dispatch('click');
  assert.equal(h.get('password').type, 'text');
  assert.equal(h.get('toggle-password').getAttribute('aria-pressed'), 'true');
  await h.get('toggle-password').dispatch('click');
  assert.equal(h.get('password').type, 'password');
});

test('빈 입력은 전송하지 않고 오류를 입력칸과 연결한다', async () => {
  const h = harness();
  await h.get('setup-form').dispatch('submit');
  assert.equal(h.requests.length, 0);
  assert.equal(h.get('password').getAttribute('aria-invalid'), 'true');
  assert.equal(h.get('password').focused, true);
  assert.ok(h.get('input-error').textContent.length > 0);
});

test('제출 즉시 원문을 제거하고 숨기며 중복 제출을 차단한다', async () => {
  const h = harness();
  h.get('password').value = ' synthetic password ';
  await h.get('toggle-password').dispatch('click');
  const pending = h.get('setup-form').dispatch('submit');
  assert.equal(h.get('password').value, '');
  assert.equal(h.get('password').type, 'password');
  assert.equal(h.get('password').disabled, true);
  assert.equal(h.get('submit').disabled, true);
  assert.equal(h.get('toggle-password').disabled, true);
  assert.equal(h.get('cancel').disabled, false);
  assert.equal(h.get('setup-form').getAttribute('aria-busy'), 'true');
  await h.get('setup-form').dispatch('submit');
  await h.get('toggle-password').dispatch('click');
  assert.equal(h.requests.length, 1);
  assert.equal(h.get('password').type, 'password');
  const request = h.requests[0]!;
  assert.equal(request.path, '/api/setup');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
  assert.deepEqual(JSON.parse(String(request.options.body)), { password: ' synthetic password ' });
  assert.equal((request.options.headers as Record<string, string>)['X-TripMoney-Token'], 'synthetic-csrf-token');
  assert.equal((request.options.headers as Record<string, string>)['Content-Type'], 'application/json');
  h.reply(0, { status: 'saved', fileSaved: true });
  await pending;
  assert.match(h.get('status-title').textContent, /저장 완료/);
  assert.match(h.get('status-detail').textContent, /DB 테스트/);
  assert.equal(h.get('cancel').disabled, true);
  assert.equal(h.get('status').focused, true);
});

for (const status of ['failed', 'cancelled']) {
  for (const fileSaved of [false, true]) {
    test(`${status} 상태는 저장 여부 ${fileSaved}를 알리고 재시도를 열지 않는다`, async () => {
      const h = harness();
      h.get('password').value = 'synthetic-only';
      const pending = h.get('setup-form').dispatch('submit');
      h.reply(0, { status, fileSaved, code: '<img src=x onerror=alert(1)>', message: 'DO_NOT_DISPLAY' });
      await pending;
      assert.match(h.get('status-title').textContent, status === 'failed' ? /실패/ : /취소/);
      assert.equal(h.get('saved-warning').hidden, !fileSaved);
      if (fileSaved) assert.match(h.get('saved-warning').textContent, /저장/);
      assert.doesNotMatch(h.get('status-detail').textContent, /DO_NOT_DISPLAY|<img/);
      assert.equal(h.get('submit').disabled, true);
      assert.equal(h.get('password').disabled, true);
      await h.get('setup-form').dispatch('submit');
      assert.equal(h.requests.length, 1);
    });
  }
}

test('준비 상태에서 명시 취소하면 입력을 제거하고 동일한 요청 보호를 사용한다', async () => {
  const h = harness();
  h.get('password').value = 'synthetic-only';
  const pending = h.get('cancel').dispatch('click');
  assert.equal(h.get('password').value, '');
  assert.equal(h.requests[0]!.path, '/api/cancel');
  assert.equal(h.requests[0]!.options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(h.requests[0]!.options.body)), {});
  assert.equal((h.requests[0]!.options.headers as Record<string, string>)['X-TripMoney-Token'], 'synthetic-csrf-token');
  await h.get('cancel').dispatch('click');
  assert.equal(h.requests.length, 1);
  h.reply(0, { status: 'cancelled', fileSaved: false });
  await pending;
  assert.match(h.get('status-title').textContent, /취소/);
});

test('처리 중 취소 후 늦은 응답이 확정 상태를 덮어쓰지 않는다', async () => {
  const h = harness();
  h.get('password').value = 'synthetic-only';
  const setup = h.get('setup-form').dispatch('submit');
  const cancel = h.get('cancel').dispatch('click');
  assert.equal(h.requests[1]!.path, '/api/cancel');
  assert.equal(h.get('cancel').disabled, true);
  h.reply(1, { status: 'cancelled', fileSaved: false });
  await cancel;
  h.reply(0, { status: 'failed', fileSaved: false });
  await setup;
  assert.match(h.get('status-title').textContent, /취소/);
});

test('취소 뒤 늦게 저장 응답이 와도 저장 경고는 누락하지 않는다', async () => {
  const h = harness();
  h.get('password').value = 'synthetic-only';
  const setup = h.get('setup-form').dispatch('submit');
  const cancel = h.get('cancel').dispatch('click');
  h.reply(1, { status: 'cancelled', fileSaved: false });
  await cancel;
  h.reply(0, { status: 'saved', fileSaved: true });
  await setup;
  assert.match(h.get('status-title').textContent, /취소/);
  assert.equal(h.get('saved-warning').hidden, false);
  assert.match(h.get('saved-warning').textContent, /저장/);
});

test('스크립트를 로드하기 전에는 입력을 잠그고 기본 폼 제출을 POST로 제한한다', () => {
  const html = renderDbSetupPage('synthetic-only');
  const input = new Element(html.match(/<input\b[^>]*>/)![0]);
  const form = new Element(html.match(/<form\b[^>]*>/)![0]);
  assert.equal(input.disabled, true);
  assert.equal(input.getAttribute('name'), null);
  assert.equal(form.getAttribute('method'), 'post');
  assert.equal(form.getAttribute('action'), '/api/setup');
  assert.equal(harness().get('password').disabled, false);
});

test('토큰은 HTML 속성 경계를 넘을 수 없다', () => {
  const html = renderDbSetupPage('x"><script>synthetic</script>&');
  const meta = html.match(/<meta\b[^>]*name="csrf-token"[^>]*>/)![0];
  assert.match(meta, /content="x&quot;&gt;&lt;script&gt;synthetic&lt;\/script&gt;&amp;"/);
  assert.doesNotMatch(html, /<script>synthetic/);
});

for (const response of [null, { status: 'saved', fileSaved: false }, { status: 'other', fileSaved: false }]) {
  test(`잘못된 최종 응답 ${JSON.stringify(response)}는 저장 완료로 표시하지 않는다`, async () => {
    const h = harness();
    h.get('password').value = 'synthetic-only';
    const pending = h.get('setup-form').dispatch('submit');
    h.reply(0, response);
    await pending;
    assert.match(h.get('status-title').textContent, /확인/);
    assert.equal(h.get('saved-warning').hidden, false);
    assert.equal(h.get('submit').disabled, true);
  });
}

test('통신 실패는 자동 재시도 없이 저장 여부 확인을 안내한다', async () => {
  const h = harness();
  h.get('password').value = 'synthetic-only';
  const pending = h.get('setup-form').dispatch('submit');
  h.requests[0]!.reject(new Error('DO_NOT_DISPLAY'));
  await pending;
  assert.equal(h.requests.length, 1);
  assert.match(h.get('status-title').textContent, /확인/);
  assert.match(h.get('saved-warning').textContent, /저장 여부/);
  assert.doesNotMatch(h.get('status-detail').textContent, /DO_NOT_DISPLAY/);
});

test('관리자 인증 실패는 고정된 안전한 오류 코드를 표시한다', async () => {
  const h = harness();
  h.get('password').value = 'synthetic-only';
  const pending = h.get('setup-form').dispatch('submit');
  h.reply(0, { status: 'failed', code: 'customer_db_auto_admin_auth_failed', fileSaved: false });
  await pending;
  assert.equal(h.get('error-code').hidden, false);
  assert.equal(h.get('error-code').textContent, '오류 코드: customer_db_auto_admin_auth_failed');
});

for (const code of [
  'customer_db_auto_commit_failed_file_saved',
  'customer_db_auto_role_preflight_failed_client_transport',
  'customer_db_auto_role_preflight_failed_file_saved_role_guard',
  'customer_db_browser_request_rejected',
  'customer_db_browser_cleanup_incomplete',
  'customer_db_browser_setup_failed',
]) {
  test(`허용한 오류 코드 ${code}를 표시한다`, async () => {
    const h = harness();
    h.get('password').value = 'synthetic-only';
    const pending = h.get('setup-form').dispatch('submit');
    h.reply(0, { status: 'failed', code, fileSaved: true });
    await pending;
    assert.equal(h.get('error-code').hidden, false);
    assert.equal(h.get('error-code').textContent, `오류 코드: ${code}`);
  });
}

test('저장 여부가 null이면 확인 경고와 안전한 실패 코드만 표시한다', async () => {
  const h = harness();
  h.get('password').value = 'synthetic-only';
  const pending = h.get('setup-form').dispatch('submit');
  h.reply(0, { status: 'failed', code: 'customer_db_browser_cleanup_incomplete', fileSaved: null,
    message: 'SYNTHETIC_PRIVATE_VALUE' });
  await pending;
  assert.match(h.get('status-title').textContent, /확인/);
  assert.equal(h.get('saved-warning').hidden, false);
  assert.match(h.get('saved-warning').textContent, /저장 여부/);
  assert.equal(h.get('error-code').hidden, false);
  assert.equal(h.get('error-code').textContent, '오류 코드: customer_db_browser_cleanup_incomplete');
  assert.doesNotMatch(h.get('status-detail').textContent, /SYNTHETIC_PRIVATE_VALUE/);
});

test('HTTP 요청 거부도 안전한 실패 코드만 표시한다', async () => {
  const h = harness();
  h.get('password').value = 'synthetic-only';
  const pending = h.get('setup-form').dispatch('submit');
  h.reply(0, { status: 'failed', code: 'customer_db_browser_request_rejected', fileSaved: false }, false);
  await pending;
  assert.equal(h.get('error-code').hidden, false);
  assert.equal(h.get('error-code').textContent, '오류 코드: customer_db_browser_request_rejected');
});

test('HTTP 실패 응답의 saved 값은 저장 완료로 표시하지 않는다', async () => {
  const h = harness();
  h.get('password').value = 'synthetic-only';
  const pending = h.get('setup-form').dispatch('submit');
  h.reply(0, { status: 'saved', fileSaved: true }, false);
  await pending;
  assert.match(h.get('status-title').textContent, /확인/);
  assert.equal(h.get('error-code').hidden, true);
});

for (const code of [
  '<img src=x onerror=alert(1)>', 'SYNTHETIC_PRIVATE_VALUE',
  'customer_db_auto_admin_auth_failed_role_guard',
  'customer_db_auto_role_preflight_failed_private_detail',
  'customer_db_auto_admin_auth_failed\nSYNTHETIC_PRIVATE_VALUE',
  { message: 'SYNTHETIC_PRIVATE_VALUE' },
]) {
  test(`허용하지 않은 code ${JSON.stringify(code)}는 표시하지 않는다`, async () => {
    const h = harness();
    h.get('password').value = 'synthetic-only';
    const pending = h.get('setup-form').dispatch('submit');
    h.reply(0, { status: 'failed', code, fileSaved: false, message: 'SYNTHETIC_PRIVATE_VALUE' });
    await pending;
    assert.equal(h.get('error-code').hidden, true);
    assert.equal(h.get('error-code').textContent, '');
    assert.doesNotMatch(h.get('status-detail').textContent, /SYNTHETIC_PRIVATE_VALUE|<img/);
  });
}

for (const status of ['saved', 'cancelled']) {
  test(`${status} 상태는 실패 코드를 잘못 표시하지 않는다`, async () => {
    const h = harness();
    h.get('password').value = 'synthetic-only';
    const pending = h.get('setup-form').dispatch('submit');
    h.reply(0, { status, code: 'customer_db_auto_admin_auth_failed', fileSaved: true });
    await pending;
    assert.equal(h.get('error-code').hidden, true);
    assert.equal(h.get('error-code').textContent, '');
  });
}
