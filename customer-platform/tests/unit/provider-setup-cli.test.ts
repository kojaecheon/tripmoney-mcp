import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as cli from '../../scripts/setup-provider-test.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const url = new URL('../../scripts/setup-provider-test.ts', import.meta.url).href;
const config = { CUSTOMER_SUPABASE_URL: 'https://agddopryfqsyfshoowgk.supabase.co',
  CUSTOMER_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic',
  CUSTOMER_PROVIDER_TEST_PROJECT_REF: 'agddopryfqsyfshoowgk', CUSTOMER_PROVIDER_TEST_EMAIL: ' Qa@Example.test ' };
test('공개 준비 설정은 고정 프로젝트와 정규화한 이메일만 반환한다', () => {
  assert.deepEqual(cli.readProviderSetupConfig(config), {email:'qa@example.test',publishableKey:'sb_publishable_synthetic'});
});
for (const changed of [{CUSTOMER_SUPABASE_URL:'https://example.invalid'},
  {CUSTOMER_PROVIDER_TEST_PROJECT_REF:'other'}, {CUSTOMER_SUPABASE_PUBLISHABLE_KEY:'sb_secret_synthetic'},
  {CUSTOMER_SUPABASE_PUBLISHABLE_KEY:'eyJlegacy'}, {CUSTOMER_PROVIDER_TEST_EMAIL:'bad'},
  {CUSTOMER_PROVIDER_TEST_EMAIL:'qa@example.test\nprivate'}, {CUSTOMER_PROVIDER_TEST_EMAIL:''}]) {
  test('공개 설정의 다른 대상·비밀 key·잘못된 이메일을 거부한다 '+Object.keys(changed)[0]+':'+Object.values(changed)[0],()=>{
    assert.throws(()=>cli.readProviderSetupConfig({...config,...changed}),{message:'customer_provider_setup_configuration'});
  });
}

const report={normalP:true,normalQ:true,dataApi:{anonymousRest:3,authenticatedRest:3,anonymousRpc:3,authenticatedRpc:3},
 revokedP:true,tokenPStillUnexpired:true,otherQStillActive:true,cleanupP:true,cleanupQ:true};
function runChild(value:unknown, env:Record<string,string>={}, args:string[]=[], extras='') {
 const source=`import {runProviderSetupCli} from ${JSON.stringify(url)};
 process.argv=[process.execPath,'/synthetic/provider-setup.ts',...${JSON.stringify(args)}];
 ${extras}
 await runProviderSetupCli({readConfig:()=>({email:'qa@example.test',publishableKey:'sb_publishable_synthetic'}),
 run:async()=>(${JSON.stringify(value)}),
 start:async()=>({url:'http://127.0.0.1:12345/',completed:Promise.resolve(${JSON.stringify(value)}),close:async()=>{}})});`;
 return spawnSync(process.execPath,['--import',new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url).pathname,'--input-type=module','-e',source],
 {cwd:root,env,encoding:'utf8',timeout:4000});
}
const approved={CUSTOMER_PROVIDER_TEST_APPROVED:'true',CUSTOMER_PROVIDER_TEST_ALLOW_LOCAL_SIGNOUT:'true'};
for (const gate of [{}, {CUSTOMER_PROVIDER_TEST_APPROVED:'true'}, {CUSTOMER_PROVIDER_TEST_ALLOW_LOCAL_SIGNOUT:'true'}]) {
 test('provider CLI는 두 승인 gate를 파일 접근 전에 요구한다 '+Object.keys(gate).join(','),()=>{
  const source=`import {runProviderSetupCli} from ${JSON.stringify(url)};
   process.argv=[process.execPath,'/synthetic/provider-setup.ts'];
   await runProviderSetupCli({readConfig:()=>{console.log('CONFIG_READ');throw new Error('PRIVATE_ERROR')}});`;
  const result=spawnSync(process.execPath,['--import',new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url).pathname,'--input-type=module','-e',source],
   {cwd:root,env:gate,encoding:'utf8',timeout:4000});
  assert.equal(result.status,78);assert.equal(result.stdout,'');assert.equal(result.stderr.trim(),'customer_provider_setup_not_started');
 });
}
test('추가 CLI 인수는 승인됐어도 시작 전에 거부한다',()=>{
 const result=runChild(null,approved,['extra']);assert.equal(result.status,78);assert.equal(result.stdout,'');
});
for (const [value,code] of [
 [{status:'passed',report,cleanupComplete:true,cleanupUncertain:false},0],
 [{status:'failed',code:'customer_provider_prepare_login_p',report:null,cleanupComplete:true,cleanupUncertain:false},1],
 [{status:'cancelled',code:'customer_provider_prepare_cancelled',report:null,cleanupComplete:true,cleanupUncertain:false},130],
 [{status:'passed',report:null,cleanupComplete:true,cleanupUncertain:false},1],
 [{status:'passed',report,cleanupComplete:false,cleanupUncertain:false},1],
 [{status:'passed',report,cleanupComplete:true,cleanupUncertain:true},1],
 [{status:'passed',report:{...report,revokedP:false},cleanupComplete:true,cleanupUncertain:false},1],
 [{status:'passed',code:'customer_provider_prepare_login_q',report,cleanupComplete:true,cleanupUncertain:false},1],
 [{status:'failed',code:'PRIVATE_ERROR',report:null,cleanupComplete:false,cleanupUncertain:true},1],
] as const) {
 test('CLI는 실제 최종 조건과 cleanup 상태로 종료한다 '+JSON.stringify(value),()=>{
  const result=runChild(value,approved,[],'setInterval(()=>{},10000);');
  assert.equal(result.status,code);assert.match(result.stdout,/^http:\/\/127\.0\.0\.1:12345\/\n/);
  assert.equal((result.stdout+result.stderr).includes('PRIVATE_ERROR'),false);
  assert.equal((result.stdout+result.stderr).includes('qa@example.test'),false);
  assert.equal((result.stdout+result.stderr).includes('sb_publishable_synthetic'),false);
 });
}
