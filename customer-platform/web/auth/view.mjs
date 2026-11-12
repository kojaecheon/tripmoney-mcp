const views = new WeakMap();
const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
const show = (element, visible) => { element.hidden = !visible; };

function mount(root, actions) {
  // This template is fixed. All response and input values below use textContent/value.
  root.innerHTML = `
    <p id="step-label" class="step-label"></p>
    <h2 id="auth-title" tabindex="-1"></h2>
    <p id="auth-description" class="description"></p>
    <div id="checking-panel"><button id="retry" class="primary" type="button" aria-describedby="busy-note">다시 확인</button></div>
    <form id="email-form" novalidate hidden>
      <div class="field">
        <label for="email">이메일</label>
        <input id="email" name="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" required aria-describedby="email-help email-error busy-note">
        <p id="email-help" class="help">인증번호를 받을 이메일을 입력해 주세요.</p>
        <p id="email-error" class="field-error" hidden></p>
      </div>
      <button id="request" type="submit" class="primary" aria-describedby="busy-note">인증번호 요청</button>
    </form>
    <form id="code-form" novalidate hidden>
      <div class="code-intro"><p><span id="sent-email" class="sent-email"></span><br>이 주소로 로그인합니다.</p>
        <button id="change-email" class="change-email" type="button" aria-describedby="busy-note">이메일 변경</button></div>
      <div class="field">
        <label for="code">인증번호</label>
        <input id="code" name="code" class="code-input" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required aria-describedby="code-help code-error busy-note">
        <p id="code-help" class="help">받은 인증번호를 입력해 주세요.</p>
        <p id="code-error" class="field-error" hidden></p>
      </div>
      <div class="form-actions">
        <button id="verify" type="submit" class="primary" aria-describedby="busy-note">로그인</button>
        <button id="resend" type="button" class="secondary" aria-describedby="countdown busy-note">인증번호 다시 요청</button>
      </div>
      <p id="countdown" class="countdown"></p>
    </form>
    <div id="email-link-panel" hidden><p><span id="link-sent-email" class="sent-email"></span> 주소로 로그인 링크를 요청했습니다.</p><p id="email-link-help"></p><button id="link-change-email" class="secondary" type="button">이메일 변경</button></div>
    <div id="session-panel" hidden>
      <span class="session-tag">로그인 상태</span>
      <dl class="session-details"><div><dt>내 이메일</dt><dd id="session-email"></dd></div><div><dt>로그인 유지 기한</dt><dd><time id="session-expiry"></time></dd></div></dl>
      <div class="form-actions"><button id="session-check" type="button" class="secondary" aria-describedby="busy-note">세션 다시 확인</button><button id="logout" type="button" class="primary" aria-describedby="busy-note">로그아웃</button></div>
    </div>
    <p id="busy-note" class="busy-note"></p>
    <p id="auth-status" class="status" role="status" aria-atomic="true" hidden></p>
    <p id="auth-error" class="error" role="alert" aria-atomic="true" tabindex="-1" hidden></p>`;
  const refs = Object.fromEntries([...root.querySelectorAll('[id]')].map(element => [element.id, element]));
  const handlers = [];
  function on(id, event, handler) { refs[id].addEventListener(event, handler); handlers.push(() => refs[id].removeEventListener(event, handler)); }
  on('email', 'input', event => actions.setEmail(event.target.value));
  on('code', 'input', event => actions.setCode(event.target.value));
  on('email-form', 'submit', event => { event.preventDefault(); void actions.requestCode(); });
  on('code-form', 'submit', event => { event.preventDefault(); void actions.verifyCode(); });
  for (const [id, action] of [['retry', 'bootstrap'], ['change-email', 'changeEmail'], ['link-change-email', 'changeEmail'], ['resend', 'resendCode'], ['session-check', 'checkSession'], ['logout', 'logout']]) on(id, 'click', () => { void actions[action](); });
  const view = { refs, previous: null, pendingFocus: null, destroy() { for (const remove of handlers) remove(); views.delete(root); root.replaceChildren(); } };
  const cancelFocusRestore = event => {
    if (view.pendingFocus && event.target !== view.pendingFocus && !view.pendingFocus.contains(event.target)) view.pendingFocus = null;
  };
  root.ownerDocument.addEventListener('focusin', cancelFocusRestore);
  root.ownerDocument.addEventListener('pointerdown', cancelFocusRestore, true);
  handlers.push(() => root.ownerDocument.removeEventListener('focusin', cancelFocusRestore), () => root.ownerDocument.removeEventListener('pointerdown', cancelFocusRestore, true));
  return view;
}

