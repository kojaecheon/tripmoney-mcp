import {parsePlaces,parseRoute,refKey,validRef} from './validation.mjs';

export function googleDirectionsLink(refs,mode) {
  if (!Array.isArray(refs) || refs.length < 2 || refs.length > 20 || !['walking','driving'].includes(mode) ||
    refs.some(ref=>!validRef(ref) || ref.provider !== 'google')) return null;
  const first=refs[0], last=refs.at(-1);
  const params=new URLSearchParams({api:'1',origin:first.placeId,origin_place_id:first.placeId,
    destination:last.placeId,destination_place_id:last.placeId,travelmode:mode});
  if (refs.length > 2) {
    params.set('waypoints',refs.slice(1,-1).map(ref=>ref.placeId).join('|'));
    params.set('waypoint_place_ids',refs.slice(1,-1).map(ref=>ref.placeId).join('|'));
  }
  return `https://www.google.com/maps/dir/?${params}`;
}

export function createMapsController(api,{onSelect=()=>false,onUnauthorized=()=>{},now=Date.now,setTimeout:schedule=globalThis.setTimeout,clearTimeout:cancel=globalThis.clearTimeout}={}) {
  const listeners=new Set();
  let context={accountId:null,tripId:null,ledger:null,day:''};
  let signature='', generation=0, searchVersion=0, routeVersion=0, destroyed=false, blocked=false;
  let query='', results=[], pins=[], selectedPinId=null, unresolvedCount=0, route=null, mode='walking';
  let error='', status='', searching=false, resolving=false, routing=false;
  let state,expiryTimer,googleReady=false,expiredDisplay=false;
  const fresh=value=>value?.source!=='google' || Number.isFinite(now()) && Date.parse(value.display?.expiresAt)>now() && Date.parse(value.display?.expiresAt)-now()<=300000;
  const visible=value=>fresh(value) && (value.source!=='google' || googleReady);
  const expired=value=>value?.source==='google' && Number.isFinite(Date.parse(value.display?.expiresAt)) && Date.parse(value.display.expiresAt)<=now();
  function prune() {
    const expiredPins=pins.filter(pin=>expired(pin.place)).length;
    if(expiredPins || results.some(expired) || route?.status==='ok' && expired(route))expiredDisplay=true;
    unresolvedCount+=expiredPins;
    if(results.some(row=>!fresh(row)))results=results.filter(fresh);if(pins.some(pin=>!fresh(pin.place)))pins=pins.filter(pin=>fresh(pin.place));
    if(route?.status==='ok' && (!fresh(route) || route.source==='google' && route.places?.some(place=>!fresh(place))))route=null;
    if(!pins.some(pin=>pin.id===selectedPinId))selectedPinId=null;
  }
  function setGoogleReady(value) {if(destroyed || googleReady===(value===true))return;googleReady=value===true;publish();}
  const available=()=>!destroyed && !blocked && Boolean(context.accountId && context.tripId && context.ledger && context.ledger.tripId===context.tripId);
  const canSelect=()=>available() && ['owner','editor'].includes(context.ledger.role);
  const refsForPins=()=>pins.map(pin=>pin.place.ref);
  function publish() {
    cancel(expiryTimer);prune();
    const shownResults=results.every(visible)?results:results.filter(visible),shownPins=pins.every(pin=>visible(pin.place))?pins:pins.filter(pin=>visible(pin.place));
    const shownRoute=route && (route.status!=='ok' || visible(route))?route:null;
    const deadlines=[...results,...pins.map(pin=>pin.place),...(route?[route]:[])].filter(row=>row.source==='google' && row.display).map(row=>Date.parse(row.display.expiresAt));
    if(deadlines.length && !destroyed){expiryTimer=schedule(publish,Math.max(1,Math.min(...deadlines)-now()));expiryTimer?.unref?.();}
    state={...context,query,results:shownResults,pins:shownPins,selectedPinId,unresolvedCount:unresolvedCount+pins.length-shownPins.length,route:shownRoute,mode,error,status,searching,resolving,routing,
      generation,googleReady,expiredDisplay,mapNotice:expiredDisplay?'장소 표시 기한이 지났습니다. 다시 조회해 주세요. 일정 메모는 유지됩니다.':!googleReady&&[...results,...pins.map(pin=>pin.place)].some(row=>row.source==='google')?'Google 지도를 사용할 수 없어 장소와 경로를 숨겼습니다. 기존 일정 메모는 유지됩니다.':'',
      available:available(),canSelect:canSelect(),externalUrl:googleDirectionsLink(shownPins.map(pin=>pin.place.ref),mode)};
    if (!destroyed) for(const listener of listeners)listener(state);
  }
  function invalidate() {generation++;searchVersion++;routeVersion++;searching=false;routing=false;resolving=false;}
  function clear() {cancel(expiryTimer);results=[];pins=[];route=null;selectedPinId=null;unresolvedCount=0;expiredDisplay=false;error='';status='';}
  function failed(issue) {
    if ([401,403,404].includes(issue?.status) || ['unauthorized','forbidden','not_found','account_changed','stale_account'].includes(issue?.code)) {
      invalidate();clear();query='';blocked=true;publish();onUnauthorized();
    } else {error='장소를 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요. 저장된 일정은 유지됩니다.';}
  }
  function tokenCurrent(epoch) {return !destroyed && available() && epoch===generation;}
  async function updateContext(next) {
    if(destroyed)return;
    const safe={accountId:next?.accountId??null,tripId:next?.tripId??null,ledger:next?.ledger??null,day:next?.day??''};
    const changedOwner=safe.accountId!==context.accountId || safe.tripId!==context.tripId;
    const nextSignature=JSON.stringify([safe.accountId,safe.tripId,safe.day,safe.ledger?.tripId,safe.ledger?.revision,safe.ledger?.role,
      safe.ledger?.items?.filter(row=>row.status==='active' && row.date===safe.day).map(row=>[row.id,row.title,row.order,row.placeRef])]);
    context=safe;
    if(nextSignature===signature){publish();return;}
    signature=nextSignature;invalidate();clear();blocked=false;
    if(changedOwner)query='';
    if(!available()){publish();return;}
    const rows=context.ledger.items.filter(row=>row.status==='active' && row.date===context.day)
      .sort((a,b)=>a.order-b.order || a.id.localeCompare(b.id));
    const refs=[...new Map(rows.filter(row=>validRef(row.placeRef)).map(row=>[refKey(row.placeRef),row.placeRef])).values()].slice(0,60);
    unresolvedCount=rows.length;publish();
    if(!refs.length)return;
    const epoch=generation;resolving=true;publish();
    try {
      const response=await api.resolvePlaces(context.tripId,refs,context.accountId);
      if(!tokenCurrent(epoch))return;
      const places=parsePlaces(response,refs), indexed=new Map(places.map(place=>[refKey(place.ref),place]));
      pins=rows.flatMap((row,index)=>{
        const place=validRef(row.placeRef)?indexed.get(refKey(row.placeRef)):null;
        return place?[{id:row.id,number:index+1,title:row.title,place}]:[];
      });
      unresolvedCount=rows.length-pins.length;
    } catch(issue){if(tokenCurrent(epoch))failed(issue);}
    finally{if(tokenCurrent(epoch)){resolving=false;publish();}}
  }
  function setQuery(value) {
    if(destroyed)return;
    query=String(value);searchVersion++;searching=false;results=[];error='';status='';publish();
  }
  async function search() {
    if(!available())return false;
    const value=query.trim();
    if(!value || query.length>120 || /[\u0000-\u001f\u007f-\u009f]/u.test(query)){error='장소 이름을 120자 이내로 입력해 주세요.';publish();return false;}
    const epoch=generation,version=++searchVersion;
    results=[];searching=true;error='';status='';publish();
    try {
      const response=await api.searchPlaces(context.tripId,value,context.accountId);
      if(!tokenCurrent(epoch) || version!==searchVersion)return false;
      results=parsePlaces(response).filter(fresh);status=results.length?'장소를 선택하면 일정 폼의 장소에 적용합니다.':'일치하는 체험 장소가 없습니다. 카페 또는 공원을 검색해 보세요.';
      return true;
    } catch(issue){if(tokenCurrent(epoch) && version===searchVersion)failed(issue);return false;}
    finally{if(tokenCurrent(epoch) && version===searchVersion){searching=false;publish();}}
  }
  function selectCandidate(key) {
    if(!canSelect())return false;
    const candidate=results.find(row=>visible(row) && refKey(row.ref)===key);if(!candidate)return false;
    try {
      const accepted=onSelect({...candidate,ref:{...candidate.ref}});
      if(accepted===false){error='일정 폼의 입력과 권한을 확인한 뒤 장소를 다시 선택해 주세요.';publish();return false;}
      error='';status='일정 폼에 장소를 적용했습니다. 기존 일정 저장 버튼으로 저장해 주세요.';publish();return true;
    } catch{error='일정 폼에 장소를 적용할 수 없습니다. 입력 내용은 유지됩니다.';publish();return false;}
  }
  function selectPin(id){if(!available() || !pins.some(pin=>visible(pin.place) && pin.id===id))return false;selectedPinId=id;publish();return true;}
  function setMode(nextMode) {
    if(destroyed || !['walking','driving'].includes(nextMode) || nextMode===mode)return;
    mode=nextMode;routeVersion++;route=null;routing=false;error='';status='';publish();
  }
  async function previewRoute(nextMode=mode) {
    if(!available() || !['walking','driving'].includes(nextMode))return false;
    prune();const refs=pins.filter(pin=>visible(pin.place)).map(pin=>pin.place.ref);mode=nextMode;route=null;routeVersion++;error='';status='';
    if(refs.length>20){error='체험 경로는 방문 일정 20개까지 확인할 수 있습니다. 일정 핀은 모두 표시합니다.';publish();return false;}
    if(refs.length<2){error='장소가 확인된 일정 두 개 이상을 저장한 뒤 경로를 확인해 주세요.';publish();return false;}
    const epoch=generation,version=routeVersion;routing=true;publish();
    try {
      const response=await api.routePlaces(context.tripId,refs,mode,context.accountId);
      if(!tokenCurrent(epoch) || version!==routeVersion)return false;
      route=parseRoute(response,refs,nextMode);return true;
    } catch(issue){if(tokenCurrent(epoch) && version===routeVersion)failed(issue);return false;}
    finally{if(tokenCurrent(epoch) && version===routeVersion){routing=false;publish();}}
  }
  function destroy(){if(destroyed)return;invalidate();clear();query='';context={accountId:null,tripId:null,ledger:null,day:''};destroyed=true;publish();listeners.clear();}
  publish();
  return {get state(){return state;},subscribe(listener){listeners.add(listener);listener(state);return()=>listeners.delete(listener);},
    updateContext,setGoogleReady,setQuery,setMode,search,selectCandidate,selectPin,previewRoute,destroy};
}
