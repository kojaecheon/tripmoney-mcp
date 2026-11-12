import {createPhase2Api} from './phase2-api.mjs';
import {parseDisplay} from './maps/validation.mjs';

const messages = Object.freeze({
  account_changed: '로그인한 계정이 바뀌어 요청을 중단했습니다. 로그인 정보를 다시 확인해 주세요.',
  unauthenticated: '인증 정보가 없거나 만료되었습니다. 다시 확인해 주세요.',
  forbidden: '요청을 처리할 수 없습니다. 화면을 새로고침해 주세요.',
  not_found: '요청한 기능을 찾을 수 없습니다.',
  validation: '입력한 내용을 확인해 주세요.',
  rate_limited: '요청 횟수가 많습니다. 잠시 뒤 다시 시도해 주세요.',
  unavailable: '지금은 인증을 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요.',
  invalid_response: '응답을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  conflict: '다른 변경이 먼저 저장되었습니다. 최신 정보를 확인한 뒤 다시 적용해 주세요.',
  invite_unavailable: '사용할 수 없는 초대입니다. 소유자에게 새 초대를 요청해 주세요.',
  network: '서버에 연결하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.',
});
const acceptReasons = Object.freeze({ alias_taken: '이 여행에서 이미 사용하는 별칭입니다. 다른 별칭을 입력해 주세요.', member_limit: '여행 정원 8명이 모두 참여 중입니다. 소유자에게 빈자리를 요청해 주세요.' });
const statuses = { 412: 'account_changed', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 410: 'invite_unavailable', 422: 'validation', 429: 'rate_limited', 503: 'unavailable' };

