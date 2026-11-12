const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function renderProviderPage(token: string, email: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="csrf-token" content="${escapeHtml(token)}"><title>로그인 검증 | TripMoney</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head>
<body><main><p class="eyebrow">TripMoney · 개발 계정 확인</p><h1>로그인 검증</h1><p class="intro">승인한 시험 계정으로 로그인과 세션 종료를 확인합니다.</p>
<dl><dt>개발 프로젝트</dt><dd>${escapeHtml('tripmoney-customer-dev')}</dd></dl>
<form id="provider-form" method="post" action="/api/run" autocomplete="off"><label for="email">승인 이메일</label><input id="email" type="email" value="${escapeHtml(email)}" readonly autocomplete="off">
<label for="password">시험 계정 비밀번호</label><p id="password-help" class="help">이번 검증에 한 번 사용합니다. 검증 뒤 이번에 만든 시험 세션을 종료합니다.</p>
<div class="password-row"><input id="password" type="password" disabled autocomplete="off" spellcheck="false" required aria-describedby="password-help input-error"><button id="toggle-password" type="button" disabled aria-controls="password" aria-pressed="false">표시</button></div>
<p id="input-error" class="error"></p><div class="actions"><button id="submit" type="submit" disabled>로그인 검증 시작</button><button id="cancel" type="button" disabled>취소</button></div></form>
<section id="status" tabindex="-1" role="status" aria-live="polite" aria-atomic="true"><h2 id="status-title">준비</h2><p id="status-detail">비밀번호를 입력한 뒤 시작해 주세요.</p><p id="cleanup-warning" class="error" hidden>시험 세션 종료를 확인하지 못했습니다. 담당자에게 정리 상태 확인을 요청해 주세요. 다시 제출하지 마세요.</p></section>
<p class="footnote">개발 계정 검증 화면입니다. 제품 로그인이나 이메일 인증 수신을 확인하는 화면은 아닙니다. 비밀번호는 파일이나 브라우저 저장소에 기록하지 않습니다.</p><noscript>이 화면은 자바스크립트가 필요합니다. 입력 기능은 잠겨 있습니다.</noscript></main></body></html>`;
}

export const PROVIDER_STYLE = `:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:#172133;background:#FFFAF0}*{box-sizing:border-box}body{margin:0;padding:clamp(20px,5vw,64px) 20px}main{max-width:560px;margin:auto;min-width:0}.eyebrow{font-size:13px;letter-spacing:.06em;color:#685640;margin:0 0 16px}h1{font-size:clamp(28px,6vw,36px);font-weight:600;margin:0 0 12px;line-height:1.25}p{line-height:1.65}.intro{margin:0 0 28px}dl{border-top:1px solid #cabea7;padding-top:20px;margin:0 0 28px}dt,.help,.footnote{font-size:14px;color:#655c4b}dd{margin:6px 0 0;overflow-wrap:anywhere}form{margin:0}label{display:block;font-weight:600;font-size:15px;margin:24px 0 10px}input,button{font:inherit;border:1px solid #9a8b73;border-radius:6px;min-height:48px}input{display:block;width:100%;min-width:0;padding:12px;background:#FFFDF7;color:#172133}input[readonly]{background:#F5EFE3;font-size:14px}button{padding:10px 16px;cursor:pointer;background:#F5EFE3;color:#172133;font-weight:600}button:disabled{cursor:default;opacity:.55}button:focus-visible,input:focus-visible,#status:focus-visible{outline:3px solid #80522d;outline-offset:3px}.help{margin:-2px 0 12px}.password-row{display:flex;gap:8px;min-width:0}.password-row input{flex:1}.password-row button{flex:none}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}#submit{background:#172133;color:#FFFAF0;flex:1}.error{color:#8a322b;font-size:14px;margin:10px 0}#status{margin-top:32px;padding:20px 0;border-top:1px solid #cabea7}h2{font-size:19px;font-weight:600;margin:0 0 8px}#status-detail{margin:0}.footnote{margin:12px 0 0;overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:380px){body{padding:24px 16px}.actions button{padding:10px 12px}}`;

export const PROVIDER_SCRIPT = `(() => {
  const get = (id) => document.getElementById(id);
  const form = get('provider-form'), password = get('password'), toggle = get('toggle-password');
  const submit = get('submit'), cancel = get('cancel'), status = get('status');
  const title = get('status-title'), detail = get('status-detail'), warning = get('cleanup-warning'), error = get('input-error');
  const token = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
  let submitted = false, cancelling = false, terminal = false, uncertain = false;
  const messages = {
    customer_provider_prepare_configuration: '검증 설정을 확인하지 못했습니다. 담당자에게 설정 확인을 요청해 주세요.',
    customer_provider_prepare_login_p: '첫 번째 시험 로그인에 실패했습니다. 담당자에게 계정 상태 확인을 요청해 주세요.',
    customer_provider_prepare_login_q: '두 번째 시험 로그인에 실패했습니다. 담당자에게 계정 상태 확인을 요청해 주세요.',
    customer_provider_prepare_session_pair: '두 시험 세션을 확인하지 못했습니다.',
    customer_provider_prepare_probe: '로그인 또는 세션 종료 검증을 통과하지 못했습니다.',
    customer_provider_prepare_cleanup: '시험 세션 종료를 확인하지 못했습니다.',
    customer_provider_prepare_cancelled: '검증을 취소했습니다.',
    customer_provider_prepare_cleanup_unknown: '시험 세션 종료 상태를 확인해 주세요.',
    customer_provider_prepare_transport: '검증 서버와 연결하지 못했습니다.'
  };
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const validReport = (r) => object(r) && ['normalP','normalQ','revokedP','tokenPStillUnexpired','otherQStillActive','cleanupP','cleanupQ'].every(k => typeof r[k] === 'boolean')
    && object(r.dataApi) && ['anonymousRest','authenticatedRest','anonymousRpc','authenticatedRpc'].every(k => Number.isInteger(r.dataApi[k]) && r.dataApi[k] >= 0 && r.dataApi[k] <= 3);
  const passedReport = (r) => validReport(r) && ['normalP','normalQ','revokedP','tokenPStillUnexpired','otherQStillActive','cleanupP','cleanupQ'].every(k => r[k] === true)
    && ['anonymousRest','authenticatedRest','anonymousRpc','authenticatedRpc'].every(k => r.dataApi[k] === 3);
  const lock = () => { password.value = ''; password.type = 'password'; password.disabled = true; toggle.disabled = true;
    toggle.textContent = '표시'; toggle.setAttribute('aria-pressed','false'); submit.disabled = true; };
  const show = (result) => {
    const shape = object(result) && ['passed','failed','cancelled'].includes(result.status)
      && typeof result.cleanupComplete === 'boolean' && typeof result.cleanupUncertain === 'boolean'
      && (result.code === undefined || Object.prototype.hasOwnProperty.call(messages, result.code))
      && (result.report === null || validReport(result.report));
    const incomplete = !shape || result.cleanupComplete !== true || result.cleanupUncertain !== false
      || result.code === 'customer_provider_prepare_cleanup_unknown'
      || (result.status === 'passed' && (result.code !== undefined || !passedReport(result.report)));
    uncertain = uncertain || incomplete;
    if (terminal) { if (uncertain) { warning.hidden = false; title.textContent = '정리 확인 필요'; detail.textContent = '시험 세션 종료 상태를 담당자에게 확인해 주세요.'; } return; }
    terminal = true; lock(); cancel.disabled = true; form.setAttribute('aria-busy','false');
    warning.hidden = !uncertain;
    if (uncertain) { title.textContent = '정리 확인 필요'; detail.textContent = '시험 세션 종료 상태를 담당자에게 확인해 주세요.'; }
    else if (result.status === 'passed') { title.textContent = '검증 통과'; detail.textContent = '로그인과 세션 분리 검증을 통과했습니다. 이번 시험 세션도 모두 종료했습니다.'; }
    else if (result.status === 'cancelled') { title.textContent = '취소'; detail.textContent = '검증을 취소했습니다. 이번에 확인한 시험 세션 정리를 마쳤습니다.'; }
    else { title.textContent = '실패'; detail.textContent = messages[result.code] || '검증을 통과하지 못했습니다. 담당자에게 결과 확인을 요청해 주세요.'; }
    status.focus();
  };
  const request = async (path, payload) => {
    try {
      let body = JSON.stringify(payload); payload.password = undefined;
      const pending = fetch(path, {method:'POST', credentials:'same-origin', cache:'no-store',
        headers: {'Content-Type':'application/json','X-TripMoney-Token':token}, body});
      body = ''; const response = await pending;
      if (!response.ok) throw new Error(); show(await response.json());
    } catch { show(null); }
  };
  toggle.addEventListener('click', () => { if (submitted || cancelling) return; const shown = password.type === 'password';
    password.type = shown ? 'text' : 'password'; toggle.textContent = shown ? '숨김' : '표시'; toggle.setAttribute('aria-pressed',String(shown)); password.focus(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (submitted || cancelling || terminal) return;
    if (!password.value) { error.textContent = '시험 계정 비밀번호를 입력해 주세요.'; password.setAttribute('aria-invalid','true'); password.focus(); return; }
    let value = password.value; submitted = true; lock(); error.textContent = ''; password.removeAttribute('aria-invalid');
    form.setAttribute('aria-busy','true'); title.textContent = '검증 중'; detail.textContent = '로그인과 시험 세션 종료를 확인하고 있습니다.';
    const pending = request('/api/run', {password:value}); value = ''; await pending;
  });
  cancel.addEventListener('click', async () => {
    if (cancelling || terminal) return; cancelling = true; lock(); cancel.disabled = true; form.setAttribute('aria-busy','true');
    title.textContent = '검증 중'; detail.textContent = '취소를 요청했습니다. 시험 세션 종료 결과를 기다리고 있습니다.';
    await request('/api/cancel', {});
  });
  password.disabled = false; toggle.disabled = false; submit.disabled = false; cancel.disabled = false; password.focus();
})();`;
