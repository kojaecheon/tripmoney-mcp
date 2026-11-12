import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { IdentityError } from '../../core/contracts.js';
import type { AuthService } from '../../server/auth/service.js';
import { readHttpConfig } from '../../server/http/config.js';
const config=readHttpConfig({publicOrigin:'https://tripmoney.example',clientKey:Buffer.alloc(32),mode:'customer',mailDelivery:true});
const challenge=Buffer.alloc(32,1).toString('base64url');const session=Buffer.alloc(32,2).toString('base64url');
const tokens={accessToken:'e30.e30.c3ludGhldGlj',refreshToken:'synthetic_refresh'};
const me={userId:'11111111-1111-4111-8111-111111111111',email:'tester@example.com',expiresAt:new Date(Date.now()+3600000).toISOString()};
function request(body:unknown=tokens,cookie=`__Host-tripmoney_challenge=${challenge}`){const req=Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;req.headers={cookie};return req;}
async function handler(){const module=await import('../../server/http/auth-link-route.js').catch(()=>({handleAuthLinkRoute:undefined}));assert.equal(typeof module.handleAuthLinkRoute,'function');return module.handleAuthLinkRoute!;}
const failure=(code:string)=>(error:unknown)=>error instanceof IdentityError&&error.code===code;
test('링크 HTTP helper는 HttpOnly challenge로 검증하고 기존 secure 쿠키를 반환한다',async()=>{
 const handle=await handler();const authService={verifyEmailLink:async(c:string,t:unknown)=>{assert.equal(c,challenge);assert.deepEqual(t,tokens);return {sessionToken:session,me};}} as AuthService;
 const result=await handle(request(),{config,authService});assert.deepEqual(result.me,me);
 assert.equal(result.cookies.length,2);assert.match(result.cookies[0]!,/^__Host-tripmoney_session=/);assert.match(result.cookies[0]!,/; Path=\/; HttpOnly; SameSite=Lax; Secure$/);assert.match(result.cookies[1]!,/^__Host-tripmoney_challenge=; Max-Age=0;/);
 assert.ok(!JSON.stringify(result.me).includes(tokens.refreshToken));
});
for(const [label,body,cookie,code] of [
 ['누락 challenge',tokens,'','unauthenticated'],['추가 key',{...tokens,userId:'attacker'},undefined,'validation'],
 ['누락 refresh',{accessToken:tokens.accessToken},undefined,'validation'],['과대 body',{accessToken:'x'.repeat(9000),refreshToken:tokens.refreshToken},undefined,'validation'],
] as const)test(`링크 HTTP helper는 ${label}를 provider 전에 거절한다`,async()=>{
 const handle=await handler();let calls=0;const authService={verifyEmailLink:async()=>{calls++;return {sessionToken:session,me};}} as unknown as AuthService;
 await assert.rejects(handle(request(body,cookie),{config,authService}),failure(code));assert.equal(calls,0);
});