export function renderAuth(root, state, actions) {
  let view = views.get(root);
  if (!view) { view = mount(root, actions); views.set(root, view); }
  const { refs: r, previous } = view;
  const busy = Boolean(state.busy);
  const phase = state.phase;
  const local=state.config?.mode==='local-demo';
  const emailLink=state.config?.authMethod==='email-link';
  text(r['email-link-help'],'로그인을 요청한 같은 브라우저에서 이메일의 로그인 링크를 열어 주세요. 메일은 자동으로 재발송하지 않습니다.');
  text(r['email-help'],emailLink?'로그인 링크를 받을 본인 이메일을 입력해 주세요.':local?'체험용 주소를 그대로 사용해도 됩니다. 비밀번호는 필요하지 않습니다.':'인증번호를 받을 본인 이메일을 입력해 주세요.');
  text(r['code-help'],local?'로컬 체험 인증번호 123456을 입력해 주세요.':'이메일로 받은 인증번호 6자리를 입력해 주세요.');
  if (busy && !previous?.busy) {
    const active = root.ownerDocument.activeElement;
    view.pendingFocus = root.contains(active) && active?.tagName === 'BUTTON' ? active : null;
  }
  const titles = { checking: ['로그인 확인', '로그인 상태 확인', '이전에 로그인했는지 확인하고 있습니다.'], email: ['01 / 이메일', '이메일로 로그인', '사용할 이메일을 입력하고 인증번호를 요청해 주세요.'], code: ['02 / 인증번호', '인증번호 입력', '실제 메일 발송 없이 로그인 과정을 체험합니다.'], authenticated: ['로그인 완료', '반가워요!', '이 컴퓨터에서 로그인한 상태를 확인할 수 있습니다.'] };
  if(emailLink){titles.email=['01 / 이메일','이메일로 로그인','사용할 이메일을 입력하고 로그인 링크를 요청해 주세요.'];titles.code=['02 / 로그인 링크','이메일의 로그인 링크를 열어 주세요','로그인을 요청한 같은 브라우저에서 이메일의 로그인 링크를 열어 주세요.'];}
  const [step, title, baseDescription] = titles[phase];
  const description=phase==='code'&&!local&&!emailLink?'이메일에서 인증번호를 확인해 주세요.':baseDescription;
  text(r['step-label'], step); text(r['auth-title'], title); text(r['auth-description'], description);
  show(r['checking-panel'], phase === 'checking'); show(r['email-form'], phase === 'email'); show(r['code-form'], phase === 'code'&&!emailLink); show(r['email-link-panel'],phase==='code'&&emailLink);text(r['link-sent-email'],phase==='code'&&emailLink?state.email:''); show(r['session-panel'], phase === 'authenticated');
  show(r.retry, phase === 'checking' && Boolean(state.error));
  for (const id of ['email-form', 'code-form', 'session-panel', 'checking-panel']) r[id].setAttribute('aria-busy', String(busy));
  for (const id of ['email', 'code']) {
    if (r[id].value !== state[id]) r[id].value = state[id];
    r[id].readOnly = busy;
    const fieldError = state.error?.field === id ? state.error.message : '';
    r[id].setAttribute('aria-invalid', String(Boolean(fieldError)));
    text(r[`${id}-error`], fieldError); show(r[`${id}-error`], Boolean(fieldError));
  }
  text(r['sent-email'], phase === 'code' ? state.email : '');
  text(r['session-email'], state.me?.email ?? '');
  const date = state.me ? new Date(state.me.expiresAt) : null;
  text(r['session-expiry'], date ? `${new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(date)} (한국 시간)` : '');
  if (state.me) r['session-expiry'].dateTime = state.me.expiresAt; else r['session-expiry'].removeAttribute('datetime');
  for (const id of ['request', 'verify', 'resend', 'change-email', 'retry', 'session-check', 'logout']) r[id].disabled = busy || (emailLink&&['verify','resend'].includes(id)) || (id === 'resend' && state.remainingSeconds > 0);
  text(r.request, emailLink?(state.busy === 'request'?'로그인 링크 준비 중…':'로그인 링크 요청'):state.busy === 'request' ? '인증번호 준비 중…' : '인증번호 요청');
  text(r.verify, state.busy === 'verify' ? '로그인 확인 중…' : '로그인');
  text(r.resend, state.busy === 'resend' ? '인증번호 준비 중…' : state.remainingSeconds > 0 ? `인증번호 다시 요청 (${state.remainingSeconds}초)` : '인증번호 다시 요청');
  text(r['session-check'], state.busy === 'session' ? '세션 확인 중…' : '세션 다시 확인');
  text(r.logout, state.busy === 'logout' ? '로그아웃 중…' : '로그아웃');
  text(r.countdown, state.remainingSeconds > 0 ? '인증번호를 요청한 뒤 60초가 지나면 다시 요청할 수 있습니다.' : '필요하면 새 인증번호를 요청할 수 있습니다.');
  text(r['busy-note'], busy ? '처리 중입니다. 완료될 때까지 입력과 버튼을 잠시 사용할 수 없습니다.' : ''); show(r['busy-note'], busy);
  text(r['auth-status'], state.status); show(r['auth-status'], Boolean(state.status));
  text(r['auth-error'], state.error?.message ?? ''); show(r['auth-error'], Boolean(state.error));
  if (previous && (previous.phase !== phase || (phase === 'code' && previous.resendAt !== state.resendAt))) {
    if (phase === 'code') (emailLink?r['auth-title']:r.code).focus();
    else if (phase === 'email') r.email.focus();
    else if (phase === 'authenticated') r['auth-title'].focus();
  } else if (state.error && state.error !== previous?.error) {
    const target = state.error.field && !r[`${state.error.field}-form`]?.hidden ? r[state.error.field] : r['auth-error'];
    if (target && root.ownerDocument.activeElement !== target) target.focus();
  } else if (previous?.busy && !busy && view.pendingFocus) {
    const active = root.ownerDocument.activeElement;
    if (active === root.ownerDocument.body && !view.pendingFocus.disabled && !view.pendingFocus.hidden) view.pendingFocus.focus();
  }
  if (!busy || previous?.phase !== phase) view.pendingFocus = null;
  view.previous = state;
  return view;
}
