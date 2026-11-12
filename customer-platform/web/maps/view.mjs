import {createMapsController} from './controller.mjs';
import {refKey,validRef,parseDisplay,parseRoute} from './validation.mjs';

export function mountMaps(root,{api,onSelect,onUnauthorized,google}) {
  let googleConfig=google??null,googleMap=null,mapGeneration=-1,mapAttempt=0,destroyed=false;
  const controller=createMapsController(api,{onSelect,onUnauthorized,now:()=>googleConfig?.now?.()??Date.now(),
    setTimeout:(fn,delay)=>(googleConfig?.setTimeout??globalThis.setTimeout)(fn,delay),clearTimeout:id=>(googleConfig?.clearTimeout??globalThis.clearTimeout)(id)});
  const doc=root.ownerDocument, removers=[];
  const node=(tag,text='',className='')=>{const n=doc.createElement(tag);n.textContent=text;n.className=className;return n;};
  const identified=(tag,id,text='',className='')=>{const n=node(tag,text,className);n.id=id;return n;};
  const svgNode=(tag,attrs={})=>{const n=doc.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value]of Object.entries(attrs))n.setAttribute(key,String(value));return n;};
  const on=(n,event,fn)=>{n.addEventListener(event,fn);removers.push(()=>n.removeEventListener(event,fn));};
  const section=node('section','','maps ledger-section');section.setAttribute('aria-labelledby','maps-title');
  const title=identified('h3','maps-title','장소 찾기 · 합성 지도 체험');title.setAttribute('tabindex','-1');
  const notice=node('p','체험 카페와 체험 공원만 검색할 수 있습니다. 합성 위치와 직선 경로이며 실제 지도, 도로, 이동 시간은 제공하지 않습니다.','help');
  const form=identified('form','maps-search-form','','maps-search');form.setAttribute('novalidate','');
  const field=node('div','','field');
  const label=node('label','장소 이름');label.setAttribute('for','maps-query');
  const input=identified('input','maps-query');input.type='search';input.maxLength=120;input.autocomplete='off';
  input.setAttribute('aria-describedby','maps-search-help');
  const searchHelp=identified('p','maps-search-help','카페 또는 공원을 검색하고 장소를 선택해 주세요. 적용 후 기존 일정 저장 버튼으로 저장합니다.','help');
  field.append(label,input,searchHelp);
  const search=identified('button','maps-search','장소 검색','secondary');search.type='submit';
  form.append(field,search);
  const busy=identified('p','maps-busy','','help');busy.setAttribute('role','status');
  const status=identified('p','maps-status','','status');status.setAttribute('role','status');
  const error=identified('p','maps-error','','error');error.setAttribute('role','alert');error.setAttribute('tabindex','-1');
  const readonly=node('p','조회 권한으로 보고 있습니다. 장소 적용은 소유자와 편집자만 할 수 있습니다.','help');
  const results=node('ul','','maps-results');results.setAttribute('aria-label','장소 검색 결과');
  const day=identified('h4','maps-day-title');
  const unresolved=node('p','','help');
  const figure=node('figure','','maps-figure');
  const svg=svgNode('svg',{viewBox:'0 0 1000 400',role:'group','aria-label':'저장된 일정의 합성 위치. 번호를 선택하면 아래 일정 카드도 선택됩니다.'});
  const caption=node('figcaption','합성 위치 그림입니다. 번호는 일정 순서이며, 각 번호를 선택할 수 있도록 화면 위치에 간격을 두었습니다.','help');
  figure.append(svg,caption);
  const googleHost=identified('div','maps-google','','maps-google');
  const googleNotice=identified('p','maps-google-notice','','help');googleNotice.setAttribute('role','status');
  const cards=node('ol','','maps-cards');cards.setAttribute('aria-labelledby','maps-day-title');
  const routeForm=node('form','','maps-route-form');
  const modeField=node('div','','field');const modeLabel=node('label','이동 방식');modeLabel.setAttribute('for','maps-mode');
  const mode=identified('select','maps-mode');
  for(const [value,text]of [['walking','도보 (합성 체험)'],['driving','차량 (합성 체험)']]){const option=node('option',text);option.value=value;mode.append(option);}
  modeField.append(modeLabel,mode);
  const routeButton=node('button','체험 경로 확인','secondary');routeButton.type='submit';
  routeForm.append(modeField,routeButton);
  const routeMessage=node('p','','help');routeMessage.setAttribute('role','status');
  const external=node('a','Google 지도에서 길찾기 열기 (새 창)');external.target='_blank';external.rel='noopener noreferrer';
  const externalHelp=node('p','이 링크를 직접 선택할 때만 Google 지도가 열립니다. 선택한 실제 Google 장소 ID가 있을 때 제공됩니다.','help');
  section.append(title,notice,form,busy,status,error,readonly,results,day,unresolved,googleNotice,googleHost,figure,cards,routeForm,routeMessage,external,externalHelp);
  root.replaceChildren(section);
  let previousResults=null,previousPins=null,previousRoute=null;
  let pinNodes=[],cardNodes=[],previousGooglePins,previousGoogleResults,previousGoogleRoute;
  let resultEpoch=0,drawingEpoch=0;
  on(input,'input',()=>controller.setQuery(input.value));
  async function run(action) {await action();if(controller.state.error)error.focus();}
  on(form,'submit',event=>{event.preventDefault();void run(()=>controller.search());});
  on(mode,'change',()=>controller.setMode(mode.value));
  on(routeForm,'submit',event=>{event.preventDefault();void run(()=>controller.previewRoute(mode.value));});

  function renderResults(state) {
    if(previousResults===state.results)return;
    previousResults=state.results;const active=++resultEpoch;
    results.replaceChildren(...state.results.map(place=>{
      const li=node('li');const button=node('button',`${place.name} · ${place.address} · ${place.source==='synthetic'?'합성 장소':'Google 장소'} 선택`,'secondary');
      button.type='button';button.disabled=!state.canSelect;
      button.addEventListener('click',()=>{if(destroyed||active!==resultEpoch)return;controller.selectCandidate(refKey(place.ref));if(controller.state.error)error.focus();});
      li.append(button);return li;
    }));
  }
  function renderDrawing(state) {
    if(previousPins===state.pins && previousRoute===state.route)return;
    const pinsChanged=previousPins!==state.pins;const active=++drawingEpoch;
    previousPins=state.pins;previousRoute=state.route;
    const syntheticPins=state.pins.filter(pin=>pin.place.source==='synthetic');
    const path=state.route?.status==='ok' && state.route.source==='synthetic'?state.route.path:[];
    const points=[...syntheticPins.map(pin=>pin.place),...path];
    const lats=points.map(p=>p.lat),lngs=points.map(p=>p.lng);
    const lowLat=Math.min(...lats),lowLng=Math.min(...lngs);
    const latSpan=Math.max(Math.max(...lats)-lowLat,0.002),lngSpan=Math.max(Math.max(...lngs)-lowLng,0.002);
    const position=p=>({x:80+(p.lng-lowLng)/lngSpan*840,y:320-(p.lat-lowLat)/latSpan*240});
    // Only screen positions move. Ledger coordinates and route references remain untouched.
    const slots=Array.from({length:90},(_,i)=>({x:80+(i%15)*60,y:50+Math.floor(i/15)*60}));
    const displayPositions=syntheticPins.map(pin=>{
      const anchor=position(pin.place);
      let nearest=0;
      for(let i=1;i<slots.length;i++){
        const distance=p=>(p.x-anchor.x)**2+(p.y-anchor.y)**2;
        if(distance(slots[i])<distance(slots[nearest]))nearest=i;
      }
      return slots.splice(nearest,1)[0];
    });
    const drawing=[];
    if(path.length){
      const screenPath=state.route.source==='synthetic'?displayPositions:path.map(position);
      drawing.push(svgNode('polyline',{points:screenPath.map(p=>`${p.x},${p.y}`).join(' '),class:'maps-path','aria-hidden':'true'}));
    }
    pinNodes=syntheticPins.map((pin,index)=>{
      const {x,y}=displayPositions[index];
      const group=svgNode('g',{transform:`translate(${x} ${y})`,role:'button',tabindex:'0','aria-label':`${pin.number}. ${pin.title}: ${pin.place.name}`,
        'aria-pressed':String(pin.id===state.selectedPinId),'data-pin-id':pin.id,class:'maps-pin'});
      const circle=svgNode('circle',{r:24});const text=svgNode('text',{'text-anchor':'middle',dy:7});text.textContent=String(pin.number);
      group.append(circle,text);
      group.addEventListener('click',()=>{if(!destroyed&&active===drawingEpoch)controller.selectPin(pin.id);});
      group.addEventListener('keydown',event=>{if(event.key==='Enter' || event.key===' '){event.preventDefault();if(!destroyed&&active===drawingEpoch)controller.selectPin(pin.id);}});
      return {id:pin.id,node:group};
    });
    drawing.push(...pinNodes.map(row=>row.node));svg.replaceChildren(...drawing);
    if(pinsChanged){
      cardNodes=state.pins.map(pin=>{
        const li=node('li');const button=node('button',`${pin.number}. ${pin.title} · ${pin.place.name}`,'secondary');button.type='button';
        button.setAttribute('data-card-id',pin.id);button.setAttribute('aria-pressed',String(pin.id===state.selectedPinId));
        const address=node('p',pin.place.address,'help');
        const generation=state.generation;button.addEventListener('click',()=>{if(!destroyed&&generation===controller.state.generation)controller.selectPin(pin.id);});li.append(button,address);
        return {id:pin.id,node:button,li};
      });
      cards.replaceChildren(...cardNodes.map(row=>row.li));
    }
  }
  function resetGoogle() {
    mapAttempt++;googleMap?.destroy();googleMap=null;previousGooglePins=previousGoogleResults=previousGoogleRoute=undefined;
  }
  function syncGoogle(state) {
    if(mapGeneration!==state.generation){mapGeneration=state.generation;resetGoogle();controller.setGoogleReady(false);}
    if(!state.available || !googleConfig)return;
    if(!googleMap){
      const attempt=++mapAttempt,generation=state.generation;
      const instance=createGoogleMap(googleHost,{...googleConfig,onSelectPin:id=>{
        if(!destroyed&&attempt===mapAttempt&&generation===controller.state.generation)controller.selectPin(id);
      }});googleMap=instance;
      void instance.mount().then(ready=>{
        if(destroyed||attempt!==mapAttempt||generation!==controller.state.generation||googleMap!==instance){instance.destroy();return;}
        controller.setGoogleReady(ready);
      });
    }
    if(!state.googleReady)return;
    if(previousGooglePins!==state.pins||previousGoogleResults!==state.results||previousGoogleRoute!==state.route){
      previousGooglePins=state.pins;previousGoogleResults=state.results;previousGoogleRoute=state.route;
      const pins=state.pins.filter(pin=>pin.place.source==='google'),route=state.route?.source==='google'&&state.route.status==='ok'?state.route:null;
      const places=[...pins.map(pin=>pin.place),...state.results.filter(place=>place.source==='google'),...(route?[route,...route.places]:[])];
      if(!places.length)googleMap.clear();
      else {
        const sources=new Map();for(const place of places)for(const source of place.display.attributions)sources.set(`${source.displayName}\n${source.uri}`,source);
        const expiresAt=new Date(Math.min(...places.map(place=>Date.parse(place.display.expiresAt)))).toISOString();
        if(!googleMap.render({pins,route,expiresAt,attributions:[...sources.values()]})){controller.setGoogleReady(false);return;}
      }
    }
    googleMap.selectPin(state.selectedPinId);
  }
  function render(state) {
    syncGoogle(state);
    if(state!==controller.state)return;
    root.hidden=!state.available;
    section.setAttribute('aria-busy',String(state.searching || state.resolving || state.routing));
    if(input.value!==state.query)input.value=state.query;
    input.disabled=!state.available;search.disabled=state.searching || !state.available;
    mode.disabled=!state.available;routeButton.disabled=state.routing || state.resolving || state.pins.length<2 || !state.available;
    mode.value=state.mode;
    for(const option of mode.children)option.textContent=option.value==='walking'?(googleConfig?'도보':'도보 (합성 체험)'):(googleConfig?'차량':'차량 (합성 체험)');
    routeButton.textContent=googleConfig?'경로 확인':'체험 경로 확인';
    busy.hidden=!(state.searching || state.resolving || state.routing);
    busy.textContent=state.searching?'장소를 검색하고 있습니다.':state.resolving?'저장된 일정 장소를 확인하고 있습니다.':state.routing?'경로를 확인하고 있습니다.':'';
    status.hidden=!state.status;status.textContent=state.status;
    error.hidden=!state.error;error.textContent=state.error;
    readonly.hidden=state.canSelect;
    renderResults(state);
    for(const li of results.children)for(const button of li.children)button.disabled=!state.canSelect;
    day.textContent=`${state.day} 저장된 일정 장소`;
    unresolved.textContent=state.resolving?'저장된 장소를 확인하고 있습니다.':state.unresolvedCount?`장소 참조가 없거나 확인할 수 없는 일정 ${state.unresolvedCount}개는 핀을 표시하지 않습니다. 기존 장소 메모는 유지됩니다.`:
      state.pins.length?'핀과 아래 일정 카드는 같은 번호를 사용합니다.':'이 날짜에는 지도에 표시할 저장된 장소가 없습니다. 장소를 선택하고 일정을 저장해 주세요.';
    const hasGoogle=state.pins.some(pin=>pin.place.source==='google')||state.results.some(place=>place.source==='google');
    googleHost.hidden=!state.googleReady||!hasGoogle;
    googleNotice.textContent=state.mapNotice||(googleConfig&&!state.googleReady?'Google 지도를 사용할 수 없어 장소와 경로를 숨겼습니다. 기존 일정 메모는 유지됩니다.':'');googleNotice.hidden=!googleNotice.textContent;
    title.textContent=googleConfig?'장소 찾기 · 일정 지도':'장소 찾기 · 합성 지도 체험';
    notice.textContent=googleConfig?'장소 검색 결과와 저장된 일정 장소를 지도에서 확인합니다. 장소 표시 기한이 지나면 다시 검색해 주세요.':'체험 카페와 체험 공원만 검색할 수 있습니다. 합성 위치와 직선 경로이며 실제 지도, 도로, 이동 시간은 제공하지 않습니다.';
    caption.hidden=!state.pins.some(pin=>pin.place.source==='synthetic');
    figure.hidden=!state.pins.some(pin=>pin.place.source==='synthetic');cards.hidden=!state.pins.length;
    renderDrawing(state);
    for(const row of [...pinNodes,...cardNodes])row.node.setAttribute('aria-pressed',String(row.id===state.selectedPinId));
    routeMessage.hidden=!state.route;routeMessage.textContent=state.route?`${state.route.source==='synthetic'?'합성 체험: ':''}${state.route.message}`:'';
    external.hidden=!state.externalUrl;externalHelp.hidden=!state.externalUrl;
    if(state.externalUrl)external.setAttribute('href',state.externalUrl);else external.removeAttribute('href');
  }
  const unsubscribe=controller.subscribe(render);
  function configureGoogle(config) {
    if(destroyed)return;resetGoogle();googleConfig=config&&typeof config==='object'?{...config,allowedOrigins:Array.isArray(config.allowedOrigins)?[...config.allowedOrigins]:[]}:null;
    controller.setGoogleReady(false);render(controller.state);
  }
  return {updateContext:controller.updateContext,configureGoogle,destroy(){destroyed=true;resetGoogle();unsubscribe();controller.destroy();for(const remove of removers)remove();root.replaceChildren();}};
}

