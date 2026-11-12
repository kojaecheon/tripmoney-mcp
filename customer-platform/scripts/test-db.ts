import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectionConfig, readDbTestConfig } from '../server/db/config.js';
import { readSecretEnvFile } from '../server/config/secret-env.js';

const allowedKeys = ['CUSTOMER_DB_TEST_APPROVED', 'CUSTOMER_DB_TEST_ID', 'CUSTOMER_DB_TEST_ADMIN_URL',
  'CUSTOMER_DB_TEST_URL', 'CUSTOMER_DB_AUTH_URL'] as const;
let childEnv: NodeJS.ProcessEnv;
let suiteFile: string;
try {
  const suite = process.env.CUSTOMER_DB_TEST_SUITE ?? 'identity';
  const suites: Record<string, string> = { identity: 'tests/db/identity.test.ts', auth: 'tests/db/auth.test.ts',
    travel: 'tests/db/travel.test.ts', channel: 'tests/db/channel.test.ts' };
  if (!Object.hasOwn(suites, suite)) throw new Error();
  suiteFile = suites[suite]!;
  // 승인 없는 단위 실행은 유효한 실제 파일이 있어도 파일을 열지 않는다.
  if (process.env.CUSTOMER_DB_TEST_APPROVED !== 'true') throw new Error();
  const secret = readSecretEnvFile(new URL('../.env.db-test', import.meta.url), allowedKeys);
  readDbTestConfig(secret);
  childEnv = Object.fromEntries(allowedKeys.map((key) => [key, secret[key]]));
} catch {
  console.error('customer_db_configuration: 승인된 신규 테스트 DB 연결·역할·식별값을 확인해 주세요.');
  process.exit(78);
}
// 승인·대상 검사를 통과하기 전에는 pg 모듈이나 DB fixture를 로드하지 않는다.
let exitCode = 1;
let recovery: typeof import('../server/db/auth-test-recovery.js') | undefined;
let durableRecovery: typeof import('../server/db/durable-test-recovery.js') | undefined;
let manifestCreated = false;
type RecoveryConnect = Parameters<typeof import('../server/db/auth-test-recovery.js').recoverAuthTestManifest>[1];
try {
  const authSuite = suiteFile === 'tests/db/auth.test.ts';
  const durableSuite = suiteFile === 'tests/db/travel.test.ts' || suiteFile === 'tests/db/channel.test.ts';
  if (authSuite) {
    recovery = await import('../server/db/auth-test-recovery.js');
    recovery.createAuthTestManifest();
    manifestCreated = true;
  } else if (durableSuite) {
    durableRecovery = await import('../server/db/durable-test-recovery.js');
    durableRecovery.createDurableTestManifest(childEnv.CUSTOMER_DB_TEST_ID!);
    manifestCreated = true;
  }
  const args = ['--import', 'tsx', '--test', '--test-reporter=spec'];
  // A single writer process lets spawnSync confirm writer termination before recovery.
  if (authSuite || durableSuite) args.push('--experimental-test-isolation=none');
  args.push(suiteFile);
  const result = spawnSync(process.execPath, args, {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: childEnv, stdio: 'inherit', timeout: 180000,
  });
  exitCode = result.status === 0 ? 0 : 1;
} catch {
  console.error('customer_db_test_failed');
} finally {
  const selected = durableRecovery ? { kind: 'durable',
    recover: (connect: RecoveryConnect) =>
      durableRecovery!.recoverDurableTestManifest(durableRecovery!.durableTestManifestPath, childEnv.CUSTOMER_DB_TEST_ID!, connect),
    guard: durableRecovery.guardDurableTestClient } : recovery ? { kind: 'auth',
    recover: (connect: RecoveryConnect) =>
      recovery!.recoverAuthTestManifest(recovery!.authTestManifestPath, connect), guard: recovery.guardAuthTestClient } : undefined;
  if (manifestCreated && selected) {
    try {
      // spawnSync has returned or failed without a running child. No writer can send more SQL.
      await selected.recover(async () => {
        const config = readDbTestConfig(childEnv);
        const { default: pg } = await import('pg');
        const pool = new pg.Pool(connectionConfig(config.adminUrl, 'admin'));
        pool.on('error', () => { console.error(`customer_${selected.kind}_test_recovery_connection_error`); });
        try {
          const client = selected.guard(await pool.connect());
          try {
            const result = await client.query('select current_user as role,current_database() as database');
            if (result.rows[0]?.role !== 'postgres' || result.rows[0]?.database !== 'postgres') throw new Error();
          } catch {
            try { client.release(true); } catch { /* Keep the original fixed failure. */ }
            throw new Error();
          }
          return { query: (query, values) => client.query(query, values),
            async close() { try { client.release(); } finally { await pool.end(); } } };
        } catch {
          await pool.end(); throw new Error(`customer_${selected.kind}_test_recovery_connect_failed`);
        }
      });
      console.error(`customer_${selected.kind}_test_recovery_verified`);
    } catch {
      // Preserve the 0600 manifest so the controller can retry scoped recovery.
      console.error(`customer_${selected.kind}_test_recovery_failed_manifest_preserved`);
      exitCode = 1;
    }
  }
}
process.exit(exitCode);
