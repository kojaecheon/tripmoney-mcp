import type {Actor} from '../../core/contracts.js';
import type {LedgerChange, LedgerCommand, LedgerDTO} from '../../core/ledger/contracts.js';

/** Internal verified sender. Construct only after skill header and bot checks. */
export type KakaoSender = {environment:'development'; botId:string; botUserKey:string};
export type ChannelCommand = Extract<LedgerCommand,{type:'schedule.create'|'expense.create'}>;
export type ChannelPair = {code:string; expiresAt:string};
export type ChannelClaim = {pendingId:string; expiresAt:string};
export type ChannelContext = {grantId:string; tripId:string; tripName:string; expiresAt:string; ledger:LedgerDTO};
export type ChannelReview = {token:string; operationId:string; tripId:string; tripName:string;
  command:ChannelCommand; expectedRevision:number; expiresAt:string};

/** Every method rechecks authority. confirm validates and writes in ONE DB transaction.
 * This port never accepts a caller-supplied Actor for bot-originated writes. */
export interface ChannelRepository {
  issuePair(actor:Actor,tripId:string):Promise<ChannelPair>;
  claimPair(sender:KakaoSender,code:string):Promise<ChannelClaim>;
  approvePair(actor:Actor,pendingId:string,expectedTripId?:string):Promise<{grantId:string;tripId:string;expiresAt:string}>;
  context(sender:KakaoSender):Promise<ChannelContext>;
  review(sender:KakaoSender,command:ChannelCommand,expectedRevision:number):Promise<ChannelReview>;
  confirm(sender:KakaoSender,token:string,operationId:string):Promise<LedgerChange>;
  unlink(actor:Actor,grantId:string):Promise<void>;
  close():void;
}

/** Server-derived scopes only. Reservations are durable and count ambiguous failures.
 * Reusing a request ID MUST NOT authorize a second provider request. */
export interface ProviderUsageStore {
  reserve(input:{scope:string;requestId:string;limit:number;expiresAt:number;periodKey?:string}):Promise<boolean>;
}
