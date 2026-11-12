import assert from 'node:assert/strict';
import test from 'node:test';
import {createGooglePlaceProvider} from '../../server/places/google-provider.js';
import {createClaudeProviders} from '../../server/ai/claude-provider.js';
import type {ProviderUsageStore} from '../../server/integration/contracts.js';
const aiContext={message:'내일 오전 10시 방문',startDate:'2026-11-07',endDate:'2026-11-09',timeZone:'Asia/Seoul',now:'2026-11-08T00:00:00Z'};
const recommendationContext={destination:'서울',startDate:'2026-11-07',endDate:'2026-11-09',timeZone:'Asia/Seoul',memberCount:2,budgetKrw:10000,interests:['산책'],pace:'balanced' as const};
const place={id:'ChIJ_a',displayName:{text:'공급자 장소'},formattedAddress:'공급자 주소',location:{latitude:37.56,longitude:126.97}};
const ref={provider:'google' as const,placeId:'ChIJ_a'};
const candidate={ref,name:'공급자 장소',address:'공급자 주소',lat:37.56,lng:126.97,source:'google',display:{expiresAt:'2026-11-08T00:05:00.000Z',attributions:[]}};
function fixture(respond:(url:string,init:RequestInit)=>Response|Promise<Response> = ()=>Response.json({places:[place]})) {
 const reservations:any[]=[],requests:{url:string;init:RequestInit}[]=[],ids=new Set<string>();let seq=0;
 const usageStore:ProviderUsageStore={async reserve(input){reservations.push(input);if(ids.has(input.requestId))return false;ids.add(input.requestId);return true;}};
 const config={apiKey:'fixture-secret-key',allowNetwork:true,usageStore,usageScope:'server-project',dailyLimit:20,now:()=>Date.parse('2026-11-08T00:00:00Z'),requestId:()=>`request-${++seq}`,fetcher:async(input:any,init:any)=>{requests.push({url:String(input),init});return respond(String(input),init);}};
 return {config,reservations,requests};
}
function claudeBody(output:unknown,extra:Record<string,unknown>={}) {return {id:'msg_fixture',type:'message',role:'assistant',model:'claude-fixture-20261108',content:[{type:'text',text:JSON.stringify(output)}],stop_reason:'end_turn',usage:{input_tokens:30,output_tokens:20},...extra};}
const extracted={kind:'schedule',fields:{date:'2026-11-09',startTime:'10:00',title:'방문'}};
test('Google blocks all network without explicit permission, key, injected transport and durable usage store',async()=>{
 for(const patch of [{allowNetwork:false},{allowNetwork:undefined},{apiKey:''},{fetcher:undefined},{usageStore:undefined},{dailyLimit:0},{usageScope:''}]){
  const f=fixture();const provider=createGooglePlaceProvider({...f.config,...patch} as any);
  await assert.rejects(provider.search('서울'),{code:'unavailable'});assert.equal(f.requests.length,0);assert.equal(f.reservations.length,0);
 }
});
test('Google projects text search, fixed endpoint and least fields while reserving server daily scope before fetch',async()=>{
 const f=fixture((_url,_init)=>{assert.equal(f.reservations.length,1);return Response.json({places:[{...place,apiKey:'do-not-return'}]});});
 assert.deepEqual(await createGooglePlaceProvider(f.config).search('서울'),[candidate]);
 assert.equal(f.requests[0]!.url,'https://places.googleapis.com/v1/places:searchText');const init=f.requests[0]!.init;
 assert.deepEqual(JSON.parse(String(init.body)),{textQuery:'서울',pageSize:20,languageCode:'ko'});assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
 assert.equal((init.headers as any)['X-Goog-Api-Key'],'fixture-secret-key');assert.equal((init.headers as any)['X-Goog-FieldMask'],'places.id,places.displayName,places.formattedAddress,places.location,places.attributions');
 assert.deepEqual(f.reservations[0],{scope:'google:server-project',requestId:'request-1',limit:20,expiresAt:Date.parse('2026-11-10T00:00:00Z')});
});
test('shared durable denial prevents a second Google request across provider instances and ambiguous failure is charged',async()=>{
 const f=fixture(()=>{throw Error('fixture-secret-key raw failure');});const config={...f.config,requestId:()=> 'same-request'};
 for(let n=0;n<2;n++)await assert.rejects(createGooglePlaceProvider(config).search('서울'),error=>{assert.doesNotMatch(String(error),/secret|raw failure/);return true;});
 assert.equal(f.requests.length,1);assert.equal(f.reservations.length,2);
});

