import test from 'node:test';
import assert from 'node:assert/strict';
async function load(){const module=await import('../../web/auth/email-link.mjs').catch(()=>({completeEmailLink:undefined}));assert.equal(typeof module.completeEmailLink,'function');return module.completeEmailLink!;}
const accessToken='e30.e30.c3ludGhldGlj';const refreshToken='synthetic_refresh';
function browser(hash=`#access_token=${accessToken}&refresh_token=${refreshToken}&token_type=bearer&expires_in=3600`,pathname='/auth/callback'){
 const events:unknown[]=[];
 const location={hash,pathname,search:'?next=https://outside.invalid&email=private',replace:(url:string)=>events.push(['navigate',url])};
 const history={replaceState:(...args:unknown[])=>{events.push(['history',...args]);location.hash='';location.search='';}};
 return {location,history,events};
}
test('callback은 fetch 전에 hash/query를 지우고 동일 origin만 호출한 뒤 루트로 이동한다',async()=>{
 const complete=await load();const b=browser();let body:unknown;
 const result=await complete({...b,fetchFn:async(url:string,init:RequestInit)=>{b.events.push(['fetch',url]);assert.equal(b.location.hash,'');assert.equal(b.location.search,'');body=JSON.parse(String(init.body));assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'error');assert.equal(new Headers(init.headers).get('X-TripMoney-Request'),'1');assert.equal(new Headers(init.headers).get('Content-Type'),'application/json');return new Response('{}');}});
 assert.deepEqual(b.events,[['history',null,'','/auth/callback'],['fetch','/api/customer/auth/verify-link'],['navigate','/']]);
 assert.deepEqual(body,{accessToken,refreshToken});assert.deepEqual(result,{status:'success'});
 assert.ok(!JSON.stringify(result).includes(refreshToken));
});
for(const kind of ['denial','network','missing','duplicate','huge','provider-error'])test(`callback ${kind} 실패는 URL을 지우고 비밀 없는 상태만 반환한다`,async()=>{
 const complete=await load();const b=browser(kind==='missing'?'#access_token=x':kind==='duplicate'?`#access_token=${accessToken}&access_token=other&refresh_token=${refreshToken}`:kind==='huge'?`#access_token=${'x'.repeat(9000)}&refresh_token=${refreshToken}`:kind==='provider-error'?'#error=access_denied&error_description=sensitive':undefined);
 let calls=0;const result=await complete({...b,fetchFn:async(url:string)=>{calls++;assert.equal(url,'/api/customer/auth/verify-link');if(kind==='network')throw Error(refreshToken);return new Response(JSON.stringify({error:{message:refreshToken}}),{status:401});}});
 assert.equal(result.status,'error');assert.equal(b.location.hash,'');assert.equal(b.location.search,'');assert.equal(calls,['denial','network'].includes(kind)?1:0);
 assert.ok(!JSON.stringify(result).includes(refreshToken));assert.equal(b.events.some((e:any)=>e[0]==='navigate'),false);
});
test('일반 페이지는 URL과 fetch를 건드리지 않는다',async()=>{
 const complete=await load();const b=browser('#private','/');assert.deepEqual(await complete({...b,fetchFn:async()=>{throw Error('unexpected');}}),{status:'idle'});assert.deepEqual(b.events,[]);
});


test('callback 성공은 DOM과 브라우저 storage를 읽거나 쓰지 않는다',async(t)=>{
 const names=['document','localStorage','sessionStorage'] as const;
 for(const name of names){const original=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,get(){assert.fail(`unexpected ${name} access`);}});t.after(()=>{if(original)Object.defineProperty(globalThis,name,original);else delete (globalThis as any)[name];});}
 const complete=await load();const b=browser();
 assert.deepEqual(await complete({...b,fetchFn:async()=>new Response('{}')}),{status:'success'});
});
