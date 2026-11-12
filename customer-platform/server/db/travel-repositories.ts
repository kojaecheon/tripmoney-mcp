import type { Pool } from 'pg';
import { IdentityError, type Actor } from '../../core/contracts.js';
import type { Awaitable, IdentityRepository, InviteProof } from '../identity/contracts.js';
import type { LedgerRepository } from '../ledger/contracts.js';
import { buildIdentityRepository } from '../local/identity-store.js';
import { buildLedgerRepository } from '../local/ledger-store.js';
import { createTravelState, failure } from '../local/travel-state.js';
import { withActor } from './actor.js';
import { decodeTravelState, encodeTravelState } from './travel-state-codec.js';

type Scope = {kind:'create'|'list'} | {kind:'trip';tripId:string} | {kind:'invite';proof:InviteProof};
type Domain = {identity: IdentityRepository; ledger: LedgerRepository};
/** Uses a caller-owned, restricted customer_app pool. close invalidates this adapter, never closes the shared pool. */
export function createPgTravelRepositories({pool,now=Date.now}: {pool:Pool;now?:()=>number}) {
  let closed = false;
  const checkOpen = () => { if (closed) throw failure('unavailable'); };
  async function transaction<T>(actor: Actor, scope: Scope, action: string | null,
                                work: (domain: Domain) => Awaitable<T>): Promise<T> {
    checkOpen();
    return withActor(pool,actor,async db => {
      checkOpen();
      const encodedScope=JSON.stringify(scope);
      const loaded=await db.query('select customer_private.travel_load($1::jsonb) as state',[encodedScope]);
      const initial=decodeTravelState(loaded.rows[0]?.state), before=encodeTravelState(initial);
      let live=true;
      const shared=createTravelState({now,initialState:initial,assertActor(candidate) {
        checkOpen();
        // This lease exists only inside withActor after the database verified the actual session.
        if (!live || candidate.userId!==actor.userId || candidate.sessionHash!==actor.sessionHash) {
          throw new IdentityError('unauthenticated','다시 로그인해 주세요.');
        }
      }});
      try {
        const domain={identity:buildIdentityRepository(shared,now).repository,ledger:buildLedgerRepository(shared)};
        const result=await work(domain);
        checkOpen();
        const after=encodeTravelState(shared.read(actor,state=>state));
        if (action!==null && JSON.stringify(before)!==JSON.stringify(after)) {
          const saved=await db.query('select customer_private.travel_save($1::jsonb,$2::jsonb,$3::jsonb,$4::text) as saved',
            [encodedScope,JSON.stringify(before),JSON.stringify(after),action]);
          if (saved.rows[0]?.saved!==true) throw failure('unavailable');
        }
        checkOpen();
        return result;
      } finally {live=false;shared.close();}
    });
  }
  const trip=(tripId:string): Scope=>({kind:'trip',tripId});
  const invitation=(proof:InviteProof): Scope=>({kind:'invite',proof});
  const identityRepository: IdentityRepository={
    create:(actor,input,op)=>transaction(actor,{kind:'create'},'create',d=>d.identity.create(actor,input,op)),
    list:actor=>transaction(actor,{kind:'list'},null,d=>d.identity.list(actor)),
    get:(actor,id)=>transaction(actor,trip(id),null,d=>d.identity.get(actor,id)),
    update:(actor,id,input,expected,op)=>transaction(actor,trip(id),'update',d=>d.identity.update(actor,id,input,expected,op)),
    members:(actor,id)=>transaction(actor,trip(id),null,d=>d.identity.members(actor,id)),
    manage:(actor,id,memberId,role,active,expected,op)=>transaction(actor,trip(id),'manage',d=>d.identity.manage(actor,id,memberId,role,active,expected,op)),
    issue:(actor,id,role,expected,op,proof)=>transaction(actor,trip(id),'issue',d=>d.identity.issue(actor,id,role,expected,op,proof)),
    invites:(actor,id)=>transaction(actor,trip(id),null,d=>d.identity.invites(actor,id)),
    link:(actor,id,inviteId)=>transaction(actor,trip(id),null,d=>d.identity.link(actor,id,inviteId)),
    revoke:(actor,id,inviteId,expected,op)=>transaction(actor,trip(id),'revoke',d=>d.identity.revoke(actor,id,inviteId,expected,op)),
    inspect:(actor,proof)=>transaction(actor,invitation(proof),null,d=>d.identity.inspect(actor,proof)),
    accept:(actor,proof,alias,op)=>transaction(actor,invitation(proof),'accept',d=>d.identity.accept(actor,proof,alias,op)),
    async reserveAttempt(actor,clientHash) {
      checkOpen();
      if (typeof clientHash!=='string' || !/^[0-9a-f]{64}$/.test(clientHash)) {
        throw new IdentityError('validation','입력 내용을 확인해 주세요.','clientHash');
      }
      await withActor(pool,actor,async db=>{
        checkOpen();
        const result=await db.query('select customer_private.travel_reserve_attempt($1::text) as allowed',[clientHash]);
        if (result.rows[0]?.allowed===false) throw failure('rate_limited');
        if (result.rows[0]?.allowed!==true) throw failure('unavailable');
        checkOpen();
      });
    },
    close(){closed=true;}
  };
  const ledgerRepository: LedgerRepository={
    get:(actor,id)=>transaction(actor,trip(id),null,d=>d.ledger.get(actor,id)),
    execute:(actor,id,prepare)=>transaction(actor,trip(id),'ledger',d=>d.ledger.execute(actor,id,prepare))
  };
  return {identityRepository,ledgerRepository,close:()=>identityRepository.close()};
}
