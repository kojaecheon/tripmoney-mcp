import type {PlaceCandidate,PlaceRef} from '../../core/places/contracts.js';
import type {PlaceProvider} from './contracts.js';
import {refKey} from './validation.js';

const fixtures: PlaceCandidate[] = [
  {ref:{provider:'demo',placeId:'demo-cafe'},name:'체험 카페',address:'합성 장소, 실제 주소 없음',lat:37.56,lng:126.97,source:'synthetic'},
  {ref:{provider:'demo',placeId:'demo-park'},name:'체험 공원',address:'합성 장소, 실제 주소 없음',lat:37.57,lng:126.98,source:'synthetic'},
];
const copy = (row: PlaceCandidate) => ({...row,ref:{...row.ref}});
function resolve(refs: PlaceRef[]) {
  return refs.flatMap(ref=>{const row = fixtures.find(row=>refKey(row.ref)===refKey(ref));return row ? [copy(row)] : [];});
}
export function createSyntheticPlaceProvider(): PlaceProvider {
  return {
    async search(query) {return fixtures.filter(row=>`${row.name} ${row.address}`.includes(query)).map(copy);},
    async resolve(refs) {return resolve(refs);},
    async route(refs,mode) {
      const places = resolve(refs);
      if (places.length !== refs.length) return {status:'unsupported',source:'synthetic',mode,message:'체험 카페와 체험 공원만 합성 경로를 확인할 수 있습니다.'};
      return {status:'ok',source:'synthetic',mode,
        message:'합성 장소를 직선으로 연결한 체험 경로입니다. 실제 도로와 이동 시간은 제공하지 않습니다.',
        places,path:places.map(({lat,lng})=>({lat,lng})),
      };
    },
  };
}
