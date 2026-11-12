import {randomBytes} from 'node:crypto';
import {readSecretEnvFile} from '../server/config/secret-env.js';
import {assertPrivateDirectory,writePrivateState} from '../server/config/private-state.js';
export const liveKeyNames=['CUSTOMER_AUTH_KEYS','CUSTOMER_AUTH_ACTIVE_KID','CUSTOMER_INVITE_KEYS',
 'CUSTOMER_INVITE_ACTIVE_KID','CUSTOMER_AUTH_RATE_KEY','CUSTOMER_HTTP_CLIENT_KEY','CUSTOMER_KAKAO_SKILL_SECRET'] as const;
/** Main operator calls this once in a Git-ignored private directory. Startup never creates keys. */
export function createLiveKeyFile(file:string):void {
 const key=()=>randomBytes(32).toString('base64url');
 const values={CUSTOMER_AUTH_KEYS:JSON.stringify({live:key()}),CUSTOMER_AUTH_ACTIVE_KID:'live',
  CUSTOMER_INVITE_KEYS:JSON.stringify({live:key()}),CUSTOMER_INVITE_ACTIVE_KID:'live',
  CUSTOMER_AUTH_RATE_KEY:key(),CUSTOMER_HTTP_CLIENT_KEY:key(),CUSTOMER_KAKAO_SKILL_SECRET:key()};
 writePrivateState(file,Object.entries(values).map(([name,value])=>`${name}='${value}'`).join('\n')+'\n');
}
export function readLiveKeyFile(file:string):NodeJS.ProcessEnv {
 assertPrivateDirectory(file);return readSecretEnvFile(file,liveKeyNames);
}
