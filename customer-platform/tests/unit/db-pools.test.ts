import test from 'node:test';
import assert from 'node:assert/strict';
import pg, { type PoolClient, type PoolConfig, type ClientConfig } from 'pg';
import { Duplex, PassThrough } from 'node:stream';
import { TLSSocket, type DetailedPeerCertificate } from 'node:tls';
import { validateRuntimeRole, createPools } from '../../server/db/pools.js';
import { IdentityError } from '../../core/contracts.js';

const valid = (kind: 'app' | 'auth') => ({
  current_user: kind === 'app' ? 'customer_app_login' : 'customer_auth_login', database: 'postgres',
  backend_ssl: true, superuser: false, bypassrls: false, createdb: false, createrole: false, replication: false, canlogin: true,
  expected_role: true, unexpected_memberships: 0, schema_create: false, provider_table_read: false,
  runtime_inherit: true, runtime_set: false, runtime_admin: false,
  owns_customer_objects: false,
  actor_context: null, session_context: null,
});
for (const role of ['app', 'auth'] as const) {
  test(`${role}의 제한된 로그인 역할과 TLS를 허용한다`, () => {
    assert.doesNotThrow(() => validateRuntimeRole(valid(role), role));
  });
  for (const patch of [
    { backend_ssl: false }, { superuser: true }, { bypassrls: true }, { createdb: true }, { createrole: true },
    { canlogin: false }, { expected_role: false }, { unexpected_memberships: 1 }, { replication: true },
    { runtime_inherit: false }, { runtime_set: true }, { runtime_admin: true },
    { schema_create: true }, { provider_table_read: true }, { owns_customer_objects: true }, { current_user: 'postgres' },
    { database: 'other' }, { actor_context: 'previous-user' }, { session_context: 'previous-hash' },
    { expected_role: undefined }, { replication: undefined }, { replication: null },
    { runtime_inherit: undefined }, { runtime_inherit: null },
    { runtime_set: undefined }, { runtime_set: null }, { runtime_admin: undefined }, { runtime_admin: null },
  ]) {
    test(`${role} 연결의 잘못된 실행 경계를 거부한다: ${Object.keys(patch)[0]}`, () => {
      assert.throws(() => validateRuntimeRole({ ...valid(role), ...patch }, role), IdentityError);
      if (!('backend_ssl' in patch)) {
        assert.throws(() => validateRuntimeRole({ ...valid(role), backend_ssl: false, ...patch }, role, 'session_pooler'), IdentityError);
      }
    });
  }
}

const host = 'db.agddopryfqsyfshoowgk.supabase.co';
const config = { appUrl: `postgresql://customer_app_login:synthetic@${host}:5432/postgres`,
  authUrl: `postgresql://customer_auth_login:synthetic@${host}:5432/postgres` };
function socketFixture(t: { after(fn: () => void): void }, hostname = host) {
  const socket = new TLSSocket(new PassThrough());
  // 체인 인증 결과와 peer만 합성한 double이며 실제 handshake를 주장하지 않는다.
  socket.authorized = true;
  socket.getPeerCertificate = () => ({ subjectaltname: `DNS:${hostname}`, raw: Buffer.from('synthetic-peer') }) as DetailedPeerCertificate;
  t.after(() => socket.destroy());
  return socket;
}

test('검증된 session pooler의 backend ssl=false는 runtime 역할 검사를 통과한다', () => {
  assert.doesNotThrow(() => validateRuntimeRole({ ...valid('app'), backend_ssl: false }, 'app', 'session_pooler'));
});

test('실제 Pool 객체 두 개를 준비하고 각 연결의 역할·TLS 메타데이터를 검증한다', async (t) => {
  let inspected = 0;
  let released = 0;
  t.mock.method(pg.Pool.prototype, 'connect', async () => {
    const kind = inspected++ === 0 ? 'app' : 'auth';
    return { connection: { stream: socketFixture(t) }, query: async (sql: string) => {
      assert.match(sql, /pg_catalog\.pg_roles/);
      return { rows: [valid(kind)], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
    }, release: () => { released++; } } as unknown as PoolClient;
  });
  const pools = await createPools(config);
  try {
    assert.equal(inspected, 2);
    assert.equal(released, 2);
    assert.equal(pools.app.options.max, 3);
    assert.equal(pools.auth.options.max, 3);
  } finally { await Promise.all([pools.app.end(), pools.auth.end()]); }
});

test('인증 LOGIN에 runtime SET 권한이 있으면 시작을 거부하고 두 Pool을 모두 닫는다', async (t) => {
  const seen: pg.Pool[] = [];
  let inspected = 0;
  t.mock.method(pg.Pool.prototype, 'connect', async function (this: pg.Pool) {
    seen.push(this);
    const row = inspected++ === 0 ? valid('app') : { ...valid('auth'), runtime_set: true };
    return { connection: { stream: socketFixture(t) }, query: async () => ({ rows: [row], rowCount: 1, command: 'SELECT', oid: 0, fields: [] }),
      release: () => {} } as unknown as PoolClient;
  });
  await assert.rejects(createPools(config), IdentityError);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((pool) => pool.ended));
});