// Keep the customer entry graph compatible with servers holding the earlier static allowlist.

const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/\p{Cc}/u.test(v);
const point=p=>p&&Number.isFinite(p.lat)&&Math.abs(p.lat)<=90&&Number.isFinite(p.lng)&&Math.abs(p.lng)<=180;
/** The host injects a reviewed SDK loader after explicit opt-in.
 * No script injection, global SDK lookup, storage, names, addresses or HTML content. */
export function createGoogleMap(root,config={}) {
 const now=config.now??Date.now,schedule=config.setTimeout??globalThis.setTimeout,cancel=config.clearTimeout??globalThis.clearTimeout;let destroyed=false,mounted=false,pending=false,epoch=0,sdk,map,markers=[],line,timer,renderEpoch=0,selection=null,envelopeIds=[],markerContents=[];
 const doc=root.ownerDocument;
 const canvas=doc.createElement('div');canvas.setAttribute('aria-label','Google 지도');
 canvas.className='maps-google-canvas';
 const attribution=doc.createElement('p');attribution.setAttribute('aria-live','polite');
 const allowed=()=>{
  const origin=doc.defaultView?.location?.origin;
  if(config.allowNetwork!==true||!text(config.browserApiKey,256)||!/^[A-Za-z0-9_-]{8,256}$/.test(config.browserApiKey)||
    !text(config.mapId,100)||!/^[A-Za-z0-9_-]+$/.test(config.mapId)||typeof config.loader!=='function'||!Array.isArray(config.allowedOrigins)||!origin)return false;
  try{const url=new URL(origin);return (url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))&&config.allowedOrigins.every(value=>new URL(value).origin===value)&&config.allowedOrigins.includes(origin);}catch{return false;}
 };
 function clear(){renderEpoch++;cancel(timer);timer=undefined;for(const marker of markers)marker.map=null;markers=[];envelopeIds=[];markerContents=[];line?.setMap(null);line=undefined;attribution.replaceChildren();}
 async function mount(){
  if(destroyed||pending||!allowed())return false;if(mounted)return true;pending=true;const attempt=++epoch;
  try{
   const loaded=await config.loader({apiKey:config.browserApiKey,mapId:config.mapId,version:'quarterly',libraries:['marker']});
   if(destroyed||attempt!==epoch||!allowed())return false;
   if(typeof loaded?.maps?.Map!=='function'||typeof loaded?.maps?.marker?.AdvancedMarkerElement!=='function'||typeof loaded?.maps?.LatLngBounds!=='function')return false;
   sdk=loaded;root.replaceChildren(canvas,attribution);
   // Google Maps owns and displays its logo and legal attribution inside the canvas.
   map=new sdk.maps.Map(canvas,{mapId:config.mapId,center:{lat:37.56,lng:126.97},zoom:12});mounted=true;return true;
  }catch{return false;}finally{pending=false;}
 }
 function render(envelope){
  clear();if(destroyed||!mounted||!allowed())return false;
  try{
   const display=parseDisplay(envelope),expiry=Date.parse(display.expiresAt),instant=now(),active=renderEpoch;
   if(!Number.isFinite(expiry)||!Number.isFinite(instant)||expiry<=instant||expiry-instant>300000||!Array.isArray(envelope.pins)||envelope.pins.length>60||!Array.isArray(envelope.attributions)||envelope.attributions.length>30)return false;
   // Copy only the server reference and current coordinates. Provider labels are deliberately ignored.
   const pins=envelope.pins.map(pin=>{
    const place=pin?.place;
    if(!text(pin?.id,200)||!Number.isSafeInteger(pin.number)||pin.number<1||pin.number>60||!validRef(place?.ref)||place.ref.provider!=='google'||place.source!=='google'||!point(place))throw Error('invalid');
    const placeDisplay=parseDisplay(place.display),placeExpiry=Date.parse(placeDisplay.expiresAt);if(expiry>placeExpiry||placeExpiry-instant>300000)throw Error('invalid');
    return {id:pin.id,number:pin.number,ref:{...place.ref},position:{lat:place.lat,lng:place.lng}};
   });
   if(new Set(pins.map(p=>p.id)).size!==pins.length)throw Error('invalid');
   const sources=display.attributions;
   const label=doc.createElement('span');label.textContent='Google Maps 제공';attribution.append(label);
   for(const source of sources){const link=doc.createElement('a');link.textContent=source.displayName;link.setAttribute('href',source.uri);link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');attribution.append(link);}
   const bounds=new sdk.maps.LatLngBounds();
   const visits=new Map();
   for(const pin of pins){const coordinateKey=`${pin.position.lat}:${pin.position.lng}`,visit=visits.get(coordinateKey)??0;visits.set(coordinateKey,visit+1);const content=doc.createElement('div');content.setAttribute('role','button');content.setAttribute('tabindex','0');content.setAttribute('data-pin-id',pin.id);content.setAttribute('aria-pressed',String(pin.id===selection));
    const select=()=>{if(!destroyed && mounted && active===renderEpoch && expiry>now())config.onSelectPin?.(pin.id);};
    content.addEventListener('click',select);content.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select();}});content.className='maps-google-pin';content.textContent=String(pin.number);content.setAttribute('aria-label',`일정 ${pin.number}`);
    const marker=new sdk.maps.marker.AdvancedMarkerElement({map,position:pin.position,content,gmpClickable:true,zIndex:pin.number,anchorLeft:`calc(-50% + ${(visit%7)*36}px)`,anchorTop:`calc(-100% - ${Math.floor(visit/7)*36}px)`});marker.addListener?.('click',select);markers.push(marker);markerContents.push(content);envelopeIds.push(pin.id);bounds.extend(pin.position);}
   if(pins.length)map.fitBounds(bounds);
   if(envelope.route){
    const route=parseRoute(envelope.route,pins.map(pin=>pin.ref),envelope.route.mode);
    if(route.status!=='ok'||route.source!=='google'||expiry>Date.parse(route.display.expiresAt)||Date.parse(route.display.expiresAt)-instant>300000||route.places.some(place=>Date.parse(place.display.expiresAt)-instant>300000)||typeof sdk.maps.Polyline!=='function')throw Error('invalid');
    line=new sdk.maps.Polyline({map,path:route.path,strokeColor:'#16634b',strokeWeight:4});
   }
   timer=schedule(clear,expiry-instant);timer?.unref?.();return true;
  }catch{clear();return false;}
 }
 function destroy(){if(destroyed)return;destroyed=true;epoch++;clear();sdk=undefined;map=undefined;root.replaceChildren();}
 function selectPin(id){selection=id;for(let i=0;i<markers.length;i++){const content=markerContents[i];content?.setAttribute('aria-pressed',String(envelopeIds[i]===id));}}
 return {mount,render,clear,destroy,selectPin};
}

