export const refKey = ref => `${ref.provider}:${ref.placeId}`;
export function validRef(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 &&
    Object.hasOwn(value,'provider') && Object.hasOwn(value,'placeId') && ['demo','google'].includes(value.provider) &&
    typeof value.placeId === 'string' && value.placeId.length > 0 && value.placeId.length <= 256 &&
    !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value.placeId);
}
const text = (value,max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const point = p => p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180;
export function parseDisplay(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    typeof value.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.expiresAt) ||
    !Number.isFinite(Date.parse(value.expiresAt)) || new Date(value.expiresAt).toISOString().slice(0,19)!==value.expiresAt.slice(0,19) ||
    !Array.isArray(value.attributions) || value.attributions.length>30) throw Error('invalid_display');
  const attributions=value.attributions.map(source=>{
    if(!text(source?.displayName,200) || !source.displayName.trim() || !text(source?.uri,2000) || /[\s\u0000-\u001f\u007f-\u009f]/u.test(source.uri))throw Error('invalid_display');
    const url=new URL(source.uri);
    if(url.protocol!=='https:' || url.username || url.password)throw Error('invalid_display');
    return {displayName:source.displayName,uri:url.href};
  });
  return {expiresAt:value.expiresAt,attributions};
}
export function parsePlaces(value,refs,allowRepeated=false) {
  if (!Array.isArray(value) || value.length > (refs ? 60 : 20)) throw Error('invalid_response');
  const seen = new Set();
  return value.map(row => {
    if (!row || !validRef(row.ref) || !text(row.name,200) || !text(row.address,500) || !point(row) ||
      row.source !== (row.ref.provider === 'demo' ? 'synthetic' : 'google') || (!allowRepeated && seen.has(refKey(row.ref))) ||
      refs && !refs.some(ref=>refKey(ref)===refKey(row.ref))) throw Error('invalid_response');
    seen.add(refKey(row.ref));
    return {ref:{...row.ref},name:row.name,address:row.address,lat:row.lat,lng:row.lng,source:row.source,...(row.source==='google'?{display:parseDisplay(row.display)}:{})};
  });
}
export function parseRoute(value,refs,mode) {
  if (!value || value.mode !== mode || !['synthetic','google'].includes(value.source) || !text(value.message,500)) throw Error('invalid_response');
  const base = {status:value.status,source:value.source,mode,message:value.message};
  if (['unsupported','error'].includes(value.status)) return base;
  if (value.status !== 'ok') throw Error('invalid_response');
  const places = parsePlaces(value.places,refs,true);
  if (places.length !== refs.length || places.some((p,i)=>refKey(p.ref)!==refKey(refs[i]) || p.source!==value.source) ||
    !Array.isArray(value.path) || value.path.length < 2 || value.path.length > 200 || !value.path.every(point)) throw Error('invalid_response');
  const display=value.source==='google'?parseDisplay(value.display):undefined;
  if(display && places.some(place=>Date.parse(display.expiresAt)>Date.parse(place.display.expiresAt)))throw Error('invalid_display');
  return {...base,places,path:value.path.map(({lat,lng})=>({lat,lng})),...(display?{display}:{})};
}