export class ApiError extends Error {
  constructor(status, code, field, reason) {
    const known = code === 'conflict' && typeof reason === 'string' && Object.hasOwn(acceptReasons, reason) ? reason : undefined;
    super(known ? acceptReasons[known] : messages[code] ?? messages.invalid_response);
    this.reason = known;
    this.name = 'ApiError'; this.status = status; this.code = Object.hasOwn(messages, code) ? code : 'invalid_response';
    this.field = ['email','code','name','destination','startDate','endDate','timeZone','budgetKrw','alias','settlementMode','dailyTime','role','trip','expectedRevision','operationId',
      'title','date','startTime','endTime','place','amount','currency','occurredLocal','itineraryId','payerId','splitIds','refreshRate','rateMilli','source','ids',
      'settlementLocked','toMemberId','amountKrw'].includes(field) ? field : undefined;
  }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Public configuration stays available on the legacy static asset set. Only
// an actual live API operation loads the live request and response module.
function parseKakaoChannels(value) {
  if(!object(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'kakao'))throw new ApiError(0,'invalid_response');
  const k=value.kakao;
  if(!object(k)||Object.keys(k).length!==3||k.mode!=='development'||k.channelUrl!=='https://pf.kakao.com/_xjvDxeX'||k.botName!=='TripMoney 개발봇')throw new ApiError(0,'invalid_response');
  return {kakao:{mode:k.mode,channelUrl:k.channelUrl,botName:k.botName}};
}
export function parsePlaceReference(value) {
  if (value === null) return null;
  if (!object(value) || !['google','demo'].includes(value.provider) || typeof value.placeId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(value.placeId) ||
      Object.keys(value).length !== 2) throw new ApiError(0,'invalid_response');
  return {provider:value.provider,placeId:value.placeId};
}
function parseMe(body) {
  const me = body?.me;
  if (!object(me) || typeof me.userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(me.userId)
    || typeof me.email !== 'string' || me.email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(me.email)
    || typeof me.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(me.expiresAt) || !Number.isFinite(Date.parse(me.expiresAt))) throw new ApiError(0, 'invalid_response');
  return { me: { userId: me.userId, email: me.email, expiresAt: me.expiresAt } };
}

export function createApi(fetchFn = globalThis.fetch) {
  let kakaoLive;
  const liveKakao=()=>kakaoLive??=import('./kakao/api.mjs').then(({createKakaoLiveApi})=>createKakaoLiveApi(call,{ledgerId}));
  async function call(path, method = 'GET', payload, parse, account, signal) {
    let response;
    try {
      response = await fetchFn(`/api/customer/${path}`, {
        method, credentials: 'same-origin', cache: 'no-store', headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-TripMoney-Request': '1' } : { Accept: 'application/json' }), ...(account ? { 'X-TripMoney-Expected-Account': account } : {}) },
        ...(method !== 'GET' ? { body: JSON.stringify(payload) } : {}),
        ...(signal ? {signal} : {}),
      });
    } catch { throw new ApiError(0, 'network'); }
    if (path === 'auth/logout' && response.status === 204) return;
    let body;
    try { body = await response.json(); } catch { throw new ApiError(response.status, 'invalid_response'); }
    if (response.status !== 200) {
      const code = statuses[response.status];
      if (!code || !object(body) || !object(body.error) || body.error.code !== code || typeof body.requestId !== 'string') throw new ApiError(response.status, 'invalid_response');
      throw new ApiError(response.status, code, code === 'validation' ? body.error.field : undefined, path === 'invites/accept' ? body.error.reason : undefined);
    }
    if (path === 'auth/logout' || !object(body)) throw new ApiError(response.status, 'invalid_response');
    try { return parse(body); } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(response.status, 'invalid_response'); }
  }
  return Object.freeze({
    issueKakaoLivePair:async(...args)=>(await liveKakao()).issueKakaoLivePair(...args),
    approveKakaoLivePair:async(...args)=>(await liveKakao()).approveKakaoLivePair(...args),
    unlinkKakaoLive:async(...args)=>(await liveKakao()).unlinkKakaoLive(...args),
    ...createPhase2Api(call,{invalid,parseChange,parseTrip,parseDraft,parsePlaceReference,ledgerId}),
    publicConfig: () => call('public-config', 'GET', undefined, body => {
      const maps=Object.hasOwn(body,'maps')?parseMapsConfig(body.maps):undefined;
      const changes=Object.hasOwn(body,'changes')?parseChangesConfig(body.changes):undefined;
      const channels=Object.hasOwn(body,'channels')?parseKakaoChannels(body.channels):undefined;
      const authMethod=Object.hasOwn(body,'authMethod')?body.authMethod:undefined;
      if(Object.hasOwn(body,'authMethod')&&(body.mode!=='customer'||authMethod!=='email-link')) invalid();
      const extra={...(maps?{maps}:{}),...(changes?{changes}:{}),...(channels?{channels}:{}),...(authMethod?{authMethod}:{})};
      const size=Object.keys(body).length-Object.keys(extra).length;
      if(body.mode==='customer'&&typeof body.mailDelivery==='boolean'&&size===2) return {mode:'customer',mailDelivery:body.mailDelivery,...extra};
      if (body.mode !== 'local-demo' || body.mailDelivery !== false || body.code !== '123456' || size!==3) throw new ApiError(0, 'invalid_response');
      return { mode: 'local-demo', mailDelivery: false, code: '123456',...extra };
    }),
    me: () => call('me', 'GET', undefined, parseMe),
    requestCode: email => call('auth/request-code', 'POST', { email }, body => {
      if (!['로컬 인증번호를 입력해 주세요.','이메일로 받은 인증번호를 입력해 주세요.','로그인을 요청한 브라우저에서 이메일의 로그인 링크를 열어 주세요.'].includes(body.message)) throw new ApiError(0, 'invalid_response');
      return { message: body.message };
    }),
    verifyCode: code => call('auth/verify-code', 'POST', { code }, parseMe),
    logout: () => call('auth/logout', 'POST', {}),
    listTrips: (account) => call('trips', 'GET', undefined, b => list(b.trips, parseTrip), account),
    getTrip: (id, account) => call(path(id), 'GET', undefined, b => parseTrip(b.trip), account),
    createTrip: (input, operationId, account) => call('trips', 'POST', { ...pick(input, inputKeys), operationId }, b => parseChange(b, v => ({ trip: parseTrip(v.trip), ownerMember: parseMember(v.ownerMember) })), account),
    updateTrip: (id, input, expectedRevision, operationId, account) => call(path(id), 'PATCH', { ...pick(input, settingKeys), expectedRevision, operationId }, b => parseChange(b, parseTrip), account),
    listMembers: (id, account) => call(`${path(id)}/members`, 'GET', undefined, b => list(b.members, parseMember), account),
    manageMember: (id, memberId, role, active, expectedRevision, operationId, account) => call(`${path(id)}/members/${encodeURIComponent(memberId)}`, 'PATCH', { role, active, expectedRevision, operationId }, b => parseChange(b, parseMember), account),
    issueInvite: (id, role, expectedRevision, operationId, account) => call(`${path(id)}/invites`, 'POST', { role, expectedRevision, operationId }, b => parseChange(b, parseLink), account),
    listInvites: (id, account) => call(`${path(id)}/invites`, 'GET', undefined, b => list(b.invites, parseInvite), account),
    getInviteLink: (id, inviteId, account) => call(`${path(id)}/invites/${encodeURIComponent(inviteId)}/link`, 'POST', {}, parseLink, account),
    revokeInvite: (id, inviteId, expectedRevision, operationId, account) => call(`${path(id)}/invites/${encodeURIComponent(inviteId)}`, 'DELETE', { expectedRevision, operationId }, b => parseChange(b, parseInvite), account),
    inspectInvite: (token, account) => call('invites/inspect', 'POST', { token }, parseInspection, account),
    acceptInvite: (token, alias, operationId, account) => call('invites/accept', 'POST', { token, alias, operationId }, b => parseChange(b, v => ({ trip: parseTrip(v.trip), member: parseMember(v.member) })), account),
    async waitForChanges(id, afterRevision, account, signal) {
      ledgerId(id);
      ledgerId(account);
      if(!Number.isSafeInteger(afterRevision)||afterRevision<0) invalid();
      return call(`${path(id)}/changes`, 'POST', {afterRevision}, body => {
        if(Object.keys(body).length!==2||body.tripId!==id||!Number.isSafeInteger(body.revision)||body.revision<1||body.revision<afterRevision) invalid();
        return {tripId:id,revision:body.revision};
      }, account, signal);
    },
    getLedger: (id, account) => call(`${path(id)}/ledger`, 'GET', undefined, b => parseLedger(b.ledger, id), account),
    executeLedger: (id, command, expectedRevision, operationId, account) => call(`${path(id)}/ledger/commands`, 'POST',
      {command, expectedRevision, operationId}, b => parseChange(b, v => ({targetId: v.targetId === null ? null : ledgerId(v.targetId)})), account),
    searchPlaces:(id,query,account)=>call(`${path(id)}/places/search`,'POST',{query},b=>parsePlaces(b.places),account),
    resolvePlaces:(id,refs,account)=>call(`${path(id)}/places/resolve`,'POST',{refs},b=>parsePlaces(b.places),account),
    routePlaces:(id,refs,mode,account)=>call(`${path(id)}/places/route`,'POST',{refs,mode},b=>parseRoute(b.route,mode),account),
    generateDraft:(id,message,expectedRevision,account)=>call(`${path(id)}/drafts`,'POST',{message,expectedRevision},b=>parseDraft(b.draft,id,expectedRevision),account),
  });
}

