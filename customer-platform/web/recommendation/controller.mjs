export function createRecommendationController({api,onSaved=()=>{},onUnauthorized=()=>{}}) {
 let context=null,version=0,destroyed=false,operationId=null;
 const listeners=new Set(),state={interests:'',pace:'balanced',draft:null,selectedIds:[],busy:false,saving:false,canEdit:false,stale:false,selectionLocked:false,error:'',status:''};
 const pendingNotice='저장 결과가 확인되지 않았습니다. 기존 후보와 선택을 유지하고 저장 결과 확인을 눌러 주세요.';
 const emit=()=>{for(const fn of listeners)fn(state);};
 function reset(clearDraft=true){version++;state.busy=false;state.saving=false;state.error='';state.status='';if(clearDraft){state.draft=null;state.selectedIds=[];state.stale=false;state.selectionLocked=false;operationId=null;}}
 function updateContext(next){
  if(destroyed)return;
  const identity=next.accountId!==context?.accountId||next.tripId!==context?.tripId;
  const changed=next.ledger?.revision!==context?.ledger?.revision||next.ledger?.role!==context?.ledger?.role;
  if(identity){reset();state.interests='';state.pace='balanced';}
  else if(changed||!next.ledger){reset(false);state.stale=Boolean(state.draft&&state.draft.baseRevision!==next.ledger?.revision);}
  context={...next,ledger:next.ledger?{...next.ledger}:null};
  state.canEdit=Boolean(next.accountId&&next.tripId&&next.ledger?.tripId===next.tripId&&['owner','editor'].includes(next.ledger?.role));if(state.selectionLocked)state.status=pendingNotice;emit();
 }
 function setInterests(value){if(destroyed||state.saving||state.selectionLocked)return;reset();state.interests=String(value);emit();}
 function setPace(value){if(destroyed||state.saving||state.selectionLocked)return;reset();state.pace=value;emit();}
 function toggle(id,selected){if(destroyed||state.busy||state.saving||state.selectionLocked||!state.canEdit||state.stale||!state.draft?.items.some(item=>item.id===id))return;state.selectedIds=selected?[...new Set([...state.selectedIds,id])]:state.selectedIds.filter(value=>value!==id);operationId=null;state.error='';emit();}
 function report(error,action){
  const rejected=[400,401,403,404,409,412,422,429].includes(error?.status)||['validation','conflict','unauthenticated','forbidden','not_found','account_changed','rate_limited'].includes(error?.code);
  if(action==='save'&&rejected){operationId=null;state.selectionLocked=false;state.stale=true;state.status='최신 장부를 확인하고 추천 다시 생성을 눌러 주세요.';state.error='기존 저장 요청을 더 확인할 수 없습니다. 최신 장부를 확인하고 추천을 다시 생성해 주세요.';}
  else {if(action==='save')state.status=pendingNotice;state.error=error?.code==='conflict'?'장부가 갱신되었거나 추천이 만료되었습니다. 최신 내용을 확인하고 다시 생성해 주세요.':error?.code==='rate_limited'?'오늘 추천 생성 한도에 도달했습니다.':action==='save'?'저장 결과를 확인하지 못했습니다. 선택은 보존했으며 같은 저장 버튼으로 재시도할 수 있습니다.':'추천을 만들지 못했습니다. 입력을 확인하고 다시 시도해 주세요.';}if([401,403,404,412].includes(error?.status)||['unauthenticated','forbidden','not_found','account_changed'].includes(error?.code))onUnauthorized(error);}
 async function generate(){
  if(destroyed||!state.canEdit||state.busy||state.saving||state.selectionLocked)return false;
  const interests=state.interests.split(/[,，\n]/u).map(v=>v.trim()).filter(Boolean);
  if(interests.length>5||interests.some(v=>[...v].length>40||/\p{Cc}/u.test(v))||!['relaxed','balanced','packed'].includes(state.pace)){state.error='관심사는 쉼표로 나누어 최대 5개, 각 40자까지 입력해 주세요.';emit();return false;}
  const own=++version,request=context;state.busy=true;state.error='';state.status='';emit();
  try{
   const draft=await api.generateRecommendation(request.tripId,{interests,pace:state.pace},request.ledger.revision,request.accountId);
   if(destroyed||own!==version)return false;
   if(!draft||draft.tripId!==request.tripId||draft.baseRevision!==request.ledger.revision||!Array.isArray(draft.items)||!draft.items.length)throw Error('invalid draft');
   state.draft=draft;state.selectedIds=[];state.selectionLocked=false;state.stale=false;operationId=null;state.status='후보를 직접 선택한 뒤 일정에 저장해 주세요.';return true;
  }catch(error){if(destroyed||own!==version)return false;report(error,'generate');return false;}
  finally{if(!destroyed&&own===version){state.busy=false;emit();}}
 }
 async function save(){
  if(destroyed||!state.canEdit||state.busy||state.saving||(state.stale&&!state.selectionLocked)||!state.draft||!state.selectedIds.length)return false;
  if(!state.selectionLocked&&Date.parse(state.draft.expiresAt)<=Date.now()){state.stale=true;state.error='추천이 만료되었습니다. 다시 생성해 주세요.';emit();return false;}
  const own=++version,request=context,draft=state.draft,ids=[...state.selectedIds];operationId??=crypto.randomUUID();const op=operationId;
  state.saving=true;state.selectionLocked=true;state.error='';state.status='';emit();
  try{
   const change=await api.adoptRecommendation(request.tripId,draft.id,ids,op,request.accountId);
   if(destroyed||own!==version)return false;
   state.draft=null;state.selectedIds=[];state.selectionLocked=false;operationId=null;state.status='선택한 후보를 일정에 저장했습니다.';onSaved(request.accountId,request.tripId,change.tripRevision);return true;
  }catch(error){if(destroyed||own!==version)return false;report(error,'save');return false;}
  finally{if(!destroyed&&own===version){state.saving=false;emit();}}
 }
 return {state,updateContext,setInterests,setPace,toggle,generate,save,subscribe(fn){listeners.add(fn);fn(state);return()=>listeners.delete(fn);},destroy(){destroyed=true;reset();context=null;listeners.clear();}};
}
