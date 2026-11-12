import test from 'node:test';
import assert from 'node:assert/strict';
import {IncomingMessage} from 'node:http';
import {Socket} from 'node:net';
import {IdentityError} from '../../core/contracts.js';
import {clientAddress} from '../../server/http/client-address.js';
import {readHttpConfig} from '../../server/http/config.js';

const base = {publicOrigin:'https://tripmoney.example.invalid',clientKey:Buffer.alloc(32,7)};
const proxy = {addresses:['127.0.0.1'],clientHeader:'cf-connecting-ip' as const};

test('trusted proxy configuration accepts only explicit IPs and supported single headers',()=>{
  const invalid = [null,{},[],{...proxy,addresses:[]},{...proxy,addresses:Array(17).fill('127.0.0.1')},
    {...proxy,addresses:['*']},{...proxy,addresses:['127.0.0.0/8']},{...proxy,addresses:['localhost']},
    {...proxy,addresses:['127.0.0.1 ']},{...proxy,addresses:['fe80::1%lo0']},{...proxy,addresses:[123]},
    {...proxy,addresses:['999.0.0.1']},{...proxy,clientHeader:'x-forwarded-for'}];
  for (const trustedProxy of invalid) assert.throws(()=>readHttpConfig({...base,trustedProxy} as any),/Invalid HTTP configuration/);
});

test('trusted proxy configuration copies and freezes caller values',()=>{
  const input = {addresses:['::FFFF:127.0.0.1','2001:0DB8:0:0:0:0:0:1'],clientHeader:'x-real-ip' as const};
  const config = readHttpConfig({...base,trustedProxy:input});
  input.addresses[0] = '203.0.113.99';
  input.addresses.push('203.0.113.100');
  assert.deepEqual(config.trustedProxy?.addresses,['127.0.0.1','2001:db8::1']);
  assert.ok(Object.isFrozen(config.trustedProxy));
  assert.ok(Object.isFrozen(config.trustedProxy?.addresses));
  assert.throws(()=>{(config as any).trustedProxy = proxy;},TypeError);
});

test('trusted proxy configuration supports the upper address count bound',()=>{
  const addresses = Array.from({length:16},(_,index)=>`192.0.2.${index + 1}`);
  assert.equal(readHttpConfig({...base,trustedProxy:{...proxy,addresses}}).trustedProxy?.addresses.length,16);
  assert.equal(readHttpConfig(base).trustedProxy,undefined);
});

function request(peer:string|undefined,rawHeaders:string[] = []):IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket,'remoteAddress',{value:peer});
  const req = new IncomingMessage(socket);
  req.rawHeaders = rawHeaders;
  return req;
}
const forbidden = (error:unknown)=>error instanceof IdentityError && error.code === 'forbidden';

test('client address defaults to the socket and ignores every forged forwarding header',()=>{
  const req = request('::ffff:192.0.2.5',['CF-Connecting-IP','203.0.113.1','CF-Connecting-IP','bad, chain','X-Real-IP','203.0.113.2','X-Forwarded-For','203.0.113.3','Forwarded','for=203.0.113.4']);
  assert.equal(clientAddress(req,readHttpConfig(base)),'192.0.2.5');
  assert.equal(clientAddress(request(undefined),readHttpConfig(base)),'unknown');
});

test('only an explicitly trusted socket peer can supply the selected client header',()=>{
  const config = readHttpConfig({...base,trustedProxy:proxy});
  assert.equal(clientAddress(request('192.0.2.5',['CF-Connecting-IP','203.0.113.1']),config),'192.0.2.5');
  assert.equal(clientAddress(request('192.0.2.5',['CF-Connecting-IP','invalid, chain']),config),'192.0.2.5');
  assert.equal(clientAddress(request('192.0.2.5'),config),'192.0.2.5');
  assert.equal(clientAddress(request('::ffff:127.0.0.1',['CF-Connecting-IP','203.0.113.1','X-Real-IP','203.0.113.2','X-Forwarded-For','203.0.113.3']),config),'203.0.113.1');
});

test('trusted IPv6 peers and mapped client IPs normalize consistently',()=>{
  const config = readHttpConfig({...base,trustedProxy:{addresses:['2001:db8::1','::ffff:192.0.2.1'],clientHeader:'x-real-ip'}});
  assert.equal(clientAddress(request('2001:0DB8:0:0:0:0:0:1',['X-Real-IP','::FFFF:203.0.113.9']),config),'203.0.113.9');
  assert.equal(clientAddress(request('192.0.2.1',['x-real-ip','2001:0DB8:0:0:0:0:0:9']),config),'2001:db8::9');
});

test('trusted peers fail closed for missing, duplicate and malformed raw client headers',()=>{
  const config = readHttpConfig({...base,trustedProxy:proxy});
  const invalidHeaders = [[],['X-Real-IP','203.0.113.1'],
    ['CF-Connecting-IP','203.0.113.1','cf-connecting-ip','203.0.113.1'],
    ...['','203.0.113.1,203.0.113.2','203.0.113.1, 203.0.113.2',' 203.0.113.1','203.0.113.1 ',
      '203.0.113.1\t','203.0.113.1\r\n','203.0.113.1\u0000','203.0.113.1:443','[2001:db8::1]',
      'localhost','fe80::1%lo0','999.1.1.1','0'.repeat(46)].map(value=>['CF-Connecting-IP',value])];
  for (const headers of invalidHeaders) assert.throws(()=>clientAddress(request('127.0.0.1',headers),config),forbidden);
  const parsedOnly = request('127.0.0.1');
  parsedOnly.headers['cf-connecting-ip'] = '203.0.113.1';
  assert.throws(()=>clientAddress(parsedOnly,config),forbidden);
});

test('raw duplicate client headers cannot be hidden by normalized request headers',()=>{
  const req = request('127.0.0.1',['CF-Connecting-IP','203.0.113.1','cf-connecting-ip','203.0.113.2']);
  req.headers['cf-connecting-ip'] = '203.0.113.1';
  assert.throws(()=>clientAddress(req,readHttpConfig({...base,trustedProxy:proxy})),forbidden);
});

test('caller mutation cannot expand the trusted peer allowlist or switch headers',()=>{
  const input = {addresses:['127.0.0.1'],clientHeader:'cf-connecting-ip' as 'cf-connecting-ip'|'x-real-ip'};
  const config = readHttpConfig({...base,trustedProxy:input});
  input.addresses[0] = '192.0.2.5';
  input.clientHeader = 'x-real-ip';
  assert.equal(clientAddress(request('192.0.2.5',['X-Real-IP','203.0.113.1']),config),'192.0.2.5');
  assert.equal(clientAddress(request('127.0.0.1',['CF-Connecting-IP','203.0.113.2','X-Real-IP','203.0.113.3']),config),'203.0.113.2');
});
