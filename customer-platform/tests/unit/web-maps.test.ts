import assert from 'node:assert/strict';
import test from 'node:test';

const controllerPath = '../../web/maps/controller.mjs';
const cafe = {ref:{provider:'demo',placeId:'demo-cafe'},name:'체험 카페',address:'합성 장소, 실제 주소 없음',lat:37.56,lng:126.97,source:'synthetic'};
const park = {ref:{provider:'demo',placeId:'demo-park'},name:'체험 공원',address:'합성 장소, 실제 주소 없음',lat:37.57,lng:126.98,source:'synthetic'};
const tripId='10000000-0000-4000-8000-000000000001',accountId='20000000-0000-4000-8000-000000000001',day='2026-11-07';
const item = {id:'saved-cafe',date:day,status:'active',order:0,title:'커피 마시기',place:'기존 메모',placeRef:cafe.ref};
const ledger = {tripId,revision:1,role:'owner',items:[item,
  {...item,id:'saved-park',order:1,title:'공원 산책',placeRef:park.ref},
  {...item,id:'legacy',order:2,title:'이전 장소 메모',place:'카페',placeRef:undefined},
  {...item,id:'cancelled',status:'cancelled'}, {...item,id:'tomorrow',date:'2026-11-08'}]};
const context = {accountId,tripId,ledger,day};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let release:(v:any)=>void=()=>{};const promise=new Promise<any>(resolve=>{release=resolve;});return{promise,release};};
async function setup(t:any, overrides:any={}, options:any={}) {
  const {createMapsController}=await import(controllerPath);
  const api = {searchPlaces:async()=>[cafe,park],resolvePlaces:async()=>[cafe,park],routePlaces:async(_id:any,_refs:any,mode:any)=>({
    status:'ok',source:'synthetic',mode,message:'합성 체험 경로',places:[cafe,park],path:[{lat:37.56,lng:126.97},{lat:37.57,lng:126.98}]}),...overrides};
  const c=createMapsController(api,options);t.after(()=>c.destroy());return c;
}

test('pins follow saved active day order, never geocode place notes, and card selection uses matching IDs',async t=>{
  let resolved:any[]=[];
  const c=await setup(t,{resolvePlaces:async(...args:any[])=>{resolved=args;return[park,cafe];}});
  await c.updateContext(context);
  assert.deepEqual(resolved,[tripId,[cafe.ref,park.ref],accountId]);
  assert.deepEqual(c.state.pins.map((p:any)=>[p.id,p.number,p.title,p.place.name]),[
    ['saved-cafe',1,'커피 마시기','체험 카페'],['saved-park',2,'공원 산책','체험 공원']]);
  assert.equal(c.state.unresolvedCount,1);
  c.selectPin('saved-park');assert.equal(c.state.selectedPinId,'saved-park');
});

test('explicit selection applies only current search result and reports a protected form without changing schedules',async t=>{
  const applied:any[]=[]; const before=structuredClone(ledger);
  const c=await setup(t,{}, {onSelect:(value:any)=>{applied.push(value);return applied.length===1;}});
  await c.updateContext(context);c.setQuery('체험');await c.search();
  assert.equal(c.selectCandidate('demo:demo-cafe'),true);
  assert.deepEqual(applied,[cafe]);assert.deepEqual(ledger,before);
  assert.equal(c.selectCandidate('demo:demo-park'),false);
  assert.match(c.state.error,/입력|폼/);
  assert.equal(c.selectCandidate('google:unrequested'),false);
});

test('late searches and changed text cannot restore an earlier query result',async t=>{
  const first=deferred(), second=deferred();let n=0;
  const c=await setup(t,{searchPlaces:async()=>++n===1?first.promise:second.promise});
  await c.updateContext(context);c.setQuery('카페');const a=c.search();
  c.setQuery('공원');const b=c.search();second.release([park]);await b;first.release([cafe]);await a;
  assert.deepEqual(c.state.results,[park]);
  c.setQuery('다른 입력');assert.deepEqual(c.state.results,[]);
  assert.equal(c.selectCandidate('demo:demo-park'),false);
});

