import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../web');
const noop=()=>{},view=()=>({destroy:noop});
const panel=()=>({configure:noop,configureGoogle:noop,updateContext:noop,destroy:noop});
const stubs={
 'auth/view.mjs':{renderAuth:(root,state)=>{root.authState=state;return view();}},'travel/view.mjs':{renderTravel:view,focusAfterAction:noop},
 'invites/view.mjs':{renderInvite:view},'ledger/view.mjs':{renderLedger:view},
 'maps/view.mjs':{mountMaps:panel,createGoogleSdkLoader:()=>noop},'drafts/view.mjs':{mountDrafts:panel},
 'recommendation/view.mjs':{mountRecommendation:panel},
};
function dom(){
 const roots=new Map(),events=new Map();let doc;
 const node=()=>({ownerDocument:doc,children:[],textContent:'',value:'',hidden:false,disabled:false,classList:{toggle:noop},
  append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
  setAttribute:noop,removeAttribute:noop,addEventListener:noop,removeEventListener:noop,focus:noop});
 doc={hidden:false,activeElement:null,body:node(),createElement:node,addEventListener:noop,removeEventListener:noop,
  getElementById(id){if(!roots.has(id)){const root=node();let nodes=[];Object.defineProperty(root,'innerHTML',{set(html){root.markup=html;nodes=[...html.matchAll(/id="([^"]+)"/g)].map(match=>Object.assign(node(),{id:match[1]}));}});root.querySelectorAll=()=>nodes;roots.set(id,root);}return roots.get(id);}};
 return {doc,roots,events};
}
async function run(callback=false){
 const {doc,roots,events}=dom(),requested=[],loaded=[],order=[];let bootComplete;const booted=new Promise(resolve=>{bootComplete=resolve;});
 const location={pathname:callback?'/auth/callback':'/',hash:'#access_token=a.b.c&refresh_token=refresh_value',origin:'https://example.invalid',replace(){order.push('redirect');}};
 const context=vm.createContext({URL,URLSearchParams,Response,Request,Headers,Date,JSON,console,setInterval,clearInterval,setTimeout,clearTimeout,queueMicrotask,
  document:doc,BroadcastChannel:undefined,window:{location,history:{replaceState(){order.push('clear');}},addEventListener(type,fn){events.set(type,fn);},removeEventListener:noop},
  fetch:async(url)=>{requested.push(url);if(url==='/api/customer/auth/verify-link'){order.push('exchange');return new Response('{}');}
   if(url==='/api/customer/public-config'){order.push('bootstrap');return new Response(JSON.stringify({mode:'local-demo',mailDelivery:false,code:'123456'}));}
   if(url==='/api/customer/me')return new Response(JSON.stringify({requestId:'fixture',error:{code:'unauthenticated'}}),{status:401});
   throw Error(`unexpected request: ${url}`);
  },
 });
 const modules=new Map();
 function load(filename){
  if(modules.has(filename))return modules.get(filename);
  // Cache the in-flight read before linking can ask for the same URL again.
  // Browser ESM imports share one module and therefore one ApiError class.
  const pending=(async()=>{
  const relative=path.relative(web,filename);loaded.push(relative);
  // These assets are absent from the still-running legacy server's allowlist.
  if(relative.startsWith('kakao/')||relative==='auth/email-link.mjs'&&!callback)throw Error(`legacy asset unavailable: ${relative}`);
  let module;
  if(stubs[relative]){const values=relative==='auth/view.mjs'?{renderAuth:(root,state)=>{root.authState=state;if(state.config)bootComplete();return view();}}:stubs[relative];module=new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context,identifier:filename});}
  else {
   // Keep overlapping API imports deterministic so this fixture also guards
   // its loader's singleton behavior rather than depending on disk timing.
   if(relative==='api.mjs')await new Promise(resolve=>setTimeout(resolve,50));
   module=new vm.SourceTextModule(await readFile(filename,'utf8'),{context,identifier:filename,
   importModuleDynamically:async(specifier,ref)=>{const target=await load(path.resolve(path.dirname(ref.identifier),specifier));if(target.status==='unlinked')await target.link(link);if(target.status==='linked')await target.evaluate();return target;}});
  }
  return module;
  })();
  modules.set(filename,pending);return pending;
 }
 const link=(specifier,ref)=>load(path.resolve(path.dirname(ref.identifier),specifier));
 const app=await load(path.join(web,'app.mjs'));await app.link(link);await app.evaluate();
 assert.equal(loaded.filter(name=>name==='api.mjs').length,1,'the fixture preserves a single API module for concurrent imports');
 if(!callback){let timer;try{await Promise.race([booted,new Promise((_,reject)=>{timer=setTimeout(()=>{const state=roots.get('auth')?.authState;reject(Error('bootstrap incomplete '+JSON.stringify({requested,order,loaded,auth:{phase:state?.phase,busy:state?.busy,errorCode:state?.error?.code,configMode:state?.config?.mode},nodeVersion:process.version,execArgv:process.execArgv})));},5000);})]);}finally{clearTimeout(timer);}}
 if(callback){assert.deepEqual(order,['clear','exchange','redirect']);assert.equal(requested.includes('/api/customer/public-config'),false);}
 else {assert.ok(order.includes('bootstrap'));assert.ok(roots.get('kakao-slot').markup?.includes('카카오 연결 방식 체험'),JSON.stringify(roots.get('auth').authState));assert.equal(loaded.some(p=>p.startsWith('kakao/')||p==='auth/email-link.mjs'),false);}
 events.get('pagehide')?.({persisted:false});
}
await run(false);await run(true);
