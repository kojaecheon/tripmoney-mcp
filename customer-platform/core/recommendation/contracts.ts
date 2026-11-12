import type {ScheduleInput} from '../ledger/contracts.js';
export type RecommendationPace = 'relaxed' | 'balanced' | 'packed';
export type RecommendationSource = 'synthetic' | 'claude' | 'gemini';
export type RecommendationRequest = {interests: string[]; pace: RecommendationPace};
export type RecommendationDraft = {
 id: string; tripId: string; baseRevision: number; source: RecommendationSource; expiresAt: string;
 items: {id: string; input: ScheduleInput; reason: string; placeStatus: 'synthetic' | 'verified' | 'unverified'}[];
 warnings: string[];
};
