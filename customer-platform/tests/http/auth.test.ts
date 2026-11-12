import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readHttpConfig } from '../../server/http/config.js';
import { createCustomerAuthServer } from '../../server/http/server.js';
import { createLocalRuntime } from '../../server/local/runtime.js';
import { cookieNames, serializeCookie, readCookie } from '../../server/http/cookies.js';
import type { AuthService } from '../../server/auth/service.js';
const key = randomBytes(32);
const origin = 'http://127.0.0.1:8125';
type Result = {status:number; body:any; raw:string; headers:import('node:http').IncomingHttpHeaders};
async function fixture(service?: AuthService, webRoot?: string) {
  const runtime = createLocalRuntime();
  const server = createCustomerAuthServer({config:readHttpConfig({publicOrigin:origin,clientKey:key}),authService:service ?? runtime.authService,webRoot});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  const send = (path:string, data?:unknown, cookie?:string, extra:Record<string,string>={}, method=data === undefined?'GET':'POST'):Promise<Result> => new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port,path,method,headers:{Host:'127.0.0.1:8125',Origin:origin,'X-TripMoney-Request':'1','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra}},res=>{
      let raw='';res.setEncoding('utf8');res.on('data',chunk=>{raw+=chunk;});res.on('end',()=>resolve({status:res.statusCode!,raw,body:raw?JSON.parse(raw):null,headers:res.headers}));
    });req.on('error',reject);if(data!==undefined) req.write(Buffer.isBuffer(data) || typeof data==='string'?data:JSON.stringify(data));req.end();
  });
  return {server,send,close:async()=>{await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));runtime.close();}};
}
const pair=(r:Result,name:string)=>r.headers['set-cookie']!.find(v=>v.startsWith(`${name}=`))!.split(';')[0]!;
test('real HTTP login exposes only fixed DTOs and cookie jar authenticates and logs out',async()=>{
 const f=await fixture();try{
  const config=await f.send('/api/customer/public-config');assert.deepEqual(config.body,{mode:'local-demo',mailDelivery:false,code:'123456'});
  const start=await f.send('/api/customer/auth/request-code',{email:'traveler@example.invalid'});assert.equal(start.status,200);
  const challenge=pair(start,'tripmoney_challenge_dev');assert.ok(!start.raw.includes(challenge.split('=')[1]!));assert.match(start.headers['set-cookie']![0]!,/Max-Age=600/);
  assert.equal((await f.send('/api/customer/auth/verify-code',{code:'000000'},challenge)).status,401);
  const verified=await f.send('/api/customer/auth/verify-code',{code:'123456'},challenge);assert.equal(verified.status,200);assert.deepEqual(Object.keys(verified.body),['me']);assert.deepEqual(Object.keys(verified.body.me).sort(),['email','expiresAt','userId']);
  const session=pair(verified,'tripmoney_session_dev');assert.ok(!verified.raw.includes(session.split('=')[1]!));assert.match(verified.headers['set-cookie']![0]!,/HttpOnly/);assert.ok(!verified.headers['set-cookie']![0]!.includes('Secure'));
  const me=await f.send('/api/customer/me',undefined,session);assert.equal(me.status,200);assert.deepEqual(me.body,verified.body);
  assert.equal((await f.send('/api/customer/auth/logout',{},session)).status,204);assert.equal((await f.send('/api/customer/me',undefined,session)).status,401);assert.equal((await f.send('/api/customer/auth/logout',{},session)).status,204);
  assert.equal((await f.send('/api/customer/auth/logout',{})).status,204);
 }finally{await f.close();}
});
test('write boundary rejects headers, extra keys, oversize and malformed JSON before auth',async()=>{
 let calls=0;const service={requestCode:async()=>{calls++;return{challengeToken:randomBytes(32).toString('base64url')}}} as unknown as AuthService;
 const f=await fixture(service);try{
  for(const headers of ([{Origin:'https://evil.invalid'},{Host:'localhost:8125'},{'X-TripMoney-Request':'0'},{'Content-Type':'text/plain'}] as Record<string,string>[])) assert.equal((await f.send('/api/customer/auth/request-code',{email:'a@b.invalid'},undefined,headers)).status,403);
  for(const value of [{email:'a@b.invalid',admin:true},[],null,Buffer.from([0xc3,0x28]),'{','{"email":"'+ 'x'.repeat(8200)+'"}']) assert.equal((await f.send('/api/customer/auth/request-code',value)).status,422);
  assert.equal(calls,0);
  assert.equal((await f.send('/api/customer/auth/request-code',{email:'bad'})).status,422);assert.equal(calls,0);
 }finally{await f.close();}
});
test('invalid and duplicate cookies never authenticate; outage messages and headers are fixed',async()=>{
 let calls=0;const service={authenticate:async()=>{calls++;throw new Error('SECRET SQL provider stack')},logout:async()=>{throw new Error('SECRET')}} as unknown as AuthService;
 const f=await fixture(service);const token=randomBytes(32).toString('base64url');try{
  for(const value of [`tripmoney_session_dev=${token}; tripmoney_session_dev=${token}`,'tripmoney_session_dev=broken',`tripmoney_session_dev=${token}=`]) assert.equal((await f.send('/api/customer/me',undefined,value)).status,401);
  assert.equal(calls,0);
  const outage=await f.send('/api/customer/me',undefined,`tripmoney_session_dev=${token}`);assert.equal(outage.status,503);assert.ok(!outage.raw.includes('SECRET'));assert.equal(outage.headers['set-cookie'],undefined);assert.match(outage.body.requestId,/^[0-9a-f-]+$/);
  assert.equal(outage.headers['cache-control'],'no-store');assert.equal(outage.headers['x-content-type-options'],'nosniff');assert.equal(outage.headers['referrer-policy'],'no-referrer');assert.match(String(outage.headers['content-security-policy']),/frame-ancestors 'none'/);
  assert.equal((await f.send('/api/customer/auth/logout',{},`tripmoney_session_dev=${token}`)).status,503);
 }finally{await f.close();}
});
test('strict paths and static allowlist reject traversal, query, symlinks and unsupported methods',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tripmoney-http-'));await mkdir(join(root,'auth'));await writeFile(join(root,'index.html'),'test page');await writeFile(join(root,'secret.txt'),'SECRET');await symlink(join(root,'secret.txt'),join(root,'app.mjs'));
 const f=await fixture(undefined,root);try{
  for(const path of ['/.env','/package.json','/secret.txt','/../secret.txt','/%69ndex.html','/index.html?x=1','/api/customer/me?x=1','/app.mjs']) assert.equal((await f.send(path,undefined,undefined,{},'HEAD')).status,404);
  const head=await f.send('/',undefined,undefined,{},'HEAD');assert.equal(head.status,200);assert.equal(head.raw,'');assert.equal(head.headers['content-type'],'text/html; charset=utf-8');
  assert.equal((await f.send('/api/customer/me',{},undefined,{},'POST')).status,404);
 }finally{await f.close();await rm(root,{recursive:true});}
});
test('HTTPS cookie contract uses host prefix and secure; HTTP exception only exact loopback',()=>{
 const config=readHttpConfig({publicOrigin:'https://example.invalid',clientKey:key});const names=cookieNames(config);assert.equal(names.session,'__Host-tripmoney_session');assert.equal(names.challenge,'__Host-tripmoney_challenge');
 const cookie=serializeCookie(config,'session',randomBytes(32).toString('base64url'),600);assert.match(cookie,/; Secure/);assert.match(cookie,/; HttpOnly/);assert.match(cookie,/; SameSite=Lax/);assert.match(cookie,/; Path=\//);assert.ok(!cookie.includes('Domain'));
 assert.equal(readCookie(`__Host-tripmoney_session=bad`,names.session),undefined);
 for(const publicOrigin of ['http://localhost:8125','http://127.0.0.1.evil.invalid:8125','http://0.0.0.0:8125','http://[::1]:8125','https://example.invalid/path','https://a:b@example.invalid']) assert.throws(()=>readHttpConfig({publicOrigin,clientKey:key}));
});
test('HTTPS handler maps only me fields, caps cookie age and clears challenge without a TLS listener',async()=>{
 const token=randomBytes(32).toString('base64url');const challenge=randomBytes(32).toString('base64url');
 const expiresAt=new Date(Date.now()+172800_000).toISOString();
 const authService={verifyCode:async()=>({sessionToken:token,me:{userId:'local-user',email:'traveler@example.invalid',expiresAt,secret:'NEVER'}})} as unknown as AuthService;
 const server=createCustomerAuthServer({config:readHttpConfig({publicOrigin:'https://example.invalid',clientKey:key}),authService});
 const req=Readable.from([Buffer.from('{"code":"123456"}')]) as unknown as import('node:http').IncomingMessage;
 Object.assign(req,{method:'POST',url:'/api/customer/auth/verify-code',headers:{host:'example.invalid',origin:'https://example.invalid','x-tripmoney-request':'1','content-type':'application/json',cookie:`__Host-tripmoney_challenge=${challenge}`},rawHeaders:['Host','example.invalid','Origin','https://example.invalid','X-TripMoney-Request','1','Content-Type','application/json']});
 const headers:Record<string,unknown>={};let result='';
 await new Promise<void>((resolve,reject)=>{
  const res={statusCode:200,setHeader(name:string,value:unknown){headers[name]=value;},end(value?:string){result=value??'';resolve();}};
  try{server.emit('request',req,res);}catch(error){reject(error);}
 });
 const cookies=headers['Set-Cookie'] as string[];
 assert.match(cookies[0]!,/^__Host-tripmoney_session=/);assert.match(cookies[0]!,/Max-Age=86400/);assert.match(cookies[0]!,/; Secure/);assert.match(cookies[1]!,/^__Host-tripmoney_challenge=; Max-Age=0/);
 assert.deepEqual(JSON.parse(result),{me:{userId:'local-user',email:'traveler@example.invalid',expiresAt}});assert.ok(!result.includes(token));assert.ok(!result.includes(challenge));
});
test('client identifier is a server HMAC of remote address and ignores forwarded headers',async()=>{
 const hashes:string[]=[];const authService={requestCode:async(_email:string,hash:string)=>{hashes.push(hash);return{challengeToken:randomBytes(32).toString('base64url')}}} as unknown as AuthService;
 const f=await fixture(authService);try{
  await f.send('/api/customer/auth/request-code',{email:'a@b.invalid'},undefined,{'X-Forwarded-For':'192.0.2.1'});
  await f.send('/api/customer/auth/request-code',{email:'a@b.invalid'},undefined,{'X-Forwarded-For':'192.0.2.2'});
  assert.equal(hashes.length,2);assert.equal(hashes[0],hashes[1]);assert.match(hashes[0]!,/^[0-9a-f]{64}$/);assert.notEqual(hashes[0],'127.0.0.1');
 }finally{await f.close();}
});
