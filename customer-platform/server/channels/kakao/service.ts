import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {IdentityError, type Actor, type ErrorCode} from '../../../core/contracts.js';
import {prepareKakaoCallback, type KakaoCallbackOptions, type KakaoCallbackDelivery} from './callback.js';
export type {KakaoCallbackOptions, KakaoCallbackDelivery, KakaoCallbackTransport} from './callback.js';
import {parseStructuredUtterance, structuredExpenseCommand, StructuredInputError} from './structured.js';
import type {MemberDTO} from '../../identity/contracts.js';
import {ledgerId, normalizeLedgerCommand} from '../../../core/ledger/normalize.js';
import type {ChannelCommand, ChannelRepository, ChannelReview, KakaoSender, ProviderUsageStore} from '../../integration/contracts.js';

export type KakaoSkillRequest = {headers:Record<string,string|string[]|undefined>;rawBody:string|Buffer};
export type KakaoSkillResponse = {version:'2.0';template:{outputs:({simpleText:{text:string}}|{basicCard:{title:string;description:string}})[];
 quickReplies?:{label:string;action:'message';messageText:string;extra:Record<string,string>}[]}};
export type KakaoSkillResult = {status:number;body:KakaoSkillResponse|{error:{code:string;message:string}}};
export type KakaoServiceOptions = {repository:ChannelRepository;usageStore:ProviderUsageStore;skillSecret:string;botId:string;
 environment:'development';now?:()=>number;callback?:KakaoCallbackOptions};
const MAX_BODY=16384;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const messages:Record<ErrorCode,string>={unauthenticated:'웹에서 다시 로그인해 주세요.',forbidden:'연결 또는 확인 권한을 확인해 주세요.',
 not_found:'연결한 여행을 확인해 주세요.',conflict:'최신 내용을 확인한 뒤 새 확인 카드를 만들어 주세요.',
 invite_unavailable:'연결 코드를 다시 발급해 주세요.',validation:'입력 형식을 확인해 주세요.',rate_limited:'잠시 후 다시 시도해 주세요.',unavailable:'지금은 요청을 처리할 수 없습니다.'};
const statuses:Record<ErrorCode,number>={unauthenticated:401,forbidden:403,not_found:404,conflict:409,invite_unavailable:410,validation:422,rate_limited:429,unavailable:503};
const fail=(code:ErrorCode):never=>{throw new IdentityError(code,messages[code]);};
function safe(error:unknown):IdentityError {
 if(error instanceof IdentityError&&error.code==='validation'&&error.field==='placeRef')return new IdentityError('validation','지도 장소는 웹 여행 장부에서 선택해 주세요.','placeRef');
 const code=error instanceof IdentityError&&Object.hasOwn(messages,error.code)?error.code:'unavailable';
 return new IdentityError(code,messages[code]);
}
function object(value:unknown):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))return fail('validation');
 return value as Record<string,unknown>;
}
function text(value:unknown,min:number,max:number):string {
 if(typeof value!=='string'||value.length<min||value.length>max||/[\u0000-\u001f\u007f]/u.test(value))return fail('validation');
 return value;
}
function exact(params:Record<string,unknown>,keys:string[]) {
 if(Object.keys(params).some(key=>!keys.includes(key)))fail('validation');
}
function reply(value:string):KakaoSkillResponse {return {version:'2.0',template:{outputs:[{simpleText:{text:value}}]}};}
function card(review:ChannelReview,members?:MemberDTO[]):KakaoSkillResponse {
 const c=review.command;
 const memberName=(id:string)=>members?.find(member=>member.id===id)?.alias??id;
 const details=c.type==='schedule.create'?
  ['일정',`여행: ${review.tripName}`,`제목: ${c.input.title}`,`날짜: ${c.input.date}`,`시간: ${c.input.startTime || '미정'} ~ ${c.input.endTime || '미정'}`,`장소: ${c.input.place || '미정'}`,`예산: ${c.input.budgetKrw}원`]:
  ['경비',`여행: ${review.tripName}`,`제목: ${c.input.title}`,`사용 시각: ${c.input.occurredLocal}`,`금액: ${c.input.amount} ${c.input.currency}`,`결제자: ${memberName(c.input.payerId)}`,`분담자: ${c.input.splitIds.map(memberName).join(', ')}`,`연결 일정 ID: ${c.input.itineraryId || '없음'}`,`환율 갱신: ${c.input.refreshRate?'예':'아니오'}`];
 return {version:'2.0',template:{outputs:[{simpleText:{text:details.join('\n')}},{basicCard:{title:'저장 전 확인',description:`위 내용을 확인해 주세요. 확인 기한: ${review.expiresAt}`}}],
  quickReplies:[{label:'확인 후 저장',action:'message',messageText:'확인 후 저장',extra:{command:'confirm',token:review.token,operationId:review.operationId}}]}};
}

