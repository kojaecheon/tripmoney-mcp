import { TLSSocket, checkServerIdentity } from 'node:tls';
import type { Client } from 'pg';
import { approvedDevelopmentProjectRef } from './config.js';

export type DatabaseTransport = 'direct' | 'session_pooler';
// pg 8.23.1과 설치된 @types/pg의 선언된 connection.stream 읽기 경계다.
export type DatabaseTransportClient = { readonly connection: Pick<Client['connection'], 'stream'> };
const invalid = () => new Error('customer_db_transport_configuration');

export function inspectClientTransport(client: DatabaseTransportClient, hostname: string): DatabaseTransport {
  try {
    const direct = hostname === `db.${approvedDevelopmentProjectRef}.supabase.co`;
    const pooled = hostname === 'aws-0-ap-northeast-2.pooler.supabase.com'
      || hostname === 'aws-1-ap-northeast-2.pooler.supabase.com';
    const socket = client?.connection?.stream;
    if ((!direct && !pooled) || !(socket instanceof TLSSocket) || socket.destroyed
      || socket.encrypted !== true || socket.authorized !== true
      || (socket.authorizationError !== null && socket.authorizationError !== undefined)) throw invalid();
    const peer = socket.getPeerCertificate();
    if (!peer || !Buffer.isBuffer(peer.raw) || peer.raw.length === 0
      || checkServerIdentity(hostname, peer) !== undefined) throw invalid();
    return direct ? 'direct' : 'session_pooler';
  } catch { throw invalid(); }
}

// pg_stat_ssl은 DB가 받은 backend hop의 관측이다. frontend 인증을 대신하지 않는다.
export function validateBackendTls(value: unknown, transport: DatabaseTransport): void {
  if (typeof value !== 'boolean' || (transport !== 'direct' && transport !== 'session_pooler')
    || (transport === 'direct' && value !== true)) throw invalid();
}
