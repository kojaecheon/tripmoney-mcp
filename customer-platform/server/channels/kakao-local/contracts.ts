import type {Actor} from '../../../core/contracts.js';
import type {DraftDTO} from '../../../core/drafts/contracts.js';
import type {ExpenseInput, LedgerChange, ScheduleInput} from '../../../core/ledger/contracts.js';
import type {TripDTO} from '../../identity/contracts.js';

export type PairTicket = {code: string; expiresAt: string};
export type KakaoLocalStatus = {source: 'synthetic'; linked: boolean; expiresAt: string | null; tripId: string | null; trips: TripDTO[]};
export type KakaoLocalDraft = DraftDTO & {id: string; expiresAt: string};
export type KakaoConfirmation = {token: string; tripId: string; tripName: string; kind: DraftDTO['kind']; input: ScheduleInput | ExpenseInput; baseRevision: number; expiresAt: string};
export interface KakaoLocalService {
 status(actor: Actor): Promise<KakaoLocalStatus>;
 issuePair(actor: Actor): Promise<PairTicket>;
 connect(actor: Actor, code: string): Promise<KakaoLocalStatus>;
 unlink(actor: Actor): Promise<KakaoLocalStatus>;
 selectTrip(actor: Actor, tripId: string): Promise<KakaoLocalStatus>;
 prepare(actor: Actor, message: string): Promise<KakaoLocalDraft>;
 review(actor: Actor, draftId: string, input: unknown): Promise<KakaoConfirmation>;
 confirm(actor: Actor, token: string, operationId: string): Promise<LedgerChange>;
 cancel(actor: Actor, draftId: string): Promise<void>;
 close(): void;
}
