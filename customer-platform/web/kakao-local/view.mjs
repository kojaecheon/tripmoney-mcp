import {createKakaoLocalController} from './controller.mjs';
import {scheduleLabels,expenseLabels} from '../ledger/forms.mjs';

const labelInput=(key,label,type='text',extra='')=>`<div class="field"><label for="kakao-local-${key}">${label}</label><input id="kakao-local-${key}" type="${type}" ${extra}></div>`;
const labelSelect=(key,label)=>`<div class="field"><label for="kakao-local-${key}">${label}</label><select id="kakao-local-${key}"></select></div>`;
export function mountKakaoLocal(root,{api,onSaved,onUnauthorized}) {
 root.innerHTML=`<section class="kakao-local" aria-labelledby="kakao-local-heading">
  <h2 id="kakao-local-heading">카카오 연결 방식 체험</h2>
  <p id="kakao-local-disclaimer" class="help"></p>
  <p id="kakao-local-state"></p>
  <div class="kakao-local-actions"><button id="kakao-local-issue" type="button">연결 코드 발급</button><button id="kakao-local-unlink" class="secondary" type="button">연결 해제</button></div>
  <form id="kakao-local-pair-form" hidden><label for="kakao-local-code">이 계정의 연결 코드</label><input id="kakao-local-code" autocomplete="off" spellcheck="false"><p id="kakao-local-pair-time" class="help"></p><button id="kakao-local-connect" type="submit">합성 연결 확인</button></form>
  <div id="kakao-local-work" hidden>
   ${labelSelect('trip','기록할 여행')}
   <button id="kakao-local-refresh" class="secondary" type="button">여행 목록 새로고침</button>
   <form id="kakao-local-message-form"><label for="kakao-local-message">일정 또는 경비 메시지</label><textarea id="kakao-local-message" maxlength="2000" rows="3" aria-describedby="kakao-local-examples"></textarea><p id="kakao-local-examples" class="help">예문: 내일 오전 10시 왕궁 방문 · 점심 300바트 · 택시 15000원</p><button id="kakao-local-prepare" type="submit">초안 만들기</button></form>
   <form id="kakao-local-edit" hidden><h3 id="kakao-local-draft-heading"></h3><p class="help">빈 항목을 직접 입력해 주세요. 결제자와 분담자는 자동 선택하지 않습니다.</p>
    ${labelInput('title','이름','text','maxlength="100" required')}
    <div id="kakao-local-schedule" class="kakao-local-grid">${labelInput('date',scheduleLabels.date,'date','required')}${labelInput('startTime',scheduleLabels.startTime,'time')}${labelInput('endTime',scheduleLabels.endTime,'time')}${labelInput('place',scheduleLabels.place,'text','maxlength="200"')}${labelInput('budgetKrw',scheduleLabels.budgetKrw,'text','inputmode="numeric" required')}</div>
    <div id="kakao-local-expense" class="kakao-local-grid">${labelInput('occurredLocal',expenseLabels.occurredLocal,'datetime-local','required')}${labelSelect('itineraryId',expenseLabels.itineraryId)}${labelSelect('currency',expenseLabels.currency)}${labelInput('amount',expenseLabels.amount,'text','inputmode="decimal" required')}${labelSelect('payerId',expenseLabels.payerId)}<fieldset><legend>분담자</legend><div id="kakao-local-splits" class="kakao-local-splits"></div></fieldset></div>
    <button id="kakao-local-review" type="submit">내용 검토</button>
   </form>
   <section id="kakao-local-preview" class="kakao-local-preview" hidden aria-labelledby="kakao-local-review-heading"><h3 id="kakao-local-review-heading">저장 전 확인</h3><p id="kakao-local-review-trip"></p><dl id="kakao-local-review-details"></dl><p id="kakao-local-review-time" class="help"></p><button id="kakao-local-confirm" type="button">확인 저장</button></section>
   <button id="kakao-local-cancel" class="secondary" type="button">작성 취소</button>
  </div>
  <p id="kakao-local-notice" role="status" aria-live="polite"></p><p id="kakao-local-error" role="alert" hidden></p>
 </section>`;
 const refs=Object.fromEntries([...root.querySelectorAll('[id]')].map(node=>[node.id.replace('kakao-local-',''),node]));
 const doc=root.ownerDocument,c=createKakaoLocalController({api,onSaved,onUnauthorized}),removers=[];
 const on=(node,event,fn)=>{node.addEventListener(event,fn);removers.push(()=>node.removeEventListener(event,fn));};
 const submit=fn=>async event=>{event.preventDefault();return fn();};
 const setValue=(node,value)=>{if(node.value!==String(value??''))node.value=String(value??'');};
 function options(node,rows,value) {
  const signature=JSON.stringify(rows);
  if(node.kakaoOptions!==signature){node.kakaoOptions=signature;node.replaceChildren(...rows.map(row=>{const option=doc.createElement('option');option.value=row.id;option.textContent=row.label;return option;}));}
  setValue(node,value);
 }
 refs.disclaimer.textContent='현재 로그인한 계정만 사용하는 로컬 합성 체험입니다. 다른 브라우저나 새 로그인에서는 연결을 다시 확인해 주세요. 실제 카카오 연결이나 일반 단체방 메시지 읽기 기능은 제공하지 않습니다.';
 on(refs.issue,'click',()=>c.issuePair());on(refs.unlink,'click',()=>c.unlink());
 on(refs['pair-form'],'submit',submit(()=>c.connect(refs.code.value.trim())));
 on(refs.trip,'change',()=>c.selectTrip(refs.trip.value));
 on(refs.refresh,'click',()=>c.refresh());
 on(refs.message,'input',()=>c.setMessage(refs.message.value));
 on(refs['message-form'],'submit',submit(()=>c.prepare()));
 on(refs.edit,'submit',submit(()=>c.review()));on(refs.confirm,'click',()=>c.confirm());on(refs.cancel,'click',()=>c.cancel());
 for(const key of ['title','date','startTime','endTime','place','budgetKrw','occurredLocal','itineraryId','currency','amount','payerId']) {
  on(refs[key],['itineraryId','currency','payerId'].includes(key)?'change':'input',()=>c.setField(key,key==='itineraryId'?(refs[key].value||null):refs[key].value));
 }
 let splitSignature='',splitNodes=[];
 const clock=value=>new Date(value).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
 const unsubscribe=c.subscribe(state=>{
  const active=state.status.linked,editable=state.ledger&&['owner','editor'].includes(state.ledger.role);
  refs.state.textContent=active?`합성 연결 중 · ${clock(state.status.expiresAt)}까지`:'연결 코드로 로컬 체험을 시작하세요.';
  refs.issue.disabled=state.busy||!state.accountId;refs.unlink.disabled=state.busy||!active;
  refs['pair-form'].hidden=!state.pair;if(state.pair&&refs.code.pair!==state.pair.code){refs.code.pair=state.pair.code;setValue(refs.code,state.pair.code);}
  refs['pair-time'].textContent=state.pair?`${clock(state.pair.expiresAt)}까지 한 번만 사용할 수 있습니다.`:'';
  refs.connect.disabled=state.busy;refs.work.hidden=!active;
  options(refs.trip,[{id:'',label:'여행 선택'},...state.status.trips.map(trip=>({id:trip.id,label:trip.name}))],state.status.tripId);
  refs.trip.disabled=state.busy;
  refs.refresh.disabled=state.busy||!active;
  setValue(refs.message,state.message);refs.message.disabled=state.busy||Boolean(state.draft)||!editable;
  refs.prepare.disabled=state.busy||!editable||Boolean(state.draft)||!state.message.trim();
  refs.edit.hidden=!state.draft;refs['draft-heading'].textContent=state.draft?.kind==='schedule'?'일정 입력':'경비 입력';
  refs.schedule.hidden=state.draft?.kind!=='schedule';refs.expense.hidden=state.draft?.kind!=='expense';
  const members=state.ledger?.members.filter(member=>member.active&&member.role!=='viewer')??[];
  options(refs.payerId,[{id:'',label:'결제자 선택'},...members.map(member=>({id:member.id,label:member.alias}))],state.fields?.payerId);
  options(refs.currency,[{id:'',label:'통화 선택'},{id:'KRW',label:'원 (KRW)'},{id:'THB',label:'바트 (THB)'}],state.fields?.currency);
  options(refs.itineraryId,[{id:'',label:'미지정 공통 경비'},...(state.ledger?.items??[]).filter(item=>item.status==='active').map(item=>({id:item.id,label:item.title}))],state.fields?.itineraryId);
  const signature=JSON.stringify(members.map(member=>[member.id,member.alias]));
  if(signature!==splitSignature){splitSignature=signature;splitNodes=[];refs.splits.replaceChildren(...members.map(member=>{
   const label=doc.createElement('label'),checkbox=doc.createElement('input'),text=doc.createElement('span');checkbox.type='checkbox';checkbox.value=member.id;text.textContent=member.alias;
   checkbox.addEventListener('change',()=>c.setField('splitIds',splitNodes.filter(node=>node.checked).map(node=>node.value)));splitNodes.push(checkbox);label.append(checkbox,text);return label;
  }));}
  for(const checkbox of splitNodes){checkbox.checked=state.fields?.splitIds?.includes(checkbox.value)??false;checkbox.disabled=state.busy||Boolean(state.operationId)||!editable;}
  for(const key of ['title','date','startTime','endTime','place','budgetKrw','occurredLocal','itineraryId','currency','amount','payerId']) {
   const input=refs[key];setValue(input,state.fields?.[key]);input.disabled=state.busy||Boolean(state.operationId)||!editable||
    (['date','startTime','endTime','place','budgetKrw'].includes(key)?state.draft?.kind!=='schedule':key!=='title'&&state.draft?.kind!=='expense');
  }
  refs.date.min=state.ledger?.startDate??'';refs.date.max=state.ledger?.endDate??'';
  refs.occurredLocal.min=(state.ledger?.startDate??'')+'T00:00';refs.occurredLocal.max=(state.ledger?.endDate??'')+'T23:59';
  refs.review.disabled=state.busy||state.stale||!editable||Boolean(state.operationId);
  refs.preview.hidden=!state.confirmation;refs.confirm.disabled=state.busy||!state.confirmation||!editable;
  refs.confirm.textContent=state.operationId?'저장 결과 다시 확인':'확인 저장';refs.cancel.disabled=state.busy||(!state.draft&&!state.message);
  refs['review-trip'].textContent=state.confirmation?`기록할 여행: ${state.confirmation.tripName}`:'';
  refs['review-time'].textContent=state.confirmation?`${clock(state.confirmation.expiresAt)}까지 확인해 주세요.`:'';
  const details=state.confirmation?Object.entries(state.confirmation.input).filter(([key])=>key!=='refreshRate'&&key!=='placeRef'):[];
  refs['review-details'].replaceChildren(...details.flatMap(([key,value])=>{
   const term=doc.createElement('dt'),description=doc.createElement('dd');term.textContent=({...scheduleLabels,...expenseLabels})[key]??key;
   const memberName=id=>members.find(member=>member.id===id)?.alias??'참여 상태 확인 필요';
   description.textContent=key==='payerId'?memberName(value):key==='splitIds'?value.map(memberName).join(', '):key==='itineraryId'?(state.ledger?.items.find(item=>item.id===value)?.title??'미지정 공통 경비'):key==='budgetKrw'?`${Number(value).toLocaleString('ko-KR')}원`:String(value??'');return [term,description];
  }));
  refs.notice.textContent=state.busy?'처리 중입니다.':state.notice;refs.notice.hidden=!state.busy&&!state.notice;
  refs.error.textContent=state.error;refs.error.hidden=!state.error;root.setAttribute('aria-busy',String(state.busy));
 });
 return {updateContext:context=>c.updateContext(context),destroy(){unsubscribe();c.destroy();for(const remove of removers)remove();root.replaceChildren();}};
}

