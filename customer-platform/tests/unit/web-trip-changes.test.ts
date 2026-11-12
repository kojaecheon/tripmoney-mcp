import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiError, createApi} from '../../web/api.mjs';
import * as ledgerControllers from '../../web/ledger/controller.mjs';
import type {ChangesApi} from '../../web/api.mjs';

const accountId='11111111-1111-4111-8111-111111111111';
const tripId='22222222-2222-4222-8222-222222222222';
const otherId='33333333-3333-4333-8333-333333333333';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const invalid=(e:unknown)=>e instanceof ApiError&&e.code==='invalid_response';
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function deferred<T>() {let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

// Each assertion protects the feature gate or the account-bound change cursor.
test('public config allows only an exact optional long-poll change capability',async()=>{
  for(const base of [{mode:'local-demo',mailDelivery:false,code:'123456'},{mode:'customer',mailDelivery:true}]) {
    assert.deepEqual(await createApi(async()=>json(base)).publicConfig(),base);
    const expected={...base,changes:{mode:'long-poll'}};
    assert.deepEqual(await createApi(async()=>json(expected)).publicConfig(),expected);
    for(const changes of [null,[],{}, {mode:'sse'}, {mode:'long-poll',url:'unsafe'}]) {
      await assert.rejects(createApi(async()=>json({...base,changes})).publicConfig(),invalid);
    }
    await assert.rejects(createApi(async()=>json({...base,extra:true})).publicConfig(),invalid);
  }
});

test('change API binds the account, sends an exact cursor and forwards cancellation',async()=>{
  const calls:[string,RequestInit][]=[];
  const api:ChangesApi=createApi(async(url,init)=>{calls.push([url,init]);return json({tripId,revision:5});});
  const signal=new AbortController().signal;
  assert.deepEqual(await api.waitForChanges(tripId,4,accountId,signal),{tripId,revision:5});
  assert.equal(calls[0]![0],`/api/customer/trips/${tripId}/changes`);
  const init=calls[0]![1];
  assert.equal(init.method,'POST');assert.equal(init.credentials,'same-origin');assert.equal(init.cache,'no-store');assert.equal(init.signal,signal);
  assert.deepEqual(init.headers,{'Content-Type':'application/json','X-TripMoney-Request':'1','X-TripMoney-Expected-Account':accountId});
  assert.deepEqual(JSON.parse(init.body as string),{afterRevision:4});
  for(const args of [[tripId,4,''],[tripId,-1,accountId],[tripId,1.5,accountId],['invalid',4,accountId]] as const) {
    await assert.rejects(api.waitForChanges(args[0],args[1],args[2],signal),invalid);
  }
  assert.equal(calls.length,1);
});

test('change API rejects mismatched, regressing and extra response fields',async()=>{
  for(const body of [{tripId:otherId,revision:5},{tripId,revision:3},{tripId,revision:0},{tripId,revision:1.5},{tripId,revision:Number.MAX_SAFE_INTEGER+1},{tripId,revision:4,extra:true},{tripId}]) {
    await assert.rejects(createApi(async()=>json(body)).waitForChanges(tripId,4,accountId),invalid);
  }
  await assert.rejects(createApi(async()=>json({tripId,revision:0})).waitForChanges(tripId,0,accountId),invalid);
  assert.deepEqual(await createApi(async()=>json({tripId,revision:1})).waitForChanges(tripId,0,accountId),{tripId,revision:1});
  assert.deepEqual(await createApi(async()=>json({tripId,revision:4})).waitForChanges(tripId,4,accountId),{tripId,revision:4});
});

function setup() {
  let visible=true,online=true,time=0,next=0;
  const timers=new Map<number,{at:number;fn:()=>void}>();
  const calls:{tripId:string;after:number;account:string;signal:AbortSignal;pending:ReturnType<typeof deferred<{tripId:string;revision:number}>>}[]=[];
  const changed:unknown[][]=[],unavailable:unknown[][]=[];
  const create=ledgerControllers.createTripChangesController;
  assert.equal(typeof create,'function','the changes controller is exported from the existing module');
  const controller=create({waitForChanges(id:string,after:number,account:string,signal:AbortSignal){const pending=deferred<{tripId:string;revision:number}>();calls.push({tripId:id,after,account,signal,pending});return pending.promise;}}, {
    onChanged:(...args:unknown[])=>changed.push(args),onUnavailable:(...args:unknown[])=>unavailable.push(args),
    isVisible:()=>visible,isOnline:()=>online,
    setTimeout:(fn:()=>void,ms:number)=>{const id=++next;timers.set(id,{at:time+ms,fn});return id;},
    clearTimeout:(id:number)=>timers.delete(id),
  });
  return {controller,calls,changed,unavailable,timers,setVisible:(value:boolean)=>{visible=value;controller.resume();},setOnline:(value:boolean)=>{online=value;controller.resume();},
    async tick(ms:number){const until=time+ms;for(;;){const due=[...timers].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].fn();await flush();}time=until;await flush();}};
}
const context={accountId,tripId,revision:4};

