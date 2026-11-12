import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = 'agddopryfqsyfshoowgk';
const host = `db.${project}.supabase.co`;
const approved = () => ({
  CUSTOMER_DB_TEST_APPROVED: 'true', CUSTOMER_DB_TEST_ID: `${host}:5432/postgres`,
  CUSTOMER_DB_TEST_ADMIN_URL: `postgresql://postgres:synthetic-only@${host}:5432/postgres`,
  CUSTOMER_DB_TEST_URL: `postgresql://customer_app_login:synthetic-only@${host}:5432/postgres`,
  CUSTOMER_DB_AUTH_URL: `postgresql://customer_auth_login:synthetic-only@${host}:5432/postgres`,
});

function runCli(t: { after(fn: () => void): void }, values: Record<string, string>, options: {
  mode?: number; parentApproved?: boolean; childStatus?: number | null; suite?: string; denySecretRead?: boolean; recoveryFails?: boolean; exerciseRecovery?: 'role' | 'commit' | 'release';
} = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'tripmoney-db-cli-'));
  const path = join(directory, 'synthetic.env');
  fs.writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 });
  fs.chmodSync(path, options.mode ?? 0o600);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const code = `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports, registerHooks } from 'node:module';
    const originalOpen = fs.openSync;
    const originalStat = fs.lstatSync;
    let secretOpens = 0;
    const mapped = (path) => {
      if (String(path).endsWith('/.env.db-test')) { secretOpens++; return process.env.SYNTHETIC_SECRET_FILE; }
      return path;
    };
    fs.openSync = (path, ...args) => originalOpen(mapped(path), ...args);
    fs.lstatSync = (path, ...args) => originalStat(mapped(path), ...args);
    cp.spawnSync = (command, args, options) => {
      globalThis.syntheticChildEnded = true;
      console.log(JSON.stringify({ child: true, executable: command === process.execPath, args,
        keys: Object.keys(options.env).sort(), safe: options.env.NODE_OPTIONS === undefined
          && options.env.PGOPTIONS === undefined && options.env.DATABASE_URL === undefined,
        fileApproval: options.env.CUSTOMER_DB_TEST_APPROVED === 'true' }));
      return { status: ${JSON.stringify(options.childStatus === undefined ? 0 : options.childStatus)} };
    };
    syncBuiltinESMExports();
    globalThis.fetch = () => { throw new Error('NETWORK_ATTEMPT'); };
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'pg' && ${JSON.stringify(options.exerciseRecovery !== undefined)}) return {
        url: 'data:text/javascript,' + encodeURIComponent(\`
          import {EventEmitter} from 'node:events';
          class Client extends EventEmitter {
            async query(query) {
              if ((${JSON.stringify(options.exerciseRecovery)} === 'role' && query.includes('current_user'))
                || (${JSON.stringify(options.exerciseRecovery)} === 'commit' && query === 'commit'))
                this.emit('error', new Error('SYNTHETIC_RAW_PG_EVENT_SECRET'));
              return {rows:[{role:'postgres',database:'postgres'}]};
            }
            release(discard) {
              this.released=true; this.discarded=Boolean(discard);
              if (${JSON.stringify(options.exerciseRecovery)} === 'release') this.emit('error',new Error('SYNTHETIC_RAW_RELEASE_SECRET'));
            }
            async end(){ this.ended=true; }
          }
          class Pool extends EventEmitter {
            async connect(){ const client=new Client(); globalThis.syntheticPgClient=client; return client; }
            async end(){ globalThis.syntheticPgPoolEnded=true; }
          }
          export default {Pool};
        \`), shortCircuit:true };
      if (specifier.endsWith('/auth-test-recovery.js')) return {
        url: 'data:text/javascript,' + encodeURIComponent(\`
          export { guardAuthTestClient } from ${JSON.stringify(new URL('../../server/db/auth-test-recovery.ts', import.meta.url).href)};
          export const authTestManifestPath='synthetic-manifest';
          export function createAuthTestManifest(){ globalThis.syntheticManifestCreated=true; }
          export async function recoverAuthTestManifest(path, connect){
            if(!globalThis.syntheticChildEnded) throw new Error('RECOVERY_BEFORE_CHILD_EXIT');
            globalThis.syntheticRecovered=true;
            if (${JSON.stringify(options.recoveryFails === true)}) throw new Error('SYNTHETIC_RAW_RECOVERY_SECRET');
            if (${JSON.stringify(options.exerciseRecovery !== undefined)}) {
              let db;
              try { db=await connect(); await db.query('commit'); }
              finally { if(db) await db.close(); }
            }
          }
        \`), shortCircuit: true };
      if (specifier.endsWith('/durable-test-recovery.js')) return {
        url: 'data:text/javascript,' + encodeURIComponent(\`
          export {guardAuthTestClient as guardDurableTestClient} from ${JSON.stringify(new URL('../../server/db/auth-test-recovery.ts', import.meta.url).href)};
          export const durableTestManifestPath='synthetic-durable-manifest';
          export function createDurableTestManifest(target){
            if(target!==${JSON.stringify(approved().CUSTOMER_DB_TEST_ID)})throw Error('WRONG_TARGET');
            globalThis.syntheticManifestCreated=true;
          }
          export async function recoverDurableTestManifest(path,target,connect){
            if(!globalThis.syntheticChildEnded)throw Error('RECOVERY_BEFORE_CHILD_EXIT');
            if(target!==${JSON.stringify(approved().CUSTOMER_DB_TEST_ID)})throw Error('WRONG_TARGET');
            globalThis.syntheticRecovered=true;
            if(${JSON.stringify(options.recoveryFails === true)})throw Error('SYNTHETIC_RAW_DURABLE_RECOVERY_SECRET');
          }
        \`), shortCircuit:true };
      if (specifier === 'pg' || specifier.includes('/fixtures')) throw new Error('DB_IMPORTED_BEFORE_CHILD');
      return next(specifier, context);
    }});
    process.on('exit', () => {
      if (['auth','travel','channel'].includes(process.env.CUSTOMER_DB_TEST_SUITE) && globalThis.syntheticChildEnded
        && (!globalThis.syntheticManifestCreated || !globalThis.syntheticRecovered)) process.exitCode=99;
      if (${JSON.stringify(options.exerciseRecovery !== undefined)}) {
        const client=globalThis.syntheticPgClient;
        if (!client?.released || !(client.discarded || client.ended) || client.listenerCount('error') !== 0
          || !globalThis.syntheticPgPoolEnded) process.exitCode=99;
      }
      if (globalThis.secretFileExecuted || ((process.env.CUSTOMER_DB_TEST_APPROVED !== 'true' || ${JSON.stringify(options.denySecretRead === true)}) && secretOpens > 0)) process.exitCode = 99;
    });
    await import('./scripts/test-db.ts');
  `;
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 10000,
    env: { ...approved(), CUSTOMER_DB_TEST_APPROVED: options.parentApproved === false ? 'false' : 'true',
      ...(options.suite === undefined ? {} : { CUSTOMER_DB_TEST_SUITE: options.suite }),
      PGOPTIONS: '-c role=postgres', DATABASE_URL: 'DO_NOT_LEAK', SYNTHETIC_SECRET_FILE: path },
  });
}

