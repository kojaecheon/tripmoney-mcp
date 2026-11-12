import {IdentityError} from '../../core/contracts.js';
import {invalid} from '../../core/ledger/money.js';
import {normalizePlaceRef} from '../../core/places/contracts.js';
import type {PlaceRef,RouteMode,RoutePreview} from '../../core/places/contracts.js';
import type {LedgerService} from '../ledger/contracts.js';
import type {PlaceProvider,PlaceService} from './contracts.js';
import {placeList,refKey,routePreview} from './validation.js';

const unavailable = () => new IdentityError('unavailable','장소를 조회할 수 없습니다. 잠시 뒤 다시 시도해 주세요.');
function references(raw: unknown, minimum = 0, maximum = 60, allowRepeated = false): PlaceRef[] {
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > maximum) return invalid('refs');
  const refs = raw.map(value=>normalizePlaceRef(value));
  if (refs.some(ref=>!ref) || (!allowRepeated && new Set(refs.map(ref=>refKey(ref!))).size !== refs.length)) return invalid('refs');
  return refs as PlaceRef[];
}
export function createPlaceService({ledgerService,provider}: {ledgerService: Pick<LedgerService,'get'>; provider: PlaceProvider}): PlaceService {
  return {
    async search(actor,tripId,raw) {
      await ledgerService.get(actor,tripId);
      if (typeof raw !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(raw) || !raw.trim() || raw.length > 120) return invalid('query');
      let result;
      try {result = placeList(await provider.search(raw.trim()));} catch {throw unavailable();}
      await ledgerService.get(actor,tripId);
      return result;
    },
    async resolve(actor,tripId,raw) {
      await ledgerService.get(actor,tripId);
      const refs = references(raw);
      let result;
      try {result = placeList(await provider.resolve(refs.map(ref=>({...ref}))),refs);} catch {throw unavailable();}
      await ledgerService.get(actor,tripId);
      return result;
    },
    async route(actor,tripId,raw,rawMode) {
      await ledgerService.get(actor,tripId);
      const refs = references(raw,2,20,true);
      if (rawMode !== 'walking' && rawMode !== 'driving') return invalid('mode');
      const mode: RouteMode = rawMode;
      let result: RoutePreview;
      try {result = routePreview(await provider.route(refs.map(ref=>({...ref})),mode),refs,mode);}
      catch {const google=refs.every(ref=>ref.provider==='google');result = {status:'error',source:google?'google':'synthetic',mode,message:google?'Google 경로를 표시할 수 없습니다. 저장된 일정은 유지됩니다.':'체험 경로를 표시할 수 없습니다. 저장된 일정은 유지됩니다.'};}
      await ledgerService.get(actor,tripId);
      return result;
    },
  };
}
