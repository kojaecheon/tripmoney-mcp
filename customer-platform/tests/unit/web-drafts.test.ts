import assert from 'node:assert/strict';
import test from 'node:test';
const path = '../../web/drafts/controller.mjs';
const viewPath = '../../web/drafts/view.mjs';
const draft = {tripId:'trip',baseRevision:4,kind:'expense',fields:{title:'점심',currency:'THB',amount:'300'},missing:['payerId','splitIds'],source:'synthetic',warnings:['합성 체험']};
const context = {accountId:'account',tripId:'trip',ledger:{tripId:'trip',revision:4,role:'editor'},day:'2026-11-07'};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
test('message survives same-trip polls, generation failures and refused form application', async () => {
 const {createDraftController} = await import(path);
 let fail = false, applies = 0;
 const c = createDraftController({api:{generateDraft:async () => {if(fail)throw new Error('provider failure');return draft;}},onApply:() => {applies++;return false;}});
 c.updateContext(context); c.setMessage('점심 300바트');
 c.updateContext({...context,ledger:{...context.ledger}});
 assert.equal(c.state.message,'점심 300바트'); assert.equal(await c.generate(),true);
 assert.equal(c.apply(),false); assert.equal(applies,1); assert.equal(c.state.message,'점심 300바트');
 fail = true; assert.equal(await c.generate(),false); assert.equal(c.state.message,'점심 300바트');
 c.destroy();
});
test('account, trip and revision changes discard late responses and disable stale application', async () => {
 const {createDraftController} = await import(path);
 for (const changed of [{...context,accountId:'other'}, {...context,tripId:'other',ledger:{...context.ledger,tripId:'other'}}, {...context,ledger:{...context.ledger,revision:5}}]) {
  let release: (value: unknown) => void = () => assert.fail('not pending');
  const c = createDraftController({api:{generateDraft:() => new Promise(resolve => {release=resolve;})},onApply:() => assert.fail('stale draft applied')});
  c.updateContext(context);c.setMessage('원문');const pending = c.generate();await turn();c.updateContext(changed);release(draft);
  assert.equal(await pending,false);assert.equal(c.state.draft,null);assert.equal(c.apply(),false);
  assert.equal(c.state.message,changed.accountId !== context.accountId || changed.tripId !== context.tripId ? '' : '원문');c.destroy();
 }
});
test('viewer cannot generate or apply and current auth errors notify parent without erasing text', async () => {
 const {createDraftController} = await import(path);let unauthorized = 0;
 const c = createDraftController({api:{generateDraft:async () => {throw {status:401,code:'unauthenticated'};}},onUnauthorized:() => {unauthorized++;},onApply:() => assert.fail('viewer applied')});
 c.updateContext({...context,ledger:{...context.ledger,role:'viewer'}});c.setMessage('점심 300바트');assert.equal(await c.generate(),false);assert.equal(c.apply(),false);
 c.updateContext(context);c.setMessage('원문');assert.equal(await c.generate(),false);assert.equal(unauthorized,1);assert.equal(c.state.message,'원문');c.destroy();
});
test('editing message invalidates an in-flight response and destroy prevents further work', async () => {
 const {createDraftController} = await import(path);let release: (value: unknown) => void = () => assert.fail('not pending');
 const c = createDraftController({api:{generateDraft:() => new Promise(resolve => {release=resolve;})},onApply:()=>true});
 c.updateContext(context);c.setMessage('원문');const pending = c.generate();await turn();c.setMessage('새 원문');release(draft);assert.equal(await pending,false);assert.equal(c.state.draft,null);
 c.destroy();assert.equal(await c.generate(),false);assert.equal(c.apply(),false);
});
function dom() {
 const nodes = new Map<string,any>();
 const doc:any = {createElement:(tag:string) => node(tag),activeElement:null,body:{}};
 function node(tag:string):any {return {tagName:tag,ownerDocument:doc,children:[],textContent:'',value:'',hidden:false,disabled:false,attrs:{},listeners:{},
  append(...values:any[]) {this.children.push(...values);},replaceChildren(...values:any[]) {this.children=values;},
  setAttribute(key:string,value:string) {this.attrs[key]=value;},addEventListener(key:string,fn:any) {this.listeners[key]=fn;},removeEventListener(key:string) {delete this.listeners[key];},focus(){doc.activeElement=this;}};}
 const root=node('div');
 Object.defineProperty(root,'innerHTML',{set(html:string){for(const id of html.matchAll(/id="([^"]+)"/g))nodes.set(id[1]!,node('div'));}});
 root.querySelectorAll=()=>[...nodes].map(([id,value])=>Object.assign(value,{id}));
 return {root,nodes};
}
test('mounted draft view renders plain text, labelled input, status and supported examples', async () => {
 const {mountDrafts} = await import(viewPath);const {root,nodes}=dom();let applied=0;
 const m=mountDrafts(root,{api:{generateDraft:async()=>({...draft,fields:{title:'<img onerror=alert(1)>'}})},onApply:()=>{applied++;return true;}});
 m.updateContext(context);
 const input=nodes.get('draft-message'); input.value='점심 300바트';input.listeners.input();
 await nodes.get('draft-form').listeners.submit({preventDefault(){}});await turn();
 assert.match(nodes.get('draft-preview').textContent,/<img onerror=alert\(1\)>/);
 assert.equal(nodes.get('draft-apply').disabled,false);nodes.get('draft-apply').listeners.click();assert.equal(applied,1);
 assert.match(nodes.get('draft-status').textContent,/폼/);assert.equal(input.value,'점심 300바트');
 m.destroy();assert.equal(root.children.length,0);
});