test('pooler runtime은 frontend TLS 확인 후 backend=false를 별도로 관측한다', async t => {
  const pooledHost = 'aws-0-ap-northeast-2.pooler.supabase.com';
  const pooled = { appUrl: `postgresql://customer_app_login.agddopryfqsyfshoowgk:synthetic@${pooledHost}:5432/postgres`,
    authUrl: `postgresql://customer_auth_login.agddopryfqsyfshoowgk:synthetic@${pooledHost}:5432/postgres` };
  let inspected = 0;
  t.mock.method(pg.Pool.prototype, 'connect', async () => {
    const role = inspected++ === 0 ? 'app' : 'auth';
    return { connection: { stream: socketFixture(t, pooledHost) },
      query: async () => ({ rows: [{ ...valid(role), backend_ssl: false }] }), release() {} } as unknown as PoolClient;
  });
  const pools = await createPools(pooled);
  try {
    assert.equal(inspected, 2);
    for (const pool of [pools.app, pools.auth]) {
      // 실제 Client 생성자에 공개 stream factory를 전달한다. pg 상태를 덮어쓰지 않는다.
      const client = new pg.Client({ stream: () => socketFixture(t, pooledHost) });
      assert.doesNotThrow(() => pool.options.onConnect!(client));
    }
  } finally { await Promise.all([pools.app.end(), pools.auth.end()]); }
});

test('SQL backend=true라도 frontend 검증 실패는 query 전에 연결을 폐기하고 두 pool을 닫는다', async t => {
  const seen: pg.Pool[] = [];
  let queries = 0, released: unknown;
  t.mock.method(pg.Pool.prototype, 'connect', async function (this: pg.Pool) {
    seen.push(this);
    return { connection: { stream: new PassThrough() }, query: async () => { queries++; return { rows: [valid('app')] }; },
      release(error: unknown) { released = error; } } as unknown as PoolClient;
  });
  const ended: pg.Pool[] = [], end = pg.Pool.prototype.end;
  t.mock.method(pg.Pool.prototype, 'end', function (this: pg.Pool) {
    ended.push(this); return new Promise<void>(resolve => end.call(this, resolve));
  });
  await assert.rejects(createPools(config), IdentityError);
  assert.equal(queries, 0); assert.equal(released, true);
  assert.equal(ended.length, 2); assert.ok(ended.every(pool => pool.ended));
  assert.equal(seen.length, 1);
});

test('실제 Pool의 신규 연결 hook이 실패하면 acquire 전에 종료하고 startup의 두 pool을 정리한다', async t => {
  let clientEnded = 0, acquired = 0;
  t.mock.method(pg.Client.prototype, 'connect', function (callback: (error?: Error) => void) { callback(); });
  t.mock.method(pg.Client.prototype, 'end', function (this: pg.Client, callback?: () => void) {
    clientEnded++; this.connection.stream.destroy(); callback?.(); return Promise.resolve();
  });
  const ended: pg.Pool[] = [], end = pg.Pool.prototype.end;
  t.mock.method(pg.Pool.prototype, 'end', function (this: pg.Pool) {
    ended.push(this); return new Promise<void>(resolve => end.call(this, resolve));
  });
  const emit = pg.Pool.prototype.emit;
  t.mock.method(pg.Pool.prototype, 'emit', function (this: pg.Pool, event: string, ...args: unknown[]) {
    if (event === 'acquire') acquired++;
    return emit.call(this, event, ...args);
  });
  await assert.rejects(createPools(config), IdentityError);
  assert.equal(clientEnded, 1); assert.equal(acquired, 0);
  assert.equal(ended.length, 2); assert.ok(ended.every(pool => pool.ended));
});

