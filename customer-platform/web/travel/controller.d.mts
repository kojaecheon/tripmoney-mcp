import type { IdentityApi } from '../api.mjs';
import type { TripInput } from '../../core/contracts.js';
import type { TripDTO, MemberDTO, InviteDTO, InviteInspection, TripSettings } from '../../server/identity/contracts.js';
export interface TravelState {
 accountId: string|null; trips: TripDTO[]; selectedTripId:string|null; trip:TripDTO|null; members:MemberDTO[]; invites:InviteDTO[];
 canManage:boolean; writesBlocked:boolean; createOpen:boolean; createDraft:TripInput; settingsDraft:Partial<TripSettings>;
 invite:InviteInspection|null; inviteNotice:string; alias:string; inviteRole:'editor'|'viewer'; busy:string|null;
 error:{code:string;message:string;field?:string;scope?:string;reason?:'alias_taken'|'member_limit'}|null; status:string; conflict:{latestChecked:boolean;revision?:number;reason?:'alias_taken'|'member_limit'}|null; pendingKind:string|null;
 confirmMemberId:string|null; shareOpen:boolean; shareStatus:string;
}
export interface TravelController {
 readonly state:TravelState;
 subscribe(listener:(state:TravelState)=>void):()=>void;
 setAccount(accountId:string|null):Promise<boolean>; setInviteToken(token:string|null):Promise<boolean>; recheckAccount():Promise<boolean>; refresh():Promise<boolean>; selectTrip(id:string):Promise<boolean>;
 showCreate():void; setCreateField(field:string,value:string|number):void; setSettingsField(field:string,value:string|number):void;
 saveTrip():Promise<boolean>; saveSettings():Promise<boolean>; setInviteRole(role:string):void; issueInvite():Promise<boolean>;
 manageMember(id:string,role:'editor'|'viewer',active?:boolean):Promise<boolean>; confirmRemove(id:string|null):void; removeMember(id:string):Promise<boolean>;
 revokeInvite(id:string):Promise<boolean>; getInviteLink(id:string):Promise<boolean>; fillShare(textarea:{value:string}):void;
 copyLink(clipboard?:{writeText(value:string):Promise<void>}):Promise<boolean>; closeShare():void;
 setAlias(alias:string):void; acceptInvite():Promise<boolean>; refreshConflict():Promise<boolean>; reapply():Promise<boolean>;
 retryPending():Promise<boolean>; discardPending():void; destroy():void;
}
export function createTravelController(api:IdentityApi,options?:{onUnauthorized?:()=>void;makeOperationId?:()=>string}):TravelController;
export function readInviteFragment(location:{hash:string;pathname:string;search:string},history:{replaceState(data:unknown,unused:string,url?:string|URL|null):void}):string|null;

export function defaultTripDraft(now?:Date):TripInput;
