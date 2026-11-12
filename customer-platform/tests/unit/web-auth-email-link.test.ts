import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi,ApiError} from '../../web/api.mjs';
import {createAuthController} from '../../web/auth/controller.mjs';
const config={mode:'customer',mailDelivery:true,authMethod:'email-link'} as const;
const message='로그인을 요청한 브라우저에서 이메일의 로그인 링크를 열어 주세요.';
const json=(body:unknown)=>new Response(JSON.stringify(body));
// Catches rejecting the advertised link flow or accepting an unknown/unsafe auth mode.
test('customer config accepts only the optional email-link authentication method',async()=>{
 assert.deepEqual(await createApi(async()=>json(config)).publicConfig(),config);
 for(const value of [{...config,authMethod:'password'},{...config,authMethod:null},{mode:'local-demo',mailDelivery:false,code:'123456',authMethod:'email-link'}])await assert.rejects(createApi(async()=>json(value)).publicConfig(),e=>e instanceof ApiError&&e.code==='invalid_response');
 assert.deepEqual(await createApi(async()=>json({message})).requestCode('person@example.invalid'),{message});
});
// Catches sending another mail or a fake numeric verification after the user requested a real link.
test('email-link request waits for the same browser and never resends or verifies a numeric code',async()=>{
 let requests=0,verifies=0;
 const c=createAuthController({publicConfig:async()=>config,me:async()=>{throw new ApiError(401,'unauthenticated');},requestCode:async()=>{requests++;return {message};},verifyCode:async()=>{verifies++;throw new Error('not allowed');},logout:async()=>{}});
 await c.bootstrap();c.setEmail('person@example.invalid');assert.equal(await c.requestCode(),true);assert.equal(c.state.phase,'code');assert.equal(c.state.remainingSeconds,0);assert.match(c.state.status,/브라우저.*로그인 링크/);
 c.setCode('123456');assert.equal(c.state.code,'');assert.equal(await c.verifyCode(),false);assert.equal(await c.resendCode(),false);assert.equal(await c.requestCode(),false);assert.equal(requests,1);assert.equal(verifies,0);c.destroy();
});
function dom(){
 const nodes=new Map<string,any>();const doc:any={activeElement:null,body:{},addEventListener(){},removeEventListener(){}};
 function node():any{return {ownerDocument:doc,textContent:'',value:'',hidden:false,disabled:false,attrs:{},listeners:{},setAttribute(k:string,v:string){this.attrs[k]=v;},removeAttribute(k:string){delete this.attrs[k];},addEventListener(k:string,v:any){this.listeners[k]=v;},removeEventListener(k:string){delete this.listeners[k];},focus(){doc.activeElement=this;},contains(){return false;},replaceChildren(){}};}
 const root=node();Object.defineProperty(root,'innerHTML',{set(html:string){for(const id of html.matchAll(/id="([^"]+)"/g))nodes.set(id[1]!,node());}});root.querySelectorAll=()=>[...nodes].map(([id,v])=>Object.assign(v,{id}));return {root,nodes};
}
// Catches showing a six-digit input or resend button for a provider that sent a link.
test('email-link screen asks for the requesting browser and hides numeric verification controls',async()=>{
 const viewPath='../../web/auth/view.mjs';const {renderAuth}=await import(viewPath);const {root,nodes}=dom();
 const actions={setEmail(){},setCode(){},requestCode(){},verifyCode(){},bootstrap(){},changeEmail(){},resendCode(){},checkSession(){},logout(){}};
 const state={phase:'code',config,email:'person@example.invalid',code:'',busy:null,remainingSeconds:0,resendAt:0,status:message,error:null,me:null};
 const view=renderAuth(root,state,actions);assert.equal(nodes.get('code-form').hidden,true);assert.equal(nodes.get('email-link-panel').hidden,false);assert.match(nodes.get('auth-description').textContent,/요청.*같은 브라우저/);assert.equal(nodes.get('link-sent-email').textContent,'person@example.invalid');assert.match(nodes.get('email-link-help').textContent,/자동.*재발송/);assert.equal(nodes.get('resend').disabled,true);view.destroy();
});
