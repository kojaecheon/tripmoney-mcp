import assert from 'node:assert/strict';
import test from 'node:test';
import {createGooglePlaceProvider} from '../../server/places/google-provider.js';
import {placeList,routePreview} from '../../server/places/validation.js';
import {createPlaceService} from '../../server/places/service.js';

const instant=Date.parse('2026-11-08T00:00:00Z');
const attribution={displayName:'자료 제공',uri:'https://provider.example.invalid/source'};
const display={expiresAt:'2026-11-08T00:05:00.000Z',attributions:[attribution]};
const ref={provider:'google' as const,placeId:'ChIJ_a'};
const row={ref,name:'장소',address:'주소',lat:37.56,lng:126.97,source:'google' as const,display};
const raw={id:'ChIJ_a',displayName:{text:'장소'},formattedAddress:'주소',location:{latitude:37.56,longitude:126.97},attributions:[{provider:'자료 제공',providerUri:'https://provider.example.invalid/source',secret:'discard'}]};
function providerFixture(response:(url:string)=>unknown,now:()=>number=()=>instant){
 const requests:{url:string;init:RequestInit}[]=[];let seq=0;
 const provider=createGooglePlaceProvider({apiKey:'fixture-secret-key',allowNetwork:true,usageStore:{reserve:async()=>true},usageScope:'unit-display',dailyLimit:20,now,requestId:()=>`display-${++seq}`,
  fetcher:async(input,init)=>{requests.push({url:String(input),init:init!});const result=response(String(input));return result instanceof Response?result:Response.json(result);}});
 return {provider,requests};
}

test('Google projects documented attribution fields and adds display expiry from response receipt',async()=>{
 let now=instant;
 const f=providerFixture(url=>{now+=1000;const place={...raw,display:{expiresAt:'2099-01-01T00:00:00Z',attributions:[]}};return url.includes('searchText')?{places:[place]}:place;},()=>now);
 assert.deepEqual(await f.provider.search('장소'),[{...row,display:{...display,expiresAt:'2026-11-08T00:05:01.000Z'}}]);
 assert.equal((f.requests[0]!.init.headers as Record<string,string>)['X-Goog-FieldMask'],'places.id,places.displayName,places.formattedAddress,places.location,places.attributions');
 const resolved=placeList(await f.provider.resolve([ref]),[ref]);assert.equal(resolved[0]!.display?.expiresAt,'2026-11-08T00:05:02.000Z');
 assert.equal((f.requests[1]!.init.headers as Record<string,string>)['X-Goog-FieldMask'],'id,displayName,formattedAddress,location,attributions');
});

test('Google accepts omitted or empty protobuf attribution lists and rejects unsafe present fields',async()=>{
 for(const attributions of [undefined,[]]){
  const f=providerFixture(()=>({places:[{...raw,attributions}]}));
  assert.deepEqual(placeList(await f.provider.search('장소'))[0]!.display,{...display,attributions:[]});
 }
 for(const attributions of [null,{},[{displayName:'wrong shape',uri:attribution.uri}],
  [{provider:' ',providerUri:attribution.uri}],[{provider:'x\n',providerUri:attribution.uri}],
  [{provider:'x'.repeat(201),providerUri:attribution.uri}],
  ...['javascript:alert(1)','http://provider.invalid','https://user:pass@provider.invalid','https://provider.invalid/a b','https://provider.invalid/\n','https://provider.invalid/'+ 'a'.repeat(2000)].map(providerUri=>[{provider:'자료',providerUri}]),
  Array(31).fill(raw.attributions[0])]){
  const f=providerFixture(()=>({places:[{...raw,attributions}]}));await assert.rejects(f.provider.search('장소'),{code:'unavailable'});
 }
});