test('day, revision, account, trip and removed access invalidate in-flight responses',async t=>{
  for(const change of [{day:'2026-11-08'},{ledger:{...ledger,revision:2}}, {accountId:'other-account'}, {tripId:'other-trip',ledger:{...ledger,tripId:'other-trip'}}, {ledger:null}]) {
    const pending=deferred();let unauthorized=0;
    const c=await setup(t,{searchPlaces:async()=>pending.promise},{onUnauthorized:()=>{unauthorized++;}});
    await c.updateContext(context);c.setQuery('카페');const p=c.search();
    await c.updateContext({...context,...change});pending.release([cafe]);await p;
    assert.deepEqual(c.state.results,[]);assert.equal(c.selectCandidate('demo:demo-cafe'),false);assert.equal(unauthorized,0);
  }
});

test('same context does not refetch; routine revisions preserve query while read-only permission blocks selection',async t=>{
  let resolveCount=0,selectCount=0;
  const c=await setup(t,{resolvePlaces:async()=>{resolveCount++;return[cafe,park];}},{onSelect:()=>{selectCount++;return true;}});
  await c.updateContext(context);c.setQuery('입력 중');await c.updateContext({...context});assert.equal(resolveCount,1);
  await c.updateContext({...context,ledger:{...ledger,revision:2}});assert.equal(c.state.query,'입력 중');
  await c.updateContext({...context,ledger:{...ledger,revision:3,role:'viewer'}});
  c.setQuery('카페');await c.search();assert.equal(c.selectCandidate('demo:demo-cafe'),false);assert.equal(selectCount,0);
});

test('route mode sequence discards slow earlier route and failures preserve the original ledger',async t=>{
  const walking=deferred();const before=structuredClone(ledger);
  const c=await setup(t,{routePlaces:async(_id:any,_refs:any,mode:any)=> mode==='walking'?walking.promise:{status:'unsupported',source:'synthetic',mode,message:'합성 경로 지원 불가'}});
  await c.updateContext(context);const slow=c.previewRoute('walking');await c.previewRoute('driving');
  walking.release({status:'ok',source:'synthetic',mode:'walking',message:'합성',places:[cafe,park],path:[{lat:37.56,lng:126.97},{lat:37.57,lng:126.98}]});await slow;
  assert.equal(c.state.route.mode,'driving');assert.equal(c.state.route.status,'unsupported');assert.deepEqual(ledger,before);
});

test('malformed search and route responses are rejected and session failure clears private map state',async t=>{
  let phase='bad', unauthorized=0;
  const c=await setup(t,{searchPlaces:async()=>{if(phase==='auth')throw{status:401,code:'unauthorized'};return[{...cafe,source:'google'}];},
    routePlaces:async()=>({status:'ok',source:'synthetic',mode:'walking',message:'합성',places:[cafe,park],path:[{lat:999,lng:0}]})},
    {onUnauthorized:()=>{unauthorized++;}});
  await c.updateContext(context);c.setQuery('카페');await c.search();assert.deepEqual(c.state.results,[]);assert.ok(c.state.error);
  await c.previewRoute('walking');assert.equal(c.state.route,null);assert.ok(c.state.error);
  phase='auth';await c.search();assert.equal(unauthorized,1);assert.deepEqual(c.state.pins,[]);assert.equal(c.state.query,'');
});

test('only explicit Google ID endpoints produce a safe external route URL and demo IDs never produce a link',async()=>{
  const {googleDirectionsLink}=await import(controllerPath);
  assert.equal(googleDirectionsLink([cafe.ref,park.ref],'walking'),null);
  const link=googleDirectionsLink([{provider:'google',placeId:'ChIJ_origin'},{provider:'google',placeId:'ChIJ_destination'}],'driving');
  const url=new URL(link);assert.equal(url.origin,'https://www.google.com');assert.equal(url.pathname,'/maps/dir/');
  assert.equal(url.searchParams.get('origin_place_id'),'ChIJ_origin');assert.equal(url.searchParams.get('destination_place_id'),'ChIJ_destination');
  assert.equal(url.searchParams.get('travelmode'),'driving');
  assert.equal(googleDirectionsLink([{provider:'google',placeId:'bad\nID'},park.ref],'walking'),null);
});

test('destroy removes subscribers and prevents pending callbacks',async t=>{
  const pending=deferred();let applied=0;
  const c=await setup(t,{searchPlaces:async()=>pending.promise},{onSelect:()=>{applied++;}});
  await c.updateContext(context);c.setQuery('카페');const request=c.search();c.destroy();pending.release([cafe]);await request;
  assert.deepEqual(c.state.results,[]);assert.equal(c.selectCandidate('demo:demo-cafe'),false);assert.equal(applied,0);
});

