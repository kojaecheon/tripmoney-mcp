import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IdentityError, type Actor} from '../../core/contracts.js';
import type {ChannelCommand, ChannelRepository, KakaoSender, ProviderUsageStore} from '../../server/integration/contracts.js';
import {createKakaoService, type KakaoSkillRequest} from '../../server/channels/kakao/service.js';

const now = Date.parse('2026-11-08T00:00:00Z');
const tripId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const pendingId = '33333333-3333-4333-8333-333333333333';
const grantId = '44444444-4444-4444-8444-444444444444';
const actor:Actor = {userId:'web-owner',sessionHash:'real-web-session'};
const command:ChannelCommand = {type:'schedule.create',input:{date:'2026-11-08',startTime:'10:00',endTime:'11:00',title:'왕궁 방문',place:'사용자가 입력한 장소',budgetKrw:10000}};
const secret = 'test-header-secret-with-at-least-32-characters';
function request(params:Record<string,unknown>, extra?:Record<string,unknown>):KakaoSkillRequest {
 return {headers:{'x-tripmoney-skill-secret':secret},rawBody:JSON.stringify({version:'2.0',bot:{id:'dev-bot'},userRequest:{user:{id:'bot-user',type:'botUserKey'},utterance:'사용자 발화'},action:{params,...(extra?{clientExtra:extra}:{})}})};
}
function fixture() {
 const calls:{name:string;args:unknown[]}[]=[];
 const usage:{scope:string;requestId:string;limit:number;expiresAt:number}[]=[];
 let error:unknown;
 const record=(name:string,...args:unknown[])=>{calls.push({name,args});if(error)throw error;};
 const repository:ChannelRepository = {
  async issuePair(...args){record('issuePair',...args);return {code:'12345678',expiresAt:new Date(now+300000).toISOString()};},
  async claimPair(...args){record('claimPair',...args);return {pendingId,expiresAt:new Date(now+300000).toISOString()};},
  async approvePair(...args){record('approvePair',...args);return {grantId,tripId,expiresAt:new Date(now+1800000).toISOString()};},
  async context(...args){record('context',...args);return {grantId,tripId,tripName:'서울 여행',expiresAt:new Date(now+1800000).toISOString(),ledger:{revision:7} as never};},
  async review(...args){record('review',...args);return {token:'review-token-'.repeat(4),operationId,tripId,tripName:'서울 여행',command:args[1],expectedRevision:7,expiresAt:new Date(now+300000).toISOString()};},
  async confirm(...args){record('confirm',...args);return {value:{targetId:'saved-item'},tripRevision:8,replayed:false};},
  async unlink(...args){record('unlink',...args);},close(){}
 };
 const usageStore:ProviderUsageStore={async reserve(input){usage.push(input);return true;}};
 const options={repository,usageStore,skillSecret:secret,botId:'dev-bot',environment:'development' as const,now:()=>now};
 return {service:createKakaoService(options),repository,usageStore,options,calls,usage,fail:(value:unknown)=>{error=value;}};
}

test('only the configured development bot and secret can construct a bot sender',async()=>{
 const f=fixture();
 const valid=request({command:'context'});
 for(const changed of [
  {...valid,headers:{}},
  {...valid,headers:{'x-tripmoney-skill-secret':secret+'bad'}},
  {...valid,headers:{'x-tripmoney-skill-secret':[secret,secret]}},
  {...valid,rawBody:String(valid.rawBody).replace('dev-bot','other-bot')},
  {...valid,rawBody:String(valid.rawBody).replace('botUserKey','appUserId')},
  {...valid,rawBody:'x'.repeat(16385)},
  {...valid,rawBody:'{broken'},
 ]) {
  const result=await f.service.handleSkill(changed);
  assert.ok(result.status>=400);assert.equal(f.calls.length,0);assert.equal(f.usage.length,0);
 }
 assert.throws(()=>createKakaoService({...f.options,environment:'production' as 'development'}),{code:'unavailable'});
 const result=await f.service.handleSkill({...valid,headers:{'X-Tripmoney-Skill-Secret':secret}});
 assert.equal(result.status,200);
 assert.deepEqual(f.calls[0],{name:'context',args:[{environment:'development',botId:'dev-bot',botUserKey:'bot-user'}]});
 assert.equal(f.usage.length,1);assert.match(f.usage[0]!.scope,/kakao/);assert.ok(f.usage[0]!.expiresAt>now);
});