test('Google keeps reservation scope stable across midnight so old request IDs cannot regain permission',async()=>{
 const f=fixture();let instant=Date.parse('2026-11-08T23:59:59Z');const config={...f.config,now:()=>instant,requestId:()=> 'same-request'};
 await createGooglePlaceProvider(config).search('서울');instant=Date.parse('2026-11-09T00:00:01Z');await assert.rejects(createGooglePlaceProvider(config).search('서울'),{code:'unavailable'});
 assert.equal(f.reservations[0].scope,'google:server-project');assert.equal(f.reservations[1].scope,'google:server-project');assert.equal(f.requests.length,1);
});
test('Google rejects malformed or unrelated places and invalid input before sending',async()=>{
 for(const response of [{places:[{...place,location:{latitude:91,longitude:1}}]},{places:[place,place]},{places:[{...place,displayName:{text:'bad\ntext'}}]},{places:'bad'}]){
  const f=fixture(()=>Response.json(response));await assert.rejects(createGooglePlaceProvider(f.config).search('서울'),{code:'unavailable'});
 }
 const f=fixture(()=>Response.json({...place,id:'ChIJ_other'}));await assert.rejects(createGooglePlaceProvider(f.config).resolve([ref]),{code:'unavailable'});
 for(const invalid of ['', 'x'.repeat(121),'query\n'])await assert.rejects(createGooglePlaceProvider(f.config).search(invalid),{code:'unavailable'});
 assert.equal(f.requests.length,1);
});
test('Google resolves IDs without storing display data and computes ordered repeated visits with ten intermediates maximum',async()=>{
 const f=fixture(url=>url.includes('computeRoutes')?Response.json({routes:[{polyline:{geoJsonLinestring:{type:'LineString',coordinates:[[126.97,37.56],[126.98,37.57]]}}}]}):Response.json(place));
 const provider=createGooglePlaceProvider(f.config);
 assert.deepEqual(await provider.resolve([ref]),[candidate]);assert.equal(f.requests[0]!.url,'https://places.googleapis.com/v1/places/ChIJ_a?languageCode=ko');
 const route=await provider.route([ref,ref,ref],'driving') as any;assert.equal(route.status,'ok');assert.equal(route.source,'google');assert.deepEqual(route.places,[candidate,candidate,candidate]);assert.deepEqual(route.path,[{lat:37.56,lng:126.97},{lat:37.57,lng:126.98}]);
 const body=JSON.parse(String(f.requests.at(-1)!.init.body));assert.deepEqual(body.origin,{placeId:'ChIJ_a'});assert.deepEqual(body.destination,{placeId:'ChIJ_a'});assert.deepEqual(body.intermediates,[{placeId:'ChIJ_a'}]);assert.equal(body.routingPreference,'TRAFFIC_UNAWARE');assert.equal(body.travelMode,'DRIVE');assert.equal(body.polylineEncoding,'GEO_JSON_LINESTRING');assert.equal(body.optimizeWaypointOrder,undefined);
 const before=f.requests.length;assert.equal((await provider.route(Array(13).fill(ref),'walking') as any).status,'unsupported');assert.equal(f.requests.length,before);
});
test('Google maps empty routes to unsupported, malformed geometry to safe error and never retries upstream failure',async()=>{
 for(const response of [{routes:[]},{routes:[{polyline:{geoJsonLinestring:{type:'LineString',coordinates:[[0,99],[1,1]]}}}]}]){
  const f=fixture(url=>url.includes('computeRoutes')?Response.json(response):Response.json(place));const result=await createGooglePlaceProvider(f.config).route([ref,ref],'walking') as any;
  assert.equal(result.source,'google');assert.equal(result.status,response.routes.length?'error':'unsupported');assert.doesNotMatch(JSON.stringify(result),/secret/);
  const body=JSON.parse(String(f.requests.at(-1)!.init.body));assert.equal(body.routingPreference,undefined);
 }
 const f=fixture(()=>new Response('fixture-secret-key raw upstream',{status:429}));await assert.rejects(createGooglePlaceProvider(f.config).search('서울'),{code:'unavailable'});assert.equal(f.requests.length,1);
});
test('provider transport enforces streamed body size, deadline through body read and late transport cancellation',async()=>{
 const oversized=fixture(()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('x'.repeat(262145)));c.close();}}),{headers:{'Content-Type':'application/json'}}));
 await assert.rejects(createGooglePlaceProvider(oversized.config).search('서울'),{code:'unavailable'});
 let signal:AbortSignal|undefined;const slow=fixture(async(_url,init)=>{signal=init.signal!;return new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}});});
 await assert.rejects(createGooglePlaceProvider({...slow.config,timeoutMs:20}).search('서울'),{code:'unavailable'});assert.equal(signal?.aborted,true);assert.equal(slow.requests.length,1);
 let release!:(value:boolean)=>void;const delayed=fixture();const pending=createGooglePlaceProvider({...delayed.config,timeoutMs:20,usageStore:{reserve:()=>new Promise<boolean>(r=>release=r)}}).search('서울');await assert.rejects(pending,{code:'unavailable'});release(true);await new Promise(r=>setImmediate(r));assert.equal(delayed.requests.length,0);
});
test('Claude shares Messages transport for extraction and recommendations without identity fields or tools',async()=>{
 const output={items:[{input:{date:'2026-11-08',startTime:'10:00',endTime:'11:00',title:'산책',place:'직접 확인',budgetKrw:1000,placeRef:null},reason:'산책 선호'}]};let n=0;
 const f=fixture(()=>Response.json(claudeBody(n++?output:extracted)));const providers=createClaudeProviders({...f.config,model:'claude-fixture-20261108',maxTokens:1024});
 assert.equal(providers.aiProvider.source,'claude');assert.deepEqual(await providers.aiProvider.extract(aiContext),extracted);assert.deepEqual(await providers.recommendationProvider.generate(recommendationContext),output);
 for(const request of f.requests){assert.equal(request.url,'https://api.anthropic.com/v1/messages');const body=JSON.parse(String(request.init.body));assert.equal(body.model,'claude-fixture-20261108');assert.equal(body.max_tokens,1024);assert.equal(body.stream,false);assert.equal(body.tools,undefined);assert.equal(body.temperature,undefined);assert.equal((request.init.headers as any)['anthropic-version'],'2026-10-21');assert.equal((request.init.headers as any)['x-api-key'],'fixture-secret-key');assert.doesNotMatch(String(request.init.body),/sessionHash|userId|tripId|fixture-secret-key/);}
 assert.match(f.reservations[0].scope,/^claude:/);
});
test('Claude refuses malformed models, excess tokens, extra context fields and missing provider gates before reservations',async()=>{
 for(const patch of [{model:''},{model:'https://evil.invalid'},{model:'claude-x\n'},{maxTokens:0},{maxTokens:4097},{allowNetwork:false},{fetcher:undefined},{usageStore:undefined}]){
  const f=fixture();const p=createClaudeProviders({...f.config,model:'claude-fixture-20261108',maxTokens:1024,...patch} as any);await assert.rejects(p.aiProvider.extract(aiContext),{code:'unavailable'});assert.equal(f.requests.length,0);assert.equal(f.reservations.length,0);
 }
 const f=fixture();await assert.rejects(createClaudeProviders({...f.config,model:'claude-fixture-20261108',maxTokens:1024}).aiProvider.extract({...aiContext,userId:'secret'} as any),{code:'unavailable'});assert.equal(f.requests.length,0);
});
test('Claude rejects truncation, tool blocks, mismatched model, malformed JSON and wrong result shapes without exposing raw provider text',async()=>{
 for(const raw of [claudeBody(extracted,{stop_reason:'max_tokens'}),claudeBody(extracted,{model:'other'}),claudeBody(extracted,{content:[{type:'tool_use',id:'tool',name:'write',input:{}}]}),claudeBody(extracted,{content:[{type:'text',text:'fixture-secret-key not json'}]}),claudeBody({kind:'execute',fields:{}}),claudeBody({kind:'expense',fields:{title:'x',currency:'USD'}})]){
  const f=fixture(()=>Response.json(raw));await assert.rejects(createClaudeProviders({...f.config,model:'claude-fixture-20261108',maxTokens:1024}).aiProvider.extract(aiContext),error=>{assert.doesNotMatch(String(error),/secret|not json/);return true;});assert.equal(f.requests.length,1);
 }
});

