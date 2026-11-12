import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createKakaoService} from '../../server/channels/kakao/service.js';
import {createLiveMailPermit} from '../../server/integration/mail-permit.js';
import type {ChannelRepository,KakaoSender} from '../../server/integration/contracts.js';
const project='agddopryfqsyfshoowgk',origin='https://tripmoney.example.invalid';
const encoded=(n:number)=>Buffer.alloc(32,n).toString('base64url');
const modulePath='../../scripts/live-startup.js';
async function startupModule(){const result=await import(modulePath).catch(()=>undefined);assert.ok(result,'live startup safety feature is available');return result;}
function fixture(t:test.TestContext){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tripmoney-startup-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const files:Record<string,string>={db:path.join(dir,'db.env'),provider:path.join(dir,'provider.env'),keys:path.join(dir,'keys.env')};
 const write=(name:string,values:Record<string,string>)=>fs.writeFileSync(files[name]!,Object.entries(values).map(([k,v])=>`${k}='${v}'`).join('\n'),{mode:0o600});
 const db={CUSTOMER_DB_TEST_APPROVED:'true',CUSTOMER_DB_TEST_ID:`db.${project}.supabase.co:5432/postgres`,CUSTOMER_DB_TEST_URL:`postgresql://customer_app_login:fixture@db.${project}.supabase.co:5432/postgres`,CUSTOMER_DB_AUTH_URL:`postgresql://customer_auth_login:fixture@db.${project}.supabase.co:5432/postgres`,CUSTOMER_DB_TEST_ADMIN_URL:`postgresql://postgres:PRIVATE_DB_VALUE@db.${project}.supabase.co:5432/postgres`};
 const provider={CUSTOMER_SUPABASE_URL:`https://${project}.supabase.co`,CUSTOMER_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',CUSTOMER_PROVIDER_TEST_PROJECT_REF:project,CUSTOMER_PROVIDER_TEST_EMAIL:'owner@example.invalid'};
 const keys={CUSTOMER_AUTH_KEYS:JSON.stringify({live:encoded(1)}),CUSTOMER_AUTH_ACTIVE_KID:'live',CUSTOMER_INVITE_KEYS:JSON.stringify({live:encoded(2)}),CUSTOMER_INVITE_ACTIVE_KID:'live',CUSTOMER_AUTH_RATE_KEY:encoded(3),CUSTOMER_HTTP_CLIENT_KEY:encoded(4),CUSTOMER_KAKAO_SKILL_SECRET:encoded(5)};
 write('db',db);write('provider',provider);write('keys',keys);
 const args=['--public-origin',origin,'--db-env',files.db!,'--provider-env',files.provider!,'--keys-file',files.keys!];
 return {args,db,provider,keys,write,dir};
}
test('CLI rejects missing approval before opening configuration and logs only a safe failure',()=>{
 const result=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../../scripts/start-live.ts',import.meta.url)),'--public-origin','https://PRIVATE_SECRET.invalid'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{PATH:process.env.PATH},encoding:'utf8',timeout:5000});
 assert.equal(result.status,78);assert.match(result.stderr,/customer_live_startup_blocked/);assert.ok(!result.stderr.includes('PRIVATE_SECRET'));assert.equal(result.stdout,'');
});
test('preflight without external approval validates fixtures but never connects or returns admin credentials',async t=>{
 const {readLiveStartup,startLiveServer}=await startupModule();const f=fixture(t);
 const startup=readLiveStartup(['--preflight',...f.args],{});
 assert.equal(startup.preflight,true);assert.equal(startup.host,'127.0.0.1');assert.equal(startup.port,8126);
 assert.ok(!JSON.stringify(startup).includes('PRIVATE_DB_VALUE'));
 let connections=0;
 const result=await startLiveServer(startup,{createRuntime:async()=>{connections++;throw new Error('network must not run');}});
 assert.equal(result,undefined);assert.equal(connections,0);
});
test('startup validates restricted roles, fixed project, exact origin, key presence and reserved local port',async t=>{
 const {readLiveStartup}=await startupModule();const f=fixture(t);const args=['--preflight',...f.args];
 assert.throws(()=>readLiveStartup([...args,'--port','8125'],{}));
 assert.throws(()=>readLiveStartup([...args,'--host','0.0.0.0'],{}));
 assert.throws(()=>readLiveStartup([...args,'--public-origin','http://127.0.0.1:8126'],{}));
 f.write('db',{...f.db,CUSTOMER_DB_TEST_URL:f.db.CUSTOMER_DB_TEST_ADMIN_URL});assert.throws(()=>readLiveStartup(args,{}));f.write('db',f.db);
 f.write('provider',{...f.provider,CUSTOMER_PROVIDER_TEST_PROJECT_REF:'other'});assert.throws(()=>readLiveStartup(args,{}));f.write('provider',f.provider);
 f.write('keys',{...f.keys,CUSTOMER_HTTP_CLIENT_KEY:''});assert.throws(()=>readLiveStartup(args,{}));
});
test('listen requires three explicit connection approvals and mail adds an environment gate and exact recipient',async t=>{
 const {readLiveStartup}=await startupModule();const f=fixture(t);
 const approvals=['--approve-database','--approve-auth-api','--approve-kakao-development'];
 assert.throws(()=>readLiveStartup(f.args,{}));
 assert.throws(()=>readLiveStartup([...f.args,...approvals.slice(0,2)],{}));
 const startup=readLiveStartup([...f.args,...approvals],{CUSTOMER_LIVE_MAIL_APPROVED:'true'});
 assert.equal(startup.options.mailDeliveryApproved,false);
 assert.throws(()=>readLiveStartup([...f.args,...approvals,'--approve-live-mail','--mail-recipient','other@example.invalid'],{CUSTOMER_LIVE_MAIL_APPROVED:'true'}));
 assert.throws(()=>readLiveStartup([...f.args,...approvals,'--approve-live-mail','--mail-recipient','owner@example.invalid'],{}));
 const permit=path.join(f.dir,'permit.json'),recipient=f.provider.CUSTOMER_PROVIDER_TEST_EMAIL;
 createLiveMailPermit(permit,recipient);
 const mailArgs=[...f.args,...approvals,'--approve-live-mail','--mail-recipient',recipient,'--mail-permit',permit];
 const mailEnvironment={CUSTOMER_LIVE_MAIL_APPROVED:'true'};
 const approved=readLiveStartup(mailArgs,mailEnvironment);
 assert.equal(approved.options.mailRecipient,recipient);
 assert.ok(approved.options.mailPermit);
 const otherPermit=path.join(f.dir,'other-permit.json');
 createLiveMailPermit(otherPermit,'other@example.invalid');
 assert.throws(()=>readLiveStartup([...mailArgs.slice(0,-1),otherPermit],mailEnvironment));
});

test('CLI preflight exits with synthetic local files and no external approval',t=>{
 const f=fixture(t);const result=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../../scripts/start-live.ts',import.meta.url)),'--preflight',...f.args],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{PATH:process.env.PATH},encoding:'utf8',timeout:5000});
 assert.equal(result.status,0);assert.match(result.stdout,/customer_live_preflight_ok/);assert.equal(result.stderr,'');assert.ok(!result.stdout.includes('PRIVATE_DB_VALUE'));
});

test('runtime is closed when HTTP construction fails before listening',async t=>{
 const {readLiveStartup,startLiveServer}=await startupModule();const f=fixture(t);
 const startup=readLiveStartup([...f.args,'--approve-database','--approve-auth-api','--approve-kakao-development'],{});let closes=0;
 await assert.rejects(startLiveServer(startup,{createRuntime:async()=>({httpConfig:undefined,close:async()=>{closes++;}} as any)}));
 assert.equal(closes,1);
});

test('started fixture listens only on loopback and closes HTTP plus runtime once',async t=>{
 const {readLiveStartup,startLiveServer}=await startupModule();const f=fixture(t);
 const startup={...readLiveStartup([...f.args,'--approve-database','--approve-auth-api','--approve-kakao-development'],{}),port:0};
 let closes=0;
 const running=await startLiveServer(startup,{createRuntime:async()=>({httpConfig:startup.config.http,authService:{},close:async()=>{closes++;}} as any)});
 t.after(()=>running?.close());assert.equal(running!.server.address().address,'127.0.0.1');
 await Promise.all([running!.close(),running!.close()]);assert.equal(closes,1);assert.equal(running!.server.listening,false);
});

test('live startup accepts only the observed development-channel wire identity before claiming a pair',async t=>{
 const {readLiveStartup}=await startupModule();const f=fixture(t);
 const startup=readLiveStartup([...f.args,'--approve-database','--approve-auth-api','--approve-kakao-development'],{});
 const wireBot='6af073a7c354b7fec3d2806b!';
 const calls:{sender:KakaoSender;code:string}[]=[];let usage=0;
 const unused=async()=>assert.fail('unexpected repository operation');
 const repository:ChannelRepository={issuePair:unused,approvePair:unused,unlink:unused,context:unused,review:unused,confirm:unused,
  async claimPair(sender,code){calls.push({sender,code});return {pendingId:'11111111-1111-4111-8111-111111111111',expiresAt:'2030-01-01T00:00:00.000Z'};},close(){}};
 const service=createKakaoService({...startup.options.kakao,repository,usageStore:{async reserve(){usage++;return true;}},environment:'development'});
 const request=(bot:string)=>({headers:{'x-tripmoney-skill-secret':f.keys.CUSTOMER_KAKAO_SKILL_SECRET},rawBody:JSON.stringify({
  bot:{id:bot},userRequest:{user:{id:'synthetic-bot-user',type:'botUserKey'},utterance:'연결 0123456789abcdef01234567'},action:{params:{}}})});
 const result=await service.handleSkill(request(wireBot));
 assert.equal(result.status,200);
 assert.deepEqual(calls,[{sender:{environment:'development',botId:wireBot,botUserKey:'synthetic-bot-user'},code:'0123456789abcdef01234567'}]);
 for(const other of ['6af073a7c354b7fec3d2806b',wireBot+'!','other-bot!',wireBot+'suffix']){
  assert.equal((await service.handleSkill(request(other))).status,403);
 }
 assert.equal(calls.length,1);assert.equal(usage,1);
});
