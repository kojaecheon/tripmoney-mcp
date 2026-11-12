import type { Actor, Change, Invite, Member, Role, Trip, TripInput } from '../../core/contracts.js';
export type TripSettings = Omit<TripInput, 'alias'>;
export type TripDTO = TripSettings & { id: string; revision: number; status: 'active'; createdAt: string; ownerMemberId: string; role: Role; memberCount: number };
export type MemberDTO = { id: string; tripId: string; alias: string; role: Role; active: boolean; isMe: boolean };
export type InviteDTO = { id: string; role: 'editor' | 'viewer'; status: 'pending' | 'accepted' | 'revoked' | 'expired'; expiresAt: string };
export type InviteLink = { invite: InviteDTO; url: string };
export type TripMembership = { trip: TripDTO; member: MemberDTO };
export type InviteInspection = { state: 'pending'; tripName: string; role: 'editor' | 'viewer'; expiresAt: string } | { state: 'joined'; tripId: string };
export interface IdentityService {
 createTrip(actor: Actor, input: TripInput, operationId: string): Promise<Change<{ trip: TripDTO; ownerMember: MemberDTO }>>;
 listTrips(actor: Actor): Promise<TripDTO[]>;
 getTrip(actor: Actor, tripId: string): Promise<TripDTO>;
 updateTrip(actor: Actor, tripId: string, input: TripSettings, expectedRevision: number, operationId: string): Promise<Change<TripDTO>>;
 listMembers(actor: Actor, tripId: string): Promise<MemberDTO[]>;
 manageMember(actor: Actor, tripId: string, memberId: string, role: 'editor' | 'viewer', active: boolean, expectedRevision: number, operationId: string): Promise<Change<MemberDTO>>;
 issueInvite(actor: Actor, tripId: string, role: 'editor' | 'viewer', expectedRevision: number, operationId: string): Promise<Change<InviteLink>>;
 listInvites(actor: Actor, tripId: string): Promise<InviteDTO[]>;
 getInviteLink(actor: Actor, tripId: string, inviteId: string): Promise<InviteLink>;
 revokeInvite(actor: Actor, tripId: string, inviteId: string, expectedRevision: number, operationId: string): Promise<Change<InviteDTO>>;
 inspectInvite(actor: Actor, token: string, clientHash: string): Promise<InviteInspection>;
 acceptInvite(actor: Actor, token: string, alias: string, operationId: string, clientHash: string): Promise<Change<TripMembership>>;
}
// Internal process-only repository contract. These rows never cross HTTP boundaries.
export type StoredMember = Member & { createdAt: string };
export type StoredInvite = Invite & { createdAt: string };
export type InviteView = Omit<StoredInvite, 'status'> & { status: InviteDTO['status'] };
export type TripSnapshot = { trip: Trip; members: StoredMember[] };
export type Operation = { operationId: string; hash: string };
export type InviteProof = { id: string; kid: string; hash: string };
export type Awaitable<T> = T | Promise<T>;
export interface IdentityRepository {
 create(actor: Actor, input: TripInput, operation: Operation): Awaitable<Change<TripSnapshot>>;
 list(actor: Actor): Awaitable<TripSnapshot[]>;
 get(actor: Actor, tripId: string): Awaitable<TripSnapshot>;
 update(actor: Actor, tripId: string, input: TripSettings, expected: number, operation: Operation): Awaitable<Change<TripSnapshot>>;
 members(actor: Actor, tripId: string): Awaitable<StoredMember[]>;
 manage(actor: Actor, tripId: string, memberId: string, role: 'editor' | 'viewer', active: boolean, expected: number, operation: Operation): Awaitable<Change<StoredMember>>;
 issue(actor: Actor, tripId: string, role: 'editor' | 'viewer', expected: number, operation: Operation, proof: InviteProof): Awaitable<Change<InviteView>>;
 invites(actor: Actor, tripId: string): Awaitable<InviteView[]>;
 link(actor: Actor, tripId: string, inviteId: string): Awaitable<InviteView>;
 revoke(actor: Actor, tripId: string, inviteId: string, expected: number, operation: Operation): Awaitable<Change<InviteView>>;
 reserveAttempt(actor: Actor, clientHash: string): Awaitable<void>;
 inspect(actor: Actor, proof: InviteProof): Awaitable<InviteInspection>;
 accept(actor: Actor, proof: InviteProof, alias: string, operation: Operation): Awaitable<Change<TripSnapshot>>;
 close(): void;
}