/** Local preparation only. No web Actor is created from a Kakao user key.
 * Development bot identity is server configuration, never a payload assertion.
 * Repository is responsible for session/grant/member checks and atomic receipts.
 */
export function createKakaoService(options:KakaoServiceOptions) {
 const {repository,usageStore,skillSecret,botId,now=Date.now}=options;
 if(options.environment!=='development'||typeof skillSecret!=='string'||skillSecret.length<32||skillSecret.length>512||typeof botId!=='string'||!botId||botId.length>128)fail('unavailable');
 const expectedSecret=createHash('sha256').update(skillSecret).digest();
 function verify(request:KakaoSkillRequest):{sender:KakaoSender;payload:Record<string,unknown>} {
  const secrets=Object.entries(request.headers).filter(([name])=>name.toLowerCase()==='x-tripmoney-skill-secret');
  if(secrets.length!==1||typeof secrets[0]?.[1]!=='string'||secrets[0][1].length>512)fail('forbidden');
  const supplied=createHash('sha256').update(secrets[0]![1] as string).digest();
  if(!timingSafeEqual(expectedSecret,supplied))fail('forbidden');
  if(typeof request.rawBody!=='string'&&!Buffer.isBuffer(request.rawBody))fail('validation');
  if(Buffer.byteLength(request.rawBody)>MAX_BODY)throw new IdentityError('validation','요청 본문이 너무 큽니다.','payloadSize');
  let decoded:unknown;
  try {decoded=JSON.parse(request.rawBody.toString());}catch{fail('validation');}
  const payload=object(decoded),bot=object(payload.bot);
  if((payload.version!==undefined&&payload.version!=='2.0')||bot.id!==botId)fail('forbidden');
  const user=object(object(payload.userRequest).user);
  if(user.type!=='botUserKey')fail('forbidden');
  const botUserKey=text(user.id,1,256);
  return {sender:Object.freeze({environment:'development',botId,botUserKey}),payload};
 }
 async function reserve(sender:KakaoSender) {
  const time=now(),day=new Date(time).toISOString().slice(0,10);
  const scope=`kakao:development:${hash(sender.botId)}:${hash(sender.botUserKey)}:${day}`;
  if(!await usageStore.reserve({scope,requestId:randomUUID(),limit:2000,expiresAt:Date.parse(day+'T00:00:00Z')+86400000}))fail('rate_limited');
 }
 async function web<T>(action:()=>Promise<T>):Promise<T> {try{return await action();}catch(error){throw safe(error);}}
 return {
  issuePair:(actor:Actor,tripId:string)=>web(()=>repository.issuePair(actor,ledgerId(tripId,'tripId'))),
  approvePair:(actor:Actor,pendingId:string,expectedTripId?:string)=>web(()=>expectedTripId===undefined?repository.approvePair(actor,ledgerId(pendingId,'pendingId')):repository.approvePair(actor,ledgerId(pendingId,'pendingId'),ledgerId(expectedTripId,'tripId'))),
  unlink:(actor:Actor,grantId:string)=>web(()=>repository.unlink(actor,ledgerId(grantId,'grantId'))),
  async prepareCallback(request:KakaoSkillRequest):Promise<KakaoCallbackDelivery> {
   const receivedAt=now();
   try {
    const {sender,payload}=verify(request);
    const userRequest=object(payload.userRequest);
    if(userRequest.params!==undefined&&object(userRequest.params).surface==='BuilderBotTest')fail('forbidden');
    await reserve(sender);
    return await prepareKakaoCallback({callbackUrl:object(payload.userRequest).callbackUrl,options:options.callback,usageStore,receivedAt,now});
   } catch(error){throw safe(error);}
  },
  async handleSkill(request:KakaoSkillRequest):Promise<KakaoSkillResult> {
   let utteranceMode=false,clientConfirmation=false;
   try {
    const {sender,payload}=verify(request);
    const action=payload.action===undefined?{}:object(payload.action),params=object(action.params??{});
    const extra=action.clientExtra==null?{}:object(action.clientExtra);
    const input=extra.command==='confirm'?extra:params;
    const command=input.command;
    if(command===undefined) {
     utteranceMode=true;
     const structured=parseStructuredUtterance(object(payload.userRequest).utterance);
     await reserve(sender);
     if(structured.kind==='pair') {
      const pending=await repository.claimPair(sender,structured.code);
      return {status:200,body:reply(`웹에서 같은 계정으로 연결을 승인해 주세요. 아래 연결 요청 ID를 복사해 웹의 연결 승인 칸에 입력해 주세요.\n연결 요청 ID: ${pending.pendingId}\n기한: ${pending.expiresAt}`)};
     }
     const context=await repository.context(sender);
     if(Date.parse(context.expiresAt)<=now()||!Number.isFinite(Date.parse(context.expiresAt)))fail('forbidden');
     if(structured.kind==='context')return {status:200,body:reply(`연결한 여행: ${context.tripName}\n장부 버전: ${context.ledger.revision}\n활성 멤버: ${context.ledger.members.filter(member=>member.active).map(member=>member.alias).join(', ')}\n경비 내용을 검토한 뒤 저장할 수 있습니다.`)};
     const expense=structuredExpenseCommand(structured,context);
     const review=await repository.review(sender,expense,context.ledger.revision);
     if(Date.parse(review.expiresAt)<=now()||!Number.isFinite(Date.parse(review.expiresAt)))fail('forbidden');
     return {status:200,body:card(review,context.ledger.members)};
    }
    let parsed:ChannelCommand|undefined,revision:number|undefined;
    if(command==='pair') {exact(input,['command','code']);text(input.code,6,128);}
    else if(command==='context')exact(input,['command']);
    else if(command==='review') {
     exact(input,['command','input','expectedRevision']);
     let value=input.input;
     if(typeof value==='string'){try{value=JSON.parse(value);}catch{fail('validation');}}
     const normalized=normalizeLedgerCommand(value);
     if(normalized.type!=='schedule.create'&&normalized.type!=='expense.create')return fail('validation');
     // The initial Kakao card cannot verify a provider map reference. Select it
     // in the web map flow instead of silently confirming hidden location data.
     if(normalized.type==='schedule.create'&&normalized.input.placeRef!=null)throw new IdentityError('validation','지도 장소는 웹 여행 장부에서 선택해 주세요.','placeRef');
     parsed=normalized;
     if(typeof input.expectedRevision!=='string'&&typeof input.expectedRevision!=='number')fail('validation');
     if(typeof input.expectedRevision==='string'&&!/^[1-9][0-9]{0,9}$/.test(input.expectedRevision))fail('validation');
     revision=Number(input.expectedRevision);
     if(!Number.isSafeInteger(revision)||revision<1)fail('validation');
    } else if(command==='confirm') {
     exact(input,['command','token','operationId']);text(input.token,32,256);ledgerId(input.operationId,'operationId');
    } else fail('validation');
    await reserve(sender);
    let body:KakaoSkillResponse;
    if(command==='pair') {
     const pending=await repository.claimPair(sender,input.code as string);
     body=reply(`웹에서 같은 계정으로 연결을 승인해 주세요.\n연결 요청 ID: ${pending.pendingId}\n기한: ${pending.expiresAt}`);
    } else if(command==='context') {
     const context=await repository.context(sender);
     if(Date.parse(context.expiresAt)<=now()||!Number.isFinite(Date.parse(context.expiresAt)))fail('forbidden');
     body=reply(`연결한 여행: ${context.tripName}\n장부 버전: ${context.ledger.revision}\n일정 또는 경비 내용을 검토한 뒤 저장할 수 있습니다.`);
    } else if(command==='review') {
     const review=await repository.review(sender,parsed!,revision!);
     if(Date.parse(review.expiresAt)<=now()||!Number.isFinite(Date.parse(review.expiresAt)))fail('forbidden');
     body=card(review);
    } else {
     // Only an authenticated and fully validated official button can receive a
     // normal Kakao bubble for a domain refusal. Legacy JSON retains its status.
     clientConfirmation=extra.command==='confirm';
     const result=await repository.confirm(sender,input.token as string,ledgerId(input.operationId,'operationId'));
     body=reply(result.replayed?'이미 저장한 내용입니다. 같은 요청을 다시 저장하지 않았습니다.':'저장했습니다. 웹 여행 장부에서 확인해 주세요.');
    }
    return {status:200,body};
   } catch(error) {
    const publicError=safe(error);
    if(utteranceMode||(clientConfirmation&&error instanceof IdentityError))return {status:200,body:reply(error instanceof StructuredInputError?error.message:publicError.message)};
    return {status:error instanceof IdentityError&&error.field==='payloadSize'?413:statuses[publicError.code],body:{error:{code:publicError.code,message:publicError.message}}};
   }
  }
 };
}