test('web pairing keeps the actual web actor while the bot claim contains no web actor',async()=>{
 const f=fixture();
 await f.service.issuePair(actor,tripId);await f.service.approvePair(actor,pendingId);await f.service.unlink(actor,grantId);
 const pair=await f.service.handleSkill(request({command:'pair',code:'12345678',actor:{userId:'forged'}}));
 assert.equal(pair.status,422);
 const result=await f.service.handleSkill(request({command:'pair',code:'12345678'}));
 assert.equal(result.status,200);assert.match(JSON.stringify(result.body),new RegExp(pendingId));
 assert.deepEqual(f.calls.slice(0,3),[{name:'issuePair',args:[actor,tripId]},{name:'approvePair',args:[actor,pendingId]},{name:'unlink',args:[actor,grantId]}]);
 assert.deepEqual(f.calls[3],{name:'claimPair',args:[{environment:'development',botId:'dev-bot',botUserKey:'bot-user'},'12345678']});
 assert.equal(f.calls.some(c=>c.name==='confirm'),false);
});

test('structured schedule review yields full visible values and a fixed confirmation operation',async()=>{
 const f=fixture();
 const reviewed=await f.service.handleSkill(request({command:'review',input:JSON.stringify(command),expectedRevision:'7'}));
 assert.equal(reviewed.status,200);
 const body=reviewed.body as any;
 const text=JSON.stringify(body);
 for(const value of ['서울 여행','왕궁 방문','사용자가 입력한 장소','2026-11-08','10:00','11:00','10000'])assert.ok(text.includes(value));
 assert.equal(f.calls.filter(c=>c.name==='confirm').length,0);
 assert.deepEqual(f.calls.at(-1),{name:'review',args:[{environment:'development',botId:'dev-bot',botUserKey:'bot-user'},command,7]});
 const confirm=body.template.quickReplies[0];
 assert.equal(confirm.extra.command,'confirm');assert.equal(confirm.extra.operationId,operationId);
 const result=await f.service.handleSkill(request({},confirm.extra));
 assert.equal(result.status,200);
 assert.deepEqual(f.calls.at(-1),{name:'confirm',args:[{environment:'development',botId:'dev-bot',botUserKey:'bot-user'},'review-token-'.repeat(4),operationId]});
 // Retransmission delegates the SAME operation to the durable repository receipt path.
 await f.service.handleSkill(request({},confirm.extra));
 assert.equal(f.calls.at(-1)!.args[2],operationId);
});

test('structured expenses work without an AI provider and unsafe ledger commands never reach review',async()=>{
 const f=fixture();
 const expense:ChannelCommand={type:'expense.create',input:{itineraryId:null,title:'택시',occurredLocal:'2026-11-08T13:00',currency:'THB',amount:'300.00',payerId:pendingId,splitIds:[pendingId,grantId],refreshRate:false}};
 const result=await f.service.handleSkill(request({command:'review',input:expense,expectedRevision:7}));
 assert.equal(result.status,200);
 for(const value of ['택시','300','THB',pendingId,grantId,'2026-11-08T13:00'])assert.ok(JSON.stringify(result.body).includes(value));
 assert.equal((f.calls.at(-1)!.args[1] as ChannelCommand).input.title,'택시');
 const before=f.calls.length;
 for(const params of [
  {command:'review',input:{type:'settlement.finalize',date:null},expectedRevision:7},
  {command:'review',input:command,expectedRevision:-1},
  {command:'review',input:command,expectedRevision:'7.1'},
  {command:'review',input:{...command,input:{...command.input,title:''}},expectedRevision:7},
  {command:'confirm',token:'bad',operationId:'forged-operation'},
  {command:'confirm',token:'review-token-'.repeat(4),operationId},
 ]) {
  // Direct confirm params are accepted: only repository can verify token/operation binding.
  const response=await f.service.handleSkill(request(params));
  assert.equal(response.status,params.token==='review-token-'.repeat(4)?200:422);
 }
 assert.equal(f.calls.length,before+1);
});

test('durable quota denial and repository errors expose no raw internal details',async()=>{
 const f=fixture();
 const denied=createKakaoService({...f.options,usageStore:{async reserve(){return false;}}});
 assert.equal((await denied.handleSkill(request({command:'context'}))).status,429);assert.equal(f.calls.length,0);
 for(const error of [new Error('SECRET password connection https://private.invalid'),new IdentityError('forbidden','SECRET raw database policy')]){
  f.fail(error);
  const result=await f.service.handleSkill(request({command:'context'}));
  assert.ok(result.status>=400);assert.equal(JSON.stringify(result).includes('SECRET'),false);assert.equal(JSON.stringify(result).includes('private.invalid'),false);
 }
});

test('review revision rejects coercible nonnumeric values before any durable usage or repository call',async()=>{
 const f=fixture();
 for(const expectedRevision of [true,[7],null,{},'',' 7','07']){
  const result=await f.service.handleSkill(request({command:'review',input:command,expectedRevision}));
  assert.equal(result.status,422,JSON.stringify(expectedRevision));
 }
 assert.equal(f.calls.length,0);assert.equal(f.usage.length,0);
});