const settingKeys = ['name','destination','startDate','endDate','timeZone','budgetKrw','settlementMode','dailyTime'];
const inputKeys = [...settingKeys, 'alias'];
const path = id => `trips/${encodeURIComponent(id)}`;
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const invalid = () => { throw new ApiError(0, 'invalid_response'); };
function parseChangesConfig(value) {
  if(!object(value)||Object.keys(value).length!==1||value.mode!=='long-poll') invalid();
  return {mode:'long-poll'};
}
function parseMapsConfig(value) {
 if(!object(value)||Object.keys(value).length!==3||value.mode!=='google'||
  typeof value.browserApiKey!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(value.browserApiKey)||
  typeof value.mapId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.mapId))invalid();
 return {mode:'google',browserApiKey:value.browserApiKey,mapId:value.mapId};
}
function boundedText(value,max=500,empty=false) {
  if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||/\p{Cc}/u.test(value)) invalid();
  return value;
}
function parsePlace(value) {
  if(!object(value)) invalid();
  const ref=parsePlaceReference(value.ref);
  if(!ref||value.source!==(ref.provider==='demo'?'synthetic':'google')||
      !Number.isFinite(value.lat)||Math.abs(value.lat)>90||!Number.isFinite(value.lng)||Math.abs(value.lng)>180) invalid();
  return {ref,name:boundedText(value.name,200),address:boundedText(value.address,500,true),lat:value.lat,lng:value.lng,source:value.source,...(value.source==='google'?{display:parseDisplay(value.display)}:{})};
}
function parsePlaces(value) {
  if(!Array.isArray(value)||value.length>60) invalid();
  return value.map(parsePlace);
}
function parseRoute(value,mode) {
  if(!object(value)||value.mode!==mode||!['walking','driving'].includes(mode)||
      !['synthetic','google'].includes(value.source)||!['ok','unsupported','error'].includes(value.status)) invalid();
  const result={status:value.status,source:value.source,mode,message:boundedText(value.message,1000,true)};
  if(value.status!=='ok') return result;
  if(!Array.isArray(value.path)||value.path.length>1000) invalid();
  return {...result,...(value.source==='google'?{display:parseDisplay(value.display)}:{}),places:parsePlaces(value.places),path:value.path.map(point=>{
    if(!object(point)||!Number.isFinite(point.lat)||Math.abs(point.lat)>90||!Number.isFinite(point.lng)||Math.abs(point.lng)>180) invalid();
    return {lat:point.lat,lng:point.lng};
  })};
}
function parseDraft(value,tripId,revision) {
  if(!object(value)||value.tripId!==tripId||value.baseRevision!==revision||!['schedule','expense'].includes(value.kind)||
      !['synthetic','claude'].includes(value.source)||!object(value.fields)) invalid();
  const allowed=value.kind==='schedule'?['date','startTime','endTime','title','place','budgetKrw','placeRef']:
    ['title','itineraryId','occurredLocal','currency','amount','payerId','splitIds','refreshRate'];
  const fields={};
  for(const key of allowed) {
    if(!Object.hasOwn(value.fields,key)) continue;
    const v=value.fields[key];
    if(key==='placeRef') fields[key]=parsePlaceReference(v);
    else if(key==='budgetKrw') {if(!Number.isSafeInteger(v)||v<0) invalid();fields[key]=v;}
    else if(key==='refreshRate') {if(typeof v!=='boolean') invalid();fields[key]=v;}
    else if(key==='splitIds') {if(!Array.isArray(v)||v.length>8) invalid();fields[key]=v.map(ledgerId);}
    else if(key==='itineraryId') fields[key]=v===null?null:ledgerId(v);
    else if(key==='payerId') fields[key]=ledgerId(v);
    else fields[key]=boundedText(v,500,true);
  }
  if(!Array.isArray(value.missing)||value.missing.length>20||!Array.isArray(value.warnings)||value.warnings.length>20) invalid();
  return {tripId,baseRevision:revision,kind:value.kind,fields,source:value.source,
    missing:value.missing.map(v=>boundedText(v,100)),warnings:value.warnings.map(v=>boundedText(v,1000))};
}
function checked(value, strings, numbers = [], booleans = []) {
 if (!object(value) || strings.some(k => typeof value[k] !== 'string') || numbers.some(k => !Number.isSafeInteger(value[k]) || value[k] < 0) || booleans.some(k => typeof value[k] !== 'boolean')) invalid();
 return pick(value, [...strings,...numbers,...booleans]);
}
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const roles = ['owner','editor','viewer'];
function parseTrip(v) { const out = checked(v, ['id','name','destination','startDate','endDate','timeZone','settlementMode','dailyTime','status','createdAt','ownerMemberId','role'], ['budgetKrw','revision','memberCount']); if (!isoDate(out.createdAt) || !roles.includes(out.role) || out.status !== 'active' || !['daily','end_of_trip'].includes(out.settlementMode)) invalid(); return out; }
function parseMember(v) { const out = checked(v,['id','tripId','alias','role'],[],['active','isMe']); if(!roles.includes(out.role)) invalid(); return out; }
function parseInvite(v) { const out = checked(v,['id','role','status','expiresAt']); if(!isoDate(out.expiresAt) || !['editor','viewer'].includes(out.role) || !['pending','accepted','revoked','expired'].includes(out.status)) invalid(); return out; }
function parseLink(v) { if (!object(v) || typeof v.url !== 'string') invalid(); return { invite: parseInvite(v.invite), url: v.url }; }
function parseInspection(v) { if(v.state === 'joined') return { state: 'joined', ...checked(v,['tripId']) }; if(v.state !== 'pending' || !isoDate(v.expiresAt) || !['editor','viewer'].includes(v.role)) invalid(); return { state: 'pending', ...checked(v,['tripName','role','expiresAt']) }; }
function parseChange(v, parse) { if (!object(v) || !Number.isSafeInteger(v.tripRevision) || v.tripRevision < 1 || typeof v.replayed !== 'boolean') invalid(); return { value: parse(v.value), tripRevision: v.tripRevision, replayed: v.replayed }; }
function list(v, parse) { if(!Array.isArray(v)) invalid(); return v.map(parse); }

