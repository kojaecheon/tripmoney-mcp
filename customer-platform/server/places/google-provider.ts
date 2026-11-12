import type {PlaceCandidate,PlaceRef,RouteMode,RoutePreview} from '../../core/places/contracts.js';
import type {PlaceProvider} from './contracts.js';
import {coordinate,placeDisplay,placeList,routePreview} from './validation.js';
import {configured,isRecord,providerJson,providerUnavailable,safeText,type LiveProviderConfig} from '../ai/provider-transport.js';

export type GooglePlaceProviderConfig=LiveProviderConfig;
const mask='id,displayName,formattedAddress,location,attributions';
function googleRef(ref:PlaceRef):boolean{return isRecord(ref)&&Object.keys(ref).length===2&&ref.provider==='google'&&typeof ref.placeId==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(ref.placeId);}
function project(raw:unknown,expiresAt:string):PlaceCandidate {
 if(!isRecord(raw)||!isRecord(raw.displayName)||!isRecord(raw.location)||typeof raw.id!=='string'||!googleRef({provider:'google',placeId:raw.id})||
  !safeText(raw.displayName.text,200)||!safeText(raw.formattedAddress,500)||!coordinate(raw.location.latitude,90)||!coordinate(raw.location.longitude,180))throw providerUnavailable();
 // Empty protobuf repeated fields can be omitted. Present attribution data must be valid.
 const attributions=raw.attributions===undefined?[]:raw.attributions;
 if(!Array.isArray(attributions)||attributions.length>30)throw providerUnavailable();
 const display=placeDisplay({expiresAt,attributions:attributions.map(row=>{if(!isRecord(row))throw providerUnavailable();return {displayName:row.provider,uri:row.providerUri};})});
 return {ref:{provider:'google',placeId:raw.id},name:raw.displayName.text,address:raw.formattedAddress,lat:raw.location.latitude,lng:raw.location.longitude,source:'google',display};
}
/** No cache: only PlaceRef is durable. Display requires a Google map or Google logo,
 * applicable third-party attributions and current data. Runtime remains synthetic until UI is ready. */
export function createGooglePlaceProvider(config:GooglePlaceProviderConfig):PlaceProvider {
 const request=async(url:string,fieldMask:string,body?:unknown)=>{
  let receivedAt:number|undefined;
  const raw=await providerJson({...config,fetcher:config.fetcher?async(input,init)=>{
   const response=await config.fetcher!(input,init);receivedAt=(config.now??Date.now)();return response;
  }:undefined},'google',url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':config.apiKey,'X-Goog-FieldMask':fieldMask},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(receivedAt===undefined||!Number.isFinite(receivedAt))throw providerUnavailable();
  return {raw,expiresAt:new Date(receivedAt+300000).toISOString()};
 };
 const resolve=async(refs:PlaceRef[])=>{
  if(!configured(config)||!Array.isArray(refs)||refs.length>60||refs.some(ref=>!googleRef(ref)))throw providerUnavailable();
  const rows:PlaceCandidate[]=[];
  for(const ref of refs){const response=await request(`https://places.googleapis.com/v1/places/${encodeURIComponent(ref.placeId)}?languageCode=ko`,mask),row=project(response.raw,response.expiresAt);if(row.ref.placeId!==ref.placeId)throw providerUnavailable();rows.push(row);}
  return placeList(rows,refs);
 };
 return {
  async search(query){
   if(!configured(config)||!safeText(query,120))throw providerUnavailable();
   try{const {raw,expiresAt}=await request('https://places.googleapis.com/v1/places:searchText',mask.split(',').map(field=>`places.${field}`).join(','),{textQuery:query.trim(),pageSize:20,languageCode:'ko'});
    if(!isRecord(raw)||(raw.places!==undefined&&!Array.isArray(raw.places)))throw providerUnavailable();const places=raw.places===undefined?[]:raw.places as unknown[];return placeList(places.map(row=>project(row,expiresAt)));
   }catch{throw providerUnavailable();}
  },
  async resolve(refs){try{return await resolve(refs);}catch{throw providerUnavailable();}},
  async route(refs,mode){
   const result=(status:'error'|'unsupported',message:string):RoutePreview=>({status,source:'google',mode,message});
   if(!Array.isArray(refs)||refs.length<2||refs.length>12||refs.some(ref=>!googleRef(ref))||!['walking','driving'].includes(mode))return result('unsupported','Google 경로는 도보·차량 이동과 중간 경유지 10개까지 지원합니다.');
   if(!configured(config))return result('error','Google 경로 연결을 사용할 수 없습니다.');
   try{
    const unique=[...new Map(refs.map(ref=>[ref.placeId,ref])).values()],resolved=await resolve(unique);
    const places=refs.map(ref=>resolved.find(p=>p.ref.placeId===ref.placeId)!);
    const point=(ref:PlaceRef)=>({placeId:ref.placeId});
    const {raw,expiresAt}=await request('https://routes.googleapis.com/directions/v2:computeRoutes','routes.polyline.geoJsonLinestring',{
     origin:point(refs[0]!),destination:point(refs.at(-1)!),intermediates:refs.slice(1,-1).map(point),travelMode:mode==='driving'?'DRIVE':'WALK',
     ...(mode==='driving'?{routingPreference:'TRAFFIC_UNAWARE'}:{}),computeAlternativeRoutes:false,polylineQuality:'OVERVIEW',polylineEncoding:'GEO_JSON_LINESTRING',languageCode:'ko',
    });
    if(!isRecord(raw)||!Array.isArray(raw.routes)||raw.routes.length>1)throw providerUnavailable();
    if(!raw.routes.length)return result('unsupported','이 지역이나 이동 방식의 Google 경로를 찾지 못했습니다.');
    const route=raw.routes[0];if(!isRecord(route)||!isRecord(route.polyline)||!isRecord(route.polyline.geoJsonLinestring))throw providerUnavailable();
    const line=route.polyline.geoJsonLinestring;if(line.type!=='LineString'||!Array.isArray(line.coordinates)||line.coordinates.length<2||line.coordinates.length>200)throw providerUnavailable();
    const path=line.coordinates.map(p=>{if(!Array.isArray(p)||p.length!==2||!coordinate(p[0],180)||!coordinate(p[1],90))throw providerUnavailable();return {lat:p[1],lng:p[0]};});
    const display=placeDisplay({expiresAt:new Date(Math.min(Date.parse(expiresAt),...places.map(place=>Date.parse(place.display!.expiresAt)))).toISOString(),
     attributions:[...new Map(places.flatMap(place=>place.display!.attributions).map(row=>[JSON.stringify([row.displayName,row.uri]),row])).values()]});
    return routePreview({status:'ok',source:'google',mode,message:'Google 제공 경로입니다. 교통 상황과 경유지 최적화는 반영하지 않습니다.',places,path,display},refs,mode);
   }catch{return result('error','Google 경로를 조회하지 못했습니다. 저장된 일정은 유지됩니다.');}
  },
 };
}
