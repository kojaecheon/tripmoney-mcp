import type { TripInput, Change } from '../core/contracts.js';
import type { LedgerChange, LedgerCommand, LedgerDTO } from '../core/ledger/contracts.js';
import type { TripDTO, TripSettings, MemberDTO, InviteDTO, InviteLink, InviteInspection, TripMembership } from '../server/identity/contracts.js';
import type { PlaceRef, PlaceCandidate, RouteMode, RoutePreview } from '../core/places/contracts.js';
import type { DraftDTO } from '../core/drafts/contracts.js';
import type {RecommendationDraft,RecommendationRequest} from '../core/recommendation/contracts.js';
import type {PairTicket,KakaoLocalStatus,KakaoLocalDraft,KakaoConfirmation} from '../server/channels/kakao-local/contracts.js';
import type {ScheduleInput,ExpenseInput} from '../core/ledger/contracts.js';
export function parsePlaceReference(value: unknown): PlaceRef | null;
export interface AuthMe { userId: string; email: string; expiresAt: string }
export type PublicMapsConfig={mode:'google';browserApiKey:string;mapId:string};
export type PublicConfig = ({ mode:'local-demo';mailDelivery:false;code:'123456' } | {mode:'customer';mailDelivery:boolean;authMethod?:'email-link'}) & {maps?:PublicMapsConfig;changes?:{mode:'long-poll'};channels?:{kakao:{mode:'development';channelUrl:'https://pf.kakao.com/_xjvDxeX';botName:'TripMoney 개발봇'}}};
export interface CustomerApi {
  publicConfig(): Promise<PublicConfig>;
  me(): Promise<{ me: AuthMe }>;
  requestCode(email: string): Promise<{ message: string }>;
  verifyCode(code: string): Promise<{ me: AuthMe }>;
  logout(): Promise<void>;
}
export class ApiError extends Error {
  status: number;
  code: string;
  field?: string;
  reason?: 'alias_taken'|'member_limit';
  constructor(status: number, code: string, field?: string, reason?: string);
}
export function createApi(fetchFn?: (url: string, init: RequestInit) => Promise<Response>): CustomerApi & IdentityApi & LedgerApi & PlanningApi & Phase2Api & ChangesApi & KakaoLiveApi;

export interface ChangesApi {
  waitForChanges(tripId:string,afterRevision:number,account:string,signal?:AbortSignal):Promise<{tripId:string;revision:number}>;
}

export interface Phase2Api {
  generateRecommendation(tripId:string,input:RecommendationRequest,expectedRevision:number,account?:string):Promise<RecommendationDraft>;
  adoptRecommendation(tripId:string,draftId:string,selectedIds:string[],operationId:string,account?:string):Promise<LedgerChange>;
  kakaoStatus(account?:string):Promise<KakaoLocalStatus>;
  issueKakaoPair(account?:string):Promise<PairTicket>;
  connectKakao(code:string,account?:string):Promise<KakaoLocalStatus>;
  unlinkKakao(account?:string):Promise<KakaoLocalStatus>;
  selectKakaoTrip(tripId:string,account?:string):Promise<KakaoLocalStatus>;
  prepareKakaoDraft(message:string,account?:string):Promise<KakaoLocalDraft>;
  reviewKakaoDraft(draftId:string,input:ScheduleInput|ExpenseInput,account?:string):Promise<KakaoConfirmation>;
  confirmKakao(token:string,operationId:string,account?:string):Promise<LedgerChange>;
  cancelKakaoDraft(draftId:string,account?:string):Promise<KakaoLocalStatus>;
}

export interface PlanningApi {
  searchPlaces(tripId:string,query:string,account?:string):Promise<PlaceCandidate[]>;
  resolvePlaces(tripId:string,refs:PlaceRef[],account?:string):Promise<PlaceCandidate[]>;
  routePlaces(tripId:string,refs:PlaceRef[],mode:RouteMode,account?:string):Promise<RoutePreview>;
  generateDraft(tripId:string,message:string,expectedRevision:number,account?:string):Promise<DraftDTO>;
}

export interface LedgerApi extends Pick<CustomerApi, 'me'> {
  getLedger(tripId: string, account?: string): Promise<LedgerDTO>;
  executeLedger(tripId: string, command: LedgerCommand, expectedRevision: number, operationId: string, account?: string): Promise<LedgerChange>;
}

export interface IdentityApi extends Pick<CustomerApi, 'me'> {
 listTrips(account?: string): Promise<TripDTO[]>;
 getTrip(id: string, account?: string): Promise<TripDTO>;
 createTrip(input: TripInput, operationId: string, account?: string): Promise<Change<{trip: TripDTO; ownerMember: MemberDTO}>>;
 updateTrip(id: string, input: TripSettings, expectedRevision: number, operationId: string, account?: string): Promise<Change<TripDTO>>;
 listMembers(id: string, account?: string): Promise<MemberDTO[]>;
 manageMember(id: string, memberId: string, role: 'editor'|'viewer', active: boolean, expectedRevision: number, operationId: string, account?: string): Promise<Change<MemberDTO>>;
 issueInvite(id: string, role: 'editor'|'viewer', expectedRevision: number, operationId: string, account?: string): Promise<Change<InviteLink>>;
 listInvites(id: string, account?: string): Promise<InviteDTO[]>;
 getInviteLink(id: string, inviteId: string, account?: string): Promise<InviteLink>;
 revokeInvite(id: string, inviteId: string, expectedRevision: number, operationId: string, account?: string): Promise<Change<InviteDTO>>;
 inspectInvite(token: string, account?: string): Promise<InviteInspection>;
 acceptInvite(token: string, alias: string, operationId: string, account?: string): Promise<Change<TripMembership>>;
}

export interface KakaoLiveApi {
  issueKakaoLivePair(tripId:string,account:string):Promise<{code:string;expiresAt:string}>;
  approveKakaoLivePair(pendingId:string,tripId:string,account:string):Promise<{grantId:string;tripId:string;expiresAt:string}>;
  unlinkKakaoLive(grantId:string,account:string):Promise<{unlinked:true}>;
}
