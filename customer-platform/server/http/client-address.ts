import type {IncomingMessage} from 'node:http';
import {IdentityError} from '../../core/contracts.js';
import {normalizeIpAddress, type HttpConfig} from './config.js';

export function clientAddress(req:IncomingMessage,config:HttpConfig):string {
  const peer = normalizeIpAddress(req.socket.remoteAddress);
  const proxy = config.trustedProxy;
  if (!proxy || !peer || !proxy.addresses.includes(peer)) return peer ?? req.socket.remoteAddress ?? 'unknown';
  let count = 0;
  let value:string|undefined;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === proxy.clientHeader) {
      count++;
      value = req.rawHeaders[index + 1];
    }
  }
  const address = normalizeIpAddress(value);
  if (count !== 1 || address === undefined) throw new IdentityError('forbidden','허용되지 않은 요청입니다.');
  return address;
}
