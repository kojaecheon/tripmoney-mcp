import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {IdentityError, type Actor} from '../../../core/contracts.js';
import type {LedgerCommand, LedgerDTO} from '../../../core/ledger/contracts.js';
import {ledgerId, normalizeLedgerCommand} from '../../../core/ledger/normalize.js';
import type {IdentityService, TripDTO} from '../../identity/contracts.js';
import type {LedgerService} from '../../ledger/contracts.js';
import type {createDraftService} from '../../drafts/service.js';
import type {KakaoLocalDraft, KakaoLocalService, KakaoLocalStatus} from './contracts.js';

const MINUTE = 60000, MAX = 256, MAX_CONTENT = 512;
type Grant = {actor: Actor; generation: string; expires: number; tripId: string | null};
type Bound = {userId: string; generation: string; tripId: string; expires: number};
type Draft = Bound & {dto: KakaoLocalDraft; confirmed: boolean};
type Confirmation = Bound & {draftId: string; command: Extract<LedgerCommand,{type:'schedule.create'|'expense.create'}>; revision: number; operationId?: string};
const forbidden = (): never => {throw new IdentityError('forbidden','연결 또는 확인 시간이 끝났습니다. 다시 연결하고 내용을 확인해 주세요.');};
const conflict = (): never => {throw new IdentityError('conflict','최신 장부를 확인하고 새 초안을 만들어 주세요.');};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const iso = (value: number) => new Date(value).toISOString();
const editable = (ledger: LedgerDTO) => {
 if (ledger.role !== 'owner' && ledger.role !== 'editor') throw new IdentityError('forbidden','편집 권한을 확인해 주세요.');
};

