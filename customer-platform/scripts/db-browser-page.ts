function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function renderDbSetupPage(token: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${escapeAttribute(token)}">
  <title>개발 DB 연결 준비 | TripMoney</title>
  <link rel="stylesheet" href="/style.css">
  <script src="/app.js" defer></script>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">TripMoney <span>이 Mac에서만</span></p>
      <h1>개발 DB 연결 준비</h1>
      <p class="intro">현재 관리자 비밀번호를 입력해 주세요.</p>
      <p class="target">tripmoney-customer-dev · 서울 · Free</p>
    </header>
    <form id="setup-form" method="post" action="/api/setup" aria-busy="false" novalidate>
      <label for="password">현재 DB 관리자 비밀번호</label>
      <p id="password-help" class="help">입력한 비밀번호로 개발용 연결 설정을 준비합니다.</p>
      <div class="password-field">
        <input id="password" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="password-help input-error" required disabled>
        <button id="toggle-password" class="toggle" type="button" aria-controls="password" aria-pressed="false" disabled>표시</button>
      </div>
      <p id="input-error" class="input-error" hidden></p>
      <p class="privacy">제출하면 입력칸이 바로 비워집니다.</p>
      <div class="actions">
        <button id="submit" class="primary" type="submit" disabled>연결 설정 시작</button>
        <button id="cancel" class="secondary" type="button" disabled>취소</button>
      </div>
    </form>
    <section id="status" class="status" aria-live="polite" aria-atomic="true" tabindex="-1" aria-labelledby="status-title">
      <h2 id="status-title">준비</h2>
      <p id="status-detail">비밀번호는 한 번만 제출할 수 있어요.</p>
      <p id="error-code" class="error-code" hidden></p>
      <p id="saved-warning" class="saved-warning" hidden></p>
    </section>
    <footer>설정 저장 후 로그인 허용과 DB 테스트를 따로 확인합니다.</footer>
    <noscript>입력창을 사용하려면 브라우저의 JavaScript를 켜 주세요.</noscript>
  </main>
</body>
</html>`;
}

export const DB_SETUP_STYLE = `
:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; color: #172133; background: #fffaf0; }
* { box-sizing: border-box; }
body { margin: 0; line-height: 1.6; }
main { width: min(100% - 40px, 540px); margin: clamp(24px, 8vh, 80px) auto; }
header { margin-bottom: 36px; }
.eyebrow { margin: 0 0 24px; font-size: .875rem; font-weight: 600; letter-spacing: .03em; }
.eyebrow span { margin-left: 12px; color: #665c4d; font-weight: 400; letter-spacing: 0; }
h1 { margin: 0 0 12px; font-size: clamp(1.6rem, 5vw, 2rem); line-height: 1.3; font-weight: 600; letter-spacing: -.035em; }
.intro { margin: 0 0 16px; }
.target { margin: 0; padding-top: 16px; border-top: 1px solid #d8cdbb; color: #665c4d; font-size: .8125rem; overflow-wrap: anywhere; }
label { font-weight: 600; }
.help { margin: 6px 0 12px; color: #665c4d; font-size: .875rem; }
.password-field { display: flex; align-items: stretch; gap: 8px; }
input { width: 100%; min-width: 0; padding: 12px; border: 1px solid #817564; border-radius: 6px; background: #fffdf7; color: #172133; font: inherit; font-size: 1rem; }
button { min-height: 48px; border: 1px solid transparent; border-radius: 6px; padding: 10px 16px; font: inherit; font-weight: 600; cursor: pointer; }
.toggle { flex: 0 0 auto; padding-inline: 12px; color: #172133; background: #f5efe3; border-color: #c5b9a5; }
.privacy { margin: 10px 0 24px; font-size: .8125rem; color: #665c4d; }
.actions { display: flex; gap: 12px; }
.primary { flex: 1; color: #fffaf0; background: #172133; }
.secondary { color: #172133; background: transparent; border-color: #b1a48f; }
button:hover:not(:disabled) { filter: brightness(.94); }
button:disabled, input:disabled { opacity: .65; cursor: default; }
button:focus-visible, input:focus-visible, .status:focus-visible { outline: 3px solid #806039; outline-offset: 4px; }
.input-error { margin: 8px 0 0; color: #8d3525; font-size: .875rem; }
input[aria-invalid="true"] { border-color: #8d3525; }
.status { margin-top: 32px; padding: 20px 0; border-block: 1px solid #d8cdbb; overflow-wrap: anywhere; }
.status h2 { margin: 0 0 6px; font-size: 1rem; font-weight: 600; }
.status p { margin: 0; font-size: .875rem; }
.status .error-code { margin-top: 12px; font-size: .8125rem; }
.saved-warning { margin-top: 12px !important; padding: 12px; background: #f5e6c6; color: #67420d; border-radius: 4px; }
footer { margin-top: 20px; color: #665c4d; font-size: .8125rem; }
[hidden] { display: none !important; }
@media (max-width: 380px) { main { width: calc(100% - 32px); } header { margin-bottom: 28px; } .actions { gap: 8px; } }
`;

export const DB_SETUP_SCRIPT = String.raw`
(() => {
  'use strict';
  const form = document.getElementById('setup-form');
  const input = document.getElementById('password');
  const toggle = document.getElementById('toggle-password');
  const submit = document.getElementById('submit');
  const cancel = document.getElementById('cancel');
  const error = document.getElementById('input-error');
  const status = document.getElementById('status');
  const title = document.getElementById('status-title');
  const detail = document.getElementById('status-detail');
  const warning = document.getElementById('saved-warning');
  const errorCode = document.getElementById('error-code');
  const token = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
  let state = 'ready';
  const safeCodes = new Set([
    'customer_db_browser_request_rejected',
    'customer_db_browser_cleanup_incomplete',
    'customer_db_browser_setup_failed',
  ]);
  for (const stage of ['local_preflight', 'input', 'admin_connect', 'admin_auth', 'role_preflight',
    'password_reset', 'local_save', 'commit', 'postcheck', 'close']) {
    for (const saved of ['', '_file_saved']) {
      const base = 'customer_db_auto_' + stage + '_failed' + saved;
      safeCodes.add(base);
      if (stage === 'role_preflight') {
        for (const suffix of ['client_transport', 'begin', 'settings', 'lock', 'inspection_query', 'role_guard']) {
          safeCodes.add(base + '_' + suffix);
        }
      }
    }
  }

  function clearInput() {
    input.value = '';
    input.type = 'password';
    toggle.textContent = '표시';
    toggle.setAttribute('aria-pressed', 'false');
    input.removeAttribute('aria-invalid');
    error.hidden = true;
    error.textContent = '';
  }

  function lockInput() {
    input.disabled = true;
    toggle.disabled = true;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
  }

  function savedWarning() {
    warning.textContent = '설정 파일은 이미 저장됐어요. 다시 실행하지 말고 저장 상태를 확인해 주세요.';
    warning.hidden = false;
  }

  function finish(result) {
    if (state === 'final') {
      // A late reply may still contain a save warning after cancellation.
      if (result && result.fileSaved === true) savedWarning();
      return;
    }
    state = 'final';
    clearInput();
    lockInput();
    cancel.disabled = true;
    form.setAttribute('aria-busy', 'false');
    if (result && result.status === 'failed' && typeof result.code === 'string' && safeCodes.has(result.code)) {
      errorCode.textContent = '오류 코드: ' + result.code;
      errorCode.hidden = false;
    }
    const valid = result && ['saved', 'failed', 'cancelled'].includes(result.status)
      && typeof result.fileSaved === 'boolean'
      && (result.status !== 'saved' || result.fileSaved === true);
    if (!valid) {
      title.textContent = '결과 확인 필요';
      detail.textContent = '처리 결과를 받지 못했어요. 자동으로 다시 시도하지 않습니다.';
      warning.textContent = '저장 여부를 확인하지 못했어요. 다시 실행하지 말고 저장 상태를 확인해 주세요.';
      warning.hidden = false;
    } else if (result.status === 'saved') {
      title.textContent = '저장 완료';
      detail.textContent = '연결 설정을 저장했어요. 로그인 허용과 DB 테스트는 아직 확인 전입니다.';
    } else {
      title.textContent = result.status === 'cancelled' ? '취소 완료' : '설정 실패';
      detail.textContent = result.status === 'cancelled'
        ? '요청한 작업을 중단했어요. 이 창을 닫아도 됩니다.'
        : '설정을 마치지 못했어요. 자동으로 다시 시도하지 않습니다.';
      if (result.fileSaved) savedWarning();
    }
    status.focus();
  }

  async function send(path, body) {
    try {
      const pending = fetch(path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-TripMoney-Token': token },
        body,
      });
      body = '';
      const response = await pending;
      const result = await response.json();
      finish(response.ok || (result && result.status === 'failed') ? result : null);
    } catch {
      finish(null);
    }
  }

  toggle.addEventListener('click', () => {
    if (state !== 'ready') return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? '숨기기' : '표시';
    toggle.setAttribute('aria-pressed', String(show));
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state !== 'ready') return;
    if (input.value.length === 0) {
      error.textContent = '현재 관리자 비밀번호를 입력해 주세요.';
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    let body = JSON.stringify({ password: input.value });
    clearInput();
    state = 'running';
    lockInput();
    title.textContent = '처리 중';
    detail.textContent = '연결을 확인하고 설정을 저장하고 있어요. 잠시 기다려 주세요.';
    cancel.focus();
    const pending = send('/api/setup', body);
    body = '';
    return pending;
  });

  cancel.addEventListener('click', () => {
    if (state !== 'ready' && state !== 'running') return;
    clearInput();
    state = 'cancelling';
    lockInput();
    cancel.disabled = true;
    title.textContent = '취소 중';
    detail.textContent = '작업을 중단하고 있어요. 결과를 확인할 때까지 기다려 주세요.';
    status.focus();
    return send('/api/cancel', '{}');
  });

  input.disabled = false;
  toggle.disabled = false;
  submit.disabled = false;
  cancel.disabled = false;
})();
`;
