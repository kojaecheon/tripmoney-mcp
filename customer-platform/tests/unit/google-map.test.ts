import assert from 'node:assert/strict';
import test from 'node:test';
const modulePath='../../web/maps/google-map.mjs';
class Element {listeners:Record<string,Function[]>={};addEventListener(event:string,fn:Function){(this.listeners[event]??=[]).push(fn);}removeEventListener(event:string,fn:Function){this.listeners[event]=(this.listeners[event]??[]).filter(f=>f!==fn);}fire(event:string,props:any={}){for(const fn of this.listeners[event]??[])fn({preventDefault(){},...props});}children:any[]=[];textContent='';attrs:Record<string,string>={};ownerDocument:any;constructor(doc:any){this.ownerDocument=doc;}append(...nodes:any[]){this.children.push(...nodes);}replaceChildren(...nodes:any[]){this.children=[...nodes];}setAttribute(k:string,v:string){this.attrs[k]=v;}}
function fixture(){
 const doc:any={defaultView:{location:{origin:'https://preview.example.invalid'}}};doc.createElement=()=>new Element(doc);const root=new Element(doc),maps:any[]=[],markers:any[]=[],lines:any[]=[],loads:any[]=[];
 const sdk={maps:{Map:class {options:any;constructor(_node:any,options:any){this.options=options;maps.push(this);}fitBounds(){}},LatLngBounds:class {extend(){}},Polyline:class {map:any;constructor(options:any){this.map=options.map;lines.push(this);}setMap(value:any){this.map=value;}},marker:{AdvancedMarkerElement:class {map:any;options:any;constructor(options:any){this.options=options;this.map=options.map;markers.push(this);}}}}};
 const config={allowNetwork:true,browserApiKey:'fixture-browser-key',mapId:'fixture-map-id',allowedOrigins:['https://preview.example.invalid'],loader:async(options:any)=>{loads.push(options);return sdk;},now:()=>Date.parse('2026-11-08T00:00:00Z')};
 const pins=[{id:'saved-1',number:1,place:{ref:{provider:'google',placeId:'ChIJ_a'},source:'google',display:{expiresAt:'2026-11-08T00:05:00Z',attributions:[]},name:'provider-private-name',address:'provider-private-address',lat:37.56,lng:126.97}}];
 return {root,config,maps,markers,lines,loads,pins};
}
test('Google map requires explicit permission, browser key, map ID, exact host and injected loader before SDK load',async()=>{
 const {createGoogleMap}=await import(modulePath);
 for(const patch of [{allowNetwork:false},{browserApiKey:''},{mapId:''},{allowedOrigins:['https://evil.invalid']},{allowedOrigins:['*']},{loader:undefined}]){
  const f=fixture();const map=createGoogleMap(f.root,{...f.config,...patch});assert.equal(await map.mount(),false);assert.equal(f.loads.length,0);assert.equal(f.maps.length,0);map.destroy();
 }
});
test('Google map only renders fresh server Google references and uses numeric markers without copying provider text',async()=>{
 const {createGoogleMap}=await import(modulePath);const f=fixture(),map=createGoogleMap(f.root,f.config);assert.equal(f.loads.length,0);assert.equal(await map.mount(),true);
 assert.deepEqual(f.loads[0],{apiKey:'fixture-browser-key',mapId:'fixture-map-id',version:'quarterly',libraries:['marker']});
 assert.equal(map.render({pins:f.pins,expiresAt:'2026-11-08T00:01:00Z',attributions:[{displayName:'자료 제공자',uri:'https://attribution.example.invalid'}]}),true);
 assert.equal(f.markers.length,1);assert.deepEqual(f.markers[0].options.position,{lat:37.56,lng:126.97});assert.equal(f.markers[0].options.content.textContent,'1');
 assert.doesNotMatch(JSON.stringify(f.markers[0].options,(key,value)=>key==='map'||key==='ownerDocument'?undefined:value),/provider-private/);assert.match(JSON.stringify(f.root,(key,value)=>key==='ownerDocument'?undefined:value),/Google Maps|자료 제공자/);
 assert.equal(map.render({pins:[{...f.pins[0],place:{...f.pins[0]!.place,source:'synthetic'}}],expiresAt:'2026-11-08T00:01:00Z',attributions:[]}),false);assert.equal(f.markers[0].map,null);map.destroy();
});
test('Google map clears expired data, unsafe attribution and detached context, including late SDK results',async()=>{
 const {createGoogleMap}=await import(modulePath);const f=fixture();let now=Date.parse('2026-11-08T00:00:00Z');const map=createGoogleMap(f.root,{...f.config,now:()=>now});await map.mount();
 const envelope={pins:f.pins,expiresAt:'2026-11-08T00:00:01Z',attributions:[]};assert.equal(map.render(envelope),true);now+=1001;assert.equal(map.render(envelope),false);assert.equal(f.markers[0].map,null);
 assert.equal(map.render({...envelope,expiresAt:'2026-11-08T00:02:00Z',attributions:[{displayName:'bad',uri:'javascript:alert(1)'}]}),false);
 map.clear();map.destroy();assert.equal(f.root.children.length,0);
 let release!:(sdk:any)=>void;const g=fixture(),pendingMap=createGoogleMap(g.root,{...g.config,loader:()=>new Promise(r=>release=r)});const pending=pendingMap.mount();pendingMap.destroy();release({maps:{}});assert.equal(await pending,false);assert.equal(g.maps.length,0);
});

