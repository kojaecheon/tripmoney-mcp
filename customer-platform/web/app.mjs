import { createApi } from './api.mjs';
import { createAuthController } from './auth/controller.mjs';
import { renderAuth } from './auth/view.mjs';
import { createTravelController, readInviteFragment } from './travel/controller.mjs';
import { renderTravel } from './travel/view.mjs';
import { renderInvite } from './invites/view.mjs';
import { createLedgerController, createTravelRefreshQueue, createTripChangesController } from './ledger/controller.mjs';
import { renderLedger } from './ledger/view.mjs';
import {mountMaps,createGoogleSdkLoader} from './maps/view.mjs';
import {mountDrafts} from './drafts/view.mjs';
import {createPlanningRecovery} from './planning-recovery.mjs';
import {mountRecommendation} from './recommendation/view.mjs';
import {mountKakaoChannel} from './kakao-local/view.mjs';

const callbackResult=window.location.pathname==='/auth/callback'?await (await import('./auth/email-link.mjs')).completeEmailLink({location:window.location,history:window.history}):{status:'idle'};
if(callbackResult.status==='error'){
 const notice=document.getElementById('login-link-notice');
 if(notice){notice.textContent='로그인 링크를 확인하지 못했습니다. 요청한 브라우저에서 다시 로그인해 주세요.';notice.hidden=false;}
}
if(callbackResult.status!=='success')startApp();
function startApp(){
const api = createApi();
const notices = typeof BroadcastChannel === 'function' ? new BroadcastChannel('tripmoney-account') : null;
// Each tab checks its own cookie after a successful authentication change.
const authApi = {
  ...api,
  async verifyCode(code) {
    const result = await api.verifyCode(code);
    notices?.postMessage('changed');
    return result;
  },
  async logout() {
    await api.logout();
    notices?.postMessage('changed');
  },
};
const authRoot = document.getElementById('auth');
const travelRoot = document.getElementById('travel');
const inviteRoot = document.getElementById('received-invite');
let auth, authView, travelView, inviteView, ledgerView, unsubscribeAuth;
let disposed = false, accountId = null;

function reconnect() {
  queueMicrotask(() => { if (!disposed) connectAuth(); });
}
const travel = createTravelController(api, {onUnauthorized: reconnect});
const travelRefresh = createTravelRefreshQueue(travel);
const ledger = createLedgerController(api, {
  onUnauthorized() {
    void travel.setAccount(null);
    reconnect();
  },
  onChanged: travelRefresh.request,
  onUnavailable: travelRefresh.request,
});
const changes = createTripChangesController(api, {
  onChanged(account, tripId, revision) {
    if (!isCurrentChangesContext(account, tripId)) return;
    travelRefresh.request(account, tripId, revision);
    void ledger.refresh();
  },
  onUnavailable(account, tripId) {
    if (!isCurrentChangesContext(account, tripId)) return;
    const refresh = () => { if (isCurrentChangesContext(account, tripId)) void ledger.refresh(); };
    void recheckSession().then(refresh, refresh);
  },
});
function isCurrentChangesContext(account, tripId) {
  return !disposed && ledger.state.accountId === account && ledger.state.tripId === tripId;
}
const mapsRoot=document.getElementById('maps-slot');
const draftsRoot=document.getElementById('drafts-slot');
const recoverPlanning=createPlanningRecovery({travel,ledger});
const onPlanningUnavailable=()=>{void recoverPlanning();};
const maps=mountMaps(mapsRoot,{api,onSelect:candidate=>ledger.applyPlace(candidate),onUnauthorized:onPlanningUnavailable});
const googleSdkLoader=createGoogleSdkLoader({document,window,allowNetwork:true});
const drafts=mountDrafts(draftsRoot,{api,onApply:draft=>ledger.applyDraft(draft),onUnauthorized:onPlanningUnavailable});
const recommendationRoot=document.getElementById('recommendation-slot');
const kakaoRoot=document.getElementById('kakao-slot');
function onPlanningSaved(account,tripId,revision) {
  if(disposed)return;
  travelRefresh.request(account,tripId,revision);
  if(ledger.state.accountId===account&&ledger.state.tripId===tripId)void ledger.refresh();
}
const recommendation=mountRecommendation(recommendationRoot,{api,onSaved:onPlanningSaved,onUnauthorized:onPlanningUnavailable});
const kakaoChannel=mountKakaoChannel(kakaoRoot,{api,onSaved:onPlanningSaved,onUnauthorized:onPlanningUnavailable});

function consumeFragment(initial = false) {
  if (window.location.pathname !== '/invite') return;
  const hasToken = new URLSearchParams(window.location.hash.slice(1)).has('t');
  if (hasToken || initial) void travel.setInviteToken(readInviteFragment(window.location, window.history));
}
function onHashChange() { consumeFragment(); }
consumeFragment(true);
window.addEventListener('hashchange', onHashChange);

const unsubscribeTravel = travel.subscribe(state => {
  travelView = renderTravel(travelRoot, state, travel);
  inviteView = renderInvite(inviteRoot, state, travel);
  void ledger.setContext(state.accountId, state.trip);
  travelRefresh.sync();
});
const unsubscribeLedger = ledger.subscribe(state => {
  changes.setContext({accountId:state.accountId,tripId:state.tripId,revision:state.ledger?.revision ?? null});
  ledgerView = renderLedger(document.getElementById('ledger-slot'), state, ledger);
  const context={accountId:state.accountId,tripId:state.tripId,ledger:state.ledger,day:state.day};
  mapsRoot.hidden=draftsRoot.hidden=!state.ledger;
  maps.updateContext(context);
  drafts.updateContext(context);
  recommendationRoot.hidden=!state.ledger;
  recommendation.updateContext(context);
  kakaoChannel.updateContext({...context,tripName:travel.state.trip?.id===state.tripId?travel.state.trip.name:''});
});

function connectAuth() {
  unsubscribeAuth?.();
  auth?.destroy();
  authView?.destroy();
  accountId = null;
  void ledger.setContext(null, null);
  auth = createAuthController(authApi);
  unsubscribeAuth = auth.subscribe(state => {
    authView = renderAuth(authRoot, state, auth);
    changes.configure(state.config?.changes?.mode === 'long-poll');
    kakaoChannel.configure(state.config);
    const demo=state.config?.mode==='local-demo';
    const label=document.getElementById('mode-label'),notice=document.getElementById('mode-notice');
    if(label)label.textContent=state.config?(demo?'로컬 체험':'내 여행'):'';
    if(notice)notice.textContent=!state.config?'로그인 방식을 확인하고 있습니다.':demo?'로컬 체험입니다. 실제 메일은 보내지 않으며 인증번호는 123456입니다. 여행과 로그인 정보는 메모리에 저장되어 서버를 다시 시작하면 초기화됩니다. 서로 다른 example.invalid 이메일로 동행자 체험을 할 수 있습니다.':state.config.mailDelivery?'이메일로 로그인하고 동행자와 여행 일정과 경비를 함께 관리하세요.':'로그인 메일 연결을 준비하고 있습니다. 연결 전에는 인증번호를 발송하지 않습니다.';
    const signedIn = state.phase === 'authenticated' && state.me;
    const google=state.config?.maps;
    maps.configureGoogle(signedIn&&google?{allowNetwork:true,browserApiKey:google.browserApiKey,mapId:google.mapId,allowedOrigins:[window.location.origin],loader:googleSdkLoader}:null);
    document.body.classList.toggle('signed-in', Boolean(signedIn));
    authRoot.setAttribute('aria-label', signedIn ? '내 로그인 정보' : '로그인');
    const next = signedIn ? state.me.userId : null;
    if (accountId !== next) {
      accountId = next;
      if (!next) void ledger.setContext(null, null);
      void travel.setAccount(next);
      if (next) document.getElementById('travel-title')?.focus();
    }
  });
  void auth.bootstrap();
}
async function recheckSession() {
  if (disposed) return;
  if (travel.state.accountId) {
    await travel.recheckAccount();
    return;
  }
  // Ordinary focus does not interrupt an anonymous form.
  const observed = auth;
  if (!observed || observed.state.busy || observed.state.phase === 'checking') return;
  try {
    await api.me();
    if (!disposed && auth === observed && !auth.state.busy && !travel.state.accountId) connectAuth();
  } catch { /* Anonymous tabs stay on the current form. */ }
}
function onVisible() {
  changes.resume();
  if (document.hidden) return;
  void recheckSession();
  void ledger.resume();
}
function onConnectivity() {
  changes.resume();
  if (globalThis.navigator?.onLine !== false && !document.hidden) onVisible();
}
function onAccountNotice(event) { if (event.data === 'changed') void recheckSession(); }
notices?.addEventListener('message', onAccountNotice);
document.addEventListener('visibilitychange', onVisible);
window.addEventListener('focus', onVisible);
window.addEventListener('online', onConnectivity);
window.addEventListener('offline', onConnectivity);
connectAuth();

function cleanup(event) {
  if (disposed) return;
  disposed = true;
  notices?.close();
  window.removeEventListener('hashchange', onHashChange);
  window.removeEventListener('focus', onVisible);
  window.removeEventListener('online', onConnectivity);
  window.removeEventListener('offline', onConnectivity);
  document.removeEventListener('visibilitychange', onVisible);
  unsubscribeAuth?.();
  unsubscribeTravel();
  unsubscribeLedger();
  changes.destroy();
  travelRefresh.destroy();
  ledger.destroy();
  maps.destroy();
  drafts.destroy();
  recommendation.destroy();
  kakaoChannel.destroy();
  ledgerView?.destroy();
  auth?.destroy();
  travel.destroy();
  authView?.destroy();
  travelView?.destroy();
  inviteView?.destroy();
  window.removeEventListener('pagehide', cleanup);
  window.removeEventListener('pageshow', restore);
  if (event?.persisted) window.addEventListener('pageshow', restore, {once: true});
}
function restore(event) { if (event.persisted) window.location.reload(); }
window.addEventListener('pagehide', cleanup);
window.addEventListener('pageshow', restore);

}
