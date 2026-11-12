export type EmailLinkResult = {status:'idle'} | {status:'success'} | {status:'error';message:string};
export function completeEmailLink(input:{
 location:Pick<Location,'pathname'|'hash'|'replace'>;
 history:Pick<History,'replaceState'>;
 fetchFn?: (url:string,init:RequestInit)=>Promise<Response>;
}):Promise<EmailLinkResult>;
