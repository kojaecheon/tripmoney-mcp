export type MapsClientInput={allowNetwork?:boolean;browserApiKey?:string;mapId?:string};
export type PublicMapsConfig={mode:'google';browserApiKey:string;mapId:string};
export function readMapsClient(value:MapsClientInput|undefined):PublicMapsConfig|undefined {
 if(!value||value.allowNetwork!==true)return;
 if(Object.keys(value).some(key=>!['allowNetwork','mode','browserApiKey','mapId'].includes(key))||
   typeof value.browserApiKey!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(value.browserApiKey)||
   typeof value.mapId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.mapId))throw new Error('customer_maps_configuration');
 return {mode:'google',browserApiKey:value.browserApiKey,mapId:value.mapId};
}
/** Applied only after explicit client activation. Default HTTP CSP is unchanged. */
export function mapsCsp(nonce:string):string {
 return `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://maps.googleapis.com https://maps.gstatic.com 'unsafe-eval' blob:; style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com; img-src 'self' data: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com; connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.google.com data: blob:; font-src 'self' https://fonts.gstatic.com; frame-src https://*.google.com; worker-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
}
