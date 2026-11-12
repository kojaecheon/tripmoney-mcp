import assert from 'node:assert/strict';
import test from 'node:test';
const validationPath='../../web/maps/validation.mjs',controllerPath='../../web/maps/controller.mjs';
const instant=Date.parse('2026-11-08T00:00:00Z');
const display={expiresAt:'2026-11-08T00:01:00.000Z',attributions:[{displayName:'자료 제공자',uri:'https://source.example.invalid/'}]};
const place={ref:{provider:'google',placeId:'ChIJ_a'},source:'google',name:'공급자 장소',address:'공급자 주소',lat:37,lng:127,display};
const ctx={accountId:'account',tripId:'trip',day:'2026-11-08',ledger:{tripId:'trip',role:'owner',revision:1,items:[{id:'visit',status:'active',date:'2026-11-08',order:0,title:'사용자 메모',place:'기존 메모',placeRef:place.ref}]}};

test('display metadata is safely projected, bounded and mandatory for Google places and successful routes',async()=>{
 const v=await import(validationPath);assert.equal(typeof v.parseDisplay,'function');
 const parsed=v.parseDisplay({...display,secret:'discard'});assert.deepEqual(parsed,display);assert.notEqual(parsed,display);assert.notEqual(parsed.attributions,display.attributions);
 for(const bad of [null,{...display,expiresAt:'tomorrow'},{...display,expiresAt:'2026-02-30T00:00:00Z'},{...display,attributions:Array(31).fill(display.attributions[0])},
  {...display,attributions:[{displayName:' ',uri:'https://safe.invalid'}]},{...display,attributions:[{displayName:'bad',uri:'https://user:pass@safe.invalid'}]},
  {...display,attributions:[{displayName:'bad',uri:'javascript:alert(1)'}]}])assert.throws(()=>v.parseDisplay(bad));
 assert.deepEqual(v.parsePlaces([place]),[place]);assert.throws(()=>v.parsePlaces([{...place,display:undefined}]));
 const route={status:'ok',source:'google',mode:'walking',message:'경로',places:[place,place],path:[{lat:37,lng:127},{lat:37,lng:127}],display};
 assert.deepEqual(v.parseRoute(route,[place.ref,place.ref],'walking').display,display);
 assert.throws(()=>v.parseRoute({...route,display:undefined},[place.ref,place.ref],'walking'));
});

test('Google data stays hidden until SDK ready and expires with no retry while user notes remain',async()=>{
 const {createMapsController}=await import(controllerPath);let now=instant,requests=0,tick:Function=()=>{};
 const c=createMapsController({resolvePlaces:async()=>{requests++;return[place];},searchPlaces:async()=>[place]},
 {now:()=>now,setTimeout:(fn:Function)=>{tick=fn;return 1;},clearTimeout:()=>{}});
 await c.updateContext(ctx);assert.equal(c.state.pins.length,0);assert.match(c.state.mapNotice,/지도/);
 c.setGoogleReady(true);assert.equal(c.state.pins.length,1);c.setQuery('검색');await c.search();assert.equal(c.state.results.length,1);
 now+=60000;tick();assert.equal(c.state.pins.length,0);assert.equal(c.state.results.length,0);assert.equal(c.state.externalUrl,null);
 assert.equal(c.state.ledger.items[0].place,'기존 메모');assert.equal(requests,1);c.destroy();
});

test('Google data rejected when expired or beyond five minutes and revoked SDK removes displayed payload',async()=>{
 const {createMapsController}=await import(controllerPath);let current=place;
 const c=createMapsController({resolvePlaces:async()=>[current],searchPlaces:async()=>[current]},{now:()=>instant});
 c.setGoogleReady(true);await c.updateContext(ctx);assert.equal(c.state.pins.length,1);c.setGoogleReady(false);assert.equal(c.state.pins.length,0);
 c.setGoogleReady(true);for(const expiresAt of ['2026-11-07T23:59:59Z','2026-11-08T00:05:01Z']){
  current={...place,display:{...display,expiresAt}};c.setQuery('검색');await c.search();assert.equal(c.state.results.length,0);
 }c.destroy();
});

