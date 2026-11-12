import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IdentityError} from '../../core/contracts.js';
import type {LedgerDTO} from '../../core/ledger/contracts.js';
import type {ChannelContext, ChannelRepository} from '../../server/integration/contracts.js';
import {createKakaoService, type KakaoSkillRequest, type KakaoSkillResponse} from '../../server/channels/kakao/service.js';
const now=Date.parse('2026-11-08T00:00:00Z');
const tripId='11111111-1111-4111-8111-111111111111',payerId='22222222-2222-4222-8222-222222222222',secondId='33333333-3333-4333-8333-333333333333';
const inactiveId='44444444-4444-4444-8444-444444444444',operationId='55555555-5555-4555-8555-555555555555',grantId='66666666-6666-4666-8666-666666666666';
const token='server-issued-review-token-123456789',secret='test-header-secret-with-at-least-32-characters';
const ledger:LedgerDTO={tripId,revision:17,role:'owner',startDate:'2026-11-08',endDate:'2026-11-10',timeZone:'Asia/Seoul',budgetKrw:100000,
 fx:{source:'demo',rateMilli:38600},members:[{id:payerId,tripId,alias:'홍길동',role:'owner',active:true,isMe:true},{id:secondId,tripId,alias:'김여행',role:'editor',active:true,isMe:false},{id:inactiveId,tripId,alias:'퇴장한사람',role:'viewer',active:false,isMe:false}],
 items:[],expenses:[],summary:{allocatedKrw:0,spentKrw:0,remainingKrw:100000,unassignedKrw:100000,byItem:[],byDate:[],byMember:[]},history:[],
 settlement:{mode:'end_of_trip',today:'2026-11-08',dailyTime:'21:00',due:false,days:[],final:{spentKrw:0,balances:[],transfers:[]},snapshots:[],payments:[]}};