const loads=new WeakMap();
let sequence=0;
const unavailable=()=>new Error('지도 SDK를 불러올 수 없습니다.');
/** Factory has no side effects. Only the approved app path may call this loader.
 * Each document gets one attempt; failures never trigger automatic retries. */
export function createGoogleSdkLoader({document:doc=globalThis.document,window:win=globalThis.window,allowNetwork=false,timeoutMs=10000}={}) {
 return function load(options={}) {
  let nonce,key,signature;
  try {
   key=options.apiKey;
   nonce=doc?.querySelector('script[nonce]')?.nonce;
   if(allowNetwork!==true||!doc?.head||!win||typeof key!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(key)||
    typeof options.mapId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(options.mapId)||options.version!=='quarterly'||
    !Array.isArray(options.libraries)||options.libraries.length!==1||options.libraries[0]!=='marker'||
    typeof nonce!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw unavailable();
   signature=JSON.stringify([key,options.version,options.libraries]);
  } catch {return Promise.reject(unavailable());}
  const existing=loads.get(doc);
  if(existing)return existing.signature===signature?existing.promise:Promise.reject(unavailable());
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  loads.set(doc,{signature,promise});
  const callback=`__tripmoneyMapsReady${++sequence}`;
  let script,timer,settled=false;
  const finish=(error)=>{
   if(settled)return;settled=true;clearTimeout(timer);
   try{delete win[callback];}catch{/* No raw browser error crosses the boundary. */}
   if(script){script.onerror=null;try{script.remove();}catch{}}
   if(error)reject(unavailable());else resolve(win.google);
  };
  try {
   if(Object.hasOwn(win,callback))throw unavailable();
   win[callback]=()=>{
    if(typeof win.google?.maps?.Map!=='function'||typeof win.google?.maps?.marker?.AdvancedMarkerElement!=='function'||typeof win.google?.maps?.LatLngBounds!=='function')return finish(true);
    finish(false);
   };
   script=doc.createElement('script');script.async=true;script.nonce=nonce;script.referrerPolicy='strict-origin-when-cross-origin';
   const url=new URL('https://maps.googleapis.com/maps/api/js');
   url.search=new URLSearchParams({key,v:'quarterly',libraries:'marker',loading:'async',callback,auth_referrer_policy:'origin'}).toString();
   script.src=url.href;script.onerror=()=>finish(true);
   timer=setTimeout(()=>finish(true),timeoutMs);
   doc.head.append(script);
  } catch {finish(true);}
  return promise;
 };
}
