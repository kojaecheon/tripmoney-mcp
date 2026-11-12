import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { TLSSocket, type PeerCertificate } from 'node:tls';
import { inspectClientTransport, validateBackendTls } from '../../server/db/transport.js';

const pooler = 'aws-0-ap-northeast-2.pooler.supabase.com';
const direct = 'db.agddopryfqsyfshoowgk.supabase.co';
// 네트워크 없는 double이다. Node가 인증을 완료했다는 결과와 peer 응답만 합성한다.
function fixture(t: TestContext, host = pooler) {
  const socket = new TLSSocket(new PassThrough());
  socket.authorized = true;
  t.mock.method(socket, 'getPeerCertificate', () => ({ subjectaltname: `DNS:${host}`,
    subject: { CN: host }, raw: Buffer.from('synthetic-peer') }) as PeerCertificate);
  t.after(() => socket.destroy());
  return { socket, client: { connection: { stream: socket } } };
}

for (const [host, expected] of [[pooler, 'session_pooler'],
  ['aws-1-ap-northeast-2.pooler.supabase.com', 'session_pooler'], [direct, 'direct']] as const) {
  test(`실제 TLSSocket shape와 승인 peer hostname을 확인한다: ${expected} ${host.slice(0, 5)}`, t => {
    assert.equal(inspectClientTransport(fixture(t, host).client, host), expected);
  });
}
for (const failure of ['plain', 'authorized', 'encrypted', 'authorization_error', 'destroyed', 'hostname',
  'missing_peer', 'missing_raw', 'throw', 'missing_connection', 'missing_socket', 'unknown_host'] as const) {
  test(`안전하지 않거나 불명확한 client transport를 거부한다: ${failure}`, t => {
    const f = fixture(t);
    let client: unknown = f.client, host = pooler;
    if (failure === 'plain') client = { connection: { stream: { encrypted: true, authorized: true } } };
    if (failure === 'authorized') f.socket.authorized = false;
    if (failure === 'encrypted') Object.defineProperty(f.socket, 'encrypted', { value: false });
    if (failure === 'authorization_error') f.socket.authorizationError = new Error('SYNTHETIC_PRIVATE_TLS');
    if (failure === 'destroyed') f.socket.destroy();
    if (failure === 'hostname') host = direct;
    if (failure === 'missing_peer') t.mock.method(f.socket, 'getPeerCertificate', () => ({}));
    if (failure === 'missing_raw') t.mock.method(f.socket, 'getPeerCertificate', () => ({ subjectaltname: `DNS:${pooler}` }));
    if (failure === 'throw') t.mock.method(f.socket, 'getPeerCertificate', () => { throw new Error('SYNTHETIC_PRIVATE_TLS'); });
    if (failure === 'missing_connection') client = {};
    if (failure === 'missing_socket') client = { connection: {} };
    if (failure === 'unknown_host') host = 'unapproved.example';
    assert.throws(() => inspectClientTransport(client as Parameters<typeof inspectClientTransport>[0], host),
      (error: unknown) => error instanceof Error && error.message === 'customer_db_transport_configuration');
  });
}
for (const transport of ['session_pooler', 'direct'] as const) {
  for (const value of [true, false, null, undefined, 'true', 1]) {
    test(`${transport} backend 관측을 frontend TLS와 구분한다: ${String(value)}`, () => {
      if (value === true || transport === 'session_pooler' && value === false) {
        assert.doesNotThrow(() => validateBackendTls(value, transport));
      } else {
        assert.throws(() => validateBackendTls(value, transport),
          (error: unknown) => error instanceof Error && error.message === 'customer_db_transport_configuration');
      }
    });
  }
}