function request(utterance:unknown,extra?:Record<string,string>):KakaoSkillRequest {
 return {headers:{'x-tripmoney-skill-secret':secret},rawBody:JSON.stringify({bot:{id:'dev-bot'},userRequest:{user:{id:'bot-user',type:'botUserKey'},utterance},...(extra?{action:{params:{},clientExtra:extra}}:{})})};
}
function fixture() {
 const context:ChannelContext={grantId,tripId,tripName:'서울 여행',expiresAt:new Date(now+1800000).toISOString(),ledger:structuredClone(ledger)};
 const calls:{name:string;args:unknown[]}[]=[],saved=new Map<string,string>();let failure:unknown;let failureAt='context';
 // The external repository owns transactions. Its fake models receipts and records
 // the service boundary so wrong arguments and writes before confirmation are visible.
 const repository:ChannelRepository={
  async issuePair(){throw Error('unexpected web action');},async approvePair(){throw Error('unexpected web action');},async unlink(){throw Error('unexpected web action');},close(){},
  async claimPair(...args){calls.push({name:'claimPair',args});return {pendingId:grantId,expiresAt:new Date(now+300000).toISOString()};},
  async context(...args){calls.push({name:'context',args});if(failure&&failureAt==='context')throw failure;return context;},
  async review(...args){calls.push({name:'review',args});if(failure&&failureAt==='review')throw failure;return {token,operationId,tripId,tripName:context.tripName,command:args[1],expectedRevision:args[2],expiresAt:new Date(now+300000).toISOString()};},
  async confirm(...args){calls.push({name:'confirm',args});assert.equal(args[1],token);assert.equal(args[2],operationId);const replayed=saved.has(args[2]);saved.set(args[2],'receipt');return {value:{targetId:'receipt'},tripRevision:18,replayed};},
 };
 const service=createKakaoService({repository,usageStore:{async reserve(){return true;}},skillSecret:secret,botId:'dev-bot',environment:'development',now:()=>now});
 return {service,context,calls,saved,fail:(value:unknown,stage='context')=>{failure=value;failureAt=stage;}};
}
function bubble(result:{status:number;body:unknown}) {
 assert.equal(result.status,200);const body=result.body as KakaoSkillResponse;
 assert.equal(body.version,'2.0');assert.ok(body.template.outputs.some(o=>'simpleText' in o));return JSON.stringify(body);
}
// Breaks caught: routing utterances to validation, missing member checks, wrong revision,
// early confirmation, ID-only cards, and swallowing the fixed confirmation operation.
test('official pairing utterance claims the explicit code without saving a ledger entry',async()=>{
 const f=fixture();const response=bubble(await f.service.handleSkill(request('연결 0123456789abcdef01234567')));
 assert.deepEqual(f.calls,[{name:'claimPair',args:[{environment:'development',botId:'dev-bot',botUserKey:'bot-user'},'0123456789abcdef01234567']}]);
 assert.match(response,/복사/);assert.equal(f.saved.size,0);
});
test('travel utterance presents the current authorized context',async()=>{
 const f=fixture(),response=bubble(await f.service.handleSkill(request('여행')));
 assert.match(response,/서울 여행/);assert.match(response,/17/);assert.deepEqual(f.calls.map(c=>c.name),['context']);
});
test('expense utterance resolves active aliases and revision, then confirms only the issued operation',async()=>{
 const f=fixture(),result=await f.service.handleSkill(request('경비 2026-11-08 12:00 | 점심 | 12000 KRW | 홍길동 | 전체')),visible=bubble(result);
 assert.deepEqual(f.calls.map(c=>c.name),['context','review']);
 assert.deepEqual(f.calls[1]!.args[1],{type:'expense.create',input:{itineraryId:null,title:'점심',occurredLocal:'2026-11-08T12:00',currency:'KRW',amount:'12000',payerId,splitIds:[payerId,secondId],refreshRate:false}});
 assert.equal(f.calls[1]!.args[2],17);assert.equal(f.saved.size,0);
 for(const value of ['서울 여행','2026-11-08','12000 KRW','결제자: 홍길동','분담자: 홍길동, 김여행'])assert.ok(visible.includes(value),value);
 for(const id of [payerId,secondId,inactiveId])assert.equal(visible.includes(id),false);
 const extra=(result.body as KakaoSkillResponse).template.quickReplies![0]!.extra;assert.deepEqual(extra,{command:'confirm',token,operationId});
 bubble(await f.service.handleSkill(request('확인 후 저장',extra)));
 assert.match(bubble(await f.service.handleSkill(request('확인 후 저장',extra))),/이미 저장/);assert.equal(f.saved.size,1);
});
test('THB decimals and explicit comma separated aliases produce a normalized expense review',async()=>{
 const f=fixture();bubble(await f.service.handleSkill(request('경비 2026-11-08 13:15 | 택시 | 300.50 THB | 김여행 | 김여행, 홍길동')));
 assert.deepEqual(f.calls[1]!.args[1],{type:'expense.create',input:{itineraryId:null,title:'택시',occurredLocal:'2026-11-08T13:15',currency:'THB',amount:'300.50',payerId:secondId,splitIds:[payerId,secondId],refreshRate:false}});
});
test('unknown, inactive and repeated names never issue a review token',async()=>{
 for(const [payer,split] of [['없는사람','전체'],['퇴장한사람','전체'],['홍길동','없는사람'],['홍길동','퇴장한사람'],['홍길동','홍길동, 홍길동'],['홍길동','전체, 홍길동'],['홍길동','홍길동,'],['홍길동','']]){
  const f=fixture(),response=bubble(await f.service.handleSkill(request(`경비 2026-11-08 12:00 | 점심 | 12000 KRW | ${payer} | ${split}`)));
  assert.equal(f.calls.some(c=>c.name==='review'||c.name==='confirm'),false);assert.equal(response.includes('quickReplies'),false);
 }
});
test('duplicate active aliases reject named and whole-group splits safely',async()=>{
 for(const split of ['전체','김여행']){
  const f=fixture();f.context.ledger.members.push({...f.context.ledger.members[0]!,id:inactiveId,active:true});
  bubble(await f.service.handleSkill(request(`경비 2026-11-08 12:00 | 점심 | 12000 KRW | 홍길동 | ${split}`)));
  assert.equal(f.calls.some(c=>c.name==='review'),false);
 }
});
test('malformed utterances and domain invalid values return guidance without review or save',async()=>{
 for(const utterance of [undefined,null,42,'','점심 12000원','연결 bad','경비 2026-11-08 12:00 | 점심 | 12000 KRW | 홍길동',
  '경비 2026-11-08 12:00 | 점심 | 12.5 KRW | 홍길동 | 전체','경비 2026-11-08 12:00 | 점심 | 1.234 THB | 홍길동 | 전체',
  '경비 2026-11-08 12:00 | 점심 | 0 KRW | 홍길동 | 전체','경비 2026-02-30 12:00 | 점심 | 12000 KRW | 홍길동 | 전체',
  '경비 2026-11-08 24:00 | 점심 | 12000 KRW | 홍길동 | 전체','경비 2026-11-08 12:00 | | 12000 KRW | 홍길동 | 전체']){
  const f=fixture(),response=bubble(await f.service.handleSkill(request(utterance)));
  assert.equal(response.includes('quickReplies'),false);assert.equal(f.calls.some(c=>c.name==='review'||c.name==='confirm'),false);
 }
});
test('structured input preserves domain rejection and hides repository details in a normal bubble',async()=>{
 const f=fixture();f.fail(new IdentityError('conflict','SECRET settlement lock'),'review');
 const response=bubble(await f.service.handleSkill(request('경비 2026-11-08 12:00 | 점심 | 12000 KRW | 홍길동 | 전체')));
 assert.match(response,/최신/);assert.equal(response.includes('SECRET'),false);assert.equal(f.saved.size,0);assert.deepEqual(f.calls.map(c=>c.name),['context','review']);
});
test('invalid authentication and malformed bodies keep HTTP rejection for utterance requests',async()=>{
 const f=fixture(),valid=request('여행');
 for(const changed of [{...valid,headers:{}},{...valid,rawBody:'{broken'},{...valid,rawBody:String(valid.rawBody).replace('dev-bot','other-bot')}])assert.ok((await f.service.handleSkill(changed)).status>=400);
 assert.equal(f.calls.length,0);
});