// This facade lives on a legacy allowlisted path so refreshing an existing
// in-memory demo never depends on assets introduced by the live server.
export function mountKakaoChannel(root,options={}) {
 let mounted=null,mode=null,context={},destroyed=false,generation=0,loading=null,loadError=false;
 const visibility=()=>{root.hidden=(!mounted&&!loadError)||!context.accountId;};
 return {
  configure(config) {
   if(destroyed)return;
   const k=config?.channels?.kakao;
   const validLive=config?.mode==='customer'&&k?.mode==='development'&&k.channelUrl==='https://pf.kakao.com/_xjvDxeX'&&k.botName==='TripMoney 개발봇';
   const next=validLive?'development':config?.mode==='local-demo'&&!config.channels?'local-demo':null;
   if(next===mode){visibility();return loading;}
   const current=++generation;mounted?.destroy();mounted=null;mode=next;loadError=false;loading=null;
   root.replaceChildren();root.setAttribute('aria-label',next==='development'?'카카오 개발봇 연결':'카카오 연결 합성 체험');
   if(next==='local-demo'){mounted=mountKakaoLocal(root,options);mounted.updateContext(context);}
   else if(next==='development')loading=import('../kakao/view.mjs').then(({mountKakao})=>{
    if(destroyed||current!==generation)return;
    mounted=mountKakao(root,{...options,config:k});
    // Read the latest context after the module arrives, never the account or
    // trip captured when loading began. Controllers keep their existing guards.
    mounted.updateContext(context);visibility();
   }).catch(()=>{
    if(destroyed||current!==generation)return;
    loadError=true;root.textContent='카카오 연결 화면을 불러오지 못했습니다. 새로고침해 주세요.';visibility();
   });
   visibility();return loading;
  },
  updateContext(value){if(destroyed)return;context=value;mounted?.updateContext(value);visibility();},
  destroy(){destroyed=true;generation++;mounted?.destroy();mounted=null;context={};root.replaceChildren();root.hidden=true;},
 };
}
