import {ApiError} from '../api.mjs';
import {kakaoId,parseKakaoPair,parseKakaoApproval,parseKakaoUnlink} from './validation.mjs';
const fresh=()=>({accountId:null,tripId:null,tripName:'',members:[],pair:null,approval:null,pendingId:'',busy:null,error:'',notice:''});
export function createKakaoController({api,onUnauthorized=()=>{},now=()=>Date.now()}={}) {
 let state=fresh(),destroyed=false,epoch=0;
 const listeners=new Set();
 const snapshot=()=>({...state,pairExpired:Boolean(state.pair&&Date.parse(state.pair.expiresAt)<=now()),approvalExpired:Boolean(state.approval&&Date.parse(state.approval.expiresAt)<=now())});
 const publish=patch=>{if(destroyed)return;state={...state,...patch};for(const fn of listeners)fn(snapshot());};
 const current=e=>!destroyed&&epoch===e;
 const validId=value=>{try{kakaoId(value);return true;}catch{return false;}};
 async function run(kind,work) {
  if(destroyed||state.busy||!validId(state.accountId)||!validId(state.tripId))return false;
  const e=epoch,account=state.accountId,trip=state.tripId;
  publish({busy:kind,error:'',notice:''});
  try{const patch=await work(account,trip);if(!current(e))return false;publish(patch);return true;}
  catch(error){
   if(!current(e))return false;
   if(error instanceof ApiError&&[401,412].includes(error.status)){
    ++epoch;publish({...fresh(),error:error.message});onUnauthorized();
   }else publish({error:error instanceof ApiError?error.message:'응답을 확인하지 못했습니다. 현재 계정과 여행을 확인한 뒤 다시 시도해 주세요.'});
   return false;
  }finally{if(current(e))publish({busy:null});}
 }
 const timer=setInterval(()=>{if(state.pair||state.approval)publish({});},1000);timer.unref?.();
 return {
  get state(){return snapshot();},
  subscribe(fn){if(destroyed)return()=>{};listeners.add(fn);fn(snapshot());return()=>listeners.delete(fn);},
  updateContext(context={}) {
   if(destroyed)return;
   const accountId=context.accountId??null,tripId=context.tripId??null;
   if(accountId!==state.accountId||tripId!==state.tripId){++epoch;state=fresh();}
   publish({accountId,tripId,tripName:context.tripName??'',members:context.ledger?.tripId===tripId?context.ledger.members.filter(m=>m.active).map(m=>({alias:m.alias})):[]});
  },
  setPendingId(value){if(!destroyed&&!state.busy)publish({pendingId:typeof value==='string'?value.trim():'',error:''});},
  issuePair(){return run('pair',async(account,tripId)=>({pair:parseKakaoPair(await api.issueKakaoLivePair(tripId,account),now()),pendingId:'',notice:'카카오 개발봇에 연결 명령을 보내고, 봇이 돌려준 연결 요청 ID를 아래에 붙여넣어 주세요.'}));},
  approve(){
   if(!validId(state.pendingId)){publish({error:'봇이 반환한 연결 요청 ID를 붙여넣어 주세요.'});return Promise.resolve(false);}
   const pendingId=state.pendingId;
   return run('approve',async(account,tripId)=>{
    const approval=parseKakaoApproval(await api.approveKakaoLivePair(pendingId,tripId,account),now());
    if(approval.tripId!==tripId)throw new ApiError(0,'invalid_response');
    return {approval,pair:null,pendingId:'',notice:'이 화면에서 서버 승인 응답을 받았습니다. 카카오에서 여행을 입력해 현재 여행을 확인해 주세요.'};
   });
  },
  unlink(){
   const grantId=state.approval?.grantId;if(!grantId)return Promise.resolve(false);
   return run('unlink',async account=>{parseKakaoUnlink(await api.unlinkKakaoLive(grantId,account));return {approval:null,pair:null,pendingId:'',notice:'서버에서 연결 해제 응답을 받았습니다.'};});
  },
  destroy(){++epoch;clearInterval(timer);state=fresh();destroyed=true;listeners.clear();},
 };
}
