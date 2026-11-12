import {fileURLToPath,pathToFileURL} from 'node:url';
import {readSecretEnvFile} from '../server/config/secret-env.js';
import type {PreparedProviderResult} from './provider-test/login.js';

type SetupConfig={email:string;publishableKey:string};
type Dependencies={
  readConfig?:()=>SetupConfig;
  start?:typeof import('./provider-test/provider-browser.js').startProviderBrowser;
  run?:typeof import('./provider-test/login.js').runPreparedProviderProbe;
};
const codes=new Set(['configuration','login_p','login_q','session_pair','probe','cleanup','cancelled','cleanup_unknown','transport']
 .map(value=>'customer_provider_prepare_'+value));
const boolKeys=['normalP','normalQ','revokedP','tokenPStillUnexpired','otherQStillActive','cleanupP','cleanupQ'] as const;
const countKeys=['anonymousRest','authenticatedRest','anonymousRpc','authenticatedRpc'] as const;
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);

export function readProviderSetupConfig(env:NodeJS.ProcessEnv):SetupConfig {
 const email=env.CUSTOMER_PROVIDER_TEST_EMAIL?.trim().toLowerCase();
 if(env.CUSTOMER_SUPABASE_URL!=='https://agddopryfqsyfshoowgk.supabase.co'
  ||env.CUSTOMER_PROVIDER_TEST_PROJECT_REF!=='agddopryfqsyfshoowgk'
  ||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(env.CUSTOMER_SUPABASE_PUBLISHABLE_KEY??'')
  ||!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
   throw new Error('customer_provider_setup_configuration');
 return {email,publishableKey:env.CUSTOMER_SUPABASE_PUBLISHABLE_KEY!};
}
function readConfig():SetupConfig {
 return readProviderSetupConfig(readSecretEnvFile(new URL('../.env.provider-setup',import.meta.url),[
  'CUSTOMER_SUPABASE_URL','CUSTOMER_SUPABASE_PUBLISHABLE_KEY','CUSTOMER_PROVIDER_TEST_PROJECT_REF','CUSTOMER_PROVIDER_TEST_EMAIL']));
}
function publicResult(value:unknown):PreparedProviderResult {
 const source=record(value)?value:{};
 let report:PreparedProviderResult['report']=null;
 const input=source.report,counts=record(input)?input.dataApi:undefined;
 if(record(input)&&record(counts)
  &&boolKeys.every(k=>typeof input[k]==='boolean')
  &&countKeys.every(k=>Number.isInteger(counts[k])&&Number(counts[k])>=0&&Number(counts[k])<=3)) {
  report={normalP:input.normalP as boolean,normalQ:input.normalQ as boolean,
   revokedP:input.revokedP as boolean,tokenPStillUnexpired:input.tokenPStillUnexpired as boolean,
   otherQStillActive:input.otherQStillActive as boolean,cleanupP:input.cleanupP as boolean,cleanupQ:input.cleanupQ as boolean,
   dataApi:Object.fromEntries(countKeys.map(k=>[k,counts[k]])) as NonNullable<typeof report>['dataApi']};
 }
 const cleanupComplete=source.cleanupComplete===true,cleanupUncertain=source.cleanupUncertain!==false;
 const complete=source.code===undefined&&report!==null&&boolKeys.every(k=>report![k]===true)
  &&countKeys.every(k=>report!.dataApi[k]===3)&&cleanupComplete&&!cleanupUncertain;
 const status=source.status==='passed'&&complete?'passed':source.status==='cancelled'?'cancelled':'failed';
 const code=typeof source.code==='string'&&codes.has(source.code)?source.code:'customer_provider_prepare_probe';
 return {status,...(status==='passed'?{}:{code}),report,cleanupComplete,cleanupUncertain};
}
function exitAfterFlush(code:number):Promise<never> {
 return new Promise(()=>{
  setTimeout(()=>process.exit(code),1000);
  let pending=2;
  for(const stream of [process.stdout,process.stderr]) {
   let done=false;const finish=()=>{if(!done){done=true;if(--pending===0)process.exit(code);}};
   stream.once('error',finish);try{stream.write('',finish);}catch{finish();}
  }
 });
}
export async function runProviderSetupCli(deps:Dependencies={}):Promise<never> {
 let code=78,server:Awaited<ReturnType<NonNullable<Dependencies['start']>>>|undefined,stopped=false;
 const cancel=()=>{stopped=true;void server?.close().catch(()=>{});};
 try {
  if(process.argv.length!==2||process.env.CUSTOMER_PROVIDER_TEST_APPROVED!=='true'
   ||process.env.CUSTOMER_PROVIDER_TEST_ALLOW_LOCAL_SIGNOUT!=='true')throw new Error();
  const settings=(deps.readConfig??readConfig)();
  const start=deps.start??(await import('./provider-test/provider-browser.js')).startProviderBrowser;
  const run=deps.run??(await import('./provider-test/login.js')).runPreparedProviderProbe;
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  server=await start({email:settings.email,run:(password,signal)=>run({...settings,password,signal})});
  if(!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(server.url))throw new Error();
  console.log(server.url);if(stopped)void server.close();
  const result=publicResult(await server.completed);
  code=result.status==='passed'?0:result.status==='cancelled'?130:1;
  console.log(JSON.stringify(result));
  if(result.status!=='passed')console.error(result.code);
 } catch {console.error('customer_provider_setup_not_started');}
 finally {
  process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
  if(server)await Promise.race([server.close().catch(()=>{}),new Promise(resolve=>{const t=setTimeout(resolve,20000);t.unref();})]);
 }
 return exitAfterFlush(code);
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await runProviderSetupCli();
