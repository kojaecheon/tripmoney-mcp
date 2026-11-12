import type {RecommendationPace,RecommendationSource} from '../../core/recommendation/contracts.js';
/** Travel-only input. Output is untrusted and cannot write to the ledger. */
export type RecommendationContext = {
 destination: string; startDate: string; endDate: string; timeZone: string; memberCount: number;
 budgetKrw: number; interests: string[]; pace: RecommendationPace;
};
export interface RecommendationProvider {
 readonly source: RecommendationSource;
 generate(context: RecommendationContext): Promise<unknown>;
}
