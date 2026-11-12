import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi,ApiError} from '../../web/api.mjs';
const path='../../web/kakao/controller.mjs';
const account='20000000-0000-4000-8000-000000000001',tripId='10000000-0000-4000-8000-000000000001',pendingId='30000000-0000-4000-8000-000000000001',grantId='40000000-0000-4000-8000-000000000001',other='50000000-0000-4000-8000-000000000001';
const future='2099-01-01T00:00:00.000Z',pair={code:'0123456789abcdef01234567',expiresAt:future},approval={grantId,tripId,expiresAt:future};
const context={accountId:account,tripId,tripName:'서울',ledger:{tripId,role:'editor',members:[{alias:'홍길동',active:true},{alias:'김동행',active:true},{alias:'제외',active:false}]}};
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred(){let resolve!:(v:any)=>void;return {promise:new Promise(r=>resolve=r),resolve:(v:any)=>resolve(v)};}
async function ready(overrides={},options={}) {
 const {createKakaoController}=await import(path);
 const c=createKakaoController({api:{issueKakaoLivePair:async()=>pair,approveKakaoLivePair:async()=>approval,unlinkKakaoLive:async()=>({unlinked:true}),...overrides},...options});c.updateContext(context);return c;
}
// Catches treating issued codes as approvals, skipping the user's approval action, or persisting local authority.
test('issued code is never shown as an approval; pending ID needs an explicit approval and server result',async()=>{
 let approvals=0;const c=await ready({approveKakaoLivePair:async(id:string,t:string,a:string)=>{assert.equal(id,pendingId);assert.equal(t,tripId);assert.equal(a,account);approvals++;return approval;}});
 assert.equal(c.state.approval,null);assert.equal(await c.issuePair(),true);assert.equal(c.state.approval,null);assert.equal(approvals,0);
 c.setPendingId('not-an-id');assert.equal(await c.approve(),false);assert.equal(approvals,0);
 c.setPendingId(pendingId);assert.equal(c.state.approval,null);assert.equal(await c.approve(),true);assert.equal(approvals,1);assert.deepEqual(c.state.approval,approval);assert.equal(c.state.pair,null);assert.equal(c.state.pendingId,'');
 assert.equal(await c.unlink(),true);assert.equal(c.state.approval,null);c.destroy();
});
// Catches old requests restoring codes / approval when a different account or trip owns the screen.
test('late issue, approval and unlink responses never cross account or trip changes',async()=>{
 for(const operation of ['issuePair','approve','unlink'])for(const changed of [{...context,accountId:other},{...context,tripId:other,ledger:{...context.ledger,tripId:other}}]) {
  const d=deferred();const endpoint=operation==='issuePair'?'issueKakaoLivePair':operation==='approve'?'approveKakaoLivePair':'unlinkKakaoLive';
  const c=await ready(operation==='unlink'?{}:{[endpoint]:()=>d.promise});
  if(operation==='unlink'){c.setPendingId(pendingId);await c.approve();c.destroy();}
  const active=operation==='unlink'?await ready({unlinkKakaoLive:()=>d.promise}):c;
  if(operation==='unlink'){active.setPendingId(pendingId);await active.approve();}
  if(operation==='approve')active.setPendingId(pendingId);
  const work=active[operation]();await turn();active.updateContext(changed);d.resolve(operation==='issuePair'?pair:operation==='approve'?approval:{unlinked:true});
  assert.equal(await work,false);assert.equal(active.state.pair,null);assert.equal(active.state.approval,null);assert.equal(active.state.pendingId,'');assert.equal(active.state.busy,null);active.destroy();
 }
});
// Catches approving a different trip or accepting malformed responses at the controller boundary.
test('wrong trip approval and invalid server records are rejected without successful state',async()=>{
 for(const result of [{...approval,tripId:other},{...approval,grantId:'bad'},{...approval,expiresAt:'2020-01-01T00:00:00.000Z'}]){
  const c=await ready({approveKakaoLivePair:async()=>result});c.setPendingId(pendingId);assert.equal(await c.approve(),false);assert.equal(c.state.approval,null);assert.ok(c.state.error);c.destroy();
 }
 const c=await ready({issueKakaoLivePair:async()=>({...pair,code:'bad'})});assert.equal(await c.issuePair(),false);assert.equal(c.state.pair,null);c.destroy();
});
// Catches duplicate writes, unchanged context resetting approval, or authentication failures leaving private state.
test('busy guard, current authentication failure, unchanged context and destroyed controller preserve boundaries',async()=>{
 const d=deferred();let calls=0,unauthorized=0;const c=await ready({issueKakaoLivePair:()=>{calls++;return d.promise;}},{onUnauthorized:()=>unauthorized++});
 const work=c.issuePair();assert.equal(await c.issuePair(),false);assert.equal(calls,1);d.resolve(pair);assert.equal(await work,true);c.updateContext({...context});assert.deepEqual(c.state.pair,pair);c.destroy();assert.equal(await c.issuePair(),false);
 const fresh=await ready({approveKakaoLivePair:async()=>{throw new ApiError(412,'account_changed');}},{onUnauthorized:()=>unauthorized++});
 await fresh.issuePair();fresh.setPendingId(pendingId);assert.equal(await fresh.approve(),false);assert.equal(unauthorized,1);assert.equal(fresh.state.pair,null);assert.equal(fresh.state.pendingId,'');fresh.destroy();
});
// Catches displaying an expired approval as current or losing the ability to ask the server to unlink it.
test('expiration is visible and unlink always uses the recorded grant with server authorization',async()=>{
 let now=Date.parse('2098-12-31T23:59:00.000Z');let unlinked='';
 const c=await ready({unlinkKakaoLive:async(id:string,a:string)=>{unlinked=id;assert.equal(a,account);return {unlinked:true};}},{now:()=>now});
 c.setPendingId(pendingId);await c.approve();now=Date.parse(future);assert.equal(c.state.approvalExpired,true);assert.equal(await c.unlink(),true);assert.equal(unlinked,grantId);c.destroy();
});
function dom(){
 const nodes=new Map<string,any>();const doc:any={activeElement:null,createElement:(tag:string)=>node(tag)};
 function node(tag:string):any{return {tagName:tag,ownerDocument:doc,children:[],textContent:'',value:'',hidden:false,disabled:false,attrs:{},listeners:{},append(...v:any[]){this.children.push(...v);},replaceChildren(...v:any[]){this.children=v;},setAttribute(k:string,v:string){this.attrs[k]=v;},addEventListener(k:string,v:any){this.listeners[k]=v;},removeEventListener(k:string){delete this.listeners[k];}};}
 const root=node('div');Object.defineProperty(root,'innerHTML',{set(html:string){root.markup=html;for(const id of html.matchAll(/id="([^"]+)"/g))nodes.set(id[1]!,node('div'));}});root.querySelectorAll=()=>[...nodes].map(([id,v])=>Object.assign(v,{id}));return {root,nodes};
}
// Catches eagerly mounting the synthetic controller in customer mode and leaking connection code into a URL.
test('development mount makes no synthetic API request and renders only the server approval record',async()=>{
 const {mountKakaoChannel}=await import('../../web/kakao/mount.mjs');const {root,nodes}=dom();const urls:string[]=[];
 const api=createApi(async(url)=>{urls.push(url);if(url==='/api/customer/kakao/pair')return new Response(JSON.stringify(pair));if(url==='/api/customer/kakao/approve')return new Response(JSON.stringify(approval));throw new Error('synthetic request forbidden');});
 const m=mountKakaoChannel(root,{api});m.updateContext(context);await turn();assert.deepEqual(urls,[]);
 await m.configure({mode:'customer',mailDelivery:true,channels:{kakao:{mode:'development',channelUrl:'https://pf.kakao.com/_xjvDxeX',botName:'TripMoney 개발봇'}}});await turn();assert.deepEqual(urls,[]);
 await nodes.get('kakao-live-issue').listeners.click();assert.deepEqual(urls,['/api/customer/kakao/pair']);assert.equal(nodes.get('kakao-live-command').textContent,'연결 0123456789abcdef01234567');assert.doesNotMatch(nodes.get('kakao-live-state').textContent,/승인 기록/);
 assert.equal(nodes.get('kakao-live-channel').href,'https://pf.kakao.com/_xjvDxeX');assert.match(nodes.get('kakao-live-members').textContent,/홍길동.*김동행/);assert.doesNotMatch(nodes.get('kakao-live-members').textContent,/제외/);assert.match(nodes.get('kakao-live-example').textContent,/경비 \d{4}-\d\d-\d\d 12:00 \| 점심 \| 12000 KRW \| 홍길동 \| 전체/);
 const input=nodes.get('kakao-live-pending');input.value=pendingId;input.listeners.input();await nodes.get('kakao-live-form').listeners.submit({preventDefault(){}});
 assert.match(nodes.get('kakao-live-state').textContent,/서버 승인 기록/);assert.doesNotMatch(nodes.get('kakao-live-state').textContent,/연결 중|동기화 중/);
 m.updateContext({...context,accountId:other});assert.equal(nodes.get('kakao-live-command').textContent,'');assert.doesNotMatch(nodes.get('kakao-live-state').textContent,/서버 승인 기록/);m.destroy();
});

// Break caught: a delayed live import reusing the account captured at configure
// time, or mounting a live panel after mode change / disposal.
test('lazy live mount uses current account and never mounts after mode change or destruction',async()=>{
 const {mountKakaoChannel}=await import('../../web/kakao/mount.mjs');
 const live={mode:'customer',channels:{kakao:{mode:'development',channelUrl:'https://pf.kakao.com/_xjvDxeX',botName:'TripMoney 개발봇'}}};
 const {root,nodes}=dom();let requestedAccount='';
 const mount=mountKakaoChannel(root,{api:{issueKakaoLivePair:async(_trip:string,account:string)=>{requestedAccount=account;return pair;}}});
 mount.updateContext(context);const loading=mount.configure(live);mount.updateContext({...context,accountId:other});await loading;
 await nodes.get('kakao-live-issue').listeners.click();assert.equal(requestedAccount,other);mount.destroy();
 const changed=dom(),second=mountKakaoChannel(changed.root,{api:{}});
 const pending=second.configure(live);second.configure(null);await pending;
 assert.equal(changed.nodes.has('kakao-live-issue'),false);assert.equal(changed.root.hidden,true);second.destroy();
 const disposed=dom(),third=mountKakaoChannel(disposed.root,{api:{}});
 const inflight=third.configure(live);third.destroy();await inflight;
 assert.equal(disposed.nodes.has('kakao-live-issue'),false);assert.equal(disposed.root.hidden,true);
});
