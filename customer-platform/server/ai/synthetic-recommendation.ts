import type {RecommendationProvider} from './recommendation-provider.js';
export function createSyntheticRecommendationProvider(): RecommendationProvider {
 return {source:'synthetic',async generate(context){
  const days=Math.min(20,Math.floor((Date.parse(context.endDate+'T00:00:00Z')-Date.parse(context.startDate+'T00:00:00Z'))/86400000)+1);
  const perDay=context.pace==='relaxed'?1:context.pace==='packed'?3:2,count=days*perDay;
  return {items:Array.from({length:count},(_,index)=>({input:{date:new Date(Date.parse(context.startDate+'T00:00:00Z')+Math.floor(index/perDay)*86400000).toISOString().slice(0,10),startTime:`${String(10+(index%perDay)*3).padStart(2,'0')}:00`,endTime:`${String(11+(index%perDay)*3).padStart(2,'0')}:00`,title:`${context.interests[index%Math.max(1,context.interests.length)]??'가벼운 산책'} 체험 후보`,place:`${context.destination} 예시 장소`,budgetKrw:Math.floor(context.budgetKrw/count),placeRef:{provider:'demo',placeId:index%2===0?'demo-cafe':'demo-park'}},reason:'여행 기간과 선택한 속도에 맞춘 합성 예시입니다. 지도 핀은 체험 카페와 공원의 합성 위치이며 실제 여행지 장소가 아닙니다.'}))};
 }};
}
