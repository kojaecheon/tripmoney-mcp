import {connectionConfig,approvedDevelopmentProjectRef} from '../db/config.js';
import {createProviderAccessVerifier} from '../auth/provider-access.js';
import {readHttpConfig,type HttpConfig} from '../http/config.js';

export type LiveConfig={appUrl:string;authUrl:string;providerUrl:string;publishableKey:string;
 authKid:string;authKeys:Record<string,Buffer>;inviteKid:string;inviteKeys:Record<string,Buffer>;
 rateKey:Buffer;mailDeliveryApproved:boolean;http:HttpConfig};
const invalid=():never=>{throw new Error('customer_live_configuration');};
function key(value:unknown):Buffer {
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))return invalid();
 const result=Buffer.from(value,'base64url');
 if(result.length!==32||result.toString('base64url')!==value)return invalid();
 return result;
}
function keyRing(value:string|undefined,active:string|undefined):Record<string,Buffer> {
 if(typeof active!=='string'||!/^[A-Za-z0-9_-]{1,16}$/.test(active))return invalid();
 const parsed:unknown=JSON.parse(value??'null');
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return invalid();
 const entries=Object.entries(parsed);
 if(!entries.length||entries.length>8)return invalid();
 const result:Record<string,Buffer>=Object.create(null);
 for(const [id,value]of entries){if(!/^[A-Za-z0-9_-]{1,16}$/.test(id))return invalid();result[id]=key(value);}
 if(!Object.hasOwn(result,active))return invalid();
 return result;
}
/** Reads only the supplied object. Never loads .env files, creates secrets or connects. */
export function readLiveConfig(env:NodeJS.ProcessEnv):LiveConfig {
 try {
  const appUrl=env.CUSTOMER_DB_TEST_URL!,authUrl=env.CUSTOMER_DB_AUTH_URL!;
  const app=connectionConfig(appUrl,'app'),auth=connectionConfig(authUrl,'auth');
  const a=new URL(app.connectionString!),b=new URL(auth.connectionString!);
  if(a.host!==b.host||a.pathname!==b.pathname)return invalid();
  const providerUrl=env.CUSTOMER_SUPABASE_URL!,publishableKey=env.CUSTOMER_SUPABASE_PUBLISHABLE_KEY!;
  if(providerUrl!==`https://${approvedDevelopmentProjectRef}.supabase.co`)return invalid();
  createProviderAccessVerifier({url:providerUrl,publishableKey});
  const authKeys=keyRing(env.CUSTOMER_AUTH_KEYS,env.CUSTOMER_AUTH_ACTIVE_KID);
  const inviteKeys=keyRing(env.CUSTOMER_INVITE_KEYS,env.CUSTOMER_INVITE_ACTIVE_KID);
  const rateKey=key(env.CUSTOMER_AUTH_RATE_KEY),clientKey=key(env.CUSTOMER_HTTP_CLIENT_KEY);
  const all=[...Object.values(authKeys),...Object.values(inviteKeys),rateKey,clientKey];
  if(new Set(all.map(v=>v.toString('base64url'))).size!==all.length)return invalid();
  const http=readHttpConfig({publicOrigin:env.CUSTOMER_PUBLIC_ORIGIN!,clientKey,mode:'customer',mailDelivery:false,trustedProxy:{addresses:['127.0.0.1'],clientHeader:'cf-connecting-ip'}});
  return {appUrl:app.connectionString!,authUrl:auth.connectionString!,providerUrl,publishableKey,
   authKid:env.CUSTOMER_AUTH_ACTIVE_KID!,authKeys,inviteKid:env.CUSTOMER_INVITE_ACTIVE_KID!,inviteKeys,rateKey,mailDeliveryApproved:env.CUSTOMER_LIVE_MAIL_APPROVED==='true',http};
 } catch {return invalid();}
}
