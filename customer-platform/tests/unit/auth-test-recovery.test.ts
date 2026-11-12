import test from 'node:test';
import { EventEmitter } from 'node:events';
import * as recovery from '../../server/db/auth-test-recovery.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAuthTestManifest, loadAuthTestManifest, recoverAuthTestManifest, gatedAuthTestPool } from '../../server/db/auth-test-recovery.js';

function location(t: { after(fn: () => void): void }) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'tripmoney-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'manifest.jsonl');
}
const hash = 'a'.repeat(64);

test('manifest는0600이며 등록이 반환되기 전에 hash가 파일에 남고 원문은 허용하지 않는다', t => {
  const path = location(t), manifest = createAuthTestManifest(path);
  manifest.register('session', hash);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(loadAuthTestManifest(path).hashes.session, [hash]);
  assert.throws(() => manifest.register('session', 'raw-cookie-token'), /auth_test_manifest/);
  assert.equal(fs.readFileSync(path, 'utf8').includes('raw-cookie-token'), false);
  assert.throws(() => createAuthTestManifest(path), /auth_test_manifest/);
});

test('합성 child 중도 종료 후 parent는 등록된 키만 복구하고0행확인 뒤 manifest를삭제한다', async t => {
  const path = location(t); createAuthTestManifest(path);
  const script = `import {loadAuthTestManifest} from './server/db/auth-test-recovery.ts';
    const manifest=loadAuthTestManifest(${JSON.stringify(path)}); manifest.register('session',${JSON.stringify(hash)});
    const fs=await import('node:fs');
    if(!loadAuthTestManifest(${JSON.stringify(path)}).hashes.session.includes(${JSON.stringify(hash)})) throw new Error('NOT_REGISTERED');
    fs.writeFileSync(${JSON.stringify(path + '.written')},'synthetic-write-completed');
    setInterval(()=>{},1000);`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 1000, env: {},
  });
  assert.equal(child.status, null); assert.equal(child.signal, 'SIGTERM');
  assert.deepEqual(loadAuthTestManifest(path).hashes.session, [hash]);
  assert.equal(fs.readFileSync(path + '.written', 'utf8'), 'synthetic-write-completed');
  const calls: string[] = [];
  await recoverAuthTestManifest(path, async () => ({
    async query(query: string, values?: unknown[]) {
      calls.push(query);
      if (query.startsWith('delete from customer_auth.sessions')) {
        assert.match(query, /where hash=any/); assert.deepEqual(values, [[hash]]);
      }
      return { rows: query.startsWith('select count') ? [{ n: 0 }] : [] };
    }, async close() { calls.push('close'); },
  }));
  assert.equal(calls.some(query => query.includes('pg_advisory_xact_lock(')), true);
  assert.equal(fs.existsSync(path), false);
  assert.equal(calls.at(-1), 'close');
});

test('정리 실패 또는 잔여행이 있으면 manifest를 보존하고 원시DB오류를 숨긴다', async t => {
  for (const fail of ['delete', 'remaining']) {
    const path = location(t), manifest = createAuthTestManifest(path); manifest.register('challenge', hash);
    let result = '';
    try {
      await recoverAuthTestManifest(path, async () => ({
        async query(query: string) {
          if (fail === 'delete' && query.startsWith('delete')) throw new Error('SYNTHETIC_RAW_DB_SECRET');
          return { rows: query.startsWith('select count') ? [{ n: 1 }] : [] };
        }, async close() {},
      }));
    } catch (error) { result = error instanceof Error ? error.message : 'unknown'; }
    assert.equal(result, 'auth_test_recovery_failed');
    assert.equal(fs.existsSync(path), true);
    assert.equal(fs.readFileSync(path, 'utf8').includes('SYNTHETIC_RAW_DB_SECRET'), false);
  }
});