test('official fallback params without command use utterance, while explicit unknown commands stay rejected',async()=>{
 const f=fixture(),base=request('여행'),payload=JSON.parse(String(base.rawBody));
 payload.action={params:{unrelatedSlot:'value'},detailParams:{},clientExtra:null};
 assert.match(bubble(await f.service.handleSkill({...base,rawBody:JSON.stringify(payload)})),/서울 여행/);
 payload.action.params={command:'unknown'};
 assert.equal((await f.service.handleSkill({...base,rawBody:JSON.stringify(payload)})).status,422);
 assert.equal(f.calls.length,1);
});
test('expired context and forbidden review never expose an actionable confirmation',async()=>{
 const f=fixture();f.context.expiresAt=new Date(now).toISOString();
 const expired=bubble(await f.service.handleSkill(request('경비 2026-11-08 12:00 | 점심 | 12000 KRW | 홍길동 | 전체')));
 assert.equal(expired.includes('quickReplies'),false);assert.deepEqual(f.calls.map(c=>c.name),['context']);
 const g=fixture();g.fail(new IdentityError('forbidden','SECRET expired review'),'review');
 const rejected=bubble(await g.service.handleSkill(request('경비 2026-11-08 12:00 | 점심 | 12000 KRW | 홍길동 | 전체')));
 assert.equal(rejected.includes('quickReplies'),false);assert.equal(rejected.includes('SECRET'),false);
});