test('transport fails closed on durable-store errors, redirects and ambiguous Claude errors',async()=>{
 const denied=fixture();await assert.rejects(createGooglePlaceProvider({...denied.config,usageStore:{async reserve(){throw Error('fixture-secret-key database error');}}}).search('서울'),e=>{assert.doesNotMatch(String(e),/secret|database/);return true;});assert.equal(denied.requests.length,0);
 for(const status of [302,429,500]){const f=fixture(()=>new Response('fixture-secret-key',{status}));const p=createClaudeProviders({...f.config,model:'claude-fixture-20261108',maxTokens:1024});await assert.rejects(p.aiProvider.extract(aiContext),{code:'unavailable'});assert.equal(f.requests.length,1);assert.equal(f.reservations.length,1);}
});

test('Claude rejects invalid recommendation candidates before they reach adoption',async()=>{
 for(const output of [{items:[]},{items:[{input:{date:'2028-01-01',startTime:'10:00',endTime:'11:00',title:'여행',place:'',budgetKrw:0,placeRef:null},reason:'범위 밖'}]},{items:[{input:{date:'2026-11-08',startTime:'10:00',endTime:'11:00',title:'여행',place:'',budgetKrw:10001,placeRef:null},reason:'예산 초과'}]}]){
  const f=fixture(()=>Response.json(claudeBody(output)));await assert.rejects(createClaudeProviders({...f.config,model:'claude-fixture-20261108',maxTokens:1024}).recommendationProvider.generate(recommendationContext),{code:'unavailable'});
 }
});