test('Google map removes markers when the server display deadline expires without another render',async()=>{
 const {createGoogleMap}=await import(modulePath);const f=fixture(),map=createGoogleMap(f.root,{...f.config,now:Date.now});await map.mount();assert.equal(map.render({pins:f.pins.map(p=>({...p,place:{...p.place,display:{expiresAt:new Date(Date.now()+1000).toISOString(),attributions:[]}}})),expiresAt:new Date(Date.now()+30).toISOString(),attributions:[]}),true);await new Promise(r=>setTimeout(r,60));assert.equal(f.markers[0].map,null);map.destroy();
});

test('Google pins expose keyboard selection, keep repeated visits separate and draw current route overlay',async()=>{
 const {createGoogleMap}=await import(modulePath);const f=fixture(),selected:string[]=[];
 const map=createGoogleMap(f.root,{...f.config,onSelectPin:(id:string)=>selected.push(id)});await map.mount();
 const firstPin=f.pins[0];assert.ok(firstPin);const pins=[firstPin,{...firstPin,id:'return',number:2}];
 const display={expiresAt:'2026-11-08T00:01:00Z',attributions:[]};
 const route={status:'ok',source:'google',mode:'walking',message:'경로',places:pins.map(p=>({...p.place,display})),path:[{lat:37.56,lng:126.97},{lat:37.57,lng:126.98}],display};
 assert.equal(map.render({pins,route,...display}),true);assert.equal(f.lines.length,1);assert.notEqual(f.markers[0].options.anchorLeft,f.markers[1].options.anchorLeft);
 const first=f.markers[0].options.content;assert.equal(first.attrs.role,'button');assert.equal(first.attrs.tabindex,'0');
 first.fire('keydown',{key:'Enter'});assert.deepEqual(selected,['saved-1']);map.selectPin('return');assert.equal(f.markers[1].options.content.attrs['aria-pressed'],'true');
 map.clear();first.fire('click');assert.deepEqual(selected,['saved-1']);assert.equal(f.lines[0].map,null);map.destroy();
});

test('SDK rejects pin and route metadata outside the five-minute window even with a shorter envelope',async()=>{
 const {createGoogleMap}=await import(modulePath);const f=fixture(),map=createGoogleMap(f.root,f.config);await map.mount();
 const display={expiresAt:'2026-11-08T00:01:00Z',attributions:[]};
 const firstPin=f.pins[0];assert.ok(firstPin);const badPin={...firstPin,place:{...firstPin.place,display:{...display,expiresAt:'2026-11-08T01:00:00Z'}}};
 assert.equal(map.render({pins:[badPin],...display}),false);
 const route={status:'ok',source:'google',mode:'walking',message:'경로',places:[badPin.place,badPin.place],path:[{lat:37,lng:127},{lat:37,lng:127}],display:{...display,expiresAt:'2026-11-08T00:10:00Z'}};
 assert.equal(map.render({pins:[f.pins[0],{...f.pins[0],id:'return',number:2}],route,...display}),false);map.destroy();
});
