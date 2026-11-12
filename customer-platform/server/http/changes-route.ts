import type {IncomingMessage} from 'node:http';
import {IdentityError} from '../../core/contracts.js';
import {ledgerId} from '../../core/ledger/normalize.js';
import type {AuthService} from '../auth/service.js';
import type {IdentityService} from '../identity/contracts.js';
import type {TripChangesService} from '../sync/service.js';
import type {HttpConfig} from './config.js';
import {cookieNames,readCookie} from './cookies.js';
import {AccountChanged} from './errors.js';
import {readJsonBody} from './json-body.js';

export async function handleChangesRoute(req:IncomingMessage,trip:string,signal:AbortSignal,{config,authService,identityService,changesService}:{
 config:HttpConfig;authService:AuthService;identityService:IdentityService;changesService:TripChangesService;
}){
 const tripId=ledgerId(trip,'tripId');
 const expected=req.headers['x-tripmoney-expected-account'];
 const count=req.rawHeaders.filter((_,index)=>index%2===0&&req.rawHeaders[index]!.toLowerCase()==='x-tripmoney-expected-account').length;
 if(count!==1||typeof expected!=='string'||!expected)throw new IdentityError('validation','입력 형식을 확인해 주세요.');
 const body=await readJsonBody(req);
 if(Object.keys(body).length!==1||!Object.hasOwn(body,'afterRevision')||!Number.isSafeInteger(body.afterRevision)||Number(body.afterRevision)<0)
  throw new IdentityError('validation','입력 형식을 확인해 주세요.');
 const session=readCookie(req.headers.cookie,cookieNames(config).session);
 if(!session)throw new IdentityError('unauthenticated','다시 로그인해 주세요.');
 return changesService.wait({tripId,afterRevision:body.afterRevision as number,signal,readCurrent:async()=>{
  const {actor}=await authService.authenticate(session);
  if(actor.userId!==expected)throw new AccountChanged();
  const current=await identityService.getTrip(actor,tripId);
  return {accountId:actor.userId,revision:current.revision};
 }});
}
