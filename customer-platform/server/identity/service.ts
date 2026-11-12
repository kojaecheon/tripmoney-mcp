import { IdentityError, type Actor, type Change, type TripInput } from '../../core/contracts.js';
import { assertInviteRole, normalizeAlias, normalizeTrip } from '../../core/input.js';
import { canonicalHash, makeInviteToken, sha256, verifyInviteToken } from '../../core/token.js';
import type { IdentityRepository, IdentityService, InviteDTO, InviteView, MemberDTO, Operation, StoredMember, TripDTO, TripSettings, TripSnapshot } from './contracts.js';
const invalid = (field: string): never => { throw new IdentityError('validation', '입력 내용을 확인해 주세요.', field); };
function id(value: string, field: string): string {
 if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) return invalid(field);
 return value.toLowerCase();
}
function revision(value: number): number { if (!Number.isSafeInteger(value) || value < 1) return invalid('expectedRevision'); return value; }
const memberDTO = (member: StoredMember, actor: Actor): MemberDTO => ({ id: member.id, tripId: member.tripId, alias: member.alias, role: member.role, active: member.active, isMe: member.userId === actor.userId });
function tripDTO(snapshot: TripSnapshot, actor: Actor): TripDTO {
 const { ownerUserId, ...trip } = snapshot.trip;
 return { ...trip, ownerMemberId: snapshot.members.find(m => m.role === 'owner')!.id, role: snapshot.members.find(m => m.userId === actor.userId)!.role, memberCount: snapshot.members.filter(m => m.active).length };
}
const inviteDTO = (invite: InviteView): InviteDTO => ({ id: invite.id, role: invite.role, status: invite.status, expiresAt: invite.expiresAt });
function mapChange<T, U>(change: Change<T>, mapper: (value: T) => U): Change<U> { return { value: mapper(change.value), tripRevision: change.tripRevision, replayed: change.replayed }; }
export function createIdentityService({ repository: repo, inviteKeys, activeKid, publicOrigin }: { repository: IdentityRepository; inviteKeys: Record<string, Buffer>; activeKid: string; publicOrigin: string }): IdentityService {
 let origin: string; const keys: Record<string, Buffer> = Object.create(null);
 try {
  const url = new URL(publicOrigin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== publicOrigin || url.username || url.password) throw Error();
  origin = url.origin;
  for (const [kid, key] of Object.entries(inviteKeys)) { makeInviteToken('11111111-1111-1111-1111-111111111111', kid, key); keys[kid] = Buffer.from(key); }
  if (!Object.hasOwn(keys, activeKid)) throw Error();
 } catch { throw new IdentityError('unavailable', '여행 서비스를 잠시 사용할 수 없습니다.'); }
 function operation(action: string, operationId: string, payload: Record<string, unknown>): Operation { return { operationId: id(operationId, 'operationId'), hash: canonicalHash({ action, ...payload }) }; }
 function link(invite: InviteView) {
  const key = keys[invite.keyId];
  if (!key || invite.status !== 'pending') throw new IdentityError('invite_unavailable', '사용할 수 없는 초대입니다.');
  const token = makeInviteToken(invite.id, invite.keyId, key);
  if (sha256(token) !== invite.tokenHash) throw new IdentityError('invite_unavailable', '사용할 수 없는 초대입니다.');
  return { invite: inviteDTO(invite), url: `${origin}/invite#t=${token}` };
 }
 return {
  async createTrip(actor, input, operationId) { const clean = normalizeTrip(input); const result = await repo.create(actor, clean, operation('create', operationId, { input: clean })); return mapChange(result, value => ({ trip: tripDTO(value, actor), ownerMember: memberDTO(value.members.find(m => m.role === 'owner')!, actor) })); },
  async listTrips(actor) { return (await repo.list(actor)).map(value => tripDTO(value, actor)); },
  async getTrip(actor, tripId) { return tripDTO(await repo.get(actor, id(tripId, 'tripId')), actor); },
  async updateTrip(actor, tripId, input, expectedRevision, operationId) {
   if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.hasOwn(input, 'alias')) return invalid('trip');
   const { alias, ...clean } = normalizeTrip({ ...input, alias: 'owner' } as TripInput); const trip = id(tripId, 'tripId'); const expected = revision(expectedRevision);
   return mapChange(await repo.update(actor, trip, clean, expected, operation('update', operationId, { tripId: trip, expectedRevision: expected, input: clean })), value => tripDTO(value, actor));
  },
  async listMembers(actor, tripId) { return (await repo.members(actor, id(tripId, 'tripId'))).map(value => memberDTO(value, actor)); },
  async manageMember(actor, tripId, memberId, role, active, expectedRevision, operationId) {
   const trip = id(tripId, 'tripId'), target = id(memberId, 'memberId'); const cleanRole = assertInviteRole(role), expected = revision(expectedRevision); if (typeof active !== 'boolean') return invalid('active');
   return mapChange(await repo.manage(actor, trip, target, cleanRole, active, expected, operation('manage', operationId, { tripId: trip, targetId: target, expectedRevision: expected, role: cleanRole, active })), value => memberDTO(value, actor));
  },
  async issueInvite(actor, tripId, role, expectedRevision, operationId) {
   const trip = id(tripId, 'tripId'), cleanRole = assertInviteRole(role), expected = revision(expectedRevision); const op = operation('issue', operationId, { tripId: trip, expectedRevision: expected, role: cleanRole });
   const token = makeInviteToken(op.operationId, activeKid, keys[activeKid]!);
   return mapChange(await repo.issue(actor, trip, cleanRole, expected, op, { id: op.operationId, kid: activeKid, hash: sha256(token) }), link);
  },
  async listInvites(actor, tripId) { return (await repo.invites(actor, id(tripId, 'tripId'))).map(inviteDTO); },
  async getInviteLink(actor, tripId, inviteId) { return link(await repo.link(actor, id(tripId, 'tripId'), id(inviteId, 'inviteId'))); },
  async revokeInvite(actor, tripId, inviteId, expectedRevision, operationId) { const trip = id(tripId, 'tripId'), target = id(inviteId, 'inviteId'), expected = revision(expectedRevision); return mapChange(await repo.revoke(actor, trip, target, expected, operation('revoke', operationId, { tripId: trip, targetId: target, expectedRevision: expected })), inviteDTO); },
  async inspectInvite(actor, token, clientHash) { await repo.reserveAttempt(actor, clientHash); return await repo.inspect(actor, verifyInviteToken(token, keys)); },
  async acceptInvite(actor, token, alias, operationId, clientHash) {
   await repo.reserveAttempt(actor, clientHash); const proof = verifyInviteToken(token, keys); const clean = normalizeAlias(alias); const op = operation('accept', operationId, { targetId: proof.id, tokenHash: proof.hash, alias: clean });
   return mapChange(await repo.accept(actor, proof, clean, op), value => ({ trip: tripDTO(value, actor), member: memberDTO(value.members.find(m => m.userId === actor.userId)!, actor) }));
  },
 };
}
