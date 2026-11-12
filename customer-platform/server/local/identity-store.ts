import { randomUUID } from 'node:crypto';
import { IdentityError, type Actor } from '../../core/contracts.js';
import type { IdentityRepository, InviteProof, InviteView, StoredInvite, StoredMember, TripSnapshot } from '../identity/contracts.js';
import { access, bump, createTravelState, expected, failure, membership, replay, tripMembers,
  type LocalTravelOptions, type LocalTravelState, type TravelState as State } from './travel-state.js';
import { assertTravelSettings, buildLedgerRepository } from './ledger-store.js';

export type LocalIdentityCounts = { trips: number; members: number; invites: number; receipts: number; audits: number; rates: number };

export function createLocalTravelRepositories(options: LocalTravelOptions) {
  const shared = createTravelState(options);
  const {repository: identityRepository} = buildIdentityRepository(shared,options.now ?? Date.now);
  return { identityRepository, ledgerRepository: buildLedgerRepository(shared), close: () => identityRepository.close() };
}
export function createLocalIdentityRepository(options: LocalTravelOptions): IdentityRepository {
  return createLocalTravelRepositories(options).identityRepository;
}
/** Test-only diagnostics expose counts, never rows, identities, tokens or sessions. */
export function createLocalIdentityRepositoryForTests(options: LocalTravelOptions) {
  return buildIdentityRepository(createTravelState(options),options.now ?? Date.now);
}
export function buildIdentityRepository(shared: LocalTravelState, now: () => number) {
 const { read, write, check, stamp, save } = shared;
 let rates: { actorId: string; clientHash: string; at: number }[] = [];
 const snapshot = (s: State, tripId: string): TripSnapshot => ({ trip: s.trips.get(tripId)!, members: tripMembers(s, tripId) });
 const isPending = (invite: StoredInvite) => invite.status === 'pending' && Date.parse(invite.expiresAt) > now();
 const inviteView = (invite: StoredInvite): InviteView => ({ ...invite, status: invite.status === 'pending' && !isPending(invite) ? 'expired' : invite.status });
 function pending(invite: StoredInvite | undefined): StoredInvite { if (!invite || !isPending(invite)) throw failure('invite_unavailable'); return invite; }
 function proven(s: State, proof: InviteProof): StoredInvite { const invite = s.invites.get(proof.id); if (!invite || invite.keyId !== proof.kid || invite.tokenHash !== proof.hash) throw failure('invite_unavailable'); return invite; }
 function inspectable(s: State, actor: Actor, proof: InviteProof) {
  const invite = proven(s, proof), member = membership(s, actor, invite.tripId);
  if (invite.status === 'accepted') {
   if (invite.acceptedBy !== actor.userId || !member?.active) throw failure('invite_unavailable');
   return { invite, member, joined: true };
  }
  pending(invite); return { invite, member, joined: !!member?.active };
 }
 const repository: IdentityRepository = {
  create(actor, input, op) { return write(actor, s => {
   const saved = replay<TripSnapshot>(s, actor, 'create', op);
   if (saved) { access(s, actor, saved.value.trip.id, true); return saved; }
   if ([...s.trips.values()].filter(t => t.ownerUserId === actor.userId).length >= 20) throw failure('conflict');
   const tripId = randomUUID(), memberId = randomUUID(), createdAt = stamp(); const { alias, ...settings } = input;
   s.trips.set(tripId, { ...settings, id: tripId, ownerUserId: actor.userId, revision: 1, status: 'active', createdAt });
   s.members.set(memberId, { id: memberId, tripId, userId: actor.userId, alias, role: 'owner', active: true, createdAt });
   return save(s, actor, 'create', op, tripId, snapshot(s, tripId));
  }); },
  list(actor) { return read(actor, s => [...s.trips.values()].filter(t => membership(s, actor, t.id)?.active).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map(t => snapshot(s, t.id))); },
  get(actor, tripId) { return read(actor, s => { access(s, actor, tripId); return snapshot(s, tripId); }); },
  update(actor, tripId, input, version, op) { return write(actor, s => {
   access(s, actor, tripId, true); const saved = replay<TripSnapshot>(s, actor, 'update', op); if (saved) return saved;
   expected(s, tripId, version); assertTravelSettings(s, tripId, input);
   Object.assign(s.trips.get(tripId)!, input); bump(s, tripId); return save(s, actor, 'update', op, tripId, snapshot(s, tripId));
  }); },
  members(actor, tripId) { return read(actor, s => { access(s, actor, tripId); return tripMembers(s, tripId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)); }); },
  manage(actor, tripId, memberId, role, active, version, op) { return write(actor, s => {
   access(s, actor, tripId, true); const saved = replay<StoredMember>(s, actor, 'manage', op); if (saved) return saved;
   expected(s, tripId, version); const member = s.members.get(memberId);
   if (!member || member.tripId !== tripId) throw failure('not_found');
   if (member.role === 'owner' || !member.active) throw failure('conflict');
   member.role = role; member.active = active; bump(s, tripId); return save(s, actor, 'manage', op, tripId, member, member.id);
  }); },
  issue(actor, tripId, role, version, op, proof) { return write(actor, s => {
   access(s, actor, tripId, true); const saved = replay<InviteView>(s, actor, 'issue', op);
   if (saved) { pending(s.invites.get(saved.value.id)); return saved; }
   expected(s, tripId, version);
   if (s.invites.has(proof.id) || [...s.invites.values()].filter(i => i.tripId === tripId && isPending(i)).length >= 20) throw failure('conflict');
   const invite: StoredInvite = { id: proof.id, tripId, role, keyId: proof.kid, tokenHash: proof.hash, expiresAt: new Date(now() + 7 * 86400_000).toISOString(), status: 'pending', acceptedBy: null, createdAt: stamp() };
   s.invites.set(invite.id, invite); bump(s, tripId); return save(s, actor, 'issue', op, tripId, inviteView(invite), invite.id);
  }); },
  invites(actor, tripId) { return read(actor, s => { access(s, actor, tripId, true); return [...s.invites.values()].filter(i => i.tripId === tripId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map(inviteView); }); },
  link(actor, tripId, inviteId) { return read(actor, s => { access(s, actor, tripId, true); const invite = pending(s.invites.get(inviteId)); if (invite.tripId !== tripId) throw failure('invite_unavailable'); return inviteView(invite); }); },
  revoke(actor, tripId, inviteId, version, op) { return write(actor, s => {
   access(s, actor, tripId, true); const saved = replay<InviteView>(s, actor, 'revoke', op); if (saved) return saved;
   expected(s, tripId, version); const invite = pending(s.invites.get(inviteId)); if (invite.tripId !== tripId) throw failure('invite_unavailable');
   invite.status = 'revoked'; bump(s, tripId); return save(s, actor, 'revoke', op, tripId, inviteView(invite), invite.id);
  }); },
  reserveAttempt(actor, clientHash) {
   check(actor); if (typeof clientHash !== 'string' || !/^[0-9a-f]{64}$/.test(clientHash)) throw new IdentityError('validation', '입력 내용을 확인해 주세요.', 'clientHash');
   const at = now(); rates = rates.filter(r => r.at > at - 60_000);
   if (rates.filter(r => r.actorId === actor.userId).length >= 30 || rates.filter(r => r.clientHash === clientHash).length >= 60) throw failure('rate_limited');
   if (rates.length >= 8192) throw failure('unavailable');
   rates.push({ actorId: actor.userId, clientHash, at });
  },
  inspect(actor, proof) { return read(actor, s => {
   const { invite, joined } = inspectable(s, actor, proof);
   return joined ? { state: 'joined' as const, tripId: invite.tripId } : { state: 'pending' as const, tripName: s.trips.get(invite.tripId)!.name, role: invite.role, expiresAt: invite.expiresAt };
  }); },
  accept(actor, proof, alias, op) { return write(actor, s => {
   const { invite, member } = inspectable(s, actor, proof);
   const saved = replay<TripSnapshot>(s, actor, 'accept', op); if (saved) return saved;
   if (member?.active) return save(s, actor, 'accept', op, invite.tripId, snapshot(s, invite.tripId));
   const members = tripMembers(s, invite.tripId);
   if (members.some(m => m.id !== member?.id && m.alias === alias)) throw Object.assign(failure('conflict'), { reason: 'alias_taken' });
   if (members.filter(m => m.active).length >= 8) throw Object.assign(failure('conflict'), { reason: 'member_limit' });
   if (member) { member.alias = alias; member.role = invite.role; member.active = true; }
   else { const id = randomUUID(); s.members.set(id, { id, tripId: invite.tripId, userId: actor.userId, alias, role: invite.role, active: true, createdAt: stamp() }); }
   invite.status = 'accepted'; invite.acceptedBy = actor.userId; bump(s, invite.tripId);
   return save(s, actor, 'accept', op, invite.tripId, snapshot(s, invite.tripId));
  }); },
  close() { shared.close(); rates = []; },
 };
 return { repository, counts: (): LocalIdentityCounts => ({ ...shared.counts(), rates: rates.length }) };
}
