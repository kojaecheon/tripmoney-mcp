import type {Pool} from 'pg';
import {IdentityError} from '../../core/contracts.js';
import {createAuthService} from '../auth/service.js';
import {createAuthStore} from '../auth/store.js';
import {createAuthProvider,type VerifiedAuthProvider} from '../auth/provider.js';
import type {AuthStore} from '../auth/store-contract.js';
import {createIdentityService} from '../identity/service.js';
import type {IdentityRepository} from '../identity/contracts.js';
import {createLedgerService} from '../ledger/service.js';
import type {LedgerRepository} from '../ledger/contracts.js';
import {createPlaceService} from '../places/service.js';
import {createSyntheticPlaceProvider} from '../places/synthetic-provider.js';
import type {PlaceProvider} from '../places/contracts.js';
import {createDraftService} from '../drafts/service.js';
import {createSyntheticAiProvider} from '../ai/synthetic.js';
import type {AiProvider} from '../ai/contracts.js';
import {createRecommendationService} from '../recommendation/service.js';
import {createSyntheticRecommendationProvider} from '../ai/synthetic-recommendation.js';
import type {RecommendationProvider} from '../ai/recommendation-provider.js';
import {createPools} from '../db/pools.js';
import {createPgTravelRepositories} from '../db/travel-repositories.js';
import {createPgChannelRepository,createPgProviderUsageStore} from '../db/integration-repositories.js';
import {createKakaoService} from '../channels/kakao/service.js';
import type {ChannelRepository,ProviderUsageStore} from './contracts.js';
import type {LiveConfig} from './config.js';
import type {LiveMailPermit} from './mail-permit.js';
import {createTripChangeNotifier,createTripChangesService,createNotifyingServices} from '../sync/service.js';

type Dependencies={authStore:AuthStore;authProvider:VerifiedAuthProvider;
 repositories:{identityRepository:IdentityRepository;ledgerRepository:LedgerRepository;close():void};
 channelRepository?:ChannelRepository;usageStore?:ProviderUsageStore;dispose?:()=>Promise<void>};
type Options={mailDeliveryApproved?:boolean;mailRecipient?:string;mailPermit?:LiveMailPermit;emailLinkAuth?:boolean;now?:()=>number;providers?:{
 place:PlaceProvider;ai:AiProvider;recommendation:RecommendationProvider};
 kakao?:{skillSecret:string;botId:string}};
const blocked=()=>new IdentityError('unavailable','외부 연결 승인이 필요합니다.');

/** Composition only. Supplied dependencies can be fully synthetic; no default network. */
export function createPreparedRuntime(config:LiveConfig,deps:Dependencies,options:Options={}) {
 const {now,mailRecipient,mailPermit}=options;
 const mailEnabled=options.mailDeliveryApproved===true&&config.mailDeliveryApproved===true&&!!mailRecipient&&!!mailPermit;
 const provider:VerifiedAuthProvider={...deps.authProvider,
  async requestCode(email){
   if(!mailEnabled||email!==mailRecipient||!mailPermit)throw blocked();
   await mailPermit.consume(email);
   return deps.authProvider.requestCode(email);
  }};
 const authService=createAuthService({store:deps.authStore,provider,kid:config.authKid,keys:config.authKeys,rateKey:config.rateKey});
 const notifier=createTripChangeNotifier(),changesService=createTripChangesService(notifier);
 const {identityService,ledgerService}=createNotifyingServices({notifier,
  identityService:createIdentityService({repository:deps.repositories.identityRepository,inviteKeys:config.inviteKeys,activeKid:config.inviteKid,publicOrigin:config.http.publicOrigin}),
  ledgerService:createLedgerService({repository:deps.repositories.ledgerRepository})});
 const placeService=createPlaceService({ledgerService,provider:options.providers?.place??createSyntheticPlaceProvider()});
 const draftService=createDraftService({ledgerService,provider:options.providers?.ai??createSyntheticAiProvider(),now:now?()=>new Date(now()):undefined});
 const recommendationService=createRecommendationService({identityService,ledgerService,placeService,provider:options.providers?.recommendation??createSyntheticRecommendationProvider(),usageStore:deps.usageStore,now});
 if(options.kakao&&(!deps.channelRepository||!deps.usageStore))throw blocked();
 const kakaoService=options.kakao?createKakaoService({...options.kakao,repository:deps.channelRepository!,usageStore:deps.usageStore!,environment:'development',now}):undefined;
 let closing:Promise<void>|undefined;
 return {authService,identityService,ledgerService,placeService,draftService,recommendationService,kakaoService,changesService,
  httpConfig:{...config.http,...(options.emailLinkAuth?{authMethod:'email-link' as const}:{}),mode:'customer' as const,mailDelivery:mailEnabled},
  close(){return closing??=(async()=>{changesService.close();recommendationService.close();deps.channelRepository?.close();deps.repositories.close();await deps.dispose?.();})();}};
}

/** Future opt-in entry, never executed by start:local. Caller must approve both external
 * connection classes. No SQL installation, admin connection or env-file loading occurs. */
export async function createLiveRuntime(config:LiveConfig,options:Options&{
 databaseApproved?:boolean;authApiApproved?:boolean;fetcher?:typeof fetch;
 poolFactory?:(config:{appUrl:string;authUrl:string})=>Promise<{app:Pool;auth:Pool}>}={}) {
 if(options.databaseApproved!==true||options.authApiApproved!==true)throw new Error('customer_live_connections_not_approved');
 let pools:{app:Pool;auth:Pool}|undefined;
 try {
  pools=await(options.poolFactory??createPools)({appUrl:config.appUrl,authUrl:config.authUrl});
  const result=await pools.app.query(`select
   to_regprocedure('customer_private.travel_load(jsonb)') is not null as travel,
   to_regprocedure('customer_private.channel_load(jsonb,text,uuid)') is not null as channel,
   to_regprocedure('customer_private.provider_usage_reserve(text,text,integer,timestamptz,text)') is not null as usage`);
  // This precise capability check is reconciled with the final SQL before activation.
  if(result.rows[0]?.travel!==true||result.rows[0]?.channel!==true||result.rows[0]?.usage!==true)throw blocked();
  const app=pools.app,auth=pools.auth;
  return createPreparedRuntime(config,{authStore:createAuthStore(auth),
   authProvider:createAuthProvider({url:config.providerUrl,publishableKey:config.publishableKey,emailRedirectTo:`${config.http.publicOrigin}/auth/callback`,fetcher:options.fetcher,now:options.now}),
   repositories:createPgTravelRepositories({pool:app,now:options.now}),
   channelRepository:createPgChannelRepository({pool:app,now:options.now}),usageStore:createPgProviderUsageStore({pool:app,now:options.now}),
   dispose:async()=>{await Promise.allSettled([app.end(),auth.end()]);}},{...options,emailLinkAuth:true});
 } catch {if(pools)await Promise.allSettled([pools.app.end(),pools.auth.end()]);throw new IdentityError('unavailable','연결 준비 상태를 확인해 주세요.');}
}
