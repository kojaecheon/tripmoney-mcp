import type {Actor} from '../../core/contracts.js';
import type {PlaceCandidate,PlaceRef,RouteMode,RoutePreview} from '../../core/places/contracts.js';

export interface PlaceProvider {
  search(query: string): Promise<unknown>;
  resolve(refs: PlaceRef[]): Promise<unknown>;
  route(refs: PlaceRef[], mode: RouteMode): Promise<unknown>;
}
export interface PlaceService {
  search(actor: Actor, tripId: string, query: string): Promise<PlaceCandidate[]>;
  resolve(actor: Actor, tripId: string, refs: PlaceRef[]): Promise<PlaceCandidate[]>;
  route(actor: Actor, tripId: string, refs: PlaceRef[], mode: RouteMode): Promise<RoutePreview>;
}
