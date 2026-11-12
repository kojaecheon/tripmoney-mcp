// 실제 TTY와 합성 관리자 값, 임시 0600 파일, 모의 DB만 사용한다.
// 정상: synthetic-admin-@#% 입력 후 Enter. 취소: --cancel로 실행 후 Ctrl+C.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { PassThrough } from 'node:stream';
import { TLSSocket, type DetailedPeerCertificate } from 'node:tls';
import { AutoDbSetupError, runAdminDbSetup } from '../scripts/db-auto-setup.js';
import { readDbTestConfig } from '../server/db/config.js';

const originalContent = 'CUSTOMER_DB_TEST_APPROVED=true\n';
const syntheticAdmin = 'synthetic-admin-@#%';
const cancelExpected = process.argv.length === 3 && process.argv[2] === '--cancel';
const previousRaw = process.stdin.isRaw === true;
let directory: string | undefined;
let socket: TLSSocket | undefined;
try {
  assert.equal(process.stdin.isTTY, true); assert.equal(process.stdout.isTTY, true);
  assert.ok(process.argv.length === 2 || cancelExpected);
  directory = fs.mkdtempSync(join(tmpdir(), 'tripmoney-db-auto-setup-tty-'));
  const path = join(directory, '.env.db-test');
  fs.writeFileSync(path, originalContent, { mode: 0o600 });
  // 실제 네트워크 없이 Node 인증 결과와 peer만 합성한다.
  socket = new TLSSocket(new PassThrough());
  socket.authorized = true;
  socket.getPeerCertificate = () => ({ subjectaltname: 'DNS:aws-0-ap-northeast-2.pooler.supabase.com',
    raw: Buffer.from('synthetic-peer') }) as DetailedPeerCertificate;
  const connection = { stream: socket };
  const queries: string[] = [];
  let connects = 0, closes = 0, savedBeforeCommit = false;
  const safeRow = (login: string) => ({ admin_user: 'postgres', database: 'postgres', backend_ssl: false,
    login_name: login, canlogin: false, inherit: true, superuser: false, createdb: false,
    createrole: false, replication: false, bypassrls: false, runtime_inherit: true,
    runtime_set: false, runtime_admin: false, membership_count: 1, unexpected_memberships: 0,
    expected_runtime: true, schema_create: false, owns_customer_objects: false,
    provider_table_read: false, helper_absent: true, can_manage: true });
  let failure: unknown;
  try {
    await runAdminDbSetup({ input: process.stdin, output: process.stdout, path, createClient: () => ({
      connection,
      async connect() { connects++; },
      async query(sql) {
        queries.push(sql);
        if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('as admin_user')) return { rows: [safeRow('customer_app_login'), safeRow('customer_auth_login')] };
        if (sql === 'commit') savedBeforeCommit = Object.keys(parseEnv(fs.readFileSync(path, 'utf8'))).length === 5;
        return { rows: [] };
      },
      async end() { assert.equal(process.stdin.isRaw, previousRaw); closes++; },
    }) });
  } catch (error) { failure = error; }
  assert.equal(process.stdin.isRaw, previousRaw);
  assert.equal(fs.statSync(path).mode & 0o7777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ['.env.db-test']);
  if (cancelExpected) {
    assert.ok(failure instanceof AutoDbSetupError);
    assert.equal(failure.stage, 'input'); assert.equal(failure.fileSaved, false);
    assert.equal(fs.readFileSync(path, 'utf8'), originalContent);
    assert.equal(connects, 0); assert.equal(closes, 0); assert.equal(queries.length, 0);
    console.log('synthetic_tty_auto_cancel_pass');
  } else {
    assert.equal(failure, undefined);
    const config = readDbTestConfig(parseEnv(fs.readFileSync(path, 'utf8')));
    const passwords = [config.adminUrl, config.appUrl, config.authUrl]
      .map(url => decodeURIComponent(new URL(url).password));
    assert.equal(passwords[0], syntheticAdmin);
    assert.match(passwords[1]!, /^[A-Za-z0-9_-]{43}$/);
    assert.match(passwords[2]!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(new Set(passwords).size, 3);
    assert.equal(connects, 1); assert.equal(closes, 1); assert.equal(savedBeforeCommit, true);
    const resets = queries.filter(sql => sql.startsWith('alter role'));
    assert.equal(resets.length, 2);
    for (const [index, role] of ['customer_app_login', 'customer_auth_login'].entries()) {
      assert.match(resets[index]!, new RegExp(`^alter role ${role} password 'SCRAM-SHA-256\\$4096:`));
    }
    assert.equal(queries.filter(sql => sql === 'commit').length, 1);
    assert.equal(queries.includes('rollback'), false);
    assert.equal(queries.some(sql => /^alter role .*\blogin\b/i.test(sql)), false);
    assert.equal(queries.some(sql => passwords.some(password => sql.includes(password))), false);
    console.log('synthetic_tty_auto_setup_pass');
  }
} catch {
  console.error('synthetic_tty_auto_setup_failed');
  process.exitCode = 1;
} finally {
  process.stdin.pause();
  try {
    socket?.destroy();
    if (process.stdin.isTTY) process.stdin.setRawMode(previousRaw);
    if (directory !== undefined) fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    console.error('synthetic_tty_auto_cleanup_failed');
    process.exitCode = 1;
  }
}