test('DB CLI는 고정 파일을 검사하고 5개 허용 키만 자식에 전달한다', (t) => {
  const result = runCli(t, approved());
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.child, true);
  assert.equal(report.executable, true);
  assert.equal(report.safe, true);
  assert.equal(report.fileApproval, true);
  assert.deepEqual(report.keys, ['CUSTOMER_DB_AUTH_URL', 'CUSTOMER_DB_TEST_ADMIN_URL',
    'CUSTOMER_DB_TEST_APPROVED', 'CUSTOMER_DB_TEST_ID', 'CUSTOMER_DB_TEST_URL']);
  assert.deepEqual(report.args, ['--import', 'tsx', '--test', '--test-reporter=spec', 'tests/db/identity.test.ts']);
});

test('DB CLI 상위 승인이 없으면 유효한 합성 파일도 열지 않고 exit78이다', (t) => {
  const result = runCli(t, approved(), { parentApproved: false });
  assert.equal(result.status, 78);
  assert.equal(result.stdout, '');
});

for (const [name, patch, mode] of [
  ['파일 승인 누락', { CUSTOMER_DB_TEST_APPROVED: '' }, 0o600],
  ['0644 파일', {}, 0o644],
  ['NODE_OPTIONS 포함', { NODE_OPTIONS: '--import=data:text/javascript,globalThis.secretFileExecuted=true' }, 0o600],
  ['허용 밖 CUSTOMER 키', { CUSTOMER_OTHER: 'DO_NOT_LEAK' }, 0o600],
] as const) {
  test(`DB CLI ${name}는 pg·자식 실행 없이 exit78이다`, (t) => {
    const result = runCli(t, { ...approved(), ...patch }, { mode });
    assert.equal(result.status, 78);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /customer_db_configuration/);
    assert.doesNotMatch(result.stderr, /DO_NOT_LEAK|synthetic-only|NODE_OPTIONS|secretFileExecuted/);
  });
}

