import {draftCommand} from '../ledger/forms.mjs';

const emptyStatus=()=>({source:'synthetic',linked:false,expiresAt:null,tripId:null,trips:[]});
const canEdit=ledger=>ledger&&['owner','editor'].includes(ledger.role);
const messages={account_changed:'로그인 계정이 바뀌었습니다. 다시 확인해 주세요.',unauthenticated:'다시 로그인해 주세요.',forbidden:'연결 시간 또는 편집 권한을 확인해 주세요.',not_found:'여행 참여 상태를 확인해 주세요.',conflict:'장부가 변경되었습니다. 내용을 취소한 뒤 새 초안을 만들어 주세요.',validation:'입력한 날짜, 금액과 동행자를 확인해 주세요.',rate_limited:'잠시 후 다시 시도해 주세요.',unavailable:'연결 체험을 잠시 사용할 수 없습니다.'};
function fieldsFor(draft) {
 const blank=draft.kind==='schedule'?{date:'',startTime:'',endTime:'',title:'',place:'',budgetKrw:''}:
  {title:'',occurredLocal:'',itineraryId:null,currency:'',amount:'',payerId:'',splitIds:[],refreshRate:false};
 const fields={...blank,...draft.fields};
 if(draft.kind==='schedule')fields.budgetKrw=Object.hasOwn(draft.fields,'budgetKrw')?String(draft.fields.budgetKrw):'';
 else {fields.payerId='';fields.splitIds=[];}
 return fields;
}
export function createKakaoLocalController({api,onSaved=()=>{},onUnauthorized=()=>{},now=Date.now}) {
 const state={accountId:null,status:emptyStatus(),pair:null,ledger:null,message:'',draft:null,fields:null,confirmation:null,operationId:null,busy:false,error:'',notice:'',stale:false};
 const listeners=new Set();let epoch=0,destroyed=false;
 const emit=()=>{if(!destroyed)for(const listener of listeners)listener(state);};
 const valid=(version,account)=>!destroyed&&version===epoch&&account===state.accountId;
 function clearDraft() {state.draft=null;state.fields=null;state.confirmation=null;state.operationId=null;state.stale=false;}
 function interrupt() {epoch++;state.busy=false;}
 function tick() {
  const time=now();let changed=false;
  if(state.pair&&Date.parse(state.pair.expiresAt)<=time){state.pair=null;changed=true;}
  if(state.status.linked&&Date.parse(state.status.expiresAt)<=time){interrupt();state.status=emptyStatus();state.ledger=null;clearDraft();state.error='연결 시간이 끝났습니다. 다시 연결해 주세요.';changed=true;}
  if(state.draft&&Date.parse(state.draft.expiresAt)<=time){interrupt();clearDraft();state.error='초안 시간이 끝났습니다. 다시 만들어 주세요.';changed=true;}
  if(state.confirmation&&Date.parse(state.confirmation.expiresAt)<=time){interrupt();state.confirmation=null;state.operationId=null;state.error='확인 시간이 끝났습니다. 내용을 다시 검토해 주세요.';changed=true;}
  if(changed)emit();
 }
 const timer=setInterval(tick,1000);timer.unref?.();
 async function task(work) {
  tick();if(destroyed||state.busy||!state.accountId)return false;
  const version=epoch,account=state.accountId;state.busy=true;state.error='';state.notice='';emit();
  const live=()=>valid(version,account);
  try {await work(account,live);return live();}
  catch(error) {
   if(!live())return false;
   state.error=error?.field==='settlementLocked'?'정산이 확정된 기간에는 경비를 등록할 수 없습니다.':messages[error?.code]??'요청 결과를 확인하지 못했습니다. 같은 버튼으로 다시 시도해 주세요.';
   if(['forbidden','not_found','conflict','unauthenticated','account_changed'].includes(error?.code)){state.confirmation=null;state.operationId=null;state.stale=true;}
   if([401,403,404,412].includes(error?.status)||['unauthenticated','forbidden','not_found','account_changed'].includes(error?.code))onUnauthorized(error);
   return false;
  } finally {if(live()){state.busy=false;emit();}}
 }
 async function loadLedger(tripId,account,live) {
  if(!tripId)return null;
  const ledger=await api.getLedger(tripId,account);
  if(!live())return null;
  if(ledger.tripId!==tripId)throw {code:'not_found'};
  return ledger;
 }
 function editable(ledger) {if(!canEdit(ledger))throw {code:'forbidden'};}
 const controller={state,
  subscribe(fn){listeners.add(fn);fn(state);return()=>listeners.delete(fn);},
  updateContext(next) {
   if(destroyed)return;
   const accountChanged=next.accountId!==state.accountId;
   const revisionChanged=next.ledger?.tripId===state.status.tripId&&
    (next.ledger?.revision!==state.ledger?.revision||next.ledger?.role!==state.ledger?.role);
   // The channel selects its own trip. Navigating elsewhere in the main app
   // must preserve its in-progress input and an ambiguous save's operation ID.
   if(accountChanged){interrupt();clearDraft();state.message='';state.error='';state.notice='';}
   if(accountChanged){state.accountId=next.accountId;state.status=emptyStatus();state.pair=null;state.ledger=null;emit();if(next.accountId)void controller.refresh();return;}
   if(revisionChanged&&next.ledger?.tripId===state.status.tripId) {
    // Ambiguous confirmation retries keep the same operation and token, allowing
    // the server to return its existing receipt despite a newer revision.
    if(!state.operationId){interrupt();state.confirmation=null;if(state.draft)state.stale=true;}
    state.ledger={...next.ledger};
    if(!canEdit(next.ledger)){interrupt();state.confirmation=null;state.operationId=null;state.stale=true;}
    if(state.draft&&!state.operationId)state.error='장부가 변경되었습니다. 입력한 내용을 확인한 뒤 취소하고 다시 만들어 주세요.';
   }
   emit();
  },
  refresh(){return task(async(account,live)=>{
   const status=await api.kakaoStatus(account);if(!live())return;
   const ledger=await loadLedger(status.tripId,account,live);if(!live())return;
   if(status.tripId!==state.status.tripId||!status.linked)clearDraft();state.status=status;state.ledger=ledger;
  });},
  issuePair(){return task(async(account,live)=>{const pair=await api.issueKakaoPair(account);if(live()){state.pair=pair;state.notice='아래 코드로 이 계정의 합성 연결을 확인해 주세요.';}});},
  connect(code){return task(async(account,live)=>{
   const status=await api.connectKakao(code,account);if(!live())return;
   clearDraft();state.pair=null;state.status=status;state.ledger=null;state.message='';state.notice='합성 연결이 완료되었습니다. 여행을 선택해 주세요.';
  });},
  unlink(){return task(async(account,live)=>{
   const status=await api.unlinkKakao(account);if(!live())return;
   clearDraft();state.status=status;state.pair=null;state.ledger=null;state.message='';state.notice='연결을 해제했습니다.';
  });},
  selectTrip(tripId) {
   if(state.draft||state.message){state.error='먼저 작성 중인 내용을 취소한 뒤 여행을 변경해 주세요.';emit();return Promise.resolve(false);}
   return task(async(account,live)=>{
    const status=await api.selectKakaoTrip(tripId,account);if(!live())return;
    const ledger=await loadLedger(status.tripId,account,live);if(!live())return;
    clearDraft();state.status=status;state.ledger=ledger;
   });
  },
  setMessage(message) {if(destroyed||state.draft)return;interrupt();state.message=message;state.error='';emit();},
  setField(key,value) {
   if(destroyed||!state.fields||!Object.hasOwn(state.fields,key)||state.operationId)return;
   interrupt();state.fields={...state.fields,[key]:value};state.confirmation=null;state.error='';emit();
  },
  prepare() {
   tick();
   if(!state.status.linked||!state.status.tripId||!canEdit(state.ledger)||state.draft||!state.message.trim())return Promise.resolve(false);
   return task(async(account,live)=>{
    const tripId=state.status.tripId,message=state.message;
    const ledger=await loadLedger(tripId,account,live);if(!live())return;editable(ledger);
    const draft=await api.prepareKakaoDraft(message,account);if(!live())return;
    if(draft.tripId!==tripId||draft.baseRevision!==ledger.revision)throw {code:'conflict'};
    state.ledger=ledger;state.draft=draft;state.fields=fieldsFor(draft);state.stale=false;state.notice='빈 항목을 입력하고 내용을 검토해 주세요.';
   });
  },
  review() {
   tick();
   if(!state.draft||state.stale||!canEdit(state.ledger)||state.operationId)return Promise.resolve(false);
   const built=draftCommand(state.draft.kind,{fields:state.fields},state.ledger);
   if(built.error){state.error=built.error.message;emit();return Promise.resolve(false);}
   return task(async(account,live)=>{
    const draft=state.draft,ledger=await loadLedger(draft.tripId,account,live);if(!live())return;editable(ledger);
    if(ledger.revision!==draft.baseRevision)throw {code:'conflict'};
    const confirmation=await api.reviewKakaoDraft(draft.id,built.command.input,account);if(!live())return;
    if(confirmation.tripId!==draft.tripId||confirmation.baseRevision!==draft.baseRevision)throw {code:'conflict'};
    state.ledger=ledger;state.confirmation=confirmation;state.notice='여행과 내용을 확인한 뒤 확인 저장을 눌러 주세요.';
   });
  },
  confirm() {
   tick();
   if(!state.confirmation||!canEdit(state.ledger))return Promise.resolve(false);
   return task(async(account,live)=>{
    const confirmation=state.confirmation,ledger=await loadLedger(confirmation.tripId,account,live);if(!live())return;editable(ledger);
    if(!state.operationId&&ledger.revision!==confirmation.baseRevision)throw {code:'conflict'};
    state.operationId??=crypto.randomUUID();
    const result=await api.confirmKakao(confirmation.token,state.operationId,account);if(!live())return;
    clearDraft();state.message='';state.ledger=ledger;state.notice='여행 장부에 저장했습니다.';
    onSaved(account,confirmation.tripId,result.tripRevision);
   });
  },
  cancel(){return task(async(account,live)=>{
   if(state.draft)await api.cancelKakaoDraft(state.draft.id,account);if(!live())return;
   clearDraft();state.message='';state.notice='작성 중인 내용을 취소했습니다.';
  });},
  destroy(){destroyed=true;epoch++;clearInterval(timer);listeners.clear();clearDraft();state.pair=null;state.message='';state.ledger=null;}
 };
 return controller;
}
