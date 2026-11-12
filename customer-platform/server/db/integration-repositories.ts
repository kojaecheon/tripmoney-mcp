import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {IdentityError, type Actor} from '../../core/contracts.js';
import {canonicalHash} from '../../core/token.js';
import {normalizeLedgerCommand} from '../../core/ledger/normalize.js';
import type {LedgerChange} from '../../core/ledger/contracts.js';
import type {ChannelClaim, ChannelCommand, ChannelRepository, KakaoSender, ProviderUsageStore} from '../integration/contracts.js';
import {buildLedgerRepository} from '../local/ledger-store.js';
import {createTravelState, failure} from '../local/travel-state.js';
import {identityDbError, withActor} from './actor.js';
import {decodeTravelState, encodeTravelState} from './travel-state-codec.js';

const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invalid=()=>new IdentityError('validation','입력 내용을 확인해 주세요.');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function identifier(value:string){if(typeof value!=='string'||!uuid.test(value))throw invalid();return value;}
function secret(value:string,pattern:RegExp){if(typeof value!=='string'||!pattern.test(value))throw invalid();return hash(value);}
/** PostgreSQL JSON timestamptz may include microseconds and an offset. Keep the
 * public wire contract in UTC milliseconds, and reject malformed DB results. */
function normalizedExpiry<T extends {expiresAt:string}>(result:T):T {
  const raw=result.expiresAt;
  if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(raw))throw failure('unavailable');
  const ms=Date.parse(raw),date=Date.parse(raw.slice(0,10)+'T00:00:00Z');
  if(!Number.isFinite(ms)||!Number.isFinite(date)||new Date(date).toISOString().slice(0,10)!==raw.slice(0,10))throw failure('unavailable');
  return {...result,expiresAt:new Date(ms).toISOString()};
}
function senderInput(sender:KakaoSender){
  if(sender?.environment!=='development'||typeof sender.botId!=='string'||sender.botId.length<1||sender.botId.length>128||
    typeof sender.botUserKey!=='string'||sender.botUserKey.length<1||sender.botUserKey.length>256)throw invalid();
  return JSON.stringify({environment:sender.environment,botId:sender.botId,senderHash:hash(sender.botUserKey)});
}
async function value<T>(db:PoolClient,sql:string,args:unknown[]):Promise<T>{
  const result=await db.query(sql,args);if(result.rows[0]?.value===undefined||result.rows[0].value===null)throw failure('unavailable');
  return result.rows[0].value as T;
}
async function transaction<T>(pool:Pool,work:(db:PoolClient)=>Promise<T>):Promise<T>{
  let db:PoolClient;try{db=await pool.connect();}catch(e){throw identityDbError(e);}
  let discard:Error|undefined;
  try{await db.query('begin');const result=await work(db);await db.query('commit');return result;}
  catch(e){try{await db.query('rollback');}catch{discard=new Error('transaction_cleanup_failed');}throw identityDbError(e);}
  finally{db.release(discard);}
}
type Lease={actor:Actor;tripId:string;grantId:string;expiresAt:string;state:unknown;
  confirmation?:{command:ChannelCommand;expectedRevision:number;operationId:string;result:LedgerChange|null}|null};

/** No environment loading or connection creation. Pool must be the restricted server pool.
 * Bot calls use dedicated SQL entry points, never withActor or a fabricated session.
 * The real approving session returned by SQL remains private to the transaction lease. */
