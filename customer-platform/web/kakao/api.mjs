import {parseKakaoPair,parseKakaoApproval,parseKakaoUnlink} from './validation.mjs';
export function createKakaoLiveApi(call,{ledgerId}) {
 return {
  async issueKakaoLivePair(tripId,account) {ledgerId(tripId);ledgerId(account);return call('kakao/pair','POST',{tripId},parseKakaoPair,account);},
  async approveKakaoLivePair(pendingId,tripId,account) {ledgerId(pendingId);ledgerId(tripId);ledgerId(account);return call('kakao/approve','POST',{pendingId,tripId},parseKakaoApproval,account);},
  async unlinkKakaoLive(grantId,account) {ledgerId(grantId);ledgerId(account);return call('kakao/unlink','POST',{grantId},parseKakaoUnlink,account);},
 };
}