test('route expiry follows place deadlines and revoking access discards pending Google results',async()=>{
 const {createMapsController}=await import(controllerPath);let now=instant,tick:Function=()=>{},resolveRoute!:(value:any)=>void;
 const visits={...ctx,ledger:{...ctx.ledger,items:[ctx.ledger.items[0],{...ctx.ledger.items[0],id:'return',order:1}]}};
 const c=createMapsController({resolvePlaces:async()=>[place],routePlaces:()=>new Promise(resolve=>resolveRoute=resolve)},
 {now:()=>now,setTimeout:(fn:Function)=>{tick=fn;return 1;},clearTimeout:()=>{}});c.setGoogleReady(true);await c.updateContext(visits);
 const request=c.previewRoute();resolveRoute({status:'ok',source:'google',mode:'walking',message:'경로',places:[place,place],path:[place,place],display:{...display,expiresAt:'2026-11-08T00:00:30Z'}});await request;assert.equal(c.state.route.status,'ok');
 now+=30000;tick();assert.equal(c.state.route,null);assert.equal(c.state.pins.length,2);
 const pending=c.previewRoute();await c.updateContext({...visits,ledger:null});resolveRoute({status:'ok',source:'google',mode:'walking',message:'경로',places:[place,place],path:[place,place],display});await pending;
 assert.equal(c.state.route,null);assert.equal(c.state.pins.length,0);c.destroy();
});

test('Google error and unsupported routes keep the fixed message without display metadata for thirteen visits',async()=>{
 const {createMapsController}=await import(controllerPath);
 const first=ctx.ledger.items[0];assert.ok(first);
 const visits={...ctx,ledger:{...ctx.ledger,items:Array.from({length:13},(_,i)=>({...first,id:`visit-${i}`,order:i}))}};
 for(const routeStatus of ['error','unsupported']){
  const c=createMapsController({resolvePlaces:async()=>[place],routePlaces:async(_trip:any,refs:any[])=>{
   assert.equal(refs.length,13);return{status:routeStatus,source:'google',mode:'walking',message:'Google 경로는 방문 일정 12개까지 확인할 수 있습니다.'};
  }},{now:()=>instant});c.setGoogleReady(true);await c.updateContext(visits);
  assert.equal(await c.previewRoute(),true);assert.equal(c.state.route?.status,routeStatus);assert.match(c.state.route?.message??'',/12개/);
  assert.equal(c.state.pins.length,13);c.selectPin('visit-12');assert.equal(c.state.route?.status,routeStatus);c.destroy();
 }
});

test('expired pins remain unresolved with a fixed refresh notice until fresh context data recovers',async()=>{
 const {createMapsController}=await import(controllerPath);let now=instant,tick:Function=()=>{},resolved=place;
 const first=ctx.ledger.items[0];assert.ok(first);
 const visits={...ctx,ledger:{...ctx.ledger,items:[first,{...first,id:'return',order:1}]}};
 const c=createMapsController({resolvePlaces:async()=>[resolved]},{now:()=>now,setTimeout:(fn:Function)=>{tick=fn;return 1;},clearTimeout:()=>{}});
 c.setGoogleReady(true);await c.updateContext(visits);assert.equal(c.state.pins.length,2);assert.equal(c.state.unresolvedCount,0);
 now+=60000;tick();assert.equal(c.state.pins.length,0);assert.equal(c.state.unresolvedCount,2);assert.equal(c.state.expiredDisplay,true);
 assert.equal(c.state.mapNotice,'장소 표시 기한이 지났습니다. 다시 조회해 주세요. 일정 메모는 유지됩니다.');
 c.setQuery('입력 유지');assert.equal(c.state.unresolvedCount,2);assert.equal(c.state.expiredDisplay,true);
 assert.equal(c.state.ledger.items[0].place,'기존 메모');
 resolved={...place,display:{...display,expiresAt:'2026-11-08T00:02:00Z'}};
 await c.updateContext({...visits,ledger:{...visits.ledger,revision:2}});
 assert.equal(c.state.pins.length,2);assert.equal(c.state.unresolvedCount,0);assert.equal(c.state.expiredDisplay,false);assert.equal(c.state.mapNotice,'');
 await c.updateContext({...visits,ledger:null});assert.equal(c.state.expiredDisplay,false);assert.equal(c.state.mapNotice,'');c.destroy();
});