test('a day with sixty unique saved places resolves every pin while the route limit is explicit',async t=>{
  const places=Array.from({length:60},(_,i)=>({...cafe,ref:{provider:'demo',placeId:`demo-${i}`}}));
  let sent=0;
  const c=await setup(t,{resolvePlaces:async(_id:any,refs:any[])=>{sent=refs.length;return places;},routePlaces:async()=>assert.fail('oversized route called')});
  await c.updateContext({...context,ledger:{...ledger,items:places.map((p,i)=>({...item,id:`saved-${i}`,order:i,placeRef:p.ref}))}});
  assert.equal(sent,60);assert.equal(c.state.pins.length,60);assert.equal(c.state.pins.at(-1).number,60);
  assert.equal(await c.previewRoute('walking'),false);assert.match(c.state.error,/20/);
});

// Small DOM boundary double. API, state, selection and SVG rendering remain real.
class Node {
  tagName:string; children:Node[]=[]; attrs:Record<string,string>={}; listeners:Record<string,Function[]>={};
  textContent=''; hidden=false; disabled=false; value=''; id=''; className=''; parentNode:Node|null=null;
  ownerDocument:any;
  constructor(tag:string,doc:any){this.tagName=tag;this.ownerDocument=doc;}
  append(...nodes:Node[]){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
  replaceChildren(...nodes:Node[]){this.children=[];this.append(...nodes);}
  setAttribute(key:string,value:any){this.attrs[key]=String(value);}
  removeAttribute(key:string){delete this.attrs[key];}
  addEventListener(event:string,listener:Function){(this.listeners[event]??=[]).push(listener);}
  removeEventListener(event:string,listener:Function){this.listeners[event]=(this.listeners[event]??[]).filter(fn=>fn!==listener);}
  focus(){this.ownerDocument.activeElement=this;}
  fire(event:string,props:any={}){for(const fn of this.listeners[event]??[])fn({preventDefault(){},currentTarget:this,...props});}
  all():Node[]{return [this,...this.children.flatMap(node=>node.all())];}
}
function documentFixture(){const doc:any={activeElement:null};doc.createElement=(tag:string)=>new Node(tag,doc);doc.createElementNS=(_ns:string,tag:string)=>new Node(tag,doc);return{doc,root:new Node('div',doc)};}

test('mounted view searches by keyboard, renders safe numbered pins and synchronizes pin and card selection',async()=>{
  const viewPath='../../web/maps/view.mjs';const {mountMaps}=await import(viewPath);
  const {root}=documentFixture();const selections:any[]=[];
  const mounted=mountMaps(root,{api:{searchPlaces:async()=>[{...cafe,name:'<img src=x onerror=alert(1)>'}],resolvePlaces:async()=>[cafe,park],routePlaces:async()=>null},
    onSelect:(p:any)=>{selections.push(p);return true;},onUnauthorized:()=>{}});
  await mounted.updateContext(context);
  const get=(id:string)=>{const node=root.all().find(n=>n.id===id);assert.ok(node,`missing ${id}`);return node;};
  const query=get('maps-query');query.value='카페';query.fire('input');get('maps-search-form').fire('submit');await turn();
  const result=root.all().find(n=>n.tagName==='button'&&n.textContent.includes('<img'));
  assert.ok(result);assert.equal(result.children.length,0);result.fire('click');assert.equal(selections[0].ref.placeId,'demo-cafe');
  const pin=root.all().find(n=>n.attrs['data-pin-id']==='saved-park');assert.ok(pin);
  pin.fire('keydown',{key:'Enter'});assert.equal(pin.attrs['aria-pressed'],'true');
  const card=root.all().find(n=>n.attrs['data-card-id']==='saved-park');assert.ok(card);assert.equal(card.attrs['aria-pressed'],'true');
  const svg=root.all().find(n=>n.tagName==='svg');assert.ok(svg);assert.equal(svg.attrs.viewBox,'0 0 1000 400');
  mounted.destroy();assert.equal(root.children.length,0);
});

test('changing the route mode invalidates an earlier preview before another route is requested',async t=>{
  const pending=deferred();const c=await setup(t,{routePlaces:async()=>pending.promise});
  await c.updateContext(context);const walking=c.previewRoute('walking');
  c.setMode('driving');assert.equal(c.state.mode,'driving');
  pending.release({status:'ok',source:'synthetic',mode:'walking',message:'합성',places:[cafe,park],path:[{lat:37.56,lng:126.97},{lat:37.57,lng:126.98}]});
  await walking;assert.equal(c.state.route,null);assert.equal(c.state.routing,false);
});

test('route requests and previews preserve the saved return visit and enforce the limit per visit',async t=>{
  let requested:any[]=[];
  const c=await setup(t,{resolvePlaces:async(_id:any,refs:any[])=>[cafe,park].filter(p=>refs.some(ref=>ref.placeId===p.ref.placeId)),routePlaces:async(_id:any,refs:any[],mode:any)=>{
    requested=refs;const places=refs.map(ref=>ref.placeId===cafe.ref.placeId?cafe:park);
    return{status:'ok',source:'synthetic',mode,message:'합성 체험',places,path:places.map(({lat,lng})=>({lat,lng}))};
  }});
  const visits=[item,{...item,id:'park',order:1,placeRef:park.ref},{...item,id:'return-cafe',order:2}];
  await c.updateContext({...context,ledger:{...ledger,items:visits}});
  assert.equal(await c.previewRoute('walking'),true);
  assert.deepEqual(requested,[cafe.ref,park.ref,cafe.ref]);
  assert.deepEqual(c.state.route.places.map((p:any)=>p.ref),[cafe.ref,park.ref,cafe.ref]);
  await c.updateContext({...context,ledger:{...ledger,items:[item,{...item,id:'cafe-again',order:1}]}});
  assert.equal(await c.previewRoute('walking'),true);assert.deepEqual(requested,[cafe.ref,cafe.ref]);
  assert.equal(c.state.route.places.length,2);
  await c.updateContext({...context,ledger:{...ledger,items:Array.from({length:21},(_,i)=>({...item,id:`visit-${i}`,order:i}))}});
  assert.equal(await c.previewRoute('walking'),false);assert.match(c.state.error,/20/);
});

test('Google external links retain the intermediate visit when the destination repeats the origin',async t=>{
  const display={expiresAt:'2026-11-08T00:01:00Z',attributions:[]};
  const googleCafe={...cafe,display,ref:{provider:'google',placeId:'ChIJ_cafe'},source:'google'};
  const googlePark={...park,display,ref:{provider:'google',placeId:'ChIJ_park'},source:'google'};
  const c=await setup(t,{resolvePlaces:async()=>[googleCafe,googlePark]},{now:()=>Date.parse('2026-11-08T00:00:00Z')});c.setGoogleReady(true);
  await c.updateContext({...context,ledger:{...ledger,items:[{...item,placeRef:googleCafe.ref},
    {...item,id:'park',order:1,placeRef:googlePark.ref},{...item,id:'return',order:2,placeRef:googleCafe.ref}]}});
  const url=new URL(c.state.externalUrl);
  assert.equal(url.searchParams.get('origin_place_id'),'ChIJ_cafe');
  assert.equal(url.searchParams.get('destination_place_id'),'ChIJ_cafe');
  assert.equal(url.searchParams.get('waypoint_place_ids'),'ChIJ_park');
});

test('repeated-place pins have separate pointer targets without changing saved coordinates or references',async()=>{
  const viewPath='../../web/maps/view.mjs';const {mountMaps}=await import(viewPath);
  const {root}=documentFixture();const visits={...context,ledger:{...ledger,items:[item,
    {...item,id:'park',order:1,placeRef:park.ref},{...item,id:'return',order:2}]}};
  const before=structuredClone(visits);
  const mounted=mountMaps(root,{api:{resolvePlaces:async()=>[cafe,park],searchPlaces:async()=>[],routePlaces:async()=>null},onSelect:()=>true,onUnauthorized:()=>{}});
  await mounted.updateContext(visits);
  const pins=root.all().filter(n=>n.attrs['data-pin-id']);
  assert.equal(pins.length,3);
  assert.notEqual(pins[0]!.attrs.transform,pins[2]!.attrs.transform);
  for(const pin of pins){pin.fire('click');assert.equal(pin.attrs['aria-pressed'],'true');
    const card=root.all().find(n=>n.attrs['data-card-id']===pin.attrs['data-pin-id']);assert.equal(card?.attrs['aria-pressed'],'true');}
  pins[0]!.fire('keydown',{key:' '});assert.equal(pins[0]!.attrs['aria-pressed'],'true');
  assert.deepEqual(visits,before);assert.equal(cafe.lat,37.56);assert.equal(cafe.lng,126.97);
  mounted.destroy();
});

test('approved SDK renders Google pins, route and sources while revocation hides provider data and preserves notes',async()=>{
 const viewPath='../../web/maps/view.mjs';const {mountMaps}=await import(viewPath);const {root,doc}=documentFixture();doc.defaultView={location:{origin:'https://preview.example.invalid'}};
 const now=Date.now(),display={expiresAt:new Date(now+60000).toISOString(),attributions:[{displayName:'외부 자료사',uri:'https://source.example.invalid/'}]};
 const a={...cafe,ref:{provider:'google',placeId:'ChIJ_a'},source:'google',display},b={...park,ref:{provider:'google',placeId:'ChIJ_b'},source:'google',display};
 const visits={...context,ledger:{...ledger,items:[{...item,placeRef:a.ref},{...item,id:'park',order:1,placeRef:b.ref},{...item,id:'return',order:2,placeRef:a.ref}]}};
 const markers:any[]=[],lines:any[]=[];let loads=0;
 const sdk={maps:{Map:class{fitBounds(){}},LatLngBounds:class{extend(){}},Polyline:class{map:any;constructor(opts:any){this.map=opts.map;lines.push(this);}setMap(map:any){this.map=map;}},marker:{AdvancedMarkerElement:class{content:any;map:any;constructor(opts:any){this.content=opts.content;this.map=opts.map;markers.push(this);}}}}};
 const mounted=mountMaps(root,{api:{resolvePlaces:async()=>[a,b],searchPlaces:async()=>[a],routePlaces:async(_id:any,refs:any[],mode:any)=>({status:'ok',source:'google',mode,message:'경로 안내',places:refs.map(ref=>ref.placeId===a.ref.placeId?a:b),path:[a,b,a].map(({lat,lng})=>({lat,lng})),display})},onSelect:()=>true,onUnauthorized:()=>{}});
 await mounted.updateContext(visits);assert.ok(!root.all().some(n=>n.attrs['data-card-id']));assert.equal(loads,0);
 mounted.configureGoogle({allowNetwork:true,browserApiKey:'browser-fixture-key',mapId:'fixture-map-id',allowedOrigins:['https://preview.example.invalid'],loader:async()=>{loads++;return sdk;},now:()=>now});await turn();
 assert.equal(loads,1);assert.equal(root.all().filter(n=>n.attrs['data-card-id']).length,3);
 assert.equal(root.all().filter(n=>n.tagName==='g'&&n.attrs['data-pin-id']).length,0);
 const current=markers.filter(m=>m.map);assert.equal(current.length,3);current[2].content.fire('keydown',{key:' '});
 assert.equal(root.all().find(n=>n.attrs['data-card-id']==='return')?.attrs['aria-pressed'],'true');
 assert.ok(root.all().some(n=>n.tagName==='a'&&n.textContent==='외부 자료사'));
 root.all().find(n=>n.className==='maps-route-form')!.fire('submit');await turn();assert.equal(lines.filter(l=>l.map).length,1);
 const detached=current[0].content;mounted.configureGoogle(null);detached.fire('click');
 assert.ok(!root.all().some(n=>n.textContent.includes(a.address)));assert.equal(markers.filter(m=>m.map).length,0);assert.equal(lines.filter(l=>l.map).length,0);
 const savedVisit=visits.ledger.items[0];assert.ok(savedVisit);assert.equal(savedVisit.place,'기존 메모');mounted.destroy();
});

test('a late SDK mount cannot render into another date or a destroyed customer view',async()=>{
 const viewPath='../../web/maps/view.mjs';const {mountMaps}=await import(viewPath);const {root,doc}=documentFixture();doc.defaultView={location:{origin:'https://preview.example.invalid'}};
 const pending=deferred();let maps=0;
 const mounted=mountMaps(root,{api:{resolvePlaces:async()=>[cafe,park]},onSelect:()=>true,onUnauthorized:()=>{},google:{allowNetwork:true,browserApiKey:'browser-fixture-key',mapId:'fixture-map-id',allowedOrigins:['https://preview.example.invalid'],loader:()=>pending.promise}});
 await mounted.updateContext(context);await mounted.updateContext({...context,day:'2026-11-08'});mounted.destroy();
 pending.release({maps:{Map:class{constructor(){maps++;}},LatLngBounds:class{},marker:{AdvancedMarkerElement:class{}}}});await turn();assert.equal(maps,0);assert.equal(root.children.length,0);
});

test('SDK failure hides Google search results and provider source text while keeping typed input',async()=>{
 const viewPath='../../web/maps/view.mjs';const {mountMaps}=await import(viewPath);const {root,doc}=documentFixture();doc.defaultView={location:{origin:'https://preview.example.invalid'}};
 const display={expiresAt:new Date(Date.now()+60000).toISOString(),attributions:[{displayName:'비공개 공급사',uri:'https://source.invalid/'}]};
 const googlePlace={...cafe,source:'google',ref:{provider:'google',placeId:'ChIJ_private'},name:'비공개 장소명',address:'비공개 주소',display};
 let loads=0;const mounted=mountMaps(root,{api:{resolvePlaces:async()=>[],searchPlaces:async()=>[googlePlace]},onSelect:()=>assert.fail('hidden candidate selected'),onUnauthorized:()=>{},google:{allowNetwork:true,browserApiKey:'browser-fixture-key',mapId:'fixture-map-id',allowedOrigins:['https://preview.example.invalid'],loader:async()=>{loads++;throw Error('load failed');}}});
 await mounted.updateContext({...context,ledger:{...ledger,items:[]}});await turn();
 const input=root.all().find(n=>n.id==='maps-query')!;input.value='입력 유지';input.fire('input');root.all().find(n=>n.id==='maps-search-form')!.fire('submit');await turn();
 assert.equal(input.value,'입력 유지');assert.equal(loads,1);assert.ok(!root.all().some(n=>/비공개/.test(n.textContent)));
 assert.ok(root.all().some(n=>n.id==='maps-google-notice'&&!n.hidden&&n.textContent.includes('숨겼')));mounted.destroy();
});

test('Google route failures retain thirteen pins, announce the limit and keep keyboard focus',async()=>{
 const viewPath='../../web/maps/view.mjs';const {mountMaps}=await import(viewPath);
 for(const routeStatus of ['unsupported','error']){
  const {root,doc}=documentFixture();doc.defaultView={location:{origin:'https://preview.example.invalid'}};
  const display={expiresAt:new Date(Date.now()+60000).toISOString(),attributions:[]};
  const place={...cafe,source:'google',ref:{provider:'google',placeId:'ChIJ_route_limit'},display};
  const visits={...context,ledger:{...ledger,items:Array.from({length:13},(_,i)=>({...item,id:`visit-${i}`,order:i,placeRef:place.ref}))}};
  const markers:any[]=[],lines:any[]=[];
  const sdk={maps:{Map:class{fitBounds(){}},LatLngBounds:class{extend(){}},Polyline:class{map:any;constructor(opts:any){this.map=opts.map;lines.push(this);}setMap(map:any){this.map=map;}},marker:{AdvancedMarkerElement:class{map:any;content:any;constructor(opts:any){this.map=opts.map;this.content=opts.content;markers.push(this);}}}}};
  const mounted=mountMaps(root,{api:{resolvePlaces:async()=>[place],routePlaces:async()=>({status:routeStatus,source:'google',mode:'walking',message:'Google 경로는 방문 일정 12개까지 확인할 수 있습니다.'})},onSelect:()=>true,onUnauthorized:()=>{},google:{allowNetwork:true,browserApiKey:'browser-fixture-key',mapId:'fixture-map-id',allowedOrigins:['https://preview.example.invalid'],loader:async()=>sdk}});
  await mounted.updateContext(visits);await turn();assert.equal(markers.filter(m=>m.map).length,13);
  const form=root.all().find(n=>n.className==='maps-route-form');assert.ok(form);const submit=form.children.find(n=>n.tagName==='button');assert.ok(submit);submit.focus();
  form.fire('submit');await turn();
  const message=root.all().find(n=>n.attrs.role==='status'&&n.textContent.includes('12개'));assert.ok(message);assert.equal(message.hidden,false);
  assert.equal(doc.activeElement,submit);assert.equal(markers.filter(m=>m.map).length,13);assert.equal(lines.filter(l=>l.map).length,0);assert.equal(root.all().filter(n=>n.attrs['data-card-id']).length,13);
  mounted.destroy();
 }
});
