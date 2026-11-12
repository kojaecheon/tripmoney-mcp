import {createKakaoController} from './controller.mjs';
export function mountKakao(root,{api,onUnauthorized,config}={}) {
 const document=root.ownerDocument;
 if(document.head&&!document.querySelector('link[data-tripmoney-kakao-live]')){
  const style=document.createElement('link');style.rel='stylesheet';style.href='/kakao/style.css';style.setAttribute('data-tripmoney-kakao-live','');document.head.append(style);
 }

 const c=createKakaoController({api,onUnauthorized});
 root.innerHTML=`<div class="kakao-local" aria-labelledby="kakao-live-title">
 <h2 id="kakao-live-title">카카오 개발봇 연결</h2>
 <p>먼저 위 여행 목록에서 연결할 여행을 선택해 주세요. 현재 로그인한 웹 계정으로 직접 승인해야 합니다.</p>
 <p id="kakao-live-trip"></p><p id="kakao-live-state" role="status"></p>
 <p>이 화면에서 받은 승인 기록만 표시합니다. 새로고침하면 기록은 지워지며, 실제 권한과 만료 여부는 요청마다 서버가 확인합니다. 로그아웃하거나 웹 세션이 만료되면 봇 사용도 제한됩니다.</p>
 <button type="button" id="kakao-live-issue">선택한 여행의 연결 코드 발급</button>
 <div id="kakao-live-pair" hidden><p>아래 명령을 복사해 개발봇의 1:1 채팅에 보내세요. 연결 코드를 다른 사람에게 공유하지 마세요.</p><pre id="kakao-live-command"></pre><p id="kakao-live-pair-time"></p></div>
 <p><a id="kakao-live-channel" target="_blank" rel="noopener noreferrer">TripMoney 개발봇 채널 열기</a></p>
 <form id="kakao-live-form"><label for="kakao-live-pending">봇이 반환한 연결 요청 ID</label><input id="kakao-live-pending" autocomplete="off" spellcheck="false" maxlength="36" placeholder="연결 요청 ID를 붙여넣으세요"><p>본인이 방금 대화한 개발봇의 요청인지 확인한 뒤 승인하세요. 이 ID만으로 계정 권한이 생기지 않습니다.</p><button type="submit" id="kakao-live-approve">현재 계정과 선택한 여행으로 연결 승인</button></form>
 <button type="button" id="kakao-live-unlink" disabled>이 승인 기록의 연결 해제</button>
 <h3>카카오 경비 입력</h3><p>날짜, 시각, 제목, 금액과 통화, 결제자 이름, 분담자를 모두 입력해 주세요. KRW는 정수, THB는 소수 둘째 자리까지 사용할 수 있습니다. 분담자는 이름을 쉼표로 구분하거나 전체를 입력하세요. 같은 이름이 있으면 여행의 별칭을 먼저 바꿔 주세요.</p>
 <p id="kakao-live-members"></p><pre id="kakao-live-example"></pre><p>전체는 현재 활성 멤버입니다. 봇이 보여 주는 여행과 검토 카드 내용을 확인하고 별도로 확인 저장을 눌러야 경비가 저장됩니다. 일반 단체방 메시지는 수집하지 않습니다.</p>
 <p id="kakao-live-notice" role="status" hidden></p><p id="kakao-live-error" role="alert" hidden></p></div>`;
 const refs=Object.fromEntries([...root.querySelectorAll('[id]')].filter(n=>n.id.startsWith('kakao-live-')).map(n=>[n.id.slice(11),n]));
 const removers=[];const on=(node,event,fn)=>{node.addEventListener(event,fn);removers.push(()=>node.removeEventListener(event,fn));};
 refs.channel.href=config.channelUrl;
 on(refs.issue,'click',()=>c.issuePair());on(refs.pending,'input',()=>c.setPendingId(refs.pending.value));
 on(refs.form,'submit',event=>{event.preventDefault();return c.approve();});on(refs.unlink,'click',()=>c.unlink());
 const time=value=>new Date(value).toLocaleString('ko-KR',{timeZoneName:'short'});
 const unsub=c.subscribe(state=>{
  const selectable=Boolean(state.accountId&&state.tripId);
  refs.trip.textContent=state.tripId?`선택한 여행: ${state.tripName||'현재 여행'}`:'위 여행 목록에서 여행을 선택해 주세요.';
  refs.state.textContent=state.approval?`서버 승인 기록: ${state.tripName||'현재 여행'}, ${time(state.approval.expiresAt)}까지${state.approvalExpired?' (승인 기한 지남)':''}`:'이 화면에서 확인한 연결 승인이 없습니다.';
  refs.issue.disabled=Boolean(state.busy)||!selectable;
  refs.pair.hidden=!state.pair;refs.command.textContent=state.pair&&!state.pairExpired?`연결 ${state.pair.code}`:'';
  refs['pair-time'].textContent=state.pair?(state.pairExpired?'연결 코드가 만료되었습니다. 새 코드를 발급해 주세요.':`${time(state.pair.expiresAt)}까지 한 번만 사용할 수 있습니다.`):'';
  refs.pending.value=state.pendingId;refs.pending.disabled=Boolean(state.busy)||!selectable;
  refs.approve.disabled=Boolean(state.busy)||!selectable||!state.pendingId;
  refs.unlink.disabled=Boolean(state.busy)||!state.approval;
  refs.members.textContent=`현재 활성 멤버: ${state.members.map(m=>m.alias).join(', ')||'여행 장부를 불러온 뒤 확인할 수 있습니다.'}`;
  const payer=state.members[0]?.alias;
  refs.example.textContent=payer?`경비 ${new Date().toLocaleDateString('sv-SE')} 12:00 | 점심 | 12000 KRW | ${payer} | 전체`:'활성 멤버 이름을 확인하면 경비 입력 예시를 표시합니다.';
  refs.notice.textContent=state.busy?'처리 중입니다.':state.notice;refs.notice.hidden=!state.busy&&!state.notice;
  refs.error.textContent=state.error;refs.error.hidden=!state.error;root.setAttribute('aria-busy',String(Boolean(state.busy)));
 });
 return {updateContext:context=>c.updateContext(context),destroy(){unsub();c.destroy();for(const remove of removers)remove();root.replaceChildren();}};
}
