import {createHash} from 'node:crypto';
import {IdentityError} from '../../core/contracts.js';
import {readPrivateState,writePrivateState} from '../config/private-state.js';
export interface LiveMailPermit {consume(email:string):Promise<void>|void;}
const blocked=()=>new IdentityError('unavailable','승인된 메일 발송 범위를 확인해 주세요.');
function permitDocument(recipient:string):string {
 if(recipient.length>254||recipient!==recipient.toLowerCase()||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))throw blocked();
 return JSON.stringify({version:1,scope:'tripmoney-kakao-development-2026-11-08',
  recipientHash:createHash('sha256').update(recipient).digest('hex'),maximumRequests:1});
}
/** Explicit initialization only. Never called by server startup and never replaces a permit. */
export function createLiveMailPermit(file:string,recipient:string):void {writePrivateState(file,permitDocument(recipient));}
export function readLiveMailPermit(file:string,recipient:string):LiveMailPermit {
 const document=permitDocument(recipient);
 if(readPrivateState(file)!==document)throw blocked();
 return {async consume(email){
  if(email!==recipient)throw blocked();
  try {
   if(readPrivateState(file)!==document)throw blocked();
   // O_EXCL is shared across processes and restarts. A failed request still consumes approval.
   writePrivateState(`${file}.spent`,JSON.stringify({version:1,spent:true}));
  } catch {throw blocked();}
 }};
}
