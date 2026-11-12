import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createCustomerAuthServer} from '../../server/http/server.js';
import {readHttpConfig} from '../../server/http/config.js';
import type {AuthService} from '../../server/auth/service.js';
import {createApi} from '../../web/api.mjs';
const config=readHttpConfig({publicOrigin:'https://preview.example.invalid',clientKey:Buffer.alloc(32,4)});
const maps={mode:'google',browserApiKey:'fixture-browser-key',mapId:'DEMO_MAP_ID'};
async function dispatch(path:string,mapsClient?:unknown) {
 const server=createCustomerAuthServer({config,authService:{} as AuthService,mapsClient} as any);
 const req=Readable.from([]) as any;Object.assign(req,{url:path,method:'GET',headers:{host:config.host},rawHeaders:['Host',config.host]});
 const headers:Record<string,string>={};let statusCode=200;
 const raw=await new Promise<string>((resolve)=>server.emit('request',req,{set statusCode(v){statusCode=v;},get statusCode(){return statusCode;},setHeader(k:string,v:string){headers[k.toLowerCase()]=v;},end(v?:Buffer|string){resolve(Buffer.isBuffer(v)?v.toString():v??'');}}));
 return {raw,headers,statusCode};
}
test('maps client is disabled by default and enabled config exposes only a public browser key',async()=>{
 assert.equal(JSON.parse((await dispatch('/api/customer/public-config')).raw).maps,undefined);
 const result=await dispatch('/api/customer/public-config',{allowNetwork:true,...maps});
 assert.deepEqual(JSON.parse(result.raw).maps,maps);
 const disabled=await dispatch('/api/customer/public-config',{allowNetwork:false,...maps});assert.equal(JSON.parse(disabled.raw).maps,undefined);
});
test('maps-enabled HTML has nonce CSP and serves SDK assets without enabling default external scripts',async()=>{
 const basic=await dispatch('/');assert.ok(!basic.headers['content-security-policy']!.includes('googleapis'));
 const first=await dispatch('/',{allowNetwork:true,...maps}),second=await dispatch('/',{allowNetwork:true,...maps});
 const nonce=first.headers['content-security-policy']!.match(/'nonce-([A-Za-z0-9_-]+)'/)?.[1];assert.ok(nonce);
 assert.ok(first.raw.includes(`nonce="${nonce}"`));assert.match(first.raw,/<style nonce=/);
 assert.notEqual(first.headers['content-security-policy'],second.headers['content-security-policy']);
 assert.match(first.headers['content-security-policy']!,/strict-dynamic/);
 assert.doesNotMatch(first.headers['content-security-policy']!,/unsafe-inline/);
 assert.equal(first.headers['referrer-policy'],'strict-origin-when-cross-origin');
 for(const path of ['/maps/google-map.mjs','/maps/sdk-loader.mjs'])assert.equal((await dispatch(path)).statusCode,200);
});
test('browser config parser preserves valid public maps config and rejects malformed or secret-bearing settings',async()=>{
 const base={mode:'customer',mailDelivery:false};
 const api=(value:unknown)=>createApi(async()=>new Response(JSON.stringify(value)));
 assert.deepEqual(await api({...base,maps}).publicConfig(),{...base,maps});
 for(const patch of [{browserApiKey:''},{mapId:'<script>'},{serverApiKey:'SECRET'},{allowNetwork:true},{mode:'synthetic'}]){
  await assert.rejects(api({...base,maps:{...maps,...patch}}).publicConfig());
 }
});
test('browser place and route API preserves Google display contract and rejects missing or malicious attribution',async()=>{
 const display={expiresAt:new Date(Date.now()+60000).toISOString(),attributions:[{displayName:'시험 자료',uri:'https://example.invalid/source'}]};
 const place={ref:{provider:'google',placeId:'ChIJfixture'},name:'합성 공급자명',address:'합성 주소',source:'google',lat:13,lng:100,display};
 const api=(body:unknown)=>createApi(async()=>new Response(JSON.stringify(body)));
 assert.deepEqual(await api({places:[place]}).resolvePlaces('trip',[place.ref] as any),[place]);
 const route={status:'ok',mode:'walking',source:'google',message:'합성 경로',places:[place,place],path:[{lat:13,lng:100},{lat:13.1,lng:100.1}],display};
 assert.deepEqual(await api({route}).routePlaces('trip',[place.ref,place.ref] as any,'walking'),route);
 const {display:discard,...missing}=place;await assert.rejects(api({places:[missing]}).resolvePlaces('trip',[place.ref] as any));
 await assert.rejects(api({places:[{...place,display:{...display,attributions:[{displayName:'bad',uri:'javascript:alert(1)'}]}}]}).resolvePlaces('trip',[place.ref] as any));
});