test('복구는exclusive gate획득으로남은쓰기종료를기다린후에만DELETE한다', async t => {
  const path = location(t); createAuthTestManifest(path).register('session', hash);
  const events: string[] = []; let finish!: () => void;
  const inFlight = new Promise<void>(resolve => { finish = resolve; });
  const recovery = recoverAuthTestManifest(path, async () => ({
    async query(query: string) {
      if (query.includes('pg_advisory_xact_lock(')) { events.push('exclusive-wait'); await inFlight; events.push('writer-finished'); }
      if (query.startsWith('delete')) events.push('delete');
      return { rows: query.startsWith('select count') ? [{ n: 0 }] : [] };
    }, async close() {},
  }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ['exclusive-wait']); finish(); await recovery;
  assert.equal(events.indexOf('writer-finished') < events.indexOf('delete'), true);
});

test('시험pool은제품BEGIN과직접DML모두쓰기전에shared gate를취득한다', async t => {
  const path = location(t), manifest = createAuthTestManifest(path); manifest.register('session', hash);
  const queries: string[] = [];
  const client = Object.assign(new EventEmitter(), { async query(query: string) {
    queries.push(query);
    if (/^(update|delete)/.test(query)) assert.deepEqual(loadAuthTestManifest(path).hashes.session, [hash]);
    return { rows: [] };
  }, release() {}, async end() {} });
  const pool = gatedAuthTestPool({ async connect() { return client; } } as never, manifest);
  const lease = await pool.connect(); await lease.query('begin'); await lease.query('update customer_auth.sessions set version=version where hash=$1', [hash]);
  await lease.query('commit'); lease.release();
  await pool.query('delete from customer_auth.sessions where hash=$1', [hash]);
  assert.equal(queries.filter(query => query.includes('pg_advisory_xact_lock_shared')).length, 2);
  assert.equal(queries[0], 'begin'); assert.match(queries[1]!, /pg_advisory_xact_lock_shared/);
  assert.equal(queries[4], 'begin'); assert.match(queries[5]!, /pg_advisory_xact_lock_shared/);
});

class EventClient extends EventEmitter {
  queries: string[] = []; released = false; discarded = false; ended = false;
  constructor(readonly phase: string) { super(); }
  async query(query: string) {
    this.queries.push(query);
    if ((this.phase === 'middle' && query.includes('statement_timeout'))
      || (this.phase === 'commit' && query === 'commit')) this.emit('error', new Error('SYNTHETIC_RAW_CLIENT_SECRET'));
    return { rows: query.startsWith('select count') ? [{ n: 0 }] : [] };
  }
  release(discard?: unknown) {
    this.released = true; this.discarded = Boolean(discard);
    if (this.phase === 'release') this.emit('error', new Error('SYNTHETIC_RAW_RELEASE_SECRET'));
  }
  async end() { this.ended = true; }
}
const guarded = (raw: EventClient) => {
  const guard = Reflect.get(recovery, 'guardAuthTestClient');
  assert.equal(typeof guard, 'function', 'guarded checkout helper is required');
  return (guard as (client: unknown) => unknown)(raw) as EventClient;
};

for (const phase of ['before', 'middle', 'commit', 'release']) {
  test(`checkout ${phase} error는영구실패·후속query차단·폐기·listener정리를보장한다`, async () => {
    const raw = new EventClient(phase), client = guarded(raw);
    if (phase === 'before') raw.emit('error', new Error('SYNTHETIC_RAW_BEFORE_SECRET'));
    let message = '';
    try {
      await client.query(phase === 'middle' ? "set local statement_timeout='30s'" : phase === 'commit' ? 'commit' : 'select 1');
      client.release();
    } catch (error) { message = error instanceof Error ? error.message : 'unknown'; }
    assert.equal(message, 'auth_test_client_failed');
    const prior = raw.queries.length;
    await assert.rejects(client.query('select 2'), { message: 'auth_test_client_failed' });
    assert.equal(raw.queries.length, prior);
    if (!raw.released) { try { client.release(); } catch {} }
    assert.equal(raw.released, true);
    assert.equal(raw.discarded || raw.ended, true);
    assert.equal(raw.listenerCount('error'), 0);
  });
  test(`복구 ${phase} client error는성공을반환하지않고manifest를보존한다`, async t => {
    const path = location(t); createAuthTestManifest(path).register('session', hash);
    const raw = new EventClient(phase);
    await assert.rejects(recoverAuthTestManifest(path, async () => {
      const client = guarded(raw);
      if (phase === 'before') raw.emit('error', new Error('SYNTHETIC_RAW_BEFORE_SECRET'));
      return { query: (query, values) => client.query(query), async close() { client.release(); } };
    }), { message: 'auth_test_recovery_failed' });
    assert.equal(fs.existsSync(path), true);
    assert.equal(raw.released, true); assert.equal(raw.discarded || raw.ended, true);
    assert.equal(raw.listenerCount('error'), 0);
  });
}

for (const phase of ['before', 'middle', 'commit', 'release']) {
  test(`gated DML ${phase} error는성공없이폐기하고listener를정리한다`, async t => {
    const path = location(t), manifest = createAuthTestManifest(path); manifest.register('session', hash);
    class DmlClient extends EventClient {
      override async query(query: string) {
        if ((phase === 'before' && query === 'begin')
          || (phase === 'middle' && query.includes('pg_advisory_xact_lock_shared')))
          this.emit('error', new Error('SYNTHETIC_RAW_DML_SECRET'));
        return super.query(query);
      }
    }
    const raw = new DmlClient(phase);
    const pool = gatedAuthTestPool({ async connect() { return raw; } } as never, manifest);
    let code = 'resolved';
    try { await pool.query('delete from customer_auth.sessions where hash=$1', [hash]); }
    catch (error) { code = error instanceof Error ? error.message : 'unknown'; }
    assert.equal(['auth_test_write_failed', 'auth_test_client_failed'].includes(code), true);
    assert.equal(raw.released, true); assert.equal(raw.discarded || raw.ended, true);
    assert.equal(raw.listenerCount('error'), 0);
  });
}

test('PID 관찰은gated checkout의기존guard를재사용하고제품listener설치전error도차단한다', async t => {
  const path = location(t), manifest = createAuthTestManifest(path), raw = new EventClient('before');
  const pool = gatedAuthTestPool({ async connect() { return raw; } } as never, manifest);
  const client = await pool.connect();
  const guard = Reflect.get(recovery, 'guardAuthTestClient');
  const observed = (guard as (client: unknown) => unknown)(client) as typeof client;
  assert.equal(observed, client); assert.equal(raw.listenerCount('error'), 1);
  raw.emit('error', new Error('SYNTHETIC_RAW_PID_SECRET'));
  await assert.rejects(observed.query('select pg_backend_pid() as pid'), { message: 'auth_test_client_failed' });
  assert.deepEqual(raw.queries, []);
  assert.throws(() => observed.release(true), { message: 'auth_test_client_failed' });
  assert.equal(raw.discarded, true); assert.equal(raw.listenerCount('error'), 0);
});