test('expired contexts and review cards cannot be presented as valid confirmations',async()=>{
 const f=fixture();
 const expired=createKakaoService({...f.options,now:()=>now+1800000});
 assert.equal((await expired.handleSkill(request({command:'context'}))).status,403);
 const result=await expired.handleSkill(request({command:'review',input:command,expectedRevision:7}));
 assert.equal(result.status,403);assert.equal('template' in result.body,false);
});

test('documented skill requests may omit request version and send null clientExtra',async()=>{
 const f=fixture();
 const payload=JSON.parse(String(request({command:'context'}).rawBody));
 delete payload.version;payload.action.clientExtra=null;
 payload.userRequest.params={surface:'BuilderBotTest',ignoreMe:'true'};
 const result=await f.service.handleSkill({headers:{'x-tripmoney-skill-secret':secret},rawBody:JSON.stringify(payload)});
 assert.equal(result.status,200);assert.match(JSON.stringify(result.body),/서울 여행/);
});

test('schedule reviews reject hidden map references before issuing a confirmation card',async()=>{
 const f=fixture();
 for(const provider of ['google','demo'])for(const place of ['', '사용자가 입력한 장소'])for(const asJson of [false,true]){
  const mapped={...command,input:{...command.input,place,placeRef:{provider,placeId:'HiddenPlaceId'}}};
  const result=await f.service.handleSkill(request({command:'review',input:asJson?JSON.stringify(mapped):mapped,expectedRevision:7}));
  assert.equal(result.status,422,`${provider}, ${place}, JSON ${asJson}`);
  assert.equal('template' in result.body,false);
  assert.match(JSON.stringify(result.body),/웹/);
  assert.equal(JSON.stringify(result.body).includes('HiddenPlaceId'),false);
 }
 assert.equal(f.calls.length,0);assert.equal(f.usage.length,0);
 const allowed=await f.service.handleSkill(request({command:'review',input:{...command,input:{...command.input,place:'',placeRef:null}},expectedRevision:7}));
 assert.equal(allowed.status,200);
 assert.match(JSON.stringify(allowed.body),/장소: 미정/);
 assert.equal((f.calls.at(-1)!.args[1] as {input:{placeRef:null}}).input.placeRef,null);
});

test('web approval passes the validated expected trip without accepting a malformed identifier',async()=>{
 const f=fixture();await f.service.approvePair(actor,pendingId,tripId);
 assert.deepEqual(f.calls,[{name:'approvePair',args:[actor,pendingId,tripId]}]);
 await assert.rejects(f.service.approvePair(actor,pendingId,'invalid'),{code:'validation'});
 assert.equal(f.calls.length,1);
});

// Break caught: an authenticated, well-formed official button returning a bare
// 4xx JSON instead of explaining a domain refusal in a Kakao message bubble.
test('official confirmation domain refusals return safe normal bubbles',async()=>{
 for(const code of ['conflict','validation','forbidden','unauthenticated'] as const){
  const f=fixture();f.fail(new IdentityError(code,'SECRET expired confirmation or settlement lock'));
  const result=await f.service.handleSkill(request({},{command:'confirm',token:'review-token-'.repeat(4),operationId}));
  assert.equal(result.status,200,code);assert.ok('template' in result.body);
  const body=result.body as any;assert.equal(body.version,'2.0');
  assert.equal(typeof body.template.outputs[0].simpleText.text,'string');assert.equal(body.template.quickReplies,undefined);
  assert.equal(JSON.stringify(body).includes('SECRET'),false);
  assert.deepEqual(f.calls.map(call=>call.name),['confirm']);
 }
});
test('official confirmation still rejects bad authentication and malformed tokens before repository access',async()=>{
 const f=fixture(),valid=request({},{command:'confirm',token:'review-token-'.repeat(4),operationId});
 for(const changed of [{...valid,headers:{}},{...valid,rawBody:'{broken'}, {...valid,rawBody:String(valid.rawBody).replace('dev-bot','other-bot')},
  request({},{command:'confirm',token:'bad',operationId}),request({},{command:'confirm',token:'review-token-'.repeat(4),operationId:'bad'}),
  request({},{command:'confirm',token:'review-token-'.repeat(4),operationId,extra:'unexpected'})]){
  const result=await f.service.handleSkill(changed);assert.ok(result.status>=400);assert.equal('template' in result.body,false);
 }
 assert.equal(f.calls.length,0);assert.equal(f.usage.length,0);
});
test('explicit JSON confirm keeps its original conflict status',async()=>{
 const f=fixture();f.fail(new IdentityError('conflict','SECRET raw conflict'));
 const result=await f.service.handleSkill(request({command:'confirm',token:'review-token-'.repeat(4),operationId}));
 assert.equal(result.status,409);assert.equal('template' in result.body,false);assert.equal(JSON.stringify(result).includes('SECRET'),false);
});
