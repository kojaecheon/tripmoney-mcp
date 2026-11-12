import test from 'node:test';
import assert from 'node:assert/strict';
const path='../../web/maps/sdk-loader.mjs';
function fixture(){
 const scripts:any[]=[];const win:any={};
 const doc:any={querySelector:()=>({nonce:'fixtureNonce0123456789'}),createElement:()=>({removed:false,remove(){this.removed=true;}}),head:{append(s:any){scripts.push(s);}}};
 return {scripts,win,doc};
}
const options={apiKey:'fixture-browser-key',mapId:'DEMO_MAP_ID',version:'quarterly',libraries:['marker']};
const sdk=()=>({maps:{Map:class{},marker:{AdvancedMarkerElement:class{}},LatLngBounds:class{},Polyline:class{}}});
test('SDK loader blocks before script creation without explicit permission, nonce or a valid key',async()=>{
 const {createGoogleSdkLoader}=await import(path);
 for(const patch of [{allowNetwork:false},{document:{...fixture().doc,querySelector:()=>null}}]){
  const f=fixture();await assert.rejects(createGoogleSdkLoader({document:f.doc,window:f.win,allowNetwork:true,...patch})(options));assert.equal(f.scripts.length,0);
 }
 const f=fixture();const loader=createGoogleSdkLoader({document:f.doc,window:f.win,allowNetwork:true});
 await assert.rejects(loader({...options,apiKey:'secret with space'}));assert.equal(f.scripts.length,0);
});
test('SDK loader uses one fixed-host script and shared promise, carries nonce, and cleans callback',async()=>{
 const {createGoogleSdkLoader}=await import(path);const f=fixture();
 const loader=createGoogleSdkLoader({document:f.doc,window:f.win,allowNetwork:true});
 const a=loader(options),b=loader(options);assert.equal(f.scripts.length,1);
 const script=f.scripts[0],url=new URL(script.src);assert.equal(url.origin,'https://maps.googleapis.com');assert.equal(url.pathname,'/maps/api/js');
 assert.equal(url.searchParams.get('key'),options.apiKey);assert.equal(url.searchParams.get('v'),'quarterly');assert.equal(script.nonce,'fixtureNonce0123456789');
 const name=url.searchParams.get('callback')!;f.win.google=sdk();f.win[name]();assert.equal(await a,f.win.google);assert.equal(await b,f.win.google);assert.equal(f.win[name],undefined);
 await assert.rejects(loader({...options,apiKey:'different-browser-key'}));assert.equal(f.scripts.length,1);
});
test('SDK error and timeout are fixed safe errors without automatic retries or lingering callbacks',async()=>{
 const {createGoogleSdkLoader}=await import(path);
 for(const scenario of ['error','timeout']){
  const f=fixture(),loader=createGoogleSdkLoader({document:f.doc,window:f.win,allowNetwork:true,timeoutMs:10});
  const promise=loader(options);const rejected=assert.rejects(promise,(e:any)=>e.message==='지도 SDK를 불러올 수 없습니다.');
  const name=new URL(f.scripts[0].src).searchParams.get('callback')!;
  if(scenario==='error')f.scripts[0].onerror(new Error('PRIVATE API KEY'));
  await rejected;assert.equal(f.win[name],undefined);assert.ok(f.scripts[0].removed);
  await assert.rejects(loader(options));assert.equal(f.scripts.length,1);
 }
});
