import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createDurableTestManifest, gatedDurableTestPool, guardDurableTestClient, loadDurableTestManifest, recoverDurableTestManifest } from '../../server/db/durable-test-recovery.js';
import { identityDbError } from '../../server/db/actor.js';
import { guardAuthTestClient } from '../../server/db/auth-test-recovery.js';

const target = 'db.agddopryfqsyfshoowgk.supabase.co:5432/postgres';
test('durable 질의 오류는 안전한 SQLSTATE만 보존하고 auth 기본값은 원문과 code를 모두 숨긴다', async () => {
  const client = (code: string) => Object.assign(new EventEmitter(), { async query() {
    throw Object.assign(new Error('SYNTHETIC_RAW_DB_SECRET'), { code, detail: 'SECRET_DETAIL', query: 'SECRET_QUERY' });
  }, release() {}, async end() {} });
  for (const [sqlstate, expected] of [['P0404', 'not_found'], ['P0409', 'conflict'], ['P0403', 'forbidden'], ['P0422', 'validation']]) {
    const guarded = guardDurableTestClient(client(sqlstate!) as never);
    await assert.rejects(guarded.query('select product_function()'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'auth_test_client_failed');
      assert.equal(Reflect.get(error, 'code'), sqlstate);
      assert.deepEqual(Object.keys(error), ['code']);
      assert.equal(identityDbError(error).code, expected);
      assert.doesNotMatch(JSON.stringify(error), /SECRET/); return true;
    });
    guarded.release();
  }
  for (const mode of ['auth-default', 'invalid-code']) {
    const raw = client(mode === 'invalid-code' ? 'RAW_SECRET_CODE' : 'P0404');
    const guarded = mode === 'auth-default' ? guardAuthTestClient(raw as never) : guardDurableTestClient(raw as never);
    await assert.rejects(guarded.query('select product_function()'), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(Reflect.get(error, 'code'), undefined);
      assert.equal(error.message, 'auth_test_client_failed'); return true;
    }); guarded.release();
  }
});
test('durable 제품 pool도 SQLSTATE를 보존하고 error 이벤트 뒤에는 code를 전달하지 않는다', async t => {
  const manifest = createDurableTestManifest(target, location(t));
  const raw = Object.assign(new EventEmitter(), { async query(sql: string) {
    if (sql === 'select forbidden_product()') throw Object.assign(Error('SYNTHETIC_RAW_SECRET'), { code: 'P0403', detail: 'SECRET' });
    return { rows: [] };
  }, release() {}, async end() {} });
  const pool = gatedDurableTestPool({ async connect() { return raw; } } as never, manifest);
  const lease = await pool.connect(); await lease.query('begin');
  await assert.rejects(lease.query('select forbidden_product()'), (error: unknown) => identityDbError(error).code === 'forbidden');
  raw.emit('error', Object.assign(Error('SYNTHETIC_RAW_EVENT_SECRET'), { code: 'P0403' }));
  await assert.rejects(lease.query('select forbidden_product()'), (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(Reflect.get(error, 'code'), undefined); return true;
  });
  assert.throws(() => lease.release(), { message: 'auth_test_client_failed' });
});
function location(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'tripmoney-durable-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return join(dir, 'manifest.jsonl');
}
test('합성 actor와 scope는 쓰기 전에0600 manifest에 영구 등록한다', t => {
  const path = location(t), manifest = createDurableTestManifest(target, path);
  const actor = manifest.registerActor(0, 'a'.repeat(64));
  const scope = `db-test:${manifest.runId}:capacity`; manifest.registerUsageScope(scope);
  const loaded = loadDurableTestManifest(path, target);
  assert.deepEqual(loaded.actors, [actor]); assert.deepEqual(loaded.usageScopes, [scope]);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.throws(() => manifest.registerActor(0, 'b'.repeat(64)), /durable_test_manifest/);
  assert.throws(() => manifest.registerUsageScope('real-provider-scope'), /durable_test_manifest/);
  assert.throws(() => createDurableTestManifest(target, path), /durable_test_manifest/);
});
test('manifest의 대상·권한·symlink·합성 UUID 변조는 DB 연결 전에 거절한다', async t => {
  for (const kind of ['target', 'mode', 'symlink', 'actor', 'extra', 'scope']) {
    const path = location(t), manifest = createDurableTestManifest(target, path);
    manifest.registerActor(0, 'a'.repeat(64));
    if (kind === 'target') {
      const text = fs.readFileSync(path, 'utf8').replace(target, 'other.supabase.co:5432/postgres'); fs.writeFileSync(path, text);
    } else if (kind === 'mode') fs.chmodSync(path, 0o644);
    else if (kind === 'symlink') { fs.renameSync(path, path + '.real'); fs.symlinkSync(path + '.real', path); }
    else if (kind === 'actor') fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replace(manifest.actors[0]!.userId, '00000000-0000-4000-8000-000000000001'));
    else if (kind === 'extra') fs.appendFileSync(path, JSON.stringify({ kind: 'actor', index: 1, userId: 'real', sessionHash: 'a'.repeat(64), extra: true }) + '\n');
    else fs.appendFileSync(path, JSON.stringify({ kind: 'usage', scope: 'real-provider-scope' }) + '\n');
    let connected = false;
    await assert.rejects(recoverDurableTestManifest(path, target, async () => { connected = true; throw Error(); }),
      { message: 'durable_test_recovery_failed' });
    assert.equal(connected, false); assert.equal(fs.existsSync(path), true);
  }
  const path = location(t); createDurableTestManifest(target, path);
  assert.throws(() => loadDurableTestManifest(path, 'aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres'), /durable_test_manifest/);
});
test('SIGKILL 뒤에도 등록된 합성 actor와 scope만 정리하고0행 확인 후 manifest를 삭제한다', async t => {
  const path = location(t); createDurableTestManifest(target, path);
  const script = `import {loadDurableTestManifest} from './server/db/durable-test-recovery.ts';
    const m=loadDurableTestManifest(${JSON.stringify(path)},${JSON.stringify(target)});
    m.registerActor(0,${JSON.stringify('a'.repeat(64))});m.registerUsageScope('db-test:'+m.runId+':capacity');
    process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 5000, env: {} });
  assert.equal(child.signal, 'SIGKILL');
  const manifest = loadDurableTestManifest(path, target), calls: { sql: string; args?: unknown[] }[] = [];
  await recoverDurableTestManifest(path, target, async () => ({
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.startsWith('select trip_id')) return { rows: [{ trip_id: '00000000-0000-4000-8000-000000000002' }] };
      return { rows: sql.startsWith('select count') ? [{ n: 0 }] : [] };
    }, async close() { calls.push({ sql: 'close' }); },
  }));
  const lock = calls.findIndex(c => c.sql.includes('pg_advisory_xact_lock('));
  assert.ok(lock >= 0); assert.deepEqual(calls[lock]!.args, [manifest.gate]);
  assert.ok(calls.findIndex(c => c.sql.startsWith('delete')) > lock);
  assert.ok(calls.some(c => c.sql.startsWith('delete from customer_private.travel_documents') && JSON.stringify(c.args).includes('00000000-0000-4000-8000-000000000002')));
  assert.ok(calls.some(c => c.sql.startsWith('delete from customer_auth.sessions') && JSON.stringify(c.args) === JSON.stringify([manifest.actors.map(a => a.sessionHash)])));
  assert.ok(calls.some(c => c.sql.startsWith('delete from customer_private.provider_usage_reservations') && JSON.stringify(c.args) === JSON.stringify([manifest.usageScopes])));
  assert.ok(calls.filter(c => c.sql.startsWith('delete')).every(c => c.sql.includes(' where ') && !c.sql.includes('truncate')));
  assert.equal(calls.at(-1)!.sql, 'close'); assert.equal(fs.existsSync(path), false);
});
test('복구는 남은 transaction shared gate가 끝나기 전에는 삭제하지 않는다', async t => {
  const path = location(t); createDurableTestManifest(target, path).registerActor(0, 'a'.repeat(64));
  const events: string[] = []; let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const recovery = recoverDurableTestManifest(path, target, async () => ({
    async query(sql) {
      if (sql.includes('pg_advisory_xact_lock(')) { events.push('waiting'); await gate; events.push('writer-finished'); }
      if (sql.startsWith('delete')) events.push('delete');
      return { rows: sql.startsWith('select count') ? [{ n: 0 }] : [] };
    }, async close() {},
  }));
  await new Promise(resolve => setTimeout(resolve, 10)); assert.deepEqual(events, ['waiting']);
  finish(); await recovery; assert.equal(events.indexOf('writer-finished') < events.indexOf('delete'), true);
});
test('제품 BEGIN과 직접 fixture DML은 같은 manifest shared gate를 쓰기 전에 획득한다', async t => {
  const path = location(t), manifest = createDurableTestManifest(target, path);
  const actor = manifest.registerActor(0, 'a'.repeat(64)), calls: { sql: string; args?: unknown[] }[] = [];
  const client = Object.assign(new EventEmitter(), { async query(sql: string, args?: unknown[]) {
    calls.push({ sql, args });
    if (sql.startsWith('insert')) assert.deepEqual(loadDurableTestManifest(path).actors, [actor]);
    return { rows: [] };
  }, release() {}, async end() {} });
  const pool = gatedDurableTestPool({ async connect() { return client; } } as never, manifest);
  await pool.query('insert into customer_auth.sessions values($1)', [actor.sessionHash]);
  const lease = await pool.connect(); await lease.query('begin'); await lease.query('select product_function()');
  await lease.query('commit'); lease.release();
  assert.equal(calls[0]!.sql, 'begin'); assert.match(calls[1]!.sql, /pg_advisory_xact_lock_shared/);
  assert.deepEqual(calls[1]!.args, [manifest.gate]);
  assert.equal(calls.filter(c => c.sql.includes('pg_advisory_xact_lock_shared')).length, 2);
});
test('복구 실패·잔여행·close 오류는 고정 오류와 manifest를 보존한다', async t => {
  for (const kind of ['delete', 'remaining', 'close']) {
    const path = location(t); createDurableTestManifest(target, path).registerActor(0, 'a'.repeat(64));
    await assert.rejects(recoverDurableTestManifest(path, target, async () => ({
      async query(sql) {
        if (kind === 'delete' && sql.startsWith('delete')) throw Error('SYNTHETIC_RAW_DB_SECRET');
        return { rows: sql.startsWith('select count') ? [{ n: kind === 'remaining' ? 1 : 0 }] : [] };
      }, async close() { if (kind === 'close') throw Error('SYNTHETIC_RAW_CLOSE_SECRET'); },
    })), { message: 'durable_test_recovery_failed' });
    assert.equal(fs.existsSync(path), true); assert.doesNotMatch(fs.readFileSync(path, 'utf8'), /SYNTHETIC_RAW/);
  }
});
