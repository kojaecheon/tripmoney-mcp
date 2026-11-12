import { randomBytes } from 'node:crypto';
import { createAuthService, type AuthService } from '../auth/service.js';
import { createIdentityService } from '../identity/service.js';
import type { IdentityService } from '../identity/contracts.js';
import { createLocalTravelRepositories } from './identity-store.js';
import { createLedgerService } from '../ledger/service.js';
import type { LedgerService } from '../ledger/contracts.js';
import { createLocalAuthStore } from './auth-store.js';
import { createLocalAuthProvider } from './auth-provider.js';
import {createPlaceService} from '../places/service.js';
import {createSyntheticPlaceProvider} from '../places/synthetic-provider.js';
import type {PlaceService} from '../places/contracts.js';
import {createDraftService} from '../drafts/service.js';
import {createSyntheticAiProvider} from '../ai/synthetic.js';
import {createRecommendationService} from '../recommendation/service.js';
import {createSyntheticRecommendationProvider} from '../ai/synthetic-recommendation.js';
import {createKakaoLocalService} from '../channels/kakao-local/service.js';
import {createTripChangeNotifier,createTripChangesService,createNotifyingServices} from '../sync/service.js';
export function createLocalRuntime({ now, publicOrigin = 'http://127.0.0.1:8125' }: { now?: () => number; publicOrigin?: string } = {}) {
  const store = createLocalAuthStore({ now });
  const provider = createLocalAuthProvider({ now });
  const authService = createAuthService({ store, provider, kid: 'local', keys: { local: randomBytes(32) }, rateKey: randomBytes(32) });
  const repositories = createLocalTravelRepositories({ assertActor: actor => store.assertActor(actor), now });
  const notifier=createTripChangeNotifier();
  const changesService=createTripChangesService(notifier);
  const {identityService,ledgerService}=createNotifyingServices({notifier,
    identityService:createIdentityService({ repository: repositories.identityRepository, inviteKeys: { local: randomBytes(32) }, activeKid: 'local', publicOrigin }),
    ledgerService:createLedgerService({ repository: repositories.ledgerRepository })});
  const placeService=createPlaceService({ledgerService,provider:createSyntheticPlaceProvider()});
  const draftService=createDraftService({ledgerService,provider:createSyntheticAiProvider(),now:now?()=>new Date(now()):undefined});
  const recommendationService=createRecommendationService({identityService,ledgerService,placeService,provider:createSyntheticRecommendationProvider(),now});
  const kakaoLocalService=createKakaoLocalService({identityService,ledgerService,draftService,now});
  return { authService, identityService, ledgerService, placeService,draftService,recommendationService,kakaoLocalService,changesService,close() { changesService.close();kakaoLocalService.close();recommendationService.close();repositories.close(); store.close(); provider.close(); } };
}
