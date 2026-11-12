import type {IncomingMessage} from 'node:http';
import {IdentityError} from '../../core/contracts.js';
import {ledgerId} from '../../core/ledger/normalize.js';
import type {RecommendationRequest} from '../../core/recommendation/contracts.js';
import type {AuthService} from '../auth/service.js';
import type {KakaoLocalService} from '../channels/kakao-local/contracts.js';
import type {RecommendationService} from '../recommendation/contracts.js';
import type {HttpConfig} from './config.js';
import {cookieNames,readCookie} from './cookies.js';
import {AccountChanged} from './errors.js';
import {readJsonBody} from './json-body.js';

export type Phase2Services={recommendationService?:RecommendationService;kakaoLocalService?:KakaoLocalService};
export type Phase2Route={area:'recommendation';action:'generate'|'adopt';tripId:string;draftId?:string}|
  {area:'kakao';action:'status'|'pair'|'connect'|'unlink'|'trip'|'prepare'|'review'|'confirm'|'cancel';draftId?:string};
export function matchPhase2Route(method:string|undefined,path:string,services:Phase2Services):Phase2Route|undefined {
  if(services.recommendationService&&method==='POST') {
    const m=/^\/api\/customer\/trips\/([^/]+)\/recommendations(?:\/([^/]+)\/adopt)?$/.exec(path);
    if(m)return {area:'recommendation',action:m[2]?'adopt':'generate',tripId:m[1]!,draftId:m[2]};
  }
  if(!services.kakaoLocalService)return;
  if(method==='GET'&&path==='/api/customer/kakao-local')return {area:'kakao',action:'status'};
  if(method!=='POST')return;
  const m=/^\/api\/customer\/kakao-local\/(pair|connect|unlink|trip|drafts|confirm|cancel)$/.exec(path);
  if(m)return {area:'kakao',action:m[1]==='drafts'?'prepare':m[1] as 'pair'|'connect'|'unlink'|'trip'|'confirm'|'cancel'};
  const review=/^\/api\/customer\/kakao-local\/drafts\/([^/]+)\/review$/.exec(path);
  if(review)return {area:'kakao',action:'review',draftId:review[1]};
}
function exact(body:Record<string,unknown>,keys:string[]) {
  if(Object.keys(body).length!==keys.length||keys.some(key=>!Object.hasOwn(body,key)))throw new IdentityError('validation','입력 형식을 확인해 주세요.');
}
export async function handlePhase2Route(req:IncomingMessage,route:Phase2Route,options:Phase2Services&{config:HttpConfig;authService:AuthService}) {
  const session=readCookie(req.headers.cookie,cookieNames(options.config).session);
  if(!session)throw new IdentityError('unauthenticated','다시 로그인해 주세요.');
  const {actor}=await options.authService.authenticate(session);
  const account=req.headers['x-tripmoney-expected-account'];
  if(account!==undefined&&account!==actor.userId)throw new AccountChanged();
  if(route.area==='kakao'&&route.action==='status')return {status:await options.kakaoLocalService!.status(actor)};
  const body=await readJsonBody(req);
  if(route.area==='recommendation') {
    const service=options.recommendationService!,tripId=ledgerId(route.tripId,'tripId');
    if(route.action==='generate') {
      exact(body,['interests','pace','expectedRevision']);
      const input={interests:body.interests,pace:body.pace} as RecommendationRequest;
      return {recommendation:await service.generate(actor,tripId,input,body.expectedRevision as number)};
    }
    exact(body,['selectedIds','operationId']);
    return service.adopt(actor,tripId,ledgerId(route.draftId,'draftId'),body.selectedIds as string[],ledgerId(body.operationId,'operationId'));
  }
  const service=options.kakaoLocalService!;
  switch(route.action) {
    case 'pair':exact(body,[]);return {pair:await service.issuePair(actor)};
    case 'connect':exact(body,['code']);return {status:await service.connect(actor,body.code as string)};
    case 'unlink':exact(body,[]);return {status:await service.unlink(actor)};
    case 'trip':exact(body,['tripId']);return {status:await service.selectTrip(actor,ledgerId(body.tripId,'tripId'))};
    case 'prepare':exact(body,['message']);return {draft:await service.prepare(actor,body.message as string)};
    case 'review':exact(body,['input']);return {confirmation:await service.review(actor,ledgerId(route.draftId,'draftId'),body.input)};
    case 'confirm':exact(body,['token','operationId']);return service.confirm(actor,body.token as string,ledgerId(body.operationId,'operationId'));
    case 'cancel':exact(body,['draftId']);await service.cancel(actor,ledgerId(body.draftId,'draftId'));return {status:await service.status(actor)};
  }
}
