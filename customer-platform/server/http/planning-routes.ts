import type {IncomingMessage} from 'node:http';
import {IdentityError} from '../../core/contracts.js';
import {ledgerId} from '../../core/ledger/normalize.js';
import type {PlaceRef,RouteMode} from '../../core/places/contracts.js';
import type {AuthService} from '../auth/service.js';
import type {createDraftService} from '../drafts/service.js';
import type {PlaceService} from '../places/contracts.js';
import type {HttpConfig} from './config.js';
import {cookieNames,readCookie} from './cookies.js';
import {AccountChanged} from './errors.js';
import {readJsonBody} from './json-body.js';

export type DraftService = ReturnType<typeof createDraftService>;
export type PlanningRoute = {tripId:string;action:'search'|'resolve'|'route'|'draft'};
export function matchPlanningRoute(method:string|undefined,path:string):PlanningRoute|undefined {
  if(method!=='POST') return;
  const m=/^\/api\/customer\/trips\/([^/]+)\/(places\/(search|resolve|route)|drafts)$/.exec(path);
  if(!m) return;
  return {tripId:m[1]!,action:m[3] ? m[3] as 'search'|'resolve'|'route' : 'draft'};
}
export async function handlePlanningRoute(req:IncomingMessage,route:PlanningRoute,options:{
  config:HttpConfig;authService:AuthService;placeService?:PlaceService;draftService?:DraftService;
}) {
  const session=readCookie(req.headers.cookie,cookieNames(options.config).session);
  if(!session) throw new IdentityError('unauthenticated','다시 로그인해 주세요.');
  const {actor}=await options.authService.authenticate(session);
  const account=req.headers['x-tripmoney-expected-account'];
  if(account!==undefined&&account!==actor.userId) throw new AccountChanged();
  const tripId=ledgerId(route.tripId,'tripId');
  const body=await readJsonBody(req);
  const expected=route.action==='search'?['query']:route.action==='resolve'?['refs']:route.action==='route'?['refs','mode']:['message','expectedRevision'];
  if(Object.keys(body).length!==expected.length||expected.some(key=>!Object.hasOwn(body,key))) {
    throw new IdentityError('validation','입력 형식을 확인해 주세요.');
  }
  if(route.action==='draft'&&options.draftService) {
    return {draft:await options.draftService.extract(actor,tripId,body.message as string,body.expectedRevision as number)};
  }
  if(options.placeService) {
    if(route.action==='search') return {places:await options.placeService.search(actor,tripId,body.query as string)};
    if(route.action==='resolve') return {places:await options.placeService.resolve(actor,tripId,body.refs as PlaceRef[])};
    if(route.action==='route') return {route:await options.placeService.route(actor,tripId,body.refs as PlaceRef[],body.mode as RouteMode)};
  }
  throw new IdentityError('not_found','요청한 기능을 찾을 수 없습니다.');
}
