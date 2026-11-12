import assert from 'node:assert/strict';
import test from 'node:test';
const controllerPath='../../web/kakao-local/controller.mjs';
const viewPath='../../web/kakao-local/view.mjs';
const future='2099-01-01T00:00:00Z';
const tripId='10000000-0000-4000-8000-000000000001',memberId='20000000-0000-4000-8000-000000000001';
const otherId='10000000-0000-4000-8000-000000000002';
const ledger={tripId,revision:1,role:'editor',startDate:'2026-11-07',endDate:'2026-11-10',members:[{id:memberId,alias:'나',active:true,role:'editor'}],items:[],expenses:[]};
const status={source:'synthetic',linked:true,expiresAt:future,tripId,trips:[{id:tripId,name:'서울'},{id:otherId,name:'부산'}]};
const draft={id:'draft',expiresAt:future,tripId,baseRevision:1,kind:'expense',fields:{title:'점심',currency:'THB',amount:'300'},missing:[],source:'synthetic',warnings:[]};
const context={accountId:'account',tripId,ledger,day:'2026-11-07'};
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function api(overrides={}) {return {kakaoStatus:async()=>status,issueKakaoPair:async()=>({code:'pair',expiresAt:future}),connectKakao:async()=>status,unlinkKakao:async()=>({...status,linked:false,tripId:null}),selectKakaoTrip:async(id:string)=>({...status,tripId:id}),getLedger:async(id:string)=>({...ledger,tripId:id}),prepareKakaoDraft:async()=>draft,reviewKakaoDraft:async(_id:string,input:unknown)=>({token:'secret',tripId,tripName:'서울',kind:'expense',input,baseRevision:1,expiresAt:future}),confirmKakao:async()=>({value:{targetId:'saved'},tripRevision:2,replayed:false}),cancelKakaoDraft:async()=>{},...overrides};}
async function ready(overrides={},callbacks={}) {
 const {createKakaoLocalController}=await import(controllerPath);const c=createKakaoLocalController({api:api(overrides),...callbacks});
 c.updateContext(context);await turn();return c;
}
async function filled(c:any) {
 c.setMessage('점심 300바트');await c.prepare();
 c.setField('occurredLocal','2026-11-07T12:30');c.setField('payerId',memberId);c.setField('splitIds',[memberId]);
}
test('expense fields keep unspecified date and participants blank; review precedes separate save',async()=>{
 let saves=0;const c=await ready({confirmKakao:async()=>{saves++;return {tripRevision:2};}});
 c.setMessage('점심 300바트');assert.equal(await c.prepare(),true);
 assert.equal(c.state.fields.occurredLocal,'');assert.equal(c.state.fields.payerId,'');assert.deepEqual(c.state.fields.splitIds,[]);
 assert.equal(await c.review(),false);assert.equal(await c.confirm(),false);assert.equal(saves,0);
 c.setField('occurredLocal','2026-11-07T12:30');c.setField('payerId',memberId);c.setField('splitIds',[memberId]);
 assert.equal(await c.review(),true);assert.equal(saves,0);assert.equal(await c.confirm(),true);assert.equal(saves,1);c.destroy();
});
test('independent trip selection loads that trip members and refuses discarding an unsaved form',async()=>{
 const c=await ready({getLedger:async(id:string)=>({...ledger,tripId:id,members:id===otherId?[{id:'other-member',alias:'동행자',active:true,role:'editor'}]:ledger.members})});
 assert.equal(await c.selectTrip(otherId),true);assert.equal(c.state.ledger.members[0].id,'other-member');
 c.setMessage('원문');assert.equal(await c.selectTrip(tripId),false);assert.equal(c.state.message,'원문');
 await c.cancel();assert.equal(await c.selectTrip(tripId),true);c.destroy();
});
test('late account/channel-ledger revision responses are discarded; polls preserve edited form',async()=>{
 for(const changed of [{...context,accountId:'other'},{...context,ledger:{...ledger,revision:2}}]) {
  let release:(value:unknown)=>void=()=>assert.fail('not pending');
  const c=await ready({prepareKakaoDraft:()=>new Promise(resolve=>{release=resolve;})});c.setMessage('원문');
  const pending=c.prepare();await turn();c.updateContext(changed);release(draft);assert.equal(await pending,false);assert.equal(c.state.draft,null);c.destroy();
 }
 const c=await ready();await filled(c);c.updateContext({...context,ledger:{...ledger}});assert.equal(c.state.fields.payerId,memberId);assert.equal(c.state.message,'점심 300바트');c.destroy();
});
test('unrelated app trip changes preserve draft, review and pending confirmation retry',async()=>{
 for(const phase of ['draft','review','retry']) {
  const operations:string[]=[];
  const c=await ready({confirmKakao:async(_token:string,operation:string)=>{operations.push(operation);if(operations.length===1)throw new TypeError('network');return {tripRevision:2};}});
  await filled(c);c.setField('title','직접 입력한 점심');
  if(phase!=='draft')await c.review();
  if(phase==='retry')assert.equal(await c.confirm(),false);
  const before={draft:c.state.draft,fields:{...c.state.fields},message:c.state.message,confirmation:c.state.confirmation,operationId:c.state.operationId};
  c.updateContext({...context,tripId:otherId,ledger:{...ledger,tripId:otherId,revision:9}});
  assert.equal(c.state.status.tripId,tripId);assert.equal(c.state.draft,before.draft);assert.deepEqual(c.state.fields,before.fields);
  assert.equal(c.state.message,before.message);assert.equal(c.state.confirmation,before.confirmation);assert.equal(c.state.operationId,before.operationId);
  assert.equal(await c.selectTrip(otherId),false);
  if(phase==='retry'){assert.equal(await c.confirm(),true);assert.equal(operations[0],operations[1]);}
  c.destroy();
 }
});
test('an unrelated app trip switch preserves in-flight draft response and confirmation result',async()=>{
 let release:(value:unknown)=>void=()=>assert.fail('not pending');
 const c=await ready({prepareKakaoDraft:()=>new Promise(resolve=>{release=resolve;})});
 c.setMessage('점심 300바트');const pending=c.prepare();await turn();
 c.updateContext({...context,tripId:otherId,ledger:{...ledger,tripId:otherId}});release(draft);
 assert.equal(await pending,true);assert.equal(c.state.draft.id,draft.id);c.destroy();
 let releaseSave:(value:unknown)=>void=()=>assert.fail('save not pending'),saved=0;
 const saving=await ready({confirmKakao:()=>new Promise(resolve=>{releaseSave=resolve;})},{onSaved:()=>{saved++;}});
 await filled(saving);await saving.review();const confirmation=saving.confirm();await turn();
 const operationId=saving.state.operationId;
 saving.updateContext({...context,tripId:otherId,ledger:{...ledger,tripId:otherId}});
 assert.equal(saving.state.operationId,operationId);releaseSave({tripRevision:2});
 assert.equal(await confirmation,true);assert.equal(saved,1);assert.equal(saving.state.draft,null);saving.destroy();
});
test('failed confirmation retry retains operation even when successful remote write changed revision',async()=>{
 const operations:string[]=[];let revision=1,saved=0;
 const c=await ready({getLedger:async()=>({...ledger,revision}),confirmKakao:async(_token:string,operation:string)=>{operations.push(operation);if(operations.length===1){revision=2;throw new TypeError('network');}return {tripRevision:2,replayed:true};}},{onSaved:(account:string,id:string,rev:number)=>{assert.equal(account,'account');assert.equal(id,tripId);assert.equal(rev,2);saved++;}});
 await filled(c);await c.review();assert.equal(await c.confirm(),false);
 c.updateContext({...context,ledger:{...ledger,revision:2}});
 assert.equal(await c.confirm(),true);assert.equal(operations.length,2);assert.equal(operations[0],operations[1]);assert.equal(saved,1);c.destroy();
});
test('permission loss and current authentication failure block confirmation',async()=>{
 let role='editor',unauthorized=0,calls=0;
 const c=await ready({getLedger:async()=>({...ledger,role}),confirmKakao:async()=>{calls++;throw {code:'unauthenticated',status:401};}},{onUnauthorized:()=>{unauthorized++;}});
 await filled(c);await c.review();role='viewer';assert.equal(await c.confirm(),false);assert.equal(calls,0);
 c.destroy();const fresh=await ready({confirmKakao:async()=>{throw {code:'unauthenticated',status:401};}},{onUnauthorized:()=>{unauthorized++;}});
 await filled(fresh);await fresh.review();assert.equal(await fresh.confirm(),false);assert.equal(unauthorized,2);fresh.destroy();
});
test('editing reviewed fields revokes local confirmation and destroy ignores pending work',async()=>{
 const c=await ready();await filled(c);await c.review();c.setField('title','수정');assert.equal(c.state.confirmation,null);assert.equal(await c.confirm(),false);c.destroy();assert.equal(await c.prepare(),false);
});
test('refreshing available trips preserves dirty input, reviewed content and ambiguous save retry',async()=>{
 for(const phase of ['draft','review','retry']) {
  let trips=status.trips,revision=1;const operations:string[]=[];
  const c=await ready({kakaoStatus:async()=>({...status,trips}),getLedger:async()=>({...ledger,revision}),
   confirmKakao:async(_token:string,operation:string)=>{operations.push(operation);if(operations.length===1){revision=2;throw new TypeError('network');}return {tripRevision:2,replayed:true};}});
  await filled(c);c.setField('title','사용자가 수정한 점심');
  if(phase!=='draft')await c.review();
  if(phase==='retry')assert.equal(await c.confirm(),false);
  const before={draft:c.state.draft,fields:{...c.state.fields},confirmation:c.state.confirmation,operationId:c.state.operationId,message:c.state.message};
  trips=[...trips,{id:'10000000-0000-4000-8000-000000000003',name:'새로 참여한 여행'}];
  assert.equal(await c.refresh(),true);assert.equal(c.state.status.trips.length,3);assert.equal(c.state.status.tripId,tripId);
  assert.equal(c.state.draft,before.draft);assert.deepEqual(c.state.fields,before.fields);assert.equal(c.state.message,before.message);
  assert.equal(c.state.confirmation,before.confirmation);assert.equal(c.state.operationId,before.operationId);
  if(phase==='retry'){assert.equal(await c.confirm(),true);assert.equal(operations[0],operations[1]);}
  c.destroy();
 }
});
function dom() {
 const nodes=new Map<string,any>();const doc:any={activeElement:null,createElement:(tag:string)=>node(tag)};
 function node(tag:string):any{return {tagName:tag,ownerDocument:doc,children:[],textContent:'',value:'',hidden:false,disabled:false,checked:false,attrs:{},dataset:{},listeners:{},
 append(...values:any[]){this.children.push(...values);},replaceChildren(...values:any[]){this.children=values;},setAttribute(k:string,v:string){this.attrs[k]=v;},addEventListener(k:string,fn:any){this.listeners[k]=fn;},removeEventListener(k:string){delete this.listeners[k];},focus(){doc.activeElement=this;}};}
 const root=node('div');Object.defineProperty(root,'innerHTML',{set(html:string){root.markup=html;for(const id of html.matchAll(/id="([^"]+)"/g))nodes.set(id[1]!,node('div'));}});root.querySelectorAll=()=>[...nodes].map(([id,value])=>Object.assign(value,{id}));return {root,nodes};
}
test('connected screen refreshes newly created trips and disables refresh during the request',async()=>{
 const {mountKakaoLocal}=await import(viewPath);const {root,nodes}=dom();
 let trips:typeof status.trips=[],hold=false,release:(value:unknown)=>void=()=>assert.fail('not pending');
 const m=mountKakaoLocal(root,{api:api({kakaoStatus:async()=>hold?new Promise(resolve=>{release=resolve;}):({...status,tripId:null,trips})})});
 m.updateContext(context);await turn();
 const refresh=nodes.get('kakao-local-refresh');assert.ok(refresh,'visible trip-list refresh control is required');
 assert.match(root.markup,/여행 목록 새로고침/);assert.equal(refresh.disabled,false);assert.equal(nodes.get('kakao-local-trip').children.length,1);
 trips=[{id:tripId,name:'새로 만든 첫 여행'}];hold=true;
 const pending=refresh.listeners.click();await turn();assert.equal(refresh.disabled,true);
 release({...status,tripId:null,trips});await pending;
 assert.equal(refresh.disabled,false);assert.equal(nodes.get('kakao-local-trip').children.length,2);
 assert.equal(nodes.get('kakao-local-trip').children[1].textContent,'새로 만든 첫 여행');
 const select=nodes.get('kakao-local-trip');select.value=tripId;await select.listeners.change();assert.equal(select.value,tripId);
 await nodes.get('kakao-local-unlink').listeners.click();assert.equal(refresh.disabled,true);m.destroy();
});
test('mounted screen labels the synthetic limitation and keeps review token out of rendered text',async()=>{
 const {mountKakaoLocal}=await import(viewPath);const {root,nodes}=dom();
 const m=mountKakaoLocal(root,{api:api()});m.updateContext(context);await turn();
 assert.match(nodes.get('kakao-local-disclaimer').textContent,/일반 단체방/);
 const msg=nodes.get('kakao-local-message');msg.value='점심 300바트';msg.listeners.input();
 await nodes.get('kakao-local-message-form').listeners.submit({preventDefault(){}});await turn();
 assert.equal(nodes.get('kakao-local-payerId').value,'');assert.equal(nodes.get('kakao-local-occurredLocal').value,'');
 assert.equal(nodes.get('kakao-local-confirm').disabled,true);
 assert.doesNotMatch([...nodes.values()].map(n=>n.textContent).join(' '),/secret/);m.destroy();assert.equal(root.children.length,0);
});
