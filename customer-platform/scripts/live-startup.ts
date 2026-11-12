import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readSecretEnvFile} from '../server/config/secret-env.js';
import {readDbTestConfig,approvedDevelopmentProjectRef} from '../server/db/config.js';
import {readLiveConfig,type LiveConfig} from '../server/integration/config.js';
import {readLiveMailPermit,type LiveMailPermit} from '../server/integration/mail-permit.js';
import {readLiveKeyFile} from './live-state.js';
import type {createLiveRuntime} from '../server/integration/runtime.js';
const invalid=():never=>{throw new Error('customer_live_startup_blocked');};
const dbNames=['CUSTOMER_DB_AUTH_URL','CUSTOMER_DB_TEST_ADMIN_URL','CUSTOMER_DB_TEST_APPROVED','CUSTOMER_DB_TEST_ID','CUSTOMER_DB_TEST_URL'];
const providerNames=['CUSTOMER_PROVIDER_TEST_EMAIL','CUSTOMER_PROVIDER_TEST_PROJECT_REF','CUSTOMER_SUPABASE_PUBLISHABLE_KEY','CUSTOMER_SUPABASE_URL'];
const defaultPath=(name:string)=>fileURLToPath(new URL(`../${name}`,import.meta.url));
export type LiveStartup={preflight:boolean;host:'127.0.0.1';port:number;config:LiveConfig;options:{
 databaseApproved:boolean;authApiApproved:boolean;mailDeliveryApproved:boolean;mailRecipient?:string;mailPermit?:LiveMailPermit;
 kakao:{skillSecret:string;botId:'6af073a7c354b7fec3d2806b!'}}};
/** Reads explicit private files only. No connections, file creation, SQL or child processes. */
export function readLiveStartup(args:string[],environment:NodeJS.ProcessEnv):LiveStartup {
 try {
  const parsed=parseArgs({args,strict:true,allowPositionals:false,tokens:true,options:{
   preflight:{type:'boolean'},'approve-database':{type:'boolean'},'approve-auth-api':{type:'boolean'},
   'approve-kakao-development':{type:'boolean'},'approve-live-mail':{type:'boolean'},
   'public-origin':{type:'string'},port:{type:'string'},'db-env':{type:'string'},'provider-env':{type:'string'},
   'keys-file':{type:'string'},'mail-permit':{type:'string'},'mail-recipient':{type:'string'}}});
  const named=parsed.tokens.filter(token=>token.kind==='option').map(token=>token.name);
  if(new Set(named).size!==named.length)return invalid();
  const values=parsed.values,preflight=values.preflight===true;
  if(!preflight&&(!values['approve-database']||!values['approve-auth-api']||!values['approve-kakao-development']))return invalid();
  if(!values['public-origin'])return invalid();
  const rawPort=values.port??'8126';
  if(!/^[1-9][0-9]{3,4}$/.test(rawPort))return invalid();
  const port=Number(rawPort);if(port>65535||port<1024||port===8125)return invalid();
  const mail=values['approve-live-mail']===true;
  if(mail?(environment.CUSTOMER_LIVE_MAIL_APPROVED!=='true'||!values['mail-recipient'])
   :values['mail-recipient']!==undefined||values['mail-permit']!==undefined)return invalid();
  const db=readDbTestConfig(readSecretEnvFile(values['db-env']??defaultPath('.env.db-test'),dbNames));
  const provider=readSecretEnvFile(values['provider-env']??defaultPath('.env.provider-setup'),providerNames);
  const recipient=provider.CUSTOMER_PROVIDER_TEST_EMAIL;
  if(provider.CUSTOMER_PROVIDER_TEST_PROJECT_REF!==approvedDevelopmentProjectRef
   ||!recipient||(mail&&values['mail-recipient']!==recipient))return invalid();
  const keys=readLiveKeyFile(values['keys-file']??defaultPath('.customer-live/keys.env'));
  const secret=keys.CUSTOMER_KAKAO_SKILL_SECRET;
  if(!secret||!/^[A-Za-z0-9_-]{43}$/.test(secret)||Buffer.from(secret,'base64url').toString('base64url')!==secret)return invalid();
  const config=readLiveConfig({CUSTOMER_DB_TEST_URL:db.appUrl,CUSTOMER_DB_AUTH_URL:db.authUrl,
   CUSTOMER_SUPABASE_URL:provider.CUSTOMER_SUPABASE_URL,CUSTOMER_SUPABASE_PUBLISHABLE_KEY:provider.CUSTOMER_SUPABASE_PUBLISHABLE_KEY,
   ...keys,CUSTOMER_PUBLIC_ORIGIN:values['public-origin'],CUSTOMER_LIVE_MAIL_APPROVED:mail?'true':'false'});
  // Keep channel credentials distinct from all auth and request-hash keys.
  if([...Object.values(config.authKeys),...Object.values(config.inviteKeys),config.rateKey,config.http.clientKey]
   .some(key=>key.toString('base64url')===secret))return invalid();
  const mailOptions=mail?{mailRecipient:recipient,
   mailPermit:readLiveMailPermit(values['mail-permit']??defaultPath('.customer-live/mail-permit.json'),recipient)}:{};
  return {preflight,host:'127.0.0.1',port,config,options:{databaseApproved:values['approve-database']===true,
   authApiApproved:values['approve-auth-api']===true,mailDeliveryApproved:mail,...mailOptions,
   // Exact wire identity observed for this owned development channel, not a suffix normalizer.
   kakao:{skillSecret:secret,botId:'6af073a7c354b7fec3d2806b!'}}};
 } catch {return invalid();}
}
/** Preflight returns before loading the network runtime or opening an HTTP listener. */
export async function startLiveServer(startup:LiveStartup,dependencies:{createRuntime?:typeof createLiveRuntime}={}) {
 if(startup.preflight)return undefined;
 if(startup.host!=='127.0.0.1'||startup.port===8125||startup.options.databaseApproved!==true||startup.options.authApiApproved!==true)return invalid();
 const factory=dependencies.createRuntime??(await import('../server/integration/runtime.js')).createLiveRuntime;
 const runtime=await factory(startup.config,startup.options);
 let server:import('node:http').Server;
 try {
  const {createCustomerAuthServer}=await import('../server/http/server.js');
  server=createCustomerAuthServer({...runtime,config:runtime.httpConfig});
  await new Promise<void>((resolve,reject)=>{
   const failed=(error:Error)=>{server.off('listening',listening);reject(error);};
   const listening=()=>{server.off('error',failed);resolve();};
   server.once('error',failed);server.once('listening',listening);server.listen(startup.port,startup.host);
  });
 } catch {await runtime.close();return invalid();}
 let closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{
  const stopped=new Promise<void>(resolve=>server.close(()=>resolve()));
  const timer=setTimeout(()=>server.closeAllConnections(),5000);timer.unref();
  try {await Promise.all([stopped,runtime.close()]);}finally {clearTimeout(timer);}
 })();
 return {server,close};
}
