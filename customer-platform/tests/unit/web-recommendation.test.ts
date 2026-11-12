import assert from 'node:assert/strict';
import test from 'node:test';
const path='../../web/recommendation/controller.mjs',viewPath='../../web/recommendation/view.mjs';
const context={accountId:'account',tripId:'trip',ledger:{tripId:'trip',revision:4,role:'editor'},day:'2026-11-07'};
const draft={id:'draft',tripId:'trip',baseRevision:4,source:'synthetic',expiresAt:'2099-01-01T00:00:00Z',warnings:['합성 체험'],items:[{id:'one',input:{date:'2026-11-07',title:'<img onerror=alert(1)>',place:'예시',budgetKrw:1000,startTime:'10:00',endTime:'11:00'},reason:'이유',placeStatus:'unverified'}]};
const turn=()=>new Promise<void>(r=>setImmediate(r));
test('requires explicit selection and preserves inputs, selection and operation ID after failed save',async()=>{
 const {createRecommendationController}=await import(path);let fail=true;const calls:any[]=[];const saved:any[]=[];
 const c=createRecommendationController({api:{generateRecommendation:async()=>draft,adoptRecommendation:async(...args:any[])=>{calls.push(args);if(fail)throw Error('network');return {tripRevision:5};}},onSaved:(...args:any[])=>saved.push(args)});
 c.updateContext(context);c.setInterests('산책, 미술');c.setPace('relaxed');assert.equal(await c.generate(),true);assert.equal(await c.save(),false);c.toggle('one',true);assert.equal(await c.save(),false);
 c.updateContext({...context,ledger:{...context.ledger}});assert.equal(c.state.interests,'산책, 미술');assert.deepEqual(c.state.selectedIds,['one']);fail=false;assert.equal(await c.save(),true);assert.equal(calls[0][3],calls[1][3]);assert.deepEqual(calls[1].slice(0,3),['trip','draft',['one']]);assert.deepEqual(saved,[['account','trip',5]]);c.destroy();
});
test('rejects late generation and save responses after identity, trip, revision or role changes',async()=>{
 const {createRecommendationController}=await import(path);
 for(const changed of [{...context,accountId:'other'},{...context,tripId:'other'},{...context,ledger:{...context.ledger,revision:5}},{...context,ledger:{...context.ledger,role:'viewer'}}]){
  let release:any;const c=createRecommendationController({api:{generateRecommendation:()=>new Promise(r=>release=r)},onSaved:()=>assert.fail('stale saved')});c.updateContext(context);const pending=c.generate();await turn();c.updateContext(changed);release(draft);assert.equal(await pending,false);assert.equal(c.state.draft,null);c.destroy();
 }
 let release:any,saved=0;const c=createRecommendationController({api:{generateRecommendation:async()=>draft,adoptRecommendation:()=>new Promise(r=>release=r)},onSaved:()=>saved++});c.updateContext(context);await c.generate();c.toggle('one',true);const saving=c.save();await turn();c.updateContext({...context,accountId:'other'});release({tripRevision:5});assert.equal(await saving,false);assert.equal(saved,0);c.destroy();
});
test('viewer, invalid preference, unauthenticated and editing while pending are handled',async()=>{
 const {createRecommendationController}=await import(path);let calls=0,unauthorized=0;
 const c=createRecommendationController({api:{generateRecommendation:async()=>{calls++;throw {code:'unauthenticated',status:401};}},onUnauthorized:()=>unauthorized++});c.updateContext({...context,ledger:{...context.ledger,role:'viewer'}});assert.equal(await c.generate(),false);c.updateContext(context);c.setInterests('1,2,3,4,5,6');assert.equal(await c.generate(),false);assert.equal(calls,0);c.setInterests('산책');assert.equal(await c.generate(),false);assert.equal(unauthorized,1);assert.equal(c.state.interests,'산책');c.destroy();
});
function dom(){const nodes=new Map<string,any>();const doc:any={createElement:(tag:string)=>node(tag)};function node(tag:string):any{return {tagName:tag,ownerDocument:doc,children:[],textContent:'',value:'',hidden:false,disabled:false,checked:false,listeners:{},attrs:{},append(...v:any[]){this.children.push(...v);},replaceChildren(...v:any[]){this.children=v;},setAttribute(k:string,v:string){this.attrs[k]=v;},addEventListener(k:string,f:any){this.listeners[k]=f;},removeEventListener(k:string){delete this.listeners[k];},focus(){}};}const root=node('div');Object.defineProperty(root,'innerHTML',{set(html:string){for(const id of html.matchAll(/id="([^"]+)"/g))nodes.set(id[1]!,node('div'));}});root.querySelectorAll=()=>[...nodes].map(([id,v])=>Object.assign(v,{id}));return{root,nodes};}
test('view displays dates budgets reasons place status and unselected safe text candidates',async()=>{
 const {mountRecommendation}=await import(viewPath),{root,nodes}=dom();const m=mountRecommendation(root,{api:{generateRecommendation:async()=>draft}});m.updateContext(context);await nodes.get('recommendation-form').listeners.submit({preventDefault(){}});
 const card=nodes.get('recommendation-items').children[0];assert.equal(card.children[0].checked,false);const texts=card.children.map((v:any)=>v.textContent).join(' ');assert.match(texts,/<img onerror/);assert.match(texts,/2026-11-07/);assert.match(texts,/1,000/);assert.match(texts,/이유/);assert.match(texts,/미확인/);assert.equal(nodes.get('recommendation-save').disabled,true);const checkbox=card.children[0];checkbox.checked=true;checkbox.listeners.change();assert.equal(nodes.get('recommendation-items').children[0].children[0],checkbox);assert.equal(nodes.get('recommendation-save').disabled,false);m.destroy();assert.equal(root.children.length,0);
});
test('lost commit response can be confirmed with original operation after revision polling',async()=>{
 const {createRecommendationController}=await import(path);const calls:any[]=[];const saved:any[]=[];
 const c=createRecommendationController({api:{generateRecommendation:async()=>draft,adoptRecommendation:async(...args:any[])=>{calls.push(args);if(calls.length===1)throw Error('response lost after commit');return {tripRevision:5,replayed:true};}},onSaved:(...args:any[])=>saved.push(args)});
 c.updateContext(context);await c.generate();c.toggle('one',true);assert.equal(await c.save(),false);c.updateContext({...context,ledger:{...context.ledger,revision:5}});assert.equal(await c.save(),true);assert.deepEqual(calls[1],calls[0]);assert.deepEqual(saved,[['account','trip',5]]);c.destroy();
});
test('unknown save result blocks preference changes, generation and selection replacement',async()=>{
 const {createRecommendationController}=await import(path);let generated=0;const calls:any[]=[];
 const c=createRecommendationController({api:{generateRecommendation:async()=>{generated++;return draft;},adoptRecommendation:async(...args:any[])=>{calls.push(args);throw Error('offline');}}});
 c.updateContext(context);c.setInterests('산책');c.setPace('relaxed');await c.generate();c.toggle('one',true);await c.save();
 c.setInterests('미술');c.setPace('packed');c.toggle('one',false);assert.equal(await c.generate(),false);assert.equal(generated,1);assert.equal(c.state.draft,draft);assert.equal(c.state.interests,'산책');assert.equal(c.state.pace,'relaxed');assert.deepEqual(c.state.selectedIds,['one']);assert.equal(c.state.selectionLocked,true);
 await c.save();assert.deepEqual(calls[1],calls[0]);c.destroy();
});
test('definitive rejection unlocks regeneration while unknown HTTP errors preserve original request',async()=>{
 const {createRecommendationController}=await import(path);
 for(const error of [{status:409,code:'conflict'},{status:422,code:'validation'}]){
  let generated=0;const c=createRecommendationController({api:{generateRecommendation:async()=>{generated++;return draft;},adoptRecommendation:async()=>{throw error;}}});c.updateContext(context);await c.generate();c.toggle('one',true);await c.save();assert.equal(c.state.selectionLocked,false);assert.equal(await c.save(),false);assert.match(c.state.error,/다시 생성/);assert.equal(await c.generate(),true);assert.equal(generated,2);c.destroy();
 }
 const c=createRecommendationController({api:{generateRecommendation:async()=>draft,adoptRecommendation:async()=>{throw {status:503,code:'unavailable'};}}});c.updateContext(context);await c.generate();c.toggle('one',true);await c.save();assert.equal(c.state.selectionLocked,true);assert.equal(await c.generate(),false);c.destroy();
});
test('pending receipt verification stays blocked for another account, trip or viewer',async()=>{
 const {createRecommendationController}=await import(path);
 for(const changed of [{...context,accountId:'other'},{...context,tripId:'other',ledger:{...context.ledger,tripId:'other'}},{...context,ledger:{...context.ledger,role:'viewer',revision:5}}]){
  let calls=0;const c=createRecommendationController({api:{generateRecommendation:async()=>draft,adoptRecommendation:async()=>{calls++;throw Error('offline');}}});c.updateContext(context);await c.generate();c.toggle('one',true);await c.save();c.updateContext(changed);assert.equal(await c.save(),false);assert.equal(calls,1);c.destroy();
 }
});
test('view offers receipt verification after revision poll and locks draft replacement until definitive result',async()=>{
 const {mountRecommendation}=await import(viewPath),{root,nodes}=dom();const calls:any[]=[];let reject=true;
 const m=mountRecommendation(root,{api:{generateRecommendation:async()=>draft,adoptRecommendation:async(...args:any[])=>{calls.push(args);if(reject)throw Error('offline');return {tripRevision:5,replayed:true};}}});m.updateContext(context);await nodes.get('recommendation-form').listeners.submit({preventDefault(){}});const checkbox=nodes.get('recommendation-items').children[0].children[0];checkbox.checked=true;checkbox.listeners.change();await nodes.get('recommendation-save').listeners.click();m.updateContext({...context,ledger:{...context.ledger,revision:5}});
 assert.equal(nodes.get('recommendation-interests').disabled,true);assert.equal(nodes.get('recommendation-pace').disabled,true);assert.equal(nodes.get('recommendation-generate').disabled,true);assert.equal(checkbox.disabled,true);assert.equal(nodes.get('recommendation-save').disabled,false);assert.match(nodes.get('recommendation-save').textContent,/확인/);assert.match(nodes.get('recommendation-status').textContent,/확인/);reject=false;await nodes.get('recommendation-save').listeners.click();assert.deepEqual(calls[1],calls[0]);m.destroy();
});
test('revision poll during save discards late response but retains receipt verification request',async()=>{
 const {createRecommendationController}=await import(path);const calls:any[]=[];let release:any,saved=0;
 const c=createRecommendationController({api:{generateRecommendation:async()=>draft,adoptRecommendation:(...args:any[])=>{calls.push(args);if(calls.length===1)return new Promise(r=>release=r);return Promise.resolve({tripRevision:5,replayed:true});}},onSaved:()=>saved++});c.updateContext(context);await c.generate();c.toggle('one',true);const pending=c.save();await turn();c.updateContext({...context,ledger:{...context.ledger,revision:5}});release({tripRevision:5});assert.equal(await pending,false);assert.equal(saved,0);assert.equal(await c.save(),true);assert.equal(saved,1);assert.deepEqual(calls[1],calls[0]);c.destroy();
});
test('expired unknown request reaches server expiry decision before regeneration unlocks',async()=>{
 const {createRecommendationController}=await import(path);let calls=0;const ownDraft=structuredClone(draft);
 const c=createRecommendationController({api:{generateRecommendation:async()=>ownDraft,adoptRecommendation:async()=>{calls++;if(calls===1)throw Error('offline');throw {status:409,code:'conflict'};}}});c.updateContext(context);await c.generate();c.toggle('one',true);await c.save();ownDraft.expiresAt='2000-01-01T00:00:00Z';assert.equal(await c.save(),false);assert.equal(calls,2);assert.equal(c.state.selectionLocked,false);assert.match(c.state.status,/최신/);c.destroy();
});
test('late pending save responses cannot cross revoked permission or trip context',async()=>{
 const {createRecommendationController}=await import(path);
 for(const changed of [{...context,ledger:{...context.ledger,role:'viewer',revision:5}},{...context,tripId:'other',ledger:{...context.ledger,tripId:'other'}}]){
  let release:any,saved=0;const c=createRecommendationController({api:{generateRecommendation:async()=>draft,adoptRecommendation:()=>new Promise(r=>release=r)},onSaved:()=>saved++});c.updateContext(context);await c.generate();c.toggle('one',true);const pending=c.save();await turn();c.updateContext(changed);release({tripRevision:5});assert.equal(await pending,false);assert.equal(saved,0);assert.equal(await c.save(),false);c.destroy();
 }
});