export function createPgChannelRepository({pool,now=Date.now}:{pool:Pool;now?:()=>number}):ChannelRepository{
  let closed=false;const check=()=>{if(closed)throw failure('unavailable');};
  async function web<T>(actor:Actor,action:string,input:object,transform?:(result:T)=>T):Promise<T>{check();return withActor(pool,actor,async db=>{
    check();const raw=await value<T>(db,'select customer_private.channel_web($1::text,$2::jsonb) as value',[action,JSON.stringify(input)]);const result=transform?transform(raw):raw;check();return result;
  });}
  async function bot<T>(sender:KakaoSender,work:(db:PoolClient,senderJson:string)=>Promise<T>):Promise<T>{
    check();const encoded=senderInput(sender);return transaction(pool,async db=>{check();const result=await work(db,encoded);check();return result;});
  }
  async function lease<T>(db:PoolClient,encoded:string,tokenHash:string|null,operationId:string|null,
    work:(l:Lease,shared:ReturnType<typeof createTravelState>)=>Promise<T>):Promise<T>{
    const l=normalizedExpiry(await value<Lease>(db,'select customer_private.channel_load($1::jsonb,$2::text,$3::uuid) as value',[encoded,tokenHash,operationId]));
    // Only DB-issued actual approval-session identity is accepted in this private domain lease.
    if(!l.actor||!uuid.test(l.actor.userId)||!/^[0-9a-f]{64}$/.test(l.actor.sessionHash)||!uuid.test(l.tripId)||!uuid.test(l.grantId)||
      !Number.isFinite(Date.parse(l.expiresAt))||Date.parse(l.expiresAt)<=now())throw failure('unavailable');
    let live=true;const shared=createTravelState({now,initialState:decodeTravelState(l.state),assertActor(candidate){
      check();if(!live||candidate.userId!==l.actor.userId||candidate.sessionHash!==l.actor.sessionHash)throw new IdentityError('unauthenticated','다시 로그인해 주세요.');
    }});
    try{return await work(l,shared);}finally{live=false;shared.close();}
  }
  return {
    async issuePair(actor,tripId){const code=randomBytes(12).toString('hex');const result=await web<{expiresAt:string}>(actor,'issue',{tripId:identifier(tripId),codeHash:hash(code)},normalizedExpiry);return {code,expiresAt:result.expiresAt};},
    claimPair(sender,code){return bot(sender,async(db,encoded)=>normalizedExpiry(await value<ChannelClaim>(db,'select customer_private.channel_claim($1::jsonb,$2::text) as value',[encoded,secret(code,/^[a-f0-9]{24}$/)])));},
    approvePair(actor,pendingId,expectedTripId){
      const expected=expectedTripId===undefined?undefined:identifier(expectedTripId).toLowerCase();
      return web<{grantId:string;tripId:string;expiresAt:string}>(actor,'approve',{pendingId:identifier(pendingId)},result=>{
        // Approval may have created a grant. Check before withActor commits so a
        // stale or foreign pending ID cannot persist a connection to another trip.
        if(expected!==undefined&&result.tripId!==expected)throw failure('conflict');
        return normalizedExpiry(result);
      });
    },
    context(sender){return bot(sender,(db,encoded)=>lease(db,encoded,null,null,async(l,shared)=>{
      const ledger=await buildLedgerRepository(shared).get(l.actor,l.tripId);
      const trip=shared.read(l.actor,s=>s.trips.get(l.tripId));if(!trip)throw failure('unavailable');
      return {grantId:l.grantId,tripId:l.tripId,tripName:trip.name,expiresAt:l.expiresAt,ledger};
    }));},
    review(sender,input,expectedRevision){return bot(sender,(db,encoded)=>lease(db,encoded,null,null,async(l,shared)=>{
      const normalized=normalizeLedgerCommand(input);if(normalized.type!=='schedule.create'&&normalized.type!=='expense.create')throw invalid();
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw invalid();
      const command=normalized as ChannelCommand,operationId=randomUUID(),token=randomBytes(32).toString('hex');
      const tripName=shared.read(l.actor,s=>s.trips.get(l.tripId)!.name);
      // Dry run validates revision, permissions, references, money and settlement locks. It is never persisted.
      await buildLedgerRepository(shared).execute(l.actor,l.tripId,()=>({command,expectedRevision,
        operation:{operationId,hash:canonicalHash({tripId:l.tripId,command,expectedRevision})}}));
      const stored=normalizedExpiry(await value<{expiresAt:string}>(db,'select customer_private.channel_review($1::jsonb,$2::uuid,$3::text,$4::uuid,$5::jsonb,$6::bigint) as value',
        [encoded,l.grantId,hash(token),operationId,JSON.stringify(command),expectedRevision]));
      return {token,operationId,tripId:l.tripId,tripName,command,expectedRevision,expiresAt:stored.expiresAt};
    }));},
    confirm(sender,token,operationId){return bot(sender,(db,encoded)=>{
      const tokenHash=secret(token,/^[a-f0-9]{64}$/);identifier(operationId);
      return lease(db,encoded,tokenHash,operationId,async(l,shared)=>{
        const confirmation=l.confirmation;if(!confirmation||confirmation.operationId!==operationId)throw failure('conflict');
        if(confirmation.result)return {...confirmation.result,replayed:true};
        const command=normalizeLedgerCommand(confirmation.command);if(command.type!=='schedule.create'&&command.type!=='expense.create')throw invalid();
        const expectedRevision=confirmation.expectedRevision;
        if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw invalid();
        const before=encodeTravelState(shared.read(l.actor,s=>s));
        const result=await buildLedgerRepository(shared).execute(l.actor,l.tripId,()=>({command,expectedRevision,
          operation:{operationId,hash:canonicalHash({tripId:l.tripId,command,expectedRevision})}}));
        const after=encodeTravelState(shared.read(l.actor,s=>s));
        const saved=await value<boolean>(db,'select customer_private.channel_save($1::jsonb,$2::text,$3::uuid,$4::jsonb,$5::jsonb,$6::jsonb) as value',
          [encoded,tokenHash,operationId,JSON.stringify(before),JSON.stringify(after),JSON.stringify(result)]);
        if(saved!==true)throw failure('unavailable');return result;
      });
    });},
    async unlink(actor,grantId){await web(actor,'unlink',{grantId:identifier(grantId)});},
    close(){closed=true;}
  };
}

/** Reservation is committed before the caller makes any external request. No refund path. */
export function createPgProviderUsageStore({pool,now=Date.now}:{pool:Pool;now?:()=>number}):ProviderUsageStore{
  return {async reserve(input){
    if(!input||typeof input.scope!=='string'||input.scope.length<1||input.scope.length>256||typeof input.requestId!=='string'||
      input.requestId.length<1||input.requestId.length>256||
      (input.periodKey!==undefined&&(typeof input.periodKey!=='string'||!/^[A-Za-z0-9:_-]{1,64}$/.test(input.periodKey)))||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>10000||
      !Number.isSafeInteger(input.expiresAt)||input.expiresAt<=now()||input.expiresAt>now()+172800000)throw invalid();
    return transaction(pool,async db=>{
      const allowed=await value<unknown>(db,'select customer_private.provider_usage_reserve($1::text,$2::text,$3::integer,$4::timestamptz,$5::text) as value',
        [input.scope,input.requestId,input.limit,new Date(input.expiresAt).toISOString(),input.periodKey??null]);
      if(typeof allowed!=='boolean')throw failure('unavailable');return allowed;
    });
  }};
}
