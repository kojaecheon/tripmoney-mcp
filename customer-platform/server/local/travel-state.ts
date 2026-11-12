import { assertPermission } from '../../core/access.js';
import { IdentityError, type Actor, type Change, type Trip } from '../../core/contracts.js';
import type { ExpenseDTO, LedgerFx, LedgerHistory, PaymentDTO, ScheduleDTO, SettlementSnapshot } from '../../core/ledger/contracts.js';
import type { Operation, StoredInvite, StoredMember } from '../identity/contracts.js';

type Receipt = { hash: string; result: Change<unknown> };
export type LedgerRows = {
  items: ScheduleDTO[]; expenses: ExpenseDTO[]; fx: LedgerFx;
  snapshots: SettlementSnapshot[]; payments: PaymentDTO[];
  expenseRevision: number; confirmedPaymentRevision: number;
};
export type TravelState = {
  trips: Map<string,Trip>; members: Map<string,StoredMember>; invites: Map<string,StoredInvite>;
  receipts: Map<string,Receipt>; audits: (LedgerHistory & {tripId:string})[]; ledgers: Map<string,LedgerRows>;
};
function empty(): TravelState {
  return {trips:new Map(),members:new Map(),invites:new Map(),receipts:new Map(),audits:[],ledgers:new Map()};
}
const messages = {
  unavailable:'여행 서비스를 잠시 사용할 수 없습니다.', conflict:'최신 정보와 입력 내용을 확인해 주세요.',
  not_found:'여행을 찾을 수 없습니다.', invite_unavailable:'사용할 수 없는 초대입니다.', rate_limited:'잠시 뒤 다시 요청해 주세요.'
};
export const failure = (code: keyof typeof messages) => new IdentityError(code,messages[code]);
export const tripMembers = (s: TravelState, id: string) => [...s.members.values()].filter(m => m.tripId === id);
export const membership = (s: TravelState, actor: Actor, id: string) => tripMembers(s,id).find(m => m.userId === actor.userId);
export function access(s: TravelState, actor: Actor, id: string, owner = false): StoredMember {
  const member = membership(s,actor,id);
  if (!s.trips.has(id) || !member?.active) throw failure('not_found');
  assertPermission(member.role,owner ? 'trip:update' : 'trip:read');
  return member;
}
export function expected(s: TravelState, id: string, revision: number) {
  if (s.trips.get(id)!.revision !== revision) throw failure('conflict');
}
export function bump(s: TravelState, id: string) {
  s.trips.get(id)!.revision++;
}
function key(actor: Actor, action: string, op: Operation) {
  return actor.userId + ':' + action + ':' + op.operationId;
}
export function replay<T>(s: TravelState, actor: Actor, action: string, op: Operation): Change<T> | null {
  const saved = s.receipts.get(key(actor,action,op));
  if (!saved) return null;
  if (saved.hash !== op.hash) throw failure('conflict');
  return {...saved.result as Change<T>,replayed:true};
}
export type LocalTravelOptions = {assertActor: (actor: Actor) => void; now?: () => number; initialState?: TravelState};
export function createTravelState({assertActor, now = Date.now, initialState}: LocalTravelOptions) {
  let current = initialState ? structuredClone(initialState) : empty(), closed = false;
  function check(actor: Actor) {
    if (closed) throw failure('unavailable');
    assertActor(actor);
  }
  function stamp() { return new Date(now()).toISOString(); }
  function read<T>(actor: Actor, work: (s: TravelState) => T): T {
    check(actor);
    return structuredClone(work(current));
  }
  function write<T>(actor: Actor, work: (s: TravelState) => T, verify?: (s: TravelState) => void): T {
    check(actor);
    const original = current;
    const next = structuredClone(original);
    const result = structuredClone(work(next));
    if (next.trips.size > 256 || next.members.size > 2048 || next.invites.size > 4096 ||
        next.receipts.size > 8192 || next.audits.length > 8192) throw failure('unavailable');
    check(actor);
    if (current === original) verify?.(original);
    if (current !== original) throw failure(closed ? 'unavailable' : 'conflict');
    current = next;
    return result;
  }
  function save<T>(s: TravelState, actor: Actor, action: string, op: Operation, tripId: string,
                   value: T, targetId: string | null = tripId): Change<T> {
    const revision = s.trips.get(tripId)!.revision;
    const result = {value,tripRevision:revision,replayed:false};
    s.receipts.set(key(actor,action,op),{hash:op.hash,result:structuredClone(result)});
    const member = membership(s,actor,tripId)!;
    s.audits.push({tripId,memberId:member.id,action,targetId,at:stamp(),revision});
    return result;
  }
  function counts() {
    return {trips:current.trips.size,members:current.members.size,invites:current.invites.size,
      receipts:current.receipts.size,audits:current.audits.length};
  }
  return {check,read,write,stamp,save,counts,close() { closed = true; current = empty(); }};
}
export type LocalTravelState = ReturnType<typeof createTravelState>;