/** Process-local synthetic channel. Never accepts an external sender or creates an app session. */
export function createKakaoLocalService({identityService,ledgerService,draftService,now=Date.now}: {
 identityService: IdentityService; ledgerService: LedgerService; draftService: ReturnType<typeof createDraftService>; now?: ()=>number;
}): KakaoLocalService {
 const pairs = new Map<string,{hash:string; expires:number}>();
 const grants = new Map<string,Grant>();
 const drafts = new Map<string,Draft>();
 const confirmations = new Map<string,Confirmation>();
 const attempts = new Map<string,{count:number;expires:number}>();
 const queues = new Map<string,Promise<unknown>>();
 const pending = new Map<string,number>();
 let totalPending=0;
 let closed = false;
 function open() {if(closed)throw new IdentityError('unavailable','로컬 연결 체험이 종료되었습니다.');}
 function cleanup() {
  const time=now();
  for(const map of [pairs,grants,drafts,confirmations,attempts])for(const [key,row] of map)if(row.expires<=time)map.delete(key);
 }
 function room(map: Map<string,unknown>,key: string,max=MAX) {
  if(!map.has(key)&&map.size>=max)throw new IdentityError('rate_limited','잠시 후 다시 시도해 주세요.');
 }
 function invalidate(userId: string) {
  for(const [id,row] of drafts)if(row.userId===userId)drafts.delete(id);
  for(const [id,row] of confirmations)if(row.userId===userId)confirmations.delete(id);
 }
 function run<T>(actor:Actor,work:()=>Promise<T>):Promise<T> {
  open();cleanup();
  // Serialize per account so a token binds to exactly one operation, including
  // overlapping requests. Global queue capacity also bounds pending accounts.
  room(queues,actor.userId);
  if((pending.get(actor.userId)??0)>=16||totalPending>=MAX_CONTENT)throw new IdentityError('rate_limited','잠시 후 다시 시도해 주세요.');
  pending.set(actor.userId,(pending.get(actor.userId)??0)+1);totalPending++;
  const previous=queues.get(actor.userId);
  const next=(previous??Promise.resolve()).catch(()=>{}).then(async()=>{open();cleanup();return work();});
  queues.set(actor.userId,next);
  void next.finally(()=>{
   totalPending--;const count=(pending.get(actor.userId)??1)-1;
   if(count)pending.set(actor.userId,count);else pending.delete(actor.userId);
   if(queues.get(actor.userId)===next)queues.delete(actor.userId);
  }).catch(()=>{});
  return next;
 }
 async function current(actor:Actor) {open();const trips=await identityService.listTrips(actor);open();return trips;}
 const sameSession=(actor:Actor,grant:Grant)=>grant.actor.userId===actor.userId&&grant.actor.sessionHash===actor.sessionHash;
 async function grantFor(actor:Actor) {
  const trips=await current(actor), grant=grants.get(actor.userId);
  // This local harness delegates no authority across app sessions. The actor
  // checked atomically by the ledger is also the actor that established the grant.
  if(!grant||!sameSession(actor,grant)||grant.expires<=now())return forbidden();
  await current(grant.actor); // Existing identity service checks the captured app session.
  if(grants.get(actor.userId)!==grant||grant.expires<=now())return forbidden();
  return {grant,trips};
 }
 async function tripFor(actor:Actor,grant:Grant,tripId=grant.tripId) {
  if(!tripId)return forbidden();
  const trip=await identityService.getTrip(actor,tripId);
  await identityService.getTrip(grant.actor,tripId);
  const ledger=await ledgerService.get(actor,tripId);
  const captured=await ledgerService.get(grant.actor,tripId);
  editable(ledger);editable(captured);
  if(grants.get(actor.userId)!==grant||grant.expires<=now())return forbidden();
  return {trip,ledger};
 }
 function statusDTO(grant:Grant|undefined,trips:TripDTO[]):KakaoLocalStatus {
  return {source:'synthetic',linked:Boolean(grant),expiresAt:grant?iso(grant.expires):null,tripId:grant?.tripId??null,trips};
 }
 function bound(row:Bound|undefined,actor:Actor,grant:Grant):asserts row is Bound {
  if(!row||row.userId!==actor.userId||row.generation!==grant.generation||row.tripId!==grant.tripId||row.expires<=now())forbidden();
 }
 function draftFor(actor:Actor,grant:Grant,id:string) {
  const row=drafts.get(id);bound(row,actor,grant);return row as Draft;
 }
 return {
  status:actor=>run(actor,async()=>{
   const trips=await current(actor),grant=grants.get(actor.userId);
   // A different valid login needs an explicit local reconnection. Do not revoke
   // the original session's grant or report its authentication error as caller 401.
   if(!grant||!sameSession(actor,grant)||grant.expires<=now())return statusDTO(undefined,trips);
   try {
    await current(grant.actor);
    if(grant.tripId)await tripFor(actor,grant);
   } catch(error) {
    if(!(error instanceof IdentityError)||error.code!=='unauthenticated')throw error;
    return statusDTO(undefined,await current(actor));
   }
   if(grant.expires<=now())return statusDTO(undefined,trips);
   return statusDTO(grant,trips);
  }),
  issuePair:actor=>run(actor,async()=>{
   await current(actor);room(pairs,actor.userId);
   const code=secret(),expires=now()+5*MINUTE;pairs.set(actor.userId,{hash:hash(code),expires});
   return {code,expiresAt:iso(expires)};
  }),
  connect:(actor,code)=>run(actor,async()=>{
   const trips=await current(actor);room(attempts,actor.userId);
   const attempt=attempts.get(actor.userId)??{count:0,expires:now()+5*MINUTE};
   if(attempt.count>=5)throw new IdentityError('rate_limited','연결 코드 확인 횟수를 초과했습니다. 5분 후 다시 시도해 주세요.');
   attempts.set(actor.userId,attempt);
   const pair=pairs.get(actor.userId);
   if(typeof code!=='string'||code.length!==43||!pair||pair.expires<=now()||pair.hash!==hash(code)){attempt.count++;return forbidden();}
   room(grants,actor.userId);pairs.delete(actor.userId);attempts.delete(actor.userId);invalidate(actor.userId);
   const grant:Grant={actor:Object.freeze({...actor}),generation:randomUUID(),expires:now()+30*MINUTE,tripId:null};
   grants.set(actor.userId,grant);return statusDTO(grant,trips);
  }),
  unlink:actor=>run(actor,async()=>{
   const trips=await current(actor);invalidate(actor.userId);grants.delete(actor.userId);pairs.delete(actor.userId);
   return statusDTO(undefined,trips);
  }),
  selectTrip:(actor,rawTripId)=>run(actor,async()=>{
   const {grant,trips}=await grantFor(actor),tripId=ledgerId(rawTripId,'tripId');
   await tripFor(actor,grant,tripId);
   if(grant.tripId!==tripId){invalidate(actor.userId);grant.tripId=tripId;grant.generation=randomUUID();}
   return statusDTO(grant,trips);
  }),
  prepare:(actor,message)=>run(actor,async()=>{
   const {grant}=await grantFor(actor),{ledger}=await tripFor(actor,grant);
   const result=await draftService.extract(actor,ledger.tripId,message,ledger.revision);
   if(result.source!=='synthetic')throw new IdentityError('unavailable','이 화면에서는 로컬 합성 예문만 사용할 수 있습니다.');
   await grantFor(actor);const {ledger:latest}=await tripFor(actor,grant);
   if(latest.revision!==ledger.revision)conflict();
   const id=randomUUID(),expires=Math.min(now()+10*MINUTE,grant.expires);
   room(drafts,id,MAX_CONTENT);
   const dto={...result,id,expiresAt:iso(expires)};
   drafts.set(id,{userId:actor.userId,generation:grant.generation,tripId:ledger.tripId,expires,dto:structuredClone(dto),confirmed:false});
   return dto;
  }),
  review:(actor,rawId,input)=>run(actor,async()=>{
   const {grant}=await grantFor(actor),{trip,ledger}=await tripFor(actor,grant);
   const id=ledgerId(rawId,'draftId'),draft=draftFor(actor,grant,id);
   if(draft.confirmed)conflict();
   if(ledger.revision!==draft.dto.baseRevision)conflict();
   const command=normalizeLedgerCommand({type:draft.dto.kind+'.create',input});
   if(command.type!=='schedule.create'&&command.type!=='expense.create')return forbidden();
   // Formatting is normalized here; reference, date and settlement rules remain
   // enforced by the existing ledger write transaction at confirmation.
   for(const [key,row] of confirmations)if(row.draftId===id)confirmations.delete(key);
   const token=secret(),key=hash(token),expires=Math.min(now()+5*MINUTE,draft.expires,grant.expires);
   room(confirmations,key,MAX_CONTENT);
   confirmations.set(key,{userId:actor.userId,generation:grant.generation,tripId:trip.id,expires,draftId:id,command:structuredClone(command),revision:ledger.revision});
   return {token,tripId:trip.id,tripName:trip.name,kind:draft.dto.kind,input:structuredClone(command.input),baseRevision:ledger.revision,expiresAt:iso(expires)};
  }),
  confirm:(actor,token,rawOperationId)=>run(actor,async()=>{
   // These checks precede receipt handling. A receipt never restores authority.
   const {grant}=await grantFor(actor);await tripFor(actor,grant);
   if(typeof token!=='string'||token.length!==43)return forbidden();
   const row=confirmations.get(hash(token));bound(row,actor,grant);
   const confirmation=row as Confirmation,draft=draftFor(actor,grant,confirmation.draftId);
   const operationId=ledgerId(rawOperationId,'operationId');
   if(confirmation.operationId&&confirmation.operationId!==operationId)conflict();
   // Bind even after a failed/ambiguous write, allowing only the same operation
   // to retry. The ledger identifies its receipt before checking base revision.
   confirmation.operationId=operationId;
   const result=await ledgerService.execute(grant.actor,confirmation.tripId,confirmation.command,confirmation.revision,operationId);
   draft.confirmed=true;
   return result;
  }),
  cancel:(actor,rawId)=>run(actor,async()=>{
   const {grant}=await grantFor(actor);await tripFor(actor,grant);
   const id=ledgerId(rawId,'draftId');draftFor(actor,grant,id);drafts.delete(id);
   for(const [key,row] of confirmations)if(row.draftId===id)confirmations.delete(key);
  }),
  close(){closed=true;pairs.clear();grants.clear();drafts.clear();confirmations.clear();attempts.clear();queues.clear();}
 };
}
