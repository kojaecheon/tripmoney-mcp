export type PlaceRef = {provider: 'google' | 'demo'; placeId: string};
export type PlaceAttribution = {displayName:string;uri:string};
/** Transient display data, never part of a saved itinerary. Required for Google at runtime. */
export type PlaceDisplay = {expiresAt:string;attributions:PlaceAttribution[]};
export type PlaceCandidate = {ref: PlaceRef; name: string; address: string; lat: number; lng: number; source: 'synthetic' | 'google';display?:PlaceDisplay};
export type RouteMode = 'walking' | 'driving';
export type RoutePreview = {mode: RouteMode; source: 'synthetic' | 'google'; message: string;display?:PlaceDisplay} & (
  {status: 'ok'; places: PlaceCandidate[]; path: {lat: number; lng: number}[]} |
  {status: 'unsupported' | 'error'}
);

export function normalizePlaceRef(value: unknown): PlaceRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string,unknown>;
  if (Object.keys(row).length !== 2 || !Object.hasOwn(row,'provider') || !Object.hasOwn(row,'placeId') ||
    (row.provider !== 'google' && row.provider !== 'demo') || typeof row.placeId !== 'string' ||
    !row.placeId || row.placeId.length > 256 || /[\s\u0000-\u001f\u007f-\u009f]/u.test(row.placeId)) return null;
  return {provider:row.provider,placeId:row.placeId};
}
