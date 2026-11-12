const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=()=>{throw new Error('Invalid Kakao response');};
const shape=(v,keys)=>{if(!object(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail();};
export function kakaoId(value) {
 if(typeof value!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)||value==='00000000-0000-0000-0000-000000000000')fail();
 return value;
}
function expiry(value,now) {
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value))fail();
 const ms=Date.parse(value);
 if(!Number.isFinite(ms)||ms<=now||new Date(ms).toISOString().replace('.000Z','Z')!==value.replace('.000Z','Z'))fail();
 return value;
}
export function parseKakaoChannels(value) {
 shape(value,['kakao']);shape(value.kakao,['mode','channelUrl','botName']);
 if(value.kakao.mode!=='development'||value.kakao.channelUrl!=='https://pf.kakao.com/_xjvDxeX'||value.kakao.botName!=='TripMoney 개발봇')fail();
 return {kakao:{mode:'development',channelUrl:value.kakao.channelUrl,botName:value.kakao.botName}};
}
export function parseKakaoPair(value,now=Date.now()) {
 shape(value,['code','expiresAt']);if(typeof value.code!=='string'||!/^[0-9a-f]{24}$/.test(value.code))fail();
 return {code:value.code,expiresAt:expiry(value.expiresAt,now)};
}
export function parseKakaoApproval(value,now=Date.now()) {
 shape(value,['grantId','tripId','expiresAt']);
 return {grantId:kakaoId(value.grantId),tripId:kakaoId(value.tripId),expiresAt:expiry(value.expiresAt,now)};
}
export function parseKakaoUnlink(value) {shape(value,['unlinked']);if(value.unlinked!==true)fail();return {unlinked:true};}
