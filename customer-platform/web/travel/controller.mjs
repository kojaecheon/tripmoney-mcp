import { ApiError } from '../api.mjs';
import { defaultTripDraft, settingsOf, tripFields, settingFields, validateDraft } from './forms.mjs';
export { defaultTripDraft } from './forms.mjs';
function safeError(e, scope) {
 const safe = e instanceof ApiError ? e : new ApiError(503,'unavailable');
 const field = safe.reason === 'alias_taken' ? 'alias' : safe.field;
 return {code:safe.code,message:safe.message,scope,...(field?{field}:{}),...(safe.reason?{reason:safe.reason}:{})};
}
// Preserve the failed request's target even when it was nested in a refresh.
class RequestFailure {
 constructor(error, context) { this.error=error; this.context=context; }
}
async function targeted(context, work) {
 try { return await work(); } catch(error) { throw error instanceof RequestFailure ? error : new RequestFailure(error,context); }
}
export function readInviteFragment(location, history) {
 const hash = location.hash;
 if(location.pathname !== '/invite') return null;
 const params = new URLSearchParams(hash.replace(/^#/,''));
 if(!params.has('t'))return null;
 history.replaceState(null, '', `${location.pathname}${location.search}`);
 const token = params.get('t');
 return token && token.length <= 2048 && /^[A-Za-z0-9_.-]+$/.test(token) ? token : null;
}
function fresh() { return {accountId:null,trips:[],selectedTripId:null,trip:null,members:[],invites:[],canManage:false,writesBlocked:false,createOpen:false,createDraft:defaultTripDraft(),settingsDraft:{},invite:null,inviteNotice:'',alias:'',inviteRole:'editor',busy:null,error:null,status:'',conflict:null,pendingKind:null,confirmMemberId:null,shareOpen:false,shareStatus:''}; }
export function createTravelController(api, {onUnauthorized = () => {}, makeOperationId = () => globalThis.crypto.randomUUID()} = {}) {
 let state=fresh(); let epoch=0; let destroyed=false; let token=null; let shareUrl=null; let pending=null; let retainedDraft=null; let settingsBase=null;
 const listeners=new Set();
 const publish = patch => { if(destroyed)return; state={...state,...patch}; for(const fn of listeners) fn(state); };
 const current = e => !destroyed && epoch===e;
 function reset({retain=false, notice=''}={}) { const account=state.accountId; if(retain && account) retainedDraft={account,draft:{...state.createDraft}}; ++epoch;settingsBase=null;token=null;shareUrl=null;pending=null;state={...fresh(),inviteNotice:notice};publish({}); }
 async function detail(id, e, preserve=false) {
  return targeted({tripId:id}, async () => {
   const account=state.accountId;
   const trip=await api.getTrip(id,account); if(!current(e))return;
   const members=await api.listMembers(id,account); if(!current(e))return;
   const invites=trip.role==='owner'?await api.listInvites(id,account):[]; if(!current(e))return;
   const canManage=trip.role==='owner'&&!state.writesBlocked;
   if(!canManage)shareUrl=null;
   const keep=preserve && canManage && settingsBase?.id===id &&
    settingFields.some(k=>state.settingsDraft[k]!==settingsBase.fields[k]);
   if(!keep)settingsBase={id,revision:trip.revision,fields:settingsOf(trip)};
   publish({selectedTripId:id,trip,members,invites,canManage,settingsDraft:keep?state.settingsDraft:settingsOf(trip),shareOpen:canManage&&state.shareOpen});
  });
 }
 async function list(e) { const trips=await api.listTrips(state.accountId); if(current(e))publish({trips}); }
 async function failure(thrown,e,allowRecovery=true,context={}) {
  if(!current(e))return;
  const error=thrown instanceof RequestFailure ? thrown.error : thrown;
  if(thrown instanceof RequestFailure)context={...context,...thrown.context};
  const info=safeError(error,context.scope);
  if(error instanceof ApiError && error.status===412) {
   retainedDraft=null;reset({notice:info.message});onUnauthorized();return;
  }
  if(error instanceof ApiError && error.status===401) {
   reset({retain:true,notice:'로그인 정보가 만료되었습니다. 다시 로그인한 뒤 받은 초대 링크를 다시 열어 주세요.'});
   onUnauthorized();
   return;
  }
  publish({error:info,status:''});
  if(error instanceof ApiError && error.status===409) publish({conflict:{latestChecked:false,reason:info.reason},pendingKind:pending?.kind??null});
  if(error instanceof ApiError && error.status===410) {
   const received=['inspect','accept'].includes(context.scope);
   if(received){token=null;publish({invite:null,alias:'',inviteNotice:info.message});}
   else {shareUrl=null;publish({shareOpen:false,shareStatus:''});}
   if(pending && (received ? pending.kind==='accept' : pending.kind===context.scope)) {
    pending=null;publish({pendingKind:null,conflict:null});
   }
  }
  if(error instanceof ApiError && error.status===404) {
   const id=context.tripId??state.selectedTripId;
   const trips=state.trips.filter(trip=>trip.id!==id);
   if(id===state.selectedTripId){
    shareUrl=null;pending=null;settingsBase=null;
    publish({trips,selectedTripId:null,trip:null,members:[],invites:[],settingsDraft:{},canManage:false,shareOpen:false,shareStatus:'',pendingKind:null,conflict:null,confirmMemberId:null});
   }else publish({trips});
   if(allowRecovery) {
    try {await list(e);}
    // Recovery failures still clear private state, but never start another list request.
    catch(requery) {await failure(requery,e,false);}
   }
  }
  if(error instanceof ApiError && error.status===403) {
   shareUrl=null;
   publish({writesBlocked:true,canManage:false,shareOpen:false,shareStatus:''});
   if(allowRecovery) {
    try {if(state.selectedTripId)await detail(state.selectedTripId,e,true);else await list(e);}
    // A lost trip needs one list refresh. Repeated 403 and every later failure stop here.
    catch(requery) {const cause=requery instanceof RequestFailure?requery.error:requery;await failure(requery,e,cause instanceof ApiError&&cause.status===404);}
   }
  }
 }
 async function run(kind,fn,context={},patch={}) {
  if(destroyed||!state.accountId||state.busy)return false;
  const e=epoch;publish({busy:kind,error:null,status:'',...patch});
  try{await fn(e);return current(e);}catch(error){await failure(error,e,true,{scope:kind,...context});return false;}finally{if(current(e))publish({busy:null});}
 }
 async function inspect(e) {
  if(!token)return;
  const value=await targeted({scope:'inspect'},()=>api.inspectInvite(token,state.accountId));
  if(!current(e))return;
  publish({invite:value,inviteNotice:''});
  if(value.state==='joined'){
   token=null;
   if(pending?.kind==='accept'){pending=null;publish({pendingKind:null,conflict:null});}
   await detail(value.tripId,e,true);
   if(current(e))publish({invite:null,alias:'',status:'이미 참여한 여행입니다.'});
  }
 }
 async function checkAccount(e) {
  const expected=state.accountId;
  const {me}=await api.me();
  if(!current(e))return false;
  if(me.userId!==expected)throw new ApiError(412,'account_changed');
  return true;
 }
 async function execute(op,e) {
  if(!await checkAccount(e)||!current(e))return;
  const a=op.args,account=state.accountId;let result;
  if(op.kind==='create')result=await api.createTrip(a.input,op.operationId,account);
  if(op.kind==='settings')result=await api.updateTrip(a.id,a.input,a.revision,op.operationId,account);
  if(op.kind==='member')result=await api.manageMember(a.id,a.memberId,a.role,a.active,a.revision,op.operationId,account);
  if(op.kind==='issue')result=await api.issueInvite(a.id,a.role,a.revision,op.operationId,account);
  if(op.kind==='revoke')result=await api.revokeInvite(a.id,a.inviteId,a.revision,op.operationId,account);
  if(op.kind==='accept')result=await api.acceptInvite(token,a.alias,op.operationId,account);
  if(!current(e))return;
  const id=(op.kind==='create'||op.kind==='accept')?result.value.trip.id:a.id;
  if(op.kind==='issue'){shareUrl=null;shareUrl=validatedLink(result.value.url);}if(op.kind==='revoke'){shareUrl=null;publish({shareOpen:false,shareStatus:''});}
  await list(e);if(!current(e))return;
  await detail(id,e,op.kind!=='settings');if(!current(e))return;
  pending=null;
  if(op.kind==='accept')token=null;
  publish({pendingKind:null,conflict:null,confirmMemberId:null,...(op.kind==='create'?{createOpen:false,createDraft:defaultTripDraft()}:{}),...(op.kind==='accept'?{invite:null,alias:''}:{}),...(op.kind==='issue'?{shareOpen:true,shareStatus:'초대를 발급했습니다. 링크를 한 사람에게 전달해 주세요.'}:{}),status:result.replayed?'이전 요청 결과를 확인하고 최신 정보를 불러왔습니다.':'저장했습니다.'});
 }
 function validatedLink(url) { try { const origin=globalThis.location?.origin ?? 'http://127.0.0.1:8125';const parsed=new URL(url);if(parsed.origin!==origin||parsed.pathname!=='/invite'||parsed.search||!/^#t=[A-Za-z0-9_.-]+$/.test(parsed.hash)||parsed.username||parsed.password)throw new Error();return parsed.href;}catch{throw new ApiError(0,'invalid_response');} }
 function write(kind,args,owner=false) {
  if(destroyed||state.busy||!state.accountId||state.conflict||pending)return Promise.resolve(false);
  if(owner&&(!state.canManage||state.writesBlocked))return Promise.resolve(false);
  const op={kind,args:structuredClone(args),operationId:makeOperationId()};
  pending=op;return run(kind,e=>execute(op,e),{tripId:args.id},{pendingKind:kind});
 }
 const c={
  get state(){return state;},
  subscribe(fn){if(destroyed)return()=>{};listeners.add(fn);fn(state);return()=>listeners.delete(fn);},
  async setAccount(accountId){
   if(destroyed||accountId===state.accountId)return false;
   if(!accountId){reset({retain:true,notice:'받은 초대 링크는 로그인 후 다시 열어 주세요.'});return true;}
   const initialToken=state.accountId?null:token;
   const notice=state.accountId?'계정이 바뀌었습니다. 받은 초대 링크를 다시 열어 주세요.':state.inviteNotice;
   const restore=retainedDraft?.account===accountId?retainedDraft.draft:null;
   reset();token=initialToken;retainedDraft=null;publish({accountId,createDraft:restore??defaultTripDraft(),inviteNotice:notice});
   return run('load',async e=>{await list(e);if(current(e))await inspect(e);});
  },
  setInviteToken(value){
   if(destroyed)return Promise.resolve(false);
   // A second invitation starts a new page lifecycle. In-flight results can never own the new link.
   const accountId=state.accountId;reset();retainedDraft=null;token=value;
   publish({accountId,inviteNotice:value?'초대 정보는 로그인 후 확인할 수 있습니다.':'받은 초대 링크를 다시 열어 주세요.'});
   return accountId?run('load',async e=>{await list(e);if(current(e))await inspect(e);}):Promise.resolve(true);
  },
  async recheckAccount(){
   if(!state.accountId||destroyed)return false;
   const e=epoch;
   try{return await checkAccount(e);}catch(error){await failure(error,e,false);return false;}
  },
  refresh(){return run('refresh',async e=>{await list(e);if(state.selectedTripId&&current(e)){publish({writesBlocked:false});await detail(state.selectedTripId,e,true);}if(token&&current(e))await inspect(e);});},
  selectTrip(id){if(state.busy||pending)return Promise.resolve(false);shareUrl=null;return run('detail',async e=>{publish({writesBlocked:false,shareOpen:false});await detail(id,e);});},
  showCreate(){if(!state.busy)publish({createOpen:!state.createOpen,error:null});},
  setCreateField(field,value){if(!state.busy&&tripFields.includes(field))publish({createDraft:{...state.createDraft,[field]:field==='budgetKrw'?Number(value):value},error:null});},
  setSettingsField(field,value){if(!state.busy&&state.canManage&&settingFields.includes(field))publish({settingsDraft:{...state.settingsDraft,[field]:field==='budgetKrw'?Number(value):value},error:null});},
  saveTrip(){if(!pending){const error=validateDraft(state.createDraft);if(error){publish({error:{...error,scope:'create'}});return Promise.resolve(false);}}return write('create',{input:state.createDraft});},
  saveSettings(){if(!state.trip)return Promise.resolve(false);if(!pending){const error=validateDraft(state.settingsDraft,false);if(error){publish({error:{...error,scope:'settings'}});return Promise.resolve(false);}}return write('settings',{id:state.trip.id,input:state.settingsDraft,revision:settingsBase.revision},true);},
  setInviteRole(role){if(!state.busy&&['editor','viewer'].includes(role))publish({inviteRole:role});},
  issueInvite(){return state.trip?write('issue',{id:state.trip.id,role:state.inviteRole,revision:state.trip.revision},true):Promise.resolve(false);},
  manageMember(memberId,role,active=true){const m=state.members.find(m=>m.id===memberId);if(!state.trip||!m||m.role==='owner'||!m.active||!['editor','viewer'].includes(role))return Promise.resolve(false);return write('member',{id:state.trip.id,memberId,role,active,revision:state.trip.revision},true);},
  confirmRemove(memberId){if(!state.busy&&!pending)publish({confirmMemberId:memberId});},
  removeMember(memberId){const member=state.members.find(m=>m.id===memberId);return member&&state.confirmMemberId===memberId?c.manageMember(memberId,member.role,false):Promise.resolve(false);},
  revokeInvite(inviteId){return state.trip?write('revoke',{id:state.trip.id,inviteId,revision:state.trip.revision},true):Promise.resolve(false);},
  getInviteLink(inviteId){return run('link',async e=>{if(!state.canManage||!await checkAccount(e)||!current(e))return;const result=await api.getInviteLink(state.trip.id,inviteId,state.accountId);if(current(e)){shareUrl=validatedLink(result.url);publish({shareOpen:true,shareStatus:'링크를 복사하거나 직접 선택해 주세요.'});}});},
  fillShare(textarea){textarea.value=state.shareOpen&&shareUrl?shareUrl:'';},
  async copyLink(clipboard=globalThis.navigator?.clipboard){if(!shareUrl||!state.shareOpen)return false;const e=epoch;const url=shareUrl;try{if(!clipboard?.writeText)throw new Error();await clipboard.writeText(url);if(current(e)&&shareUrl===url)publish({shareStatus:'복사했습니다. 다른 계정에서는 받은 링크를 다시 열어 주세요.'});return current(e);}catch{if(current(e))publish({shareStatus:'자동 복사를 사용할 수 없습니다. 아래 링크를 직접 선택해 복사해 주세요.'});return false;}},
  closeShare(){shareUrl=null;publish({shareOpen:false,shareStatus:''});},
  setAlias(alias){if(!state.busy)publish({alias,error:null});},
  acceptInvite(){if(!token||state.invite?.state!=='pending')return Promise.resolve(false);if(!state.alias.trim()||[...state.alias.trim()].length>40){publish({error:{code:'validation',scope:'accept',field:'alias',message:'별칭은 1자부터 40자까지 입력해 주세요.'}});return Promise.resolve(false);}return write('accept',{alias:state.alias});},
  refreshConflict(){
   if(!state.conflict||!pending)return Promise.resolve(false);
   return run('conflict',async e=>{
    if(pending.kind==='accept')await inspect(e);
    else if(state.selectedTripId)await detail(state.selectedTripId,e,true);
    else await list(e);
    if(current(e)&&pending)publish({conflict:{...state.conflict,latestChecked:true,revision:state.trip?.revision},status:'최신 정보를 확인했습니다. 초안을 확인한 뒤 다시 적용해 주세요.'});
   });
  },
  reapply(){
   if(state.busy||!state.conflict?.latestChecked||!pending||(!['create','accept'].includes(pending.kind)&&!state.canManage))return Promise.resolve(false);
   const old=pending,args={...old.args};
   if(old.kind==='create')args.input={...state.createDraft};
   if(old.kind==='settings')args.input={...state.settingsDraft};
   if(old.kind==='accept')args.alias=state.alias;
   if('revision' in args)args.revision=state.conflict.revision;
   if(['create','settings'].includes(old.kind)){
    const error=validateDraft(args.input,old.kind==='create');
    if(error){publish({error:{...error,scope:old.kind}});return Promise.resolve(false);}
   }
   pending={...old,args,operationId:makeOperationId()};
   return run(old.kind,e=>execute(pending,e),{tripId:args.id},{conflict:null});
  },
  retryPending(){if(state.writesBlocked||!pending||state.conflict)return Promise.resolve(false);return run(pending.kind,e=>execute(pending,e));},
  discardPending(){if(state.busy)return;pending=null;publish({pendingKind:null,conflict:null,error:null,status:'요청 보존을 해제했습니다. 현재 입력으로 새 요청을 보낼 수 있습니다.'});},
  destroy(){reset();destroyed=true;retainedDraft=null;listeners.clear();},
 };
 return c;
}