test('feature off and invalid or anonymous contexts never open a change request',()=>{
  const s=setup();s.controller.setContext(context);s.controller.resume();assert.equal(s.calls.length,0);
  s.controller.configure(true);assert.equal(s.calls.length,1);
  s.controller.configure(false);assert.equal(s.calls[0]!.signal.aborted,true);
  s.controller.setContext({accountId:null,tripId,revision:4});s.controller.configure(true);assert.equal(s.calls.length,1);
  s.controller.setContext({...context,revision:0});assert.equal(s.calls.length,1);
  s.controller.destroy();assert.equal(s.timers.size,0);
});

test('changed revisions refresh once and heartbeats wait at least 100ms with one request in flight',async()=>{
  const s=setup();s.controller.configure(true);s.controller.setContext(context);s.controller.resume();assert.equal(s.calls.length,1);
  s.calls[0]!.pending.resolve({tripId,revision:5});await flush();
  assert.deepEqual(s.changed,[[accountId,tripId,5]]);assert.equal(s.calls.length,1);
  s.controller.setContext(context);s.controller.resume();await s.tick(99);assert.equal(s.calls.length,1);
  await s.tick(1);assert.equal(s.calls.length,2);assert.equal(s.calls[1]!.after,5);
  s.calls[1]!.pending.resolve({tripId,revision:5});await flush();assert.equal(s.changed.length,1);
  await s.tick(100);assert.equal(s.calls.length,3);s.controller.destroy();
});

test('account and trip changes abort pending requests and discard late results including authorization errors',async()=>{
  const s=setup();s.controller.configure(true);s.controller.setContext(context);
  s.controller.setContext({...context,tripId:otherId});assert.equal(s.calls[0]!.signal.aborted,true);
  s.calls[0]!.pending.reject(new ApiError(401,'unauthenticated'));await flush();assert.equal(s.unavailable.length,0);
  s.controller.setContext({...context,accountId:otherId});assert.equal(s.calls[1]!.signal.aborted,true);
  s.calls[1]!.pending.resolve({tripId:otherId,revision:9});await flush();assert.equal(s.changed.length,0);
  assert.equal(s.calls.length,3);assert.equal(s.calls[2]!.account,otherId);s.controller.destroy();
});

test('hidden and offline states abort and resume only while visible and online',async()=>{
  const s=setup();s.controller.configure(true);s.controller.setContext(context);
  s.setVisible(false);assert.equal(s.calls[0]!.signal.aborted,true);s.setOnline(false);s.setVisible(true);assert.equal(s.calls.length,1);
  s.setOnline(true);assert.equal(s.calls.length,2);s.setOnline(false);assert.equal(s.calls[1]!.signal.aborted,true);
  s.calls[1]!.pending.reject(new ApiError(401,'unauthenticated'));await flush();assert.equal(s.unavailable.length,0);
  s.setOnline(true);assert.equal(s.calls.length,3);s.controller.destroy();assert.equal(s.calls[2]!.signal.aborted,true);
  s.calls[2]!.pending.resolve({tripId,revision:8});await flush();assert.equal(s.changed.length,0);assert.equal(s.timers.size,0);
});

test('a pending request is aborted after 30 seconds and retries only after five seconds',async()=>{
  const s=setup();s.controller.configure(true);s.controller.setContext(context);
  await s.tick(29999);assert.equal(s.calls[0]!.signal.aborted,false);
  await s.tick(1);assert.equal(s.calls[0]!.signal.aborted,true);assert.equal(s.calls.length,1);
  s.calls[0]!.pending.reject(new ApiError(401,'unauthenticated'));await flush();assert.equal(s.unavailable.length,0);
  s.controller.resume();await s.tick(4999);assert.equal(s.calls.length,1);
  await s.tick(1);assert.equal(s.calls.length,2);s.controller.destroy();
});

test('failures back off and current access errors request an ordinary API recheck',async()=>{
  for(const status of [0,401,403,404,412,429,503]) {
    const s=setup();s.controller.configure(true);s.controller.setContext(context);
    s.calls[0]!.pending.reject(new ApiError(status,'unavailable'));await flush();
    assert.equal(s.unavailable.length,[401,403,404,412].includes(status)?1:0);
    if(s.unavailable.length)assert.deepEqual(s.unavailable[0],[accountId,tripId]);
    const delay=status===429?15000:5000;s.controller.resume();await s.tick(delay-1);assert.equal(s.calls.length,1);
    await s.tick(1);assert.equal(s.calls.length,2);s.controller.destroy();
  }
});

