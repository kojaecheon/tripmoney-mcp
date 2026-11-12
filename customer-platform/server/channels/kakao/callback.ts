import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {IdentityError} from '../../../core/contracts.js';
import type {ProviderUsageStore} from '../../integration/contracts.js';
import type {KakaoSkillResponse} from './service.js';

export type KakaoCallbackTransport = (request:{url:string;body:string;headers:Record<string,string>;signal:AbortSignal;redirect:'error'})=>Promise<{status:number;body?:string}>;
export type KakaoCallbackOptions = {allowedHosts:readonly string[];allowExternal?:boolean;transport?:KakaoCallbackTransport;timeoutMs?:number};
export type KakaoCallbackDelivery = {ack:{version:'2.0';useCallback:true};expiresAt:string;send(response:KakaoSkillResponse):Promise<void>};
const denied=():never=>{throw new IdentityError('forbidden','콜백 주소 또는 기한을 확인해 주세요.');};
const unavailable=():never=>{throw new IdentityError('unavailable','지금은 콜백을 처리할 수 없습니다.');};
const invalid=():never=>{throw new IdentityError('validation','콜백 응답 크기와 형식을 확인해 주세요.');};

/** No built-in network client. An explicit allow flag AND injected transport are
 * required. The local acceptance tests inject fixtures only. No Event API.
 * Kakao documentation currently contains both five-minute and one-minute text;
 * preparation uses a conservative 55-second deadline from server receipt.
 */
export async function prepareKakaoCallback({callbackUrl,options,usageStore,receivedAt,now}: {
 callbackUrl:unknown;options:KakaoCallbackOptions|undefined;usageStore:ProviderUsageStore;receivedAt:number;now:()=>number;
}):Promise<KakaoCallbackDelivery> {
 if(!options?.allowExternal||!options.transport)return unavailable();
 if(typeof callbackUrl!=='string'||callbackUrl.length>2048)return denied();
 let url:URL;
 try{url=new URL(callbackUrl);}catch{return denied();}
 const hostname=url.hostname.toLowerCase();
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||hostname.endsWith('.')||
  isIP(hostname)||hostname.startsWith('[')||!hostname.includes('.')||
  !/^[a-z0-9.-]+$/.test(hostname)||hostname.endsWith('.localhost')||hostname.endsWith('.local')||
  !options.allowedHosts.some(host=>host===hostname))return denied();
 const expires=receivedAt+55000;
 if(!Number.isFinite(expires)||now()>=expires)return denied();
 // Reserve before handing out an acknowledgement. URL fingerprint retains its
 // one-use claim beyond the transport deadline, including ambiguous failures.
 const fingerprint=createHash('sha256').update(url.href).digest('hex');
 if(!await usageStore.reserve({scope:`kakao:callback:${fingerprint}`,requestId:fingerprint,limit:1,expiresAt:receivedAt+86400000}))return denied();
 if(now()>=expires)return denied();
 let used=false;
 const timeout=options.timeoutMs===undefined?2000:options.timeoutMs;
 if(!Number.isInteger(timeout)||timeout<1||timeout>5000)return unavailable();
 const transport=options.transport;
 return {
  ack:{version:'2.0',useCallback:true},expiresAt:new Date(expires).toISOString(),
  async send(response) {
   if(used||now()>=expires)return denied();
   used=true;
   let body:string;
   try{body=JSON.stringify(response);}catch{return invalid();}
   if(typeof body!=='string'||Buffer.byteLength(body)>8192||response.version!=='2.0'||!response.template||!Array.isArray(response.template.outputs))return invalid();
   const remaining=expires-now();
   if(remaining<=0)return denied();
   const controller=new AbortController();
   let timer:ReturnType<typeof setTimeout>|undefined;
   try {
    const result=await Promise.race([
     transport({url:url.href,body,headers:{'content-type':'application/json'},signal:controller.signal,redirect:'error'}),
     new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},Math.min(timeout,remaining));}),
    ]);
    if(now()>=expires||!Number.isInteger(result?.status)||result.status<200||result.status>=300||
     typeof result.body!=='string'||Buffer.byteLength(result.body)>4096)return unavailable();
    const receipt:unknown=JSON.parse(result.body);
    if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||(receipt as Record<string,unknown>).status!=='SUCCESS')return unavailable();
   } catch {return unavailable();}
   finally {if(timer)clearTimeout(timer);}
  },
 };
}
