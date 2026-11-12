import type {IncomingMessage} from 'node:http';
import {IdentityError} from '../../core/contracts.js';
import {ledgerId} from '../../core/ledger/normalize.js';
import type {createKakaoService} from '../channels/kakao/service.js';
import type {AuthService} from '../auth/service.js';
import type {HttpConfig} from './config.js';
import {readCookie,cookieNames} from './cookies.js';
import {readJsonBody} from './json-body.js';
import {AccountChanged} from './errors.js';

export type KakaoHttpService=Pick<ReturnType<typeof createKakaoService>,'handleSkill'|'issuePair'|'approvePair'|'unlink'>;
export const isKakaoWebRoute=(method:string|undefined,path:string)=>method==='POST'&&['/api/customer/kakao/pair','/api/customer/kakao/approve','/api/customer/kakao/unlink'].includes(path);
export class SkillBodyLimit extends Error {}
export async function readSkillBody(req:IncomingMessage):Promise<Buffer> {
 const chunks:Buffer[]=[];let size=0;
 for await(const raw of req){const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw);size+=chunk.length;if(size>16384)throw new SkillBodyLimit();chunks.push(chunk);}
 return Buffer.concat(chunks);
}
/** Preserve duplicates rather than letting Node's joined custom headers hide ambiguity. */
export function skillHeaders(req:IncomingMessage):Record<string,string|string[]> {
 const headers:Record<string,string|string[]>=Object.create(null);
 for(let i=0;i<req.rawHeaders.length;i+=2){const name=req.rawHeaders[i]!.toLowerCase(),value=req.rawHeaders[i+1]!;
  const prior=headers[name];headers[name]=prior===undefined?value:Array.isArray(prior)?[...prior,value]:[prior,value];}
 return headers;
}
export async function handleKakaoWeb(req:IncomingMessage,path:string,{config,authService,kakaoService}:{config:HttpConfig;authService:AuthService;kakaoService:KakaoHttpService}) {
 const session=readCookie(req.headers.cookie,cookieNames(config).session);
 if(!session)throw new IdentityError('unauthenticated','다시 로그인해 주세요.');
 const {actor}=await authService.authenticate(session);
 if(req.headers['x-tripmoney-expected-account']!==actor.userId)throw new AccountChanged();
 const field=path.endsWith('/pair')?'tripId':path.endsWith('/approve')?'pendingId':'grantId';
 const body=await readJsonBody(req);
 const fields=field==='pendingId'?['pendingId','tripId']:[field];
 if(Object.keys(body).length!==fields.length||fields.some(key=>!Object.hasOwn(body,key)))throw new IdentityError('validation','입력 형식을 확인해 주세요.');
 const id=ledgerId(body[field] as string,field);
 if(field==='tripId')return kakaoService.issuePair(actor,id);
 if(field==='pendingId')return kakaoService.approvePair(actor,id,ledgerId(body.tripId,'tripId'));
 await kakaoService.unlink(actor,id);return {unlinked:true};
}
