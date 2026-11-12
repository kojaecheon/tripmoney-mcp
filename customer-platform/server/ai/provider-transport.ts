import {randomUUID} from 'node:crypto';
import {IdentityError} from '../../core/contracts.js';
import type {ProviderUsageStore} from '../integration/contracts.js';

/** Server-only configuration. Never build this object from a browser request. */
export type LiveProviderConfig = {
 apiKey:string; allowNetwork?:boolean; fetcher?:typeof fetch; usageStore:ProviderUsageStore;
 usageScope:string; dailyLimit:number; now?:()=>number; requestId?:()=>string; timeoutMs?:number;
};
export const providerUnavailable=()=>new IdentityError('unavailable','외부 제공자를 사용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.');
export const isRecord=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
export const safeText=(v:unknown,max:number,empty=false):v is string=>typeof v==='string'&&(empty||v.trim().length>0)&&v.length<=max&&!/\p{Cc}/u.test(v);
export const validGeminiKey=(value:string):boolean=>/^[A-Za-z0-9._-]{8,256}$/.test(value);
export function configured(config:LiveProviderConfig, provider?:keyof typeof providerHosts):boolean {
 return config.allowNetwork===true&&typeof config.fetcher==='function'&&typeof config.usageStore?.reserve==='function'&&
  typeof config.apiKey==='string'&&(provider==='gemini'?validGeminiKey(config.apiKey):/^[A-Za-z0-9_-]{8,256}$/.test(config.apiKey))&&
  typeof config.usageScope==='string'&&/^[A-Za-z0-9:_-]{1,120}$/.test(config.usageScope)&&
  Number.isSafeInteger(config.dailyLimit)&&config.dailyLimit>=1&&config.dailyLimit<=10000&&
  (config.timeoutMs===undefined||(Number.isSafeInteger(config.timeoutMs)&&config.timeoutMs>=10&&config.timeoutMs<=10000));
}
const providerHosts = {
 google: ['places.googleapis.com', 'routes.googleapis.com'],
 claude: ['api.anthropic.com'],
 gemini: ['generativelanguage.googleapis.com'],
};
/** One reservation, one HTTP attempt, no retries. A deadline includes reservation and streamed reads. */
export async function providerJson(config:LiveProviderConfig,provider:keyof typeof providerHosts,url:string,init:RequestInit):Promise<unknown> {
 if(!configured(config,provider))throw providerUnavailable();
 // Endpoints are fixed by adapters; this second guard prevents accidental credential forwarding.
 const target=new URL(url);
 if(target.protocol!=='https:'||target.username||target.password||target.port||target.hash||
  !providerHosts[provider].includes(target.hostname))throw providerUnavailable();
 const body=init.body;if(body!==undefined&&(typeof body!=='string'||Buffer.byteLength(body)>65536))throw providerUnavailable();
 const controller=new AbortController();let active=true,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{active=false;controller.abort();void reader?.cancel().catch(()=>{});reject(providerUnavailable());},config.timeoutMs??5000);});
 const work=async()=>{
  const now=(config.now??Date.now)(),requestId=(config.requestId??randomUUID)();
  if(!Number.isFinite(now)||!safeText(requestId,200)||!/^[A-Za-z0-9:_-]+$/.test(requestId))throw providerUnavailable();
  const day=new Date(now).toISOString().slice(0,10),expiresAt=Date.parse(day+'T00:00:00Z')+2*86400000;
  const reserved=await config.usageStore.reserve({scope:`${provider}:${config.usageScope}`,requestId,limit:config.dailyLimit,expiresAt});
  if(!active||reserved!==true)throw providerUnavailable();
  const response=await config.fetcher!(url,{...init,signal:controller.signal,redirect:'error',cache:'no-store'});
  if(!active||!response.ok){void response.body?.cancel().catch(()=>{});throw providerUnavailable();}
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>262144)){void response.body?.cancel().catch(()=>{});throw providerUnavailable();}
  if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')){void response.body?.cancel().catch(()=>{});throw providerUnavailable();}
  if(!response.body)throw providerUnavailable();reader=response.body.getReader();
  const chunks:Uint8Array[]=[];let size=0;
  while(active){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>262144)throw providerUnavailable();chunks.push(part.value);}
  if(!active)throw providerUnavailable();
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
 };
 try{return await Promise.race([work(),deadline]);}catch{throw providerUnavailable();}
 finally{active=false;clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});}
}
