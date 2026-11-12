import {isIP} from 'node:net';

export type TrustedProxy = Readonly<{addresses:readonly string[];clientHeader:'cf-connecting-ip'|'x-real-ip'}>;
export type HttpConfig = { publicOrigin: string; host: string; secure: boolean; clientKey: Buffer; mode:'local-demo'|'customer'; mailDelivery:boolean; authMethod?:'email-link'; readonly trustedProxy?:TrustedProxy };

export function normalizeIpAddress(value:unknown):string|undefined {
  if (typeof value !== 'string' || value.length > 45 || /[^0-9a-fA-F:.]/.test(value)) return undefined;
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return undefined;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1,-1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const high = parseInt(mapped[1]!,16), low = parseInt(mapped[2]!,16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function readHttpConfig(input: { publicOrigin: string; clientKey: Buffer; mode?:'local-demo'|'customer'; mailDelivery?:boolean;authMethod?:'email-link';trustedProxy?:TrustedProxy }): HttpConfig {
  const url = new URL(input.publicOrigin);
  if (url.origin !== input.publicOrigin || url.username || url.password
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    || !Buffer.isBuffer(input.clientKey) || input.clientKey.length !== 32
    || (input.authMethod!==undefined&&(input.authMethod!=='email-link'||input.mode!=='customer'))
    || (input.mode!==undefined&&input.mode!=='local-demo'&&input.mode!=='customer')
    || (input.mailDelivery!==undefined&&typeof input.mailDelivery!=='boolean')
    || (input.mode==='customer'&&url.protocol!=='https:')
    || (input.mode!=='customer'&&input.mailDelivery===true)) throw new Error('Invalid HTTP configuration');
  const config:HttpConfig = { publicOrigin: url.origin, host: url.host, secure: url.protocol === 'https:', clientKey: Buffer.from(input.clientKey),mode:input.mode??'local-demo',mailDelivery:input.mode==='customer'&&input.mailDelivery===true };
  if(input.authMethod!==undefined)config.authMethod=input.authMethod;
  if (input.trustedProxy !== undefined) {
    const proxy = input.trustedProxy;
    if (!proxy || !Array.isArray(proxy.addresses) || proxy.addresses.length < 1 || proxy.addresses.length > 16
      || (proxy.clientHeader !== 'cf-connecting-ip' && proxy.clientHeader !== 'x-real-ip')) throw new Error('Invalid HTTP configuration');
    const addresses = Array.from(proxy.addresses,normalizeIpAddress);
    if (addresses.some(address=>address === undefined)) throw new Error('Invalid HTTP configuration');
    Object.defineProperty(config,'trustedProxy',{enumerable:true,value:Object.freeze({addresses:Object.freeze(addresses as string[]),clientHeader:proxy.clientHeader})});
  }
  return config;
}