test('소비자에게 반환한 Pool도 이후 새 연결에서 frontend를 검사한다', async t => {
  let inspected = 0;
  const connect = t.mock.method(pg.Pool.prototype, 'connect', async () => ({
    connection: { stream: socketFixture(t) },
    query: async () => ({ rows: [valid(inspected++ === 0 ? 'app' : 'auth')] }), release() {},
  } as unknown as PoolClient));
  const pools = await createPools(config);
  connect.mock.restore();
  let ended = 0;
  t.mock.method(pg.Client.prototype, 'connect', function (callback: (error?: Error) => void) { callback(); });
  t.mock.method(pg.Client.prototype, 'end', function (this: pg.Client, callback?: () => void) {
    ended++; this.connection.stream.destroy(); callback?.(); return Promise.resolve();
  });
  try {
    const result: unknown = await pools.app.connect().then(client => { client.release(); return 'unsafe'; }, error => error);
    assert.ok(result instanceof Error); assert.equal(result.message, 'customer_db_transport_configuration');
    assert.equal(ended, 1);
  } finally { await Promise.all([pools.app.end(), pools.auth.end()]); }
});

for (const phase of ['startup', 'later'] as const) {
  test(`${phase} TLS 거부는 실제 pg end의 Terminate 응답 정지에도 destroy 후 반환한다`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Node 자체 MockTimers 경고는 출력한 뒤 애플리케이션 오류 출력만 관측한다.
    await new Promise(resolve => setImmediate(resolve));
    const streams: SyntheticStream[] = [], pools: pg.Pool[] = [];
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...values: unknown[]) => { errors.push(values); });
    let terminated = 0, acquired = 0, queries = 0, clientEndEvents = 0;
    class SyntheticStream extends Duplex {
      _read() {}
      setNoDelay() {}
      setKeepAlive() {}
      connect() { queueMicrotask(() => this.emit('connect')); }
      _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        if (chunk[0] === 0x58) { terminated++; return; }
        if (chunk[0] === 0x51) queries++;
        callback();
        queueMicrotask(() => this.push(Buffer.from('5200000008000000005a0000000549', 'hex')));
      }
    }
    class SyntheticClient extends pg.Client {
      constructor(options?: ClientConfig) {
        const stream = new SyntheticStream(); streams.push(stream);
        // 공개 생성자 경계의 합성 plain 연결이다. 실제 connect/end·close lifecycle은 그대로 사용한다.
        super({ ...options, ssl: false, stream: () => stream, password: 'SYNTHETIC_PRIVATE_POOL' });
        this.on('end', () => { clientEndEvents++; });
      }
    }
    const Pool = pg.Pool;
    class SyntheticPool extends Pool {
      constructor(options?: PoolConfig) {
        super({ ...options, Client: SyntheticClient });
        pools.push(this); this.on('acquire', () => { acquired++; });
      }
    }
    t.mock.method(pg, 'Pool', SyntheticPool);
    let inspected = 0;
    const initial = phase === 'later' ? t.mock.method(Pool.prototype, 'connect', async () => ({
      connection: { stream: socketFixture(t) },
      query: async () => ({ rows: [valid(inspected++ === 0 ? 'app' : 'auth')] }), release() {},
    } as unknown as PoolClient)) : undefined;
    if (phase === 'later') {
      await createPools(config);
      initial!.mock.restore();
    }
    let result: unknown, completed = false;
    const pending = phase === 'startup' ? createPools(config) : pools[0]!.connect();
    const settled = pending.then(value => { completed = true; result = value; }, error => { completed = true; result = error; });
    t.after(async () => {
      streams.forEach(stream => stream.destroy());
      await settled;
      if (result && typeof result === 'object' && 'release' in result && typeof result.release === 'function') result.release();
      await Promise.allSettled(pools.map(pool => pool.end()));
    });
    await new Promise(resolve => setImmediate(resolve));
    const completedWithoutTimeout = completed;
    t.mock.timers.tick(60000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, true, `pg end 대기가 남음: Terminate=${terminated}, acquired=${acquired}`);
    assert.equal(completedWithoutTimeout, true);
    await settled;
    assert.ok(result instanceof Error);
    assert.equal(result.message, phase === 'startup' ? '잠시 후 다시 시도해 주세요.' : 'customer_db_transport_configuration');
    if (phase === 'startup') assert.ok(result instanceof IdentityError);
    assert.equal(result.message.includes('SYNTHETIC_PRIVATE_POOL'), false);
    assert.equal(streams.length, 1); assert.equal(streams[0]!.destroyed, true);
    assert.equal(clientEndEvents, 1);
    assert.equal(acquired, 0); assert.equal(queries, 0);
    assert.ok(errors.every(values => values.length === 1 && values[0] === 'customer_db_idle_connection_error'));
    if (phase === 'later') await Promise.all(pools.map(pool => pool.end()));
    assert.equal(pools.length, 2); assert.ok(pools.every(pool => pool.ended));
  });
}