test('place validation preserves independent display objects and refuses missing or invalid Google metadata',()=>{
 const projected=placeList([{...row,secret:'discard',display:{...display,secret:'discard',attributions:[{...attribution,secret:'discard'}]}}]);
 assert.deepEqual(projected,[row]);assert.notEqual(projected[0]!.display,display);assert.notEqual(projected[0]!.display?.attributions[0],attribution);
 for(const invalid of [undefined,null,{}, {...display,expiresAt:'not-a-date'}, {...display,expiresAt:'2026-02-30T00:00:00Z'}, {...display,expiresAt:'2026-11-08'},
  {...display,attributions:null},{...display,attributions:Array(1)},{...display,attributions:[{...attribution,uri:'javascript:alert(1)'}]}, {...display,attributions:Array(31).fill(attribution)}])assert.throws(()=>placeList([{...row,display:invalid}]));
 const synthetic={...row,ref:{provider:'demo',placeId:'demo-a'},source:'synthetic'};assert.equal(placeList([synthetic])[0]!.display,undefined);
});

test('Google route expiry uses earliest response and merges unique place attribution sources',async()=>{
 let now=instant;
 const other={provider:'다른 자료',providerUri:'https://other.example.invalid/source'};
 const f=providerFixture(url=>{now+=1000;if(url.includes('computeRoutes'))return {routes:[{polyline:{geoJsonLinestring:{type:'LineString',coordinates:[[126.97,37.56],[126.98,37.57]]}}}]};return url.includes('ChIJ_b')?{...raw,id:'ChIJ_b',attributions:[raw.attributions[0],other]}:raw;},()=>now);
 const refs=[ref,{provider:'google' as const,placeId:'ChIJ_b'},ref];
 const route=routePreview(await f.provider.route(refs,'walking'),refs,'walking');assert.equal(route.status,'ok');
 assert.deepEqual(route.display,{expiresAt:'2026-11-08T00:05:01.000Z',attributions:[attribution,{displayName:'다른 자료',uri:'https://other.example.invalid/source'}]});
 if(route.status==='ok')assert.deepEqual(route.places.map(p=>p.display?.expiresAt),['2026-11-08T00:05:01.000Z','2026-11-08T00:05:02.000Z','2026-11-08T00:05:01.000Z']);
});

test('route validation rejects missing display, extended expiry and dropped place attributions',()=>{
 const route={status:'ok',source:'google',mode:'walking',message:'경로',places:[row,row],path:[{lat:37.56,lng:126.97},{lat:37.57,lng:126.98}],display};
 assert.deepEqual(routePreview(route,[ref,ref],'walking'),route);
 for(const metadata of [undefined,{...display,expiresAt:'2026-11-08T00:05:00.001Z'},{...display,attributions:[]}])assert.throws(()=>routePreview({...route,display:metadata},[ref,ref],'walking'));
 assert.deepEqual(routePreview({status:'error',source:'google',mode:'walking',message:'조회 실패',display:null},[ref,ref],'walking'),{status:'error',source:'google',mode:'walking',message:'조회 실패'});
});

test('service validation preserves original Google expiry without extending reused provider responses',async()=>{
 const service=createPlaceService({ledgerService:{get:async()=>({})} as any,provider:{search:async()=>[row],resolve:async()=>[row],route:async()=>null}});
 const actor={} as any;
 assert.deepEqual(await service.search(actor,'trip','장소'),[row]);assert.deepEqual(await service.resolve(actor,'trip',[ref]),[row]);
 assert.equal((await service.search(actor,'trip','장소'))[0]!.display?.expiresAt,'2026-11-08T00:05:00.000Z');
});

// A streamed body can arrive after response headers. Parsing must not refresh the lease.
test('body read delays do not extend Google display expiry beyond response receipt',async()=>{
 let now=instant;
 const f=providerFixture(()=>new Response(new ReadableStream<Uint8Array>({pull(controller){now+=60000;controller.enqueue(new TextEncoder().encode(JSON.stringify({places:[raw]})));controller.close();}},{highWaterMark:0}),{headers:{'Content-Type':'application/json'}}),()=>now);
 const places=placeList(await f.provider.search('장소'));assert.equal(now,instant+60000);
 assert.equal(places[0]!.display?.expiresAt,'2026-11-08T00:05:00.000Z');
});
