import type {Actor} from '../../core/contracts.js';
import type {LedgerChange} from '../../core/ledger/contracts.js';
import type {RecommendationDraft,RecommendationRequest} from '../../core/recommendation/contracts.js';
export interface RecommendationService {
 generate(actor: Actor, tripId: string, request: RecommendationRequest, expectedRevision: number): Promise<RecommendationDraft>;
 adopt(actor: Actor, tripId: string, draftId: string, selectedIds: string[], operationId: string): Promise<LedgerChange>;
 close(): void;
}