test('Claude accepts LF CR TAB and counts message length by Unicode code points like the draft input',async()=>{
 for(const message of ['내일 오전 10시 방문\n예산 10000원\r\n메모\t동행', '🌴'.repeat(2000)]){
  const f=fixture(()=>Response.json(claudeBody(extracted)));const provider=createClaudeProviders({...f.config,model:'claude-fixture-20261108',maxTokens:1024}).aiProvider;
  assert.deepEqual(await provider.extract({...aiContext,message}),extracted);assert.equal(f.requests.length,1);
  const body=JSON.parse(String(f.requests[0]!.init.body));assert.equal(JSON.parse(body.messages[0].content).message,message);
 }
});

test('Claude still blocks forbidden message controls blank input and excess code points before reservations',async()=>{
 for(const message of ['', ' \n\r\t ', '🌴'.repeat(2001),...['\u0000','\u0001','\u0008','\u000b','\u000c','\u000e','\u001f','\u007f'].map(control=>`방문${control}메모`)]){
  const f=fixture(()=>Response.json(claudeBody(extracted)));const provider=createClaudeProviders({...f.config,model:'claude-fixture-20261108',maxTokens:1024}).aiProvider;
  await assert.rejects(provider.extract({...aiContext,message}),{code:'unavailable'});assert.equal(f.requests.length,0);assert.equal(f.reservations.length,0);
 }
});