function ledgerId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ||
    value === '00000000-0000-0000-0000-000000000000') invalid();
  return value;
}
function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || value.startsWith('0000')) invalid();
  const ms = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10) !== value) invalid();
  return ms;
}
const clock = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
function parseRecord(value, strings, numbers, tripId) {
  const row = checked(value, ['id','tripId','status','createdAt','updatedAt','updatedByMemberId',...strings], numbers);
  ledgerId(row.id);
  ledgerId(row.updatedByMemberId);
  if (row.tripId !== tripId || !['active','cancelled'].includes(row.status) || !isoDate(row.createdAt) || !isoDate(row.updatedAt)) invalid();
  return row;
}
function parseSchedule(value, tripId) {
  const row = parseRecord(value, ['date','startTime','endTime','title','place'], ['budgetKrw','order'], tripId);
  calendarDate(row.date);
  if ((row.startTime || row.endTime) && (!clock(row.startTime) || !clock(row.endTime) || row.startTime > row.endTime)) invalid();
  return {...row, ...(Object.hasOwn(value,'placeRef') ? {placeRef:parsePlaceReference(value.placeRef)} : {})};
}
function parseExpense(value, tripId) {
  const row = parseRecord(value, ['title','currency','rateSource','occurredAt','occurredLocal','localDate','timeZone','payerId'],
    ['amountCents','amountKrw','rateMilli'], tripId);
  calendarDate(row.localDate);
  if (!['KRW','THB'].includes(row.currency) || !['unit','manual','demo'].includes(row.rateSource) || !isoDate(row.occurredAt) ||
    !row.occurredLocal.startsWith(row.localDate + 'T') || !clock(row.occurredLocal.slice(11)) || !row.amountCents || !row.amountKrw || !row.rateMilli) invalid();
  ledgerId(row.payerId);
  return {...row, itineraryId: value.itineraryId === null ? null : ledgerId(value.itineraryId),
    splitIds: list(value.splitIds, ledgerId),
    shares: list(value.shares, share => {
      const row = checked(share, ['memberId'], ['amountKrw']);
      ledgerId(row.memberId);
      return row;
    })};
}
function signed(value) {
  if (!Number.isSafeInteger(value)) invalid();
  return value;
}
function parseMemberBalance(member) {
  const row = checked(member, ['memberId'], ['paidKrw','owedKrw']);
  ledgerId(row.memberId);
  return {...row, netKrw: signed(member.netKrw)};
}
function parseSummary(value) {
  const totals = checked(value, [], ['allocatedKrw','spentKrw','unassignedKrw']);
  return {...totals, remainingKrw: signed(value.remainingKrw),
    byItem: list(value.byItem, item => {
      const row = checked(item, ['itineraryId'], ['budgetKrw','spentKrw']);
      ledgerId(row.itineraryId);
      return {...row, remainingKrw: signed(item.remainingKrw)};
    }),
    byDate: list(value.byDate, date => {
      const row = checked(date, ['date'], ['spentKrw']);
      calendarDate(row.date);
      return row;
    }),
    byMember: list(value.byMember, parseMemberBalance)};
}
function parseTransfer(value) {
  const row = checked(value, ['fromMemberId','toMemberId'], ['amountKrw']);
  ledgerId(row.fromMemberId);
  ledgerId(row.toMemberId);
  if (row.fromMemberId === row.toMemberId || !row.amountKrw) invalid();
  return row;
}
function parseSettlementResult(value) {
  return {...checked(value, [], ['spentKrw']), balances: list(value.balances, parseMemberBalance),
    transfers: list(value.transfers, parseTransfer)};
}
function nullableDate(value) {
  if (value !== null) calendarDate(value);
  return value;
}
function nullableTimestamp(value) {
  if (value !== null && !isoDate(value)) invalid();
  return value;
}
const nullableLedgerId = value => value === null ? null : ledgerId(value);
function parseSnapshot(value) {
  const row = checked(value, ['id','createdAt','createdByMemberId'], ['sourceRevision','expenseRevision','confirmedPaymentRevision']);
  ledgerId(row.id);
  ledgerId(row.createdByMemberId);
  if (!isoDate(row.createdAt) || !row.sourceRevision) invalid();
  return {...row, date: nullableDate(value.date), result: parseSettlementResult(value.result),
    reopenedAt: nullableTimestamp(value.reopenedAt), reopenedByMemberId: nullableLedgerId(value.reopenedByMemberId)};
}
function parsePayment(value) {
  const row = checked(value, ['id','status','reportedAt'], ['revision']);
  ledgerId(row.id);
  if (!['reported','confirmed','void_requested','voided'].includes(row.status) || !isoDate(row.reportedAt) || !row.revision) invalid();
  return {...row, ...parseTransfer(value), confirmedAt: nullableTimestamp(value.confirmedAt),
    confirmedDate: nullableDate(value.confirmedDate), voidRequestedByMemberId: nullableLedgerId(value.voidRequestedByMemberId),
    voidRequestedAt: nullableTimestamp(value.voidRequestedAt), voidedAt: nullableTimestamp(value.voidedAt),
    voidedByMemberId: nullableLedgerId(value.voidedByMemberId)};
}
function parseSettlement(value) {
  const row = checked(value, ['mode','today','dailyTime'], [], ['due']);
  calendarDate(row.today);
  if (!['daily','end_of_trip'].includes(row.mode) || !clock(row.dailyTime)) invalid();
  return {...row, final: parseSettlementResult(value.final), snapshots: list(value.snapshots, parseSnapshot),
    payments: list(value.payments, parsePayment), days: list(value.days, value => {
      const day = checked(value, ['date'], ['spentKrw']);
      calendarDate(day.date);
      return {...day, current: parseSettlementResult(value.current)};
    })};
}
function parseLedger(value, tripId) {
  const ledger = checked(value, ['tripId','role','startDate','endDate','timeZone'], ['revision','budgetKrw']);
  const span = calendarDate(ledger.endDate) - calendarDate(ledger.startDate);
  if (ledgerId(ledger.tripId) !== tripId.toLowerCase() || !roles.includes(ledger.role) || !ledger.revision ||
    span < 0 || span >= 14 * 86400000) invalid();
  const fx = checked(value.fx, ['source'], ['rateMilli']);
  if (!['demo','manual'].includes(fx.source) || fx.rateMilli < 1 || fx.rateMilli > 1_000_000_000) invalid();
  return {...ledger, fx, summary: parseSummary(value.summary),
    ...(Object.hasOwn(value, 'settlement') ? {settlement: parseSettlement(value.settlement)} : {}),
    members: list(value.members, member => {
      const row = parseMember(member);
      if (row.tripId !== ledger.tripId) invalid();
      ledgerId(row.id);
      return row;
    }),
    items: list(value.items, item => parseSchedule(item, ledger.tripId)),
    expenses: list(value.expenses, expense => parseExpense(expense, ledger.tripId)),
    history: list(value.history, entry => {
      const row = checked(entry, ['memberId','action','at'], ['revision']);
      ledgerId(row.memberId);
      if (!isoDate(row.at) || !row.revision) invalid();
      return {...row, targetId: entry.targetId === null ? null : ledgerId(entry.targetId)};
    })};
}