for (const status of [1, null]) {
  test(`DB CLI 자식 실패 ${status}는 exit1이다`, (t) => {
    const result = runCli(t, approved(), { childStatus: status });
    assert.equal(result.status, 1);
  });
}

for (const suite of ['identity', 'auth', 'travel', 'channel']) {
  test(`DB CLI 허용 suite ${suite}는 지정한 시험만 자식으로 실행한다`, (t) => {
    const result = runCli(t, approved(), { suite });
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.args.at(-1), `tests/db/${suite}.test.ts`);
    assert.equal(report.keys.includes('CUSTOMER_DB_TEST_SUITE'), false);
    assert.equal(report.keys.length, 5);
    assert.equal(report.args.includes('--experimental-test-isolation=none'), suite !== 'identity');
  });
}
for (const suite of ['travel', 'channel']) {
  test(`DB CLI ${suite}도 상위 승인 없이 파일·pg·자식 실행을 시작하지 않는다`, t => {
    const result = runCli(t, approved(), { suite, parentApproved: false, denySecretRead: true });
    assert.equal(result.status, 78); assert.equal(result.stdout, '');
  });
}
for (const suite of ['', 'AUTH', '../identity', '../travel', 'travel.test.ts', 'channel.test.ts', 'all', '__proto__', 'constructor']) {
  test(`DB CLI 허용 밖 suite ${JSON.stringify(suite)}는 파일 열기 전 exit78이다`, (t) => {
    const result = runCli(t, approved(), { suite, denySecretRead: true });
    assert.equal(result.status, 78);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /customer_db_configuration/);
  });
}

for (const childStatus of [1, null]) test(`auth child 종료 ${childStatus} 뒤에도 parent 복구를 실행한다`, t => {
  const result = runCli(t, approved(), { suite: 'auth', childStatus });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).child, true);
});

for (const suite of ['travel', 'channel']) {
  for (const childStatus of [1, null]) test(`${suite} 자식 실패·강제 종료 ${childStatus} 후 parent 복구를 실행한다`, t => {
    const result = runCli(t, approved(), { suite, childStatus });
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).child, true);
    assert.match(result.stderr, /customer_durable_test_recovery_verified/);
  });
  test(`${suite} parent 복구 실패는 manifest 보존과 고정 오류를 반환한다`, t => {
    const result = runCli(t, approved(), { suite, recoveryFails: true });
    assert.equal(result.status, 1); assert.match(result.stderr, /customer_durable_test_recovery_failed_manifest_preserved/);
    assert.doesNotMatch(result.stderr, /SYNTHETIC_RAW|synthetic-only|DO_NOT_LEAK/);
  });
}

test('auth parent 복구 실패는exit1과고정manifest보존오류를출력한다', t => {
  const result = runCli(t, approved(), { suite: 'auth', recoveryFails: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /customer_auth_test_recovery_failed_manifest_preserved/);
  assert.doesNotMatch(result.stderr, /SYNTHETIC_RAW_RECOVERY_SECRET|synthetic-only|DO_NOT_LEAK/);
});

for (const exerciseRecovery of ['role', 'commit', 'release'] as const) {
  test(`auth CLI 실제연결callback의 ${exerciseRecovery} error는고정실패·폐기·종료를확인한다`, t => {
    const result = runCli(t, approved(), { suite: 'auth', exerciseRecovery });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /customer_auth_test_recovery_failed_manifest_preserved/);
    assert.doesNotMatch(result.stderr, /SYNTHETIC_RAW|synthetic-only|DO_NOT_LEAK|Unhandled/);
  });
}
