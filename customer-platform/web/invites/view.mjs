const views=new WeakMap();
export function renderInvite(root,state,actions) {
 let view=views.get(root);
 if(!view){
  root.innerHTML=`<h2 id="invite-title" tabindex="-1">받은 초대</h2><p id="invite-notice" class="help"></p><div id="invite-summary" hidden><p id="invite-trip-name"></p><p id="invite-meta" class="help"></p></div><form id="accept-form" hidden novalidate><div class="field"><label for="invite-alias">이 여행에서 쓸 별칭</label><input id="invite-alias" name="alias" maxlength="40" required autocomplete="nickname" aria-describedby="invite-alias-help invite-alias-error"><p class="help" id="invite-alias-help">동행자에게 표시할 이름을 40자 이내로 입력해 주세요.</p><p id="invite-alias-error" class="field-error" hidden></p></div><button id="accept-invite" class="primary" type="submit">여행 참여 수락</button></form>`;
  const r=Object.fromEntries([...root.querySelectorAll('[id]')].map(n=>[n.id,n]));
  const input=()=>actions.setAlias(r['invite-alias'].value);const submit=e=>{e.preventDefault();void actions.acceptInvite();};
  r['invite-alias'].addEventListener('input',input);r['accept-form'].addEventListener('submit',submit);
  view={r,previous:null,destroy(){r['invite-alias'].removeEventListener('input',input);r['accept-form'].removeEventListener('submit',submit);root.replaceChildren();views.delete(root);}};views.set(root,view);
 }
 const r=view.r;const pending=state.accountId&&state.invite?.state==='pending';
 root.hidden=!state.inviteNotice&&!state.invite;
 r['invite-notice'].textContent=state.inviteNotice||'참여할 여행과 역할을 확인해 주세요.';
 r['invite-summary'].hidden=!pending;r['accept-form'].hidden=!pending;
 r['invite-trip-name'].textContent=pending?state.invite.tripName:'';
 r['invite-meta'].textContent=pending?`${state.invite.role==='editor'?'편집자':'조회자'} · 초대 기한 ${new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date(state.invite.expiresAt))} (한국 시간)`:'';
 if(r['invite-alias'].value!==state.alias)r['invite-alias'].value=state.alias;
 r['invite-alias'].readOnly=Boolean(state.busy);r['accept-invite'].disabled=Boolean(state.busy)||Boolean(state.conflict)||Boolean(state.pendingKind);r['accept-form'].setAttribute('aria-busy',String(Boolean(state.busy)));
 const error=state.error?.scope==='accept'&&state.error?.field==='alias'&&pending?state.error.message:'';r['invite-alias-error'].textContent=error;r['invite-alias-error'].hidden=!error;r['invite-alias'].setAttribute('aria-invalid',String(Boolean(error)));
 if(error&&state.error!==view.previous?.error)r['invite-alias'].focus();
 else if(pending&&view.previous?.invite?.state!=='pending')r['invite-title'].focus();
 view.previous=state;return view;
}