test('app gates change requests on public config and refreshes through existing controllers',async t=>{
  const {readFile}=await import('node:fs/promises');
  const {pathToFileURL}=await import('node:url');
  const state={accountId:null as string|null,tripId:null as string|null,ledger:null as {revision:number}|null,day:''};
  const authState={phase:'checking',me:null as {userId:string}|null,config:null as Record<string,unknown>|null};
  let authListen:(state:typeof authState)=>void=()=>{},ledgerListen:(value:typeof state)=>void=()=>{};
  let refreshes=0,rechecks=0,clearedCookies=0;
  const kakaoConfigs:unknown[]=[];
  const startup:string[]=[],callbackLoads:string[]=[];
  const requests:{signal:AbortSignal;pending:ReturnType<typeof deferred<{tripId:string;revision:number}>>}[]=[];
  const travelRequests:unknown[][]=[];
  const events=new Map<string,()=>void>();
  const ui={hidden:false,textContent:'',setAttribute(){},focus(){},classList:{toggle(){}}};
  const loginLinkNotice={...ui};
  const document={hidden:false,getElementById:(id:string)=>id==='login-link-notice'?loginLinkNotice:ui,body:ui,addEventListener:(name:string,fn:()=>void)=>events.set(name,fn),removeEventListener:(name:string)=>events.delete(name)};
  const navigator={onLine:true};
  const window={location:{pathname:'/',origin:'http://localhost'},addEventListener:(name:string,fn:()=>void)=>events.set(name,fn),removeEventListener:(name:string)=>events.delete(name)};
  const travel={state:{accountId:null as string|null,selectedTripId:null as string|null,busy:null},subscribe:()=>()=>{},async setAccount(id:string|null){this.state.accountId=id;},async recheckAccount(){rechecks++;},destroy(){}};
  const ledger={state,subscribe(fn:typeof ledgerListen){ledgerListen=fn;fn(state);return()=>{};},setContext(){},async refresh(){refreshes++;},resume(){},destroy(){}};
  const fixture={startup,callbackLoads,callbackStatus:'idle',api:{waitForChanges(_id:string,_after:number,_account:string,signal:AbortSignal){const pending=deferred<{tripId:string;revision:number}>();requests.push({signal,pending});return pending.promise;},logout(){clearedCookies++;}},
    travel,ledger,queue:{request:(...args:unknown[])=>travelRequests.push(args),sync(){},destroy(){}},
    auth:{state:authState,subscribe(fn:typeof authListen){authListen=fn;fn(authState);return()=>{};},destroy(){},bootstrap(){}},
    widget:{updateContext(){},configureGoogle(){},destroy(){}},kakao:{updateContext(){},configure(config:unknown){kakaoConfigs.push(config);},destroy(){}},view:{destroy(){}}};
  for(const [key,value] of Object.entries({document,window,navigator,BroadcastChannel:undefined,__tripChangesAppFixture:fixture})) {
    const original=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    t.after(()=>{if(original)Object.defineProperty(globalThis,key,original);else Reflect.deleteProperty(globalThis,key);});
  }
  const moduleUrl=(code:string)=>`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const prefix='const f=globalThis.__tripChangesAppFixture;';
  const modules:Record<string,string>={
    './api.mjs':prefix+'export const createApi=()=>{f.startup.push("api");return f.api;};',
    './auth/email-link.mjs':prefix+'f.callbackLoads.push("email-link");export const completeEmailLink=async()=>{f.startup.push("callback");return {status:f.callbackStatus};};',
    './auth/controller.mjs':prefix+'export const createAuthController=()=>f.auth;',
    './travel/controller.mjs':prefix+'export const createTravelController=()=>f.travel;export const readInviteFragment=()=>null;',
    './ledger/controller.mjs':prefix+`export {createTripChangesController} from ${JSON.stringify(pathToFileURL(new URL('../../web/ledger/controller.mjs',import.meta.url).pathname).href)};export const createLedgerController=()=>f.ledger;export const createTravelRefreshQueue=()=>f.queue;`,
    './maps/view.mjs':prefix+'export const mountMaps=()=>f.widget;export const createGoogleSdkLoader=()=>null;',
    './drafts/view.mjs':prefix+'export const mountDrafts=()=>f.widget;',
    './planning-recovery.mjs':'export const createPlanningRecovery=()=>()=>{};',
    './recommendation/view.mjs':prefix+'export const mountRecommendation=()=>f.widget;',
    './kakao-local/view.mjs':prefix+'export const mountKakaoChannel=()=>f.kakao;',
  };
  for(const [path,name] of [['./auth/view.mjs','renderAuth'],['./travel/view.mjs','renderTravel'],['./invites/view.mjs','renderInvite'],['./ledger/view.mjs','renderLedger']])modules[path!]=prefix+`export const ${name}=()=>f.view;`;
  const source=(await readFile(new URL('../../web/app.mjs',import.meta.url),'utf8')).replace(/from '([^']+)'/g,(_all,path:string)=>`from '${moduleUrl(modules[path]!)}'`).replace(/import\('([^']+)'\)/g,(_all,path:string)=>`import('${moduleUrl(modules[path]!)}')`);
  await import(moduleUrl(source));
  assert.deepEqual(startup,['api'],'normal startup initializes the API without invoking callback handling');
  assert.deepEqual(callbackLoads,[],'normal startup does not load the callback module');
  assert.deepEqual(kakaoConfigs,[null],'Kakao stays disabled until public configuration is known');
  state.accountId=accountId;state.tripId=tripId;state.ledger={revision:4};travel.state.accountId=accountId;travel.state.selectedTripId=tripId;
  ledgerListen(state);assert.equal(requests.length,0,'old public config keeps the feature inactive');
  authState.phase='authenticated';authState.me={userId:accountId};authState.config={mode:'local-demo',mailDelivery:false,code:'123456',changes:{mode:'long-poll'}};authListen(authState);
  assert.equal(requests.length,1,'the advertised change capability starts the wait');
  assert.equal(kakaoConfigs.at(-1),authState.config,'Kakao receives the same validated public capability');
  requests[0]!.pending.resolve({tripId,revision:5});await flush();assert.equal(refreshes,1);assert.deepEqual(travelRequests,[[accountId,tripId,5]]);
  document.hidden=true;events.get('visibilitychange')!();document.hidden=false;events.get('visibilitychange')!();
  assert.equal(requests.length,2);requests[1]!.pending.reject(new ApiError(401,'unauthenticated'));await flush();
  assert.ok(rechecks>=1);assert.equal(refreshes,2);assert.equal(clearedCookies,0);
  navigator.onLine=false;events.get('offline')!();navigator.onLine=true;events.get('online')!();
  events.get('pagehide')!();assert.equal(requests.at(-1)!.signal.aborted,true);
  window.location.pathname='/auth/callback';fixture.callbackStatus='success';startup.length=0;
  await import(moduleUrl(source+'\n// successful callback navigation'));
  assert.deepEqual(startup,['callback'],'successful callback skips normal startup while navigation completes');
  assert.deepEqual(callbackLoads,['email-link'],'the callback route loads its handler lazily');
  fixture.callbackStatus='error';startup.length=0;
  await import(moduleUrl(source+'\n// failed callback normal login'));
  assert.deepEqual(startup.slice(0,2),['callback','api']);
  assert.match(loginLinkNotice.textContent,/로그인 링크를 확인하지 못했습니다/);
  events.get('pagehide')!();
});

test('disabling the capability and moving the ledger cursor invalidate old requests',async()=>{
  const s=setup();s.controller.configure(true);s.controller.setContext(context);
  s.controller.configure(false);s.calls[0]!.pending.reject(new ApiError(401,'unauthenticated'));await flush();
  assert.equal(s.unavailable.length,0);await s.tick(60000);assert.equal(s.calls.length,1);
  s.controller.configure(true);s.controller.setContext({...context,revision:7});assert.equal(s.calls[1]!.signal.aborted,true);
  assert.equal(s.calls[2]!.after,7);s.calls[1]!.pending.resolve({tripId,revision:20});await flush();assert.equal(s.changed.length,0);
  s.calls[2]!.pending.resolve({tripId,revision:8});await flush();assert.deepEqual(s.changed,[[accountId,tripId,8]]);s.controller.destroy();
});

test('malformed adapter replies cannot move the cursor or create a retry loop',async()=>{
  for(const result of [{tripId:otherId,revision:5},{tripId,revision:3},{tripId,revision:4.5}]) {
    const s=setup();s.controller.configure(true);s.controller.setContext(context);
    s.calls[0]!.pending.resolve(result);await flush();assert.equal(s.changed.length,0);
    await s.tick(4999);assert.equal(s.calls.length,1);await s.tick(1);assert.equal(s.calls.length,2);assert.equal(s.calls[1]!.after,4);s.controller.destroy();
  }
});
