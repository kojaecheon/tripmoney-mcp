import {randomUUID} from 'node:crypto';
import {IdentityError, type Actor} from '../../core/contracts.js';
import type {LedgerDTO,ScheduleInput} from '../../core/ledger/contracts.js';
import {invalid} from '../../core/ledger/money.js';
import {ledgerId,normalizeLedgerCommand} from '../../core/ledger/normalize.js';
import {tripClock} from '../../core/ledger/time.js';
import type {RecommendationDraft,RecommendationRequest} from '../../core/recommendation/contracts.js';
import type {RecommendationProvider} from '../ai/recommendation-provider.js';
import type {IdentityService} from '../identity/contracts.js';
import type {LedgerService} from '../ledger/contracts.js';
import type {PlaceService} from '../places/contracts.js';
import type {ProviderUsageStore} from '../integration/contracts.js';
import type {RecommendationService} from './contracts.js';

type Stored = {owner: string; draft: RecommendationDraft; attempt?: {operationId: string; signature: string}};
const conflict=()=>new IdentityError('conflict','추천이 만료되었거나 장부가 변경되었습니다. 다시 생성해 주세요.');
function record(value: unknown): Record<string,unknown> {
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)return invalid('recommendation');
 return value as Record<string,unknown>;
}
function safe(value: unknown, seen=new Set<object>(), budget={left:120000}, depth=0): void {
 if(depth>30)return invalid('recommendation');
 if(typeof value==='string')budget.left-=value.length*3;
 else if(value&&typeof value==='object'){
  if(seen.has(value))return invalid('recommendation');seen.add(value);
  if(!Array.isArray(value))record(value);
  else if(Object.getPrototypeOf(value)!==Array.prototype||Reflect.ownKeys(value).length!==value.length+1||Array.from({length:value.length},(_,i)=>Object.getOwnPropertyDescriptor(value,String(i))).some(d=>!d||!Object.hasOwn(d,'value')))return invalid('recommendation');
  for(const key of Reflect.ownKeys(value)){
   const d=Object.getOwnPropertyDescriptor(value,key)!;
   if(typeof key!=='string'||!Object.hasOwn(d,'value'))return invalid('recommendation');
   budget.left-=key.length*3+8;if(budget.left<0)return invalid('recommendation');safe(d.value,seen,budget,depth+1);
  }seen.delete(value);
 }else if(value!==null&&!['number','boolean','undefined'].includes(typeof value))return invalid('recommendation');
 else budget.left-=16;
 if(budget.left<0)return invalid('recommendation');
}
function text(value: unknown, field: string, max: number): string {
 if(typeof value!=='string'||/\p{Cc}/u.test(value)||!value.trim()||[...value.trim()].length>max)return invalid(field);
 return value.trim();
}
function request(raw: RecommendationRequest): RecommendationRequest {
 safe(raw);const r=record(raw);
 if(Object.keys(r).length!==2||!Array.isArray(r.interests)||r.interests.length>5||!['relaxed','balanced','packed'].includes(String(r.pace)))return invalid('recommendation');
 return {interests:r.interests.map(v=>text(v,'interests',40)),pace:r.pace as RecommendationRequest['pace']};
}
function authorize(ledger: LedgerDTO, tripId: string, revision?: number) {
 if(ledger.tripId!==tripId)throw new IdentityError('not_found','여행을 찾을 수 없습니다.');
 if(!['owner','editor'].includes(ledger.role))throw new IdentityError('forbidden','편집 권한을 확인해 주세요.');
 if(revision!==undefined&&ledger.revision!==revision)throw conflict();
}
export function createRecommendationService({identityService,ledgerService,placeService,provider,usageStore,now=Date.now}: {
 identityService: Pick<IdentityService,'getTrip'>;ledgerService: LedgerService;placeService: Pick<PlaceService,'resolve'>;
 provider: RecommendationProvider;usageStore?:ProviderUsageStore;now?:()=>number;
}): RecommendationService {
 const drafts=new Map<string,Stored>(), quotas=new Map<string,{count:number;until:number}>();let closed=false;
 function available(){if(closed)throw new IdentityError('unavailable','추천 서비스를 사용할 수 없습니다.');}
 async function reserve(actor: Actor,tripId: string,zone: string){
  const t=now(),tripDay=tripClock(new Date(t).toISOString(),zone).date,userDay=new Date(t).toISOString().slice(0,10);
  if(provider.source==='claude'){
   if(!usageStore)throw new IdentityError('unavailable','추천 사용량 저장소를 사용할 수 없습니다.');
   const requestId=randomUUID();
   // Stable scopes retain spent request IDs across period changes. Failures are never refunded.
   for(const row of [{scope:`recommendation:trip:${tripId}`,limit:3,periodKey:tripDay},{scope:`recommendation:user:${actor.userId}`,limit:10,periodKey:userDay}]){
    let allowed:boolean;
    try{allowed=await usageStore.reserve({...row,requestId,expiresAt:t+48*3600000});}
    catch{throw new IdentityError('unavailable','추천 사용량을 확인하지 못했습니다.');}
    available();if(allowed!==true)throw new IdentityError('rate_limited','오늘 추천 생성 한도에 도달했습니다.');
   }
   return;
  }
  for(const [key,row]of quotas)if(row.until<=t)quotas.delete(key);
  const keys=[`trip:${tripId}:${tripDay}`,`user:${actor.userId}:${userDay}`],limits=[3,10];
  for(let i=0;i<keys.length;i++)if((quotas.get(keys[i]!)?.count??0)>=limits[i]!)throw new IdentityError('rate_limited','오늘 추천 생성 한도에 도달했습니다.');
  if(quotas.size+2>20000)throw new IdentityError('unavailable','추천 요청이 많습니다. 잠시 뒤 다시 시도해 주세요.');
  for(const key of keys)quotas.set(key,{count:(quotas.get(key)?.count??0)+1,until:t+48*3600000});
 }
 return {
  async generate(actor,rawTripId,raw,expectedRevision){
   available();const tripId=ledgerId(rawTripId,'tripId');
   const trip=await identityService.getTrip(actor,tripId),ledger=await ledgerService.get(actor,tripId);
   if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)return invalid('expectedRevision');authorize(ledger,tripId,expectedRevision);
   if(trip.id!==tripId)throw new IdentityError('not_found','여행을 찾을 수 없습니다.');
   if(!['owner','editor'].includes(trip.role)||trip.revision!==ledger.revision)throw conflict();
   const clean=request(raw);
   if(provider.source!=='synthetic'&&provider.source!=='claude'&&provider.source!=='gemini')return invalid('source');
   for(const [id,row]of drafts)if(Date.parse(row.draft.expiresAt)<=now())drafts.delete(id);
   if(drafts.size>=500)throw new IdentityError('unavailable','보관 중인 추천이 많습니다. 잠시 뒤 다시 시도해 주세요.');
   await reserve(actor,tripId,ledger.timeZone);
   let output: unknown;
   try{output=await provider.generate({destination:trip.destination,startDate:ledger.startDate,endDate:ledger.endDate,timeZone:ledger.timeZone,memberCount:trip.memberCount,budgetKrw:ledger.budgetKrw,interests:clean.interests,pace:clean.pace});}
   catch(error){
    if(provider.source==='gemini'&&error instanceof IdentityError&&['validation','rate_limited'].includes(error.code))throw error;
    throw new IdentityError('unavailable','추천을 만들지 못했습니다. 다시 시도해 주세요.');
   }
   safe(output);const rawItems=record(output).items;
   if(!Array.isArray(rawItems)||rawItems.length<1||rawItems.length>60)return invalid('items');
   let total=0;
   const items: RecommendationDraft['items']=rawItems.map(rawItem=>{
    const row=record(rawItem);const command=normalizeLedgerCommand({type:'schedule.create',input:row.input});
    if(command.type!=='schedule.create')return invalid('input');
    const input: ScheduleInput={...command.input,placeRef:command.input.placeRef??null};
    if(input.date<ledger.startDate||input.date>ledger.endDate)return invalid('date');
    total+=input.budgetKrw;if(!Number.isSafeInteger(total)||total>ledger.budgetKrw)return invalid('budgetKrw');
    return {id:randomUUID(),input,reason:text(row.reason,'reason',500),placeStatus:'unverified'};
   });
   const refs=items.flatMap(item=>item.input.placeRef?[item.input.placeRef]:[]), unique=[...new Map(refs.map(ref=>[`${ref.provider}:${ref.placeId}`,ref])).values()];
   let places: Awaited<ReturnType<PlaceService['resolve']>>=[];
   if(unique.length)try{places=await placeService.resolve(actor,tripId,unique);}catch{/* Unavailable place proof is never presented as verified. */}
   let unverified=false;
   for(const item of items){
    const ref=item.input.placeRef,p=ref&&places.find(place=>place.ref.provider===ref.provider&&place.ref.placeId===ref.placeId);
    // Google display text is request-scoped. Only the place ID enters an adopted schedule.
    if(p){item.input.place=p.source==='synthetic'?p.name:'';item.placeStatus=p.source==='synthetic'?'synthetic':'verified';}
    else{item.input.placeRef=null;unverified=true;}
   }
   const currentTrip=await identityService.getTrip(actor,tripId),current=await ledgerService.get(actor,tripId);available();authorize(current,tripId,expectedRevision);
   if(!['owner','editor'].includes(currentTrip.role)||currentTrip.revision!==expectedRevision)throw conflict();
   const draft: RecommendationDraft={id:randomUUID(),tripId,baseRevision:expectedRevision,source:provider.source,expiresAt:new Date(now()+600000).toISOString(),items,warnings:[...(provider.source==='synthetic'?['합성 추천 체험입니다. 실제 Claude·지도 연결이나 영업 정보를 확인한 결과가 아닙니다.']:['생성한 후보입니다. 저장 전에 내용을 확인해 주세요.']),...(unverified?['확인되지 않은 장소가 있습니다. 장소와 운영 정보를 직접 확인해 주세요.']:[])]};
   if(drafts.size>=500)throw new IdentityError('unavailable','보관 중인 추천이 많습니다.');drafts.set(draft.id,{owner:actor.userId,draft});return structuredClone(draft);
  },
  async adopt(actor,rawTripId,rawDraftId,rawIds,rawOp){
   available();const tripId=ledgerId(rawTripId,'tripId'),draftId=ledgerId(rawDraftId,'draftId'),operationId=ledgerId(rawOp,'operationId');
   const trip=await identityService.getTrip(actor,tripId),ledger=await ledgerService.get(actor,tripId);authorize(ledger,tripId);
   if(!['owner','editor'].includes(trip.role))throw new IdentityError('forbidden','편집 권한을 확인해 주세요.');
   const stored=drafts.get(draftId);if(!stored||stored.owner!==actor.userId||stored.draft.tripId!==tripId)throw new IdentityError('not_found','추천을 찾을 수 없습니다.');
   const draft=stored.draft;if(now()>=Date.parse(draft.expiresAt))throw conflict();
   safe(rawIds);if(!Array.isArray(rawIds)||rawIds.length<1||rawIds.length>60)return invalid('selectedIds');
   const ids=rawIds.map(id=>ledgerId(id,'selectedIds')).sort();if(new Set(ids).size!==ids.length||ids.some(id=>!draft.items.some(item=>item.id===id)))return invalid('selectedIds');
   const signature=JSON.stringify(ids),attempt=stored.attempt;
   if(attempt&&(attempt.operationId!==operationId||attempt.signature!==signature))throw conflict();
   // Existing attempt uses the ledger receipt path before checking its old base revision.
   if(!attempt){authorize(ledger,tripId,draft.baseRevision);stored.attempt={operationId,signature};}
   const inputs=draft.items.filter(item=>ids.includes(item.id)).map(item=>structuredClone(item.input));
   return ledgerService.execute(actor,tripId,{type:'schedule.adopt',inputs},draft.baseRevision,operationId);
  },
  close(){closed=true;drafts.clear();quotas.clear();}
 };
}
