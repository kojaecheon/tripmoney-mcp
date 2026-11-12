import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityError } from '../../core/contracts.js';
import { createAuthProvider } from '../../server/auth/provider.js';
const url='https://agddopryfqsyfshoowgk.supabase.co';
const userId='11111111-1111-4111-8111-111111111111';
const providerSessionId='22222222-2222-4222-8222-222222222222';
const email='tester@example.com';
const jwt=(patch={})=>`e30.${Buffer.from(JSON.stringify({iss:`${url}/auth/v1`,sub:userId,aud:'authenticated',exp:1800001200,session_id:providerSessionId,...patch})).toString('base64url')}.c3ludGhldGlj`;
const user=(patch={})=>({id:userId,email,is_anonymous:false,email_confirmed_at:'2026-10-01T00:00:00Z',...patch});
const config={url,publishableKey:'sb_publishable_unit_only_not_a_real_key',now:()=>1800000000000};
const response=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
const failure=(code:string)=>(error:unknown)=>error instanceof IdentityError&&error.code===code;

test('이메일 링크 요청은 명시한 HTTPS callback만 Supabase redirect_to에 전달한다',async()=>{
 let target='';
 const provider=createAuthProvider({...config,emailRedirectTo:'https://tripmoney.example/auth/callback',fetcher:async(input)=>{target=String(input);return response({});}});
 await provider.requestCode(email);
 assert.equal(new URL(target).searchParams.get('redirect_to'),'https://tripmoney.example/auth/callback');
});
for(const redirect of ['http://tripmoney.example/auth/callback','https://tripmoney.example/elsewhere','https://tripmoney.example/auth/callback?next=x','https://tripmoney.example/auth/callback#x','https://a:b@tripmoney.example/auth/callback','https://tripmoney.example:443/auth/callback']){
 test(`이메일 callback 비정규 형식은 구성 시 거절: ${redirect}`,()=>{
  assert.throws(()=>createAuthProvider({...config,emailRedirectTo:redirect}),failure('unavailable'));
 });
}
test('이메일 링크는 실제 getUser 검증으로 identity와 만료를 결정한다',async()=>{
 const paths:string[]=[];
 const provider=createAuthProvider({...config,fetcher:async(input,init)=>{paths.push(String(input));assert.equal(new Headers(init?.headers).get('Authorization'),`Bearer ${jwt()}`);return response(user());}});
 assert.equal(typeof provider.verifyEmailLink,'function');
 const result=await provider.verifyEmailLink!(email,{accessToken:jwt(),refreshToken:'synthetic_refresh'});
 assert.deepEqual(result,{accessToken:jwt(),refreshToken:'synthetic_refresh',userId,providerSessionId,expiresAt:1800001200});
 assert.deepEqual(paths,[`${url}/auth/v1/user`]);
});
for(const [label,claims,remoteUser] of [
 ['이메일',{},user({email:'other@example.com'})],['issuer',{iss:'https://other.invalid'},user()],
 ['session',{session_id:'bad'},user()],['subject',{sub:'33333333-3333-4333-8333-333333333333'},user()],
 ['만료',{exp:1800000000},user()],['미확인 이메일',{},user({email_confirmed_at:null})],
] as const){test(`이메일 링크 ${label} 불일치는 거절한다`,async()=>{
 const provider=createAuthProvider({...config,fetcher:async()=>response(remoteUser)});
 assert.equal(typeof provider.verifyEmailLink,'function');
 await assert.rejects(provider.verifyEmailLink!(email,{accessToken:jwt(claims),refreshToken:'synthetic_refresh'}),failure('unauthenticated'));
});}
for(const patch of [{refreshToken:'synthetic_refresh\n'},{accessToken:jwt()+'\n'},{refreshToken:''},{refreshToken:undefined},{refreshToken:'a b'},{refreshToken:'a.b'},{refreshToken:'x'.repeat(513)},{accessToken:'x'.repeat(8193)}]){
 test('이메일 링크의 잘못된 토큰은 네트워크 전에 거절한다',async()=>{
  let calls=0;const provider=createAuthProvider({...config,fetcher:async()=>{calls++;return response(user());}});
  assert.equal(typeof provider.verifyEmailLink,'function');
  await assert.rejects(provider.verifyEmailLink!(email,{accessToken:jwt(),refreshToken:'synthetic_refresh',...patch} as never),failure('validation'));
  assert.equal(calls,0);
 });
}
