import {normalizePlaceRef} from '../../core/places/contracts.js';
import type {PlaceCandidate,PlaceDisplay,PlaceRef,RouteMode,RoutePreview} from '../../core/places/contracts.js';

export const refKey = (ref: PlaceRef) => `${ref.provider}:${ref.placeId}`;
const record = (v: unknown): v is Record<string,unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
export const coordinate = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
export function placeDisplay(value: unknown): PlaceDisplay {
  if (!record(value) || typeof value.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.expiresAt)) throw new Error('invalid display');
  const timestamp = Date.parse(value.expiresAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== (value.expiresAt.length===20?value.expiresAt.replace('Z','.000Z'):value.expiresAt) ||
      !Array.isArray(value.attributions) || value.attributions.length > 30) throw new Error('invalid display');
  const attributions = Array.from(value.attributions,raw=>{
    if (!record(raw) || !text(raw.displayName,200) || !raw.displayName.trim() || !text(raw.uri,2000) || /\s/u.test(raw.uri)) throw new Error('invalid attribution');
    let uri: URL;
    try {uri = new URL(raw.uri);} catch {throw new Error('invalid attribution');}
    if (uri.protocol !== 'https:' || !uri.hostname || uri.username || uri.password) throw new Error('invalid attribution');
    return {displayName:raw.displayName,uri:raw.uri};
  });
  return {expiresAt:value.expiresAt,attributions};
}
function candidate(value: unknown): PlaceCandidate {
  if (!record(value)) throw new Error('invalid place');
  const ref = normalizePlaceRef(value.ref);
  if (!ref || !text(value.name,200) || !text(value.address,500) || !coordinate(value.lat,90) || !coordinate(value.lng,180) ||
      value.source !== (ref.provider === 'demo' ? 'synthetic' : 'google')) throw new Error('invalid place');
  return {ref,name:value.name,address:value.address,lat:value.lat,lng:value.lng,source:value.source as PlaceCandidate['source'],
    ...(value.source==='google'?{display:placeDisplay(value.display)}:{})};
}
export function placeList(value: unknown, requested?: PlaceRef[], allowRepeated = false): PlaceCandidate[] {
  if (!Array.isArray(value) || value.length > (requested ? 60 : 20)) throw new Error('invalid places');
  const rows = value.map(candidate), keys = rows.map(row=>refKey(row.ref));
  if ((!allowRepeated && new Set(keys).size !== keys.length) || requested && keys.some(key=>!requested.some(ref=>refKey(ref)===key))) throw new Error('invalid references');
  return rows;
}
export function routePreview(value: unknown, refs: PlaceRef[], mode: RouteMode): RoutePreview {
  if (!record(value) || value.mode !== mode || !['synthetic','google'].includes(String(value.source)) || !text(value.message,500)) throw new Error('invalid route');
  const source = value.source as RoutePreview['source'];
  if (value.status === 'unsupported' || value.status === 'error') return {status:value.status,source,mode,message:value.message};
  if (value.status !== 'ok') throw new Error('invalid status');
  const places = placeList(value.places,refs,true);
  if (places.length !== refs.length || places.some((place,i)=>refKey(place.ref)!==refKey(refs[i]!) || place.source!==source) ||
      !Array.isArray(value.path) || value.path.length < 2 || value.path.length > 200 ||
      value.path.some(p=>!record(p) || !coordinate(p.lat,90) || !coordinate(p.lng,180))) throw new Error('invalid route points');
  const display = source==='google'?placeDisplay(value.display):undefined;
  if (display && places.some(place=>Date.parse(display.expiresAt)>Date.parse(place.display!.expiresAt) ||
      place.display!.attributions.some(attribution=>!display.attributions.some(row=>row.displayName===attribution.displayName&&row.uri===attribution.uri)))) throw new Error('invalid route display');
  return {status:'ok',source,mode,message:value.message,places,path:value.path.map(p=>({lat:p.lat as number,lng:p.lng as number})),...(display?{display}:{})};
}
