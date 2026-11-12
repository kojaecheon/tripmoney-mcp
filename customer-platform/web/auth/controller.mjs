import { ApiError } from '../api.mjs';

const defaultEmail = 'traveler@example.invalid';
const errorInfo = error => {
  const safe = error instanceof ApiError ? error : new ApiError(0, 'unavailable');
  return { code: safe.code, message: safe.message, ...(safe.field ? { field: safe.field } : {}) };
};

export function createAuthController(api, { now = Date.now } = {}) {
  let state = { phase: 'checking', email: defaultEmail, code: '', error: null, busy: null, resendAt: 0, remainingSeconds: 0, me: null, config: null, status: '로그인 상태를 확인하고 있습니다.' };
  let version = 0; let destroyed = false; let timer = null;
  const listeners = new Set();
  function publish(patch = {}) {
    if (destroyed) return;
    state = { ...state, ...patch, remainingSeconds: Math.max(0, Math.ceil(((patch.resendAt ?? state.resendAt) - now()) / 1000)) };
    for (const listener of listeners) listener(state);
  }
  function stopTimer() { if (timer !== null) { clearInterval(timer); timer = null; } }
  function startTimer() {
    stopTimer();
    timer = setInterval(() => { publish(); if (state.remainingSeconds === 0) stopTimer(); }, 1000);
    timer.unref?.();
  }
  async function run(busy, operation, success, failure) {
    if (destroyed || state.busy) return false;
    const current = ++version;
    publish({ busy, error: null, status: '' });
    try {
      const result = await operation();
      if (destroyed || current !== version) return false;
      success(result); return true;
    } catch (error) {
      if (destroyed || current !== version) return false;
      failure(error); return false;
    } finally { if (!destroyed && current === version) publish({ busy: null }); }
  }
  function signedOut(status) {
    stopTimer();
    publish({ phase: 'email', me: null, email: state.config?.mode==='customer'?'':defaultEmail, code: '', error: null, resendAt: 0, status });
  }
  async function request(resend) {
    const emailLink=state.config?.authMethod==='email-link';
    if ((emailLink&&resend) || state.busy || destroyed || (resend ? state.phase !== 'code' || now() < state.resendAt : state.phase !== 'email')) return false;
    const email = state.email.trim();
    if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
      publish({ error: { code: 'validation', field: 'email', message: '이메일 주소를 확인해 주세요.' }, status: '' }); return false;
    }
    return run(resend ? 'resend' : 'request', () => api.requestCode(email), () => {
      if(emailLink){publish({phase:'code',email,code:'',resendAt:0,status:'로그인을 요청한 같은 브라우저에서 이메일의 로그인 링크를 열어 주세요. 메일은 자동으로 재발송하지 않습니다.'});return;}
      publish({ phase: 'code', email, code: '', resendAt: now() + 60000, status: state.config?.mode==='customer'?'이메일로 받은 인증번호를 입력해 주세요.':resend ? '새 인증번호를 준비했습니다. 123456을 입력해 주세요.' : '인증번호를 준비했습니다. 123456을 입력해 주세요.' });
      startTimer();
    }, error => publish({ error: errorInfo(error), status: '' }));
  }
  const controller = {
    get state() { return state; },
    subscribe(listener) { if (destroyed) return () => {}; listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    bootstrap() {
      if (state.phase !== 'checking') return Promise.resolve(false);
      return run('bootstrap', async () => {
        const config = await api.publicConfig();
        try { return { config, me: (await api.me()).me }; }
        catch (error) { if (error instanceof ApiError && error.status === 401) return { config, me: null }; throw error; }
      }, result => publish({ config: result.config, email:result.config.mode==='customer'?'':defaultEmail,me: result.me, phase: result.me ? 'authenticated' : 'email', status: result.me ? '로그인 상태입니다.' : '' }), error => publish({ error: errorInfo(error), status: '' }));
    },
    setEmail(email) { if (state.phase === 'email' && !state.busy) publish({ email, error: null, status: '' }); },
    setCode(code) { if (state.config?.authMethod!=='email-link' && state.phase === 'code' && !state.busy) publish({ code, error: null, status: '' }); },
    requestCode: () => request(false),
    resendCode: () => request(true),
    verifyCode() {
      if (state.config?.authMethod==='email-link' || state.phase !== 'code' || state.busy || destroyed) return Promise.resolve(false);
      if (!/^\d{6}$/.test(state.code)) { publish({ error: { code: 'validation', field: 'code', message: '인증번호 6자리를 입력해 주세요.' }, status: '' }); return Promise.resolve(false); }
      return run('verify', () => api.verifyCode(state.code), result => {
        stopTimer(); publish({ phase: 'authenticated', me: result.me, code: '', resendAt: 0, status: '로그인했습니다.' });
      }, error => {
        const info = errorInfo(error);
        if (error instanceof ApiError && [401, 422].includes(error.status)) { info.field = 'code'; info.message = '인증번호가 틀렸거나 만료되었습니다. 다시 입력하거나 새 번호를 요청해 주세요.'; }
        publish({ error: info, status: '' });
      });
    },
    changeEmail() {
      if (destroyed || state.phase === 'authenticated') return;
      ++version; stopTimer(); publish({ phase: 'email', code: '', error: null, busy: null, resendAt: 0, status: '이메일 주소를 변경할 수 있습니다.' });
    },
    checkSession() {
      if (state.phase !== 'authenticated') return Promise.resolve(false);
      return run('session', () => api.me(), result => publish({ me: result.me, status: '로그인 상태를 다시 확인했습니다.' }), error => {
        if (error instanceof ApiError && error.status === 401) signedOut('로그인 시간이 끝났습니다. 다시 로그인해 주세요.');
        else publish({ error: errorInfo(error), status: '' });
      });
    },
    logout() {
      if (state.phase !== 'authenticated') return Promise.resolve(false);
      return run('logout', () => api.logout(), () => signedOut('로그아웃했습니다.'), error => publish({ error: errorInfo(error), status: '' }));
    },
    destroy() { destroyed = true; ++version; stopTimer(); listeners.clear(); state = { ...state, me: null, email: '', code: '', busy: null }; },
  };
  return controller;
}
