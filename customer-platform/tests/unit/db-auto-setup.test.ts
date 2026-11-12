import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { TLSSocket, type DetailedPeerCertificate } from 'node:tls';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readDbTestConfig } from '../../server/db/config.js';
import * as auto from '../../scripts/db-auto-setup.js';

const syntheticAdmin = 'SYNTHETIC-admin-@#%';
test('password 경계는 TTY 없이 공식 TLS와 저장 순서, 진행 단계를 보존한다', async t => {
  const file = fixture(t), db = clientFixture(file.path, t), stages: string[] = [];
  assert.equal(typeof auto.runAdminDbSetupWithPassword, 'function');
  await auto.runAdminDbSetupWithPassword({ path: file.path, password: syntheticAdmin,
    onProgress: stage => { stages.push(stage); }, createClient: config => {
      assert.equal(config.ssl !== false && typeof config.ssl === 'object' && config.ssl.rejectUnauthorized, true);
      return db.client;
    } });
  assert.deepEqual(stages, ['admin_connect', 'password_reset', 'local_save']);
  assert.equal(db.savedBeforeCommit(), true); assert.equal(db.ended(), true);
  assert.equal(fs.statSync(file.path).mode & 0o7777, 0o600);
  assert.equal(db.queries.some(sql => /^alter role .*\blogin\b/i.test(sql)), false);
});
test('최초 실패 뒤 정리 중 취소는 실패를 취소로 덮어쓰지 않는다', async t => {
  const file = fixture(t), db = clientFixture(file.path, t), controller = new AbortController();
  db.deny('connect');
  db.client.end = async () => { controller.abort(); };
  await assert.rejects(auto.runAdminDbSetupWithPassword({ path: file.path, password: syntheticAdmin,
    signal: controller.signal, createClient: () => db.client }), (error: unknown) => {
    assert.ok(error instanceof auto.AutoDbSetupError);
    assert.equal(error.stage, 'admin_auth'); assert.equal(error.cancelled, false); return true;
  });
});
test('password 실행 중 취소는 실패 객체에 취소 원인을 고정한다', async t => {
  const file = fixture(t), db = clientFixture(file.path, t), controller = new AbortController();
  const query = db.client.query;
  db.client.query = async sql => { const value = await query(sql); if (sql.includes('as admin_user')) controller.abort(); return value; };
  await assert.rejects(auto.runAdminDbSetupWithPassword({ path: file.path, password: syntheticAdmin,
    signal: controller.signal, createClient: () => db.client }), (error: unknown) => {
    assert.ok(error instanceof auto.AutoDbSetupError); assert.equal(error.cancelled, true); return true;
  });
});
for (const password of ['', ' ', 'bad\nvalue', 'x'.repeat(1025), '\ud800']) {
  test('password 경계는 유효하지 않은 입력을 연결 전에 거부한다 ' + password.length, async t => {
    const file = fixture(t); let called = false;
    await assert.rejects(auto.runAdminDbSetupWithPassword({ path: file.path, password,
      createClient: () => { called = true; throw new Error(); } }), auto.AutoDbSetupError);
    assert.equal(called, false);
    assert.equal(fs.readFileSync(file.path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=true\n');
  });
}
for (const failure of ['connect', 'roles', 'snapshot', 'save', 'commit', 'cancel'] as const) {
  test('password 경계의 실패는 최초 단계와 저장 여부를 보존한다 ' + failure, async t => {
    const file = fixture(t), db = clientFixture(file.path, t), controller = new AbortController();
    if (failure === 'connect') db.deny('connect');
    if (failure === 'roles') db.unsafe();
    if (failure === 'save') t.mock.method(fs, 'renameSync', () => { throw new Error(syntheticAdmin); });
    if (failure === 'commit') db.deny('commit');
    const query = db.client.query;
    db.client.query = async sql => {
      const result = await query(sql);
      if (sql.includes('as admin_user') && failure === 'snapshot') fs.writeFileSync(file.path, 'CUSTOMER_DB_TEST_APPROVED=false\n');
      if (sql.includes('as admin_user') && failure === 'cancel') controller.abort();
      return result;
    };
    await assert.rejects(auto.runAdminDbSetupWithPassword({ path: file.path, password: syntheticAdmin,
      signal: controller.signal, createClient: () => db.client }), (error: unknown) => {
      assert.ok(error instanceof auto.AutoDbSetupError);
      assert.equal(error.stage, failure === 'connect' ? 'admin_auth' : failure === 'commit' ? 'commit'
        : failure === 'save' || failure === 'snapshot' ? 'local_save' : 'role_preflight');
      assert.equal(error.fileSaved, failure === 'commit');
      assert.equal(error.message.includes(syntheticAdmin), false); return true;
    });
    assert.equal(db.ended(), true);
    assert.equal(db.queries.includes('commit'), failure === 'commit');
    if (failure === 'cancel' || failure === 'roles') assert.equal(db.queries.some(sql => sql.startsWith('alter role')), false);
  });
}
function fixture(t: { after(fn: () => void): void }) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'tripmoney-db-auto-'));
  const path = join(directory, '.env.db-test');
  fs.writeFileSync(path, 'CUSTOMER_DB_TEST_APPROVED=true\n', { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { path, directory };
}
class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(mode: boolean) { this.isRaw = mode; return this; }
}
function terminal() {
  const input = new Input();
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let text = '';
  output.on('data', chunk => { text += String(chunk); });
  return { input, output, text: () => text };
}
const safeRow = (login: string) => ({ admin_user: 'postgres', database: 'postgres', backend_ssl: true,
  login_name: login, canlogin: false, inherit: true, superuser: false, createdb: false,
  createrole: false, replication: false, bypassrls: false, runtime_inherit: true,
  runtime_set: false, runtime_admin: false, membership_count: 1, unexpected_memberships: 0,
  expected_runtime: true, schema_create: false, owns_customer_objects: false,
  provider_table_read: false, helper_absent: true, can_manage: true });
const safeRows = () => [safeRow('customer_app_login'), safeRow('customer_auth_login')];
function clientFixture(path: string, t: { after(fn: () => void): void }) {
  // 실제 TLS handshake는 수행하지 않는다. Node 인증 결과와 peer를 합성한 TLS double이다.
  const socket = new TLSSocket(new PassThrough());
  socket.authorized = true;
  socket.getPeerCertificate = () => ({ subjectaltname: 'DNS:aws-0-ap-northeast-2.pooler.supabase.com',
    raw: Buffer.from('synthetic-peer') }) as DetailedPeerCertificate;
  t.after(() => socket.destroy());
  const queries: string[] = [];
  let ended = false, connected = false, savedBeforeCommit = false;
  let denied = '', rows: Record<string, unknown>[] = safeRows(), locked = true;
  const client = {
    connection: { stream: socket },
    async connect() { connected = true; if (denied === 'connect') throw Object.assign(new Error(syntheticAdmin), { code: '28P01' }); },
    async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
      queries.push(sql);
      if (denied && sql.includes(denied)) throw new Error('SYNTHETIC_PRIVATE_QUERY_ERROR');
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked }] };
      if (sql.includes('as admin_user')) return { rows };
      if (sql === 'commit') savedBeforeCommit = Object.keys(parseEnv(fs.readFileSync(path, 'utf8'))).length === 5;
      return { rows: [] };
    },
    async end() { ended = true; },
  };
  return { client, socket, queries, ended: () => ended, connected: () => connected,
    savedBeforeCommit: () => savedBeforeCommit,
    deny: (value: string) => { denied = value; }, unsafe: () => { rows[0]!.bypassrls = true; },
    unlock: () => { locked = false; }, backend: (value: unknown) => { rows = safeRows().map(row => ({ ...row, backend_ssl: value })); } };
}
async function start(t: { after(fn: () => void): void }) {
  const file = fixture(t), tty = terminal(), db = clientFixture(file.path, t);
  let queryTimeout: number | undefined;
  const run = auto.runAdminDbSetup({ ...file, ...tty, createClient: config => {
    assert.equal(config.ssl !== false && typeof config.ssl === 'object' && config.ssl.rejectUnauthorized, true);
    assert.equal(new URL(config.connectionString!).hostname, 'aws-0-ap-northeast-2.pooler.supabase.com');
    queryTimeout = config.query_timeout;
    return db.client;
  } });
  return { ...file, ...tty, db, run, queryTimeout: () => queryTimeout };
}

test('SCRAM verifier는 RFC7677 공개 예제와 독립 계산한 PostgreSQL 형식에 일치한다', () => {
  // Python hashlib/hmac으로 독립 계산한 공개 password=pencil, salt=RFC7677 예제다.
  assert.equal(auto.scramVerifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64')),
    'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=');
});
test('서비스 비밀번호는 각각 32바이트 난수이며 값과 salt를 재사용하지 않는다', () => {
  const first = auto.generateServicePasswords(), second = auto.generateServicePasswords();
  const values = [first.app, first.auth, second.app, second.auth];
  for (const value of values) assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set(values).size, 4);
  assert.notEqual(auto.scramVerifier(first.app), auto.scramVerifier(first.app));
});
for (const value of ['', "quote'", '한글', 'x'.repeat(129)]) {
  test('생성용 ASCII 범위 밖 비밀번호는 verifier를 만들지 않는다: ' + JSON.stringify(value).slice(0, 14), () => {
    assert.throws(() => auto.scramVerifier(value), (e: unknown) => e instanceof Error && e.message === 'customer_db_auto_configuration');
  });
}
test('제한된 두 NOLOGIN과 postgres 관리 권한만 허용한다', () => {
  assert.doesNotThrow(() => auto.validateResetRoles(safeRows()));
  for (const rows of [[], [safeRows()[0]!], [...safeRows(), safeRows()[0]!], [safeRows()[0]!, safeRows()[0]!]]) {
    assert.throws(() => auto.validateResetRoles(rows));
  }
});
test('검증된 session pooler의 backend ssl=false는 제한 역할 검사를 통과한다', () => {
  const rows = safeRows().map(row => ({ ...row, backend_ssl: false }));
  assert.doesNotThrow(() => auto.validateResetRoles(rows, 'session_pooler'));
});

for (const [fragment, detail] of [['begin', 'begin'], ['set local', 'settings'],
  ['statement_timeout', 'settings'], ['pg_try_advisory_xact_lock', 'lock'], ['as admin_user', 'inspection_query']] as const) {
  test(`사전검사 ${detail} 실패는 고정 상세 코드로만 보고하고 파일을 보존한다`, async t => {
    const f = await start(t); f.db.deny(fragment);
    const assertion = assert.rejects(f.run, (error: unknown) => error instanceof auto.AutoDbSetupError
      && error.stage === 'role_preflight' && !error.fileSaved && error.detail === detail
      && error.message === `customer_db_auto_role_preflight_failed_${detail}`);
    f.input.write(syntheticAdmin + '\r'); await assertion;
    assert.equal(f.db.queries.some(sql => sql.startsWith('alter role') || sql === 'commit'), false);
    assert.equal(f.db.ended(), true); assert.equal(f.input.isRaw, false);
    assert.equal(fs.readFileSync(f.path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=true\n');
    assert.equal(f.text().includes('SYNTHETIC_PRIVATE_QUERY_ERROR'), false);
  });
}

test('검증된 frontend와 backend=false인 session pooler는 저장·commit까지 완료한다', async t => {
  const f = await start(t); f.db.backend(false);
  f.input.write(syntheticAdmin + '\r'); await f.run;
  assert.equal(f.db.queries.filter(sql => sql.startsWith('alter role')).length, 2);
  assert.equal(f.db.queries.includes('commit'), true);
  assert.equal(f.db.savedBeforeCommit(), true); assert.equal(f.db.ended(), true);
  assert.equal(f.input.isRaw, false); assert.equal(fs.statSync(f.path).mode & 0o7777, 0o600);
});
for (const failure of ['client_transport', 'role_guard', 'lock', 'backend_null', 'backend_missing', 'backend_string'] as const) {
  test(`${failure} 사전검사는 변경 전에 중단하고 고정 상세 코드·최초 오류를 보존한다`, async t => {
    const f = await start(t);
    if (failure === 'client_transport') f.db.socket.authorized = false;
    if (failure === 'role_guard') f.db.unsafe();
    if (failure === 'lock') f.db.unlock();
    if (failure === 'backend_null') f.db.backend(null);
    if (failure === 'backend_missing') f.db.backend(undefined);
    if (failure === 'backend_string') f.db.backend('true');
    const detail = failure.startsWith('backend_') ? 'role_guard' : failure;
    let closeCalls = 0;
    f.db.client.end = async () => { closeCalls++; assert.equal(f.input.isRaw, false); throw new Error('SYNTHETIC_PRIVATE_CLOSE'); };
    const assertion = assert.rejects(f.run, (error: unknown) => error instanceof auto.AutoDbSetupError
      && error.stage === 'role_preflight' && !error.fileSaved && error.detail === detail
      && error.message === `customer_db_auto_role_preflight_failed_${detail}`);
    f.input.write(syntheticAdmin + '\r'); await assertion;
    assert.equal(f.db.queries.some(sql => sql.startsWith('alter role') || sql === 'commit'), false);
    if (failure === 'client_transport') assert.equal(f.db.queries.length, 0);
    else assert.equal(f.db.queries.includes('rollback'), true);
    assert.equal(f.input.isRaw, false);
    assert.equal(closeCalls, 1);
    assert.equal(fs.readFileSync(f.path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=true\n');
  });
}
test('사전검사 상세 코드는 allowlist와 단계 밖 원문을 출력하지 않는다', () => {
  const invalid = new auto.AutoDbSetupError('role_preflight', false, 'SYNTHETIC_PRIVATE_DETAIL' as never);
  assert.equal(invalid.message, 'customer_db_auto_role_preflight_failed'); assert.equal(invalid.detail, undefined);
  const other = new auto.AutoDbSetupError('close', true, 'client_transport');
  assert.equal(other.message, 'customer_db_auto_close_failed_file_saved'); assert.equal(other.detail, undefined);
});
for (const [field, value] of [['admin_user', 'other'], ['database', 'other'], ['backend_ssl', false],
  ['canlogin', true], ['inherit', false], ['superuser', true], ['createdb', true], ['createrole', true],
  ['replication', true], ['bypassrls', true], ['runtime_inherit', false], ['runtime_set', true],
  ['runtime_admin', true], ['membership_count', 2], ['unexpected_memberships', 1], ['expected_runtime', false],
  ['schema_create', true], ['owns_customer_objects', true], ['provider_table_read', true],
  ['helper_absent', false], ['can_manage', false]] as const) {
  test(`역할 guard는 ${field} 위반을 거부한다`, () => {
    const rows: Record<string, unknown>[] = safeRows(); rows[1]![field] = value;
    assert.throws(() => auto.validateResetRoles(rows));
    if (field !== 'backend_ssl') {
      assert.throws(() => auto.validateResetRoles(rows.map(row => ({ ...row, backend_ssl: false })), 'session_pooler'));
    }
  });
}
test('관리자 한 번 숨김 입력 후 두 verifier만 재설정하고 커밋 전 0600 저장한다', async t => {
  const f = await start(t);
  assert.equal(f.input.isRaw, true);
  f.input.write(syntheticAdmin + '\r');
  await f.run;
  const config = readDbTestConfig(parseEnv(fs.readFileSync(f.path, 'utf8')));
  const passwords = [config.adminUrl, config.appUrl, config.authUrl].map(url => decodeURIComponent(new URL(url).password));
  assert.equal(passwords[0] === syntheticAdmin, true);
  assert.match(passwords[1]!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(passwords[2]!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set(passwords).size, 3);
  const resets = f.db.queries.filter(sql => sql.startsWith('alter role'));
  assert.equal(resets.length, 2);
  for (const [index, role] of ['customer_app_login', 'customer_auth_login'].entries()) {
    assert.match(resets[index]!, new RegExp(`^alter role ${role} password 'SCRAM-SHA-256\\$4096:`));
  }
  for (const password of passwords) {
    assert.equal(f.text().includes(password), false);
    assert.equal(f.db.queries.some(sql => sql.includes(password)), false);
  }
  assert.equal(f.db.savedBeforeCommit(), true);
  assert.equal(f.db.queries.includes('commit'), true);
  assert.equal(f.db.queries.includes('rollback'), false);
  assert.equal(f.db.queries.some(sql => /^alter role .*\blogin\b/i.test(sql)), false);
  assert.equal(fs.statSync(f.path).mode & 0o7777, 0o600);
  assert.deepEqual(fs.readdirSync(f.directory), ['.env.db-test']);
  assert.equal(f.db.ended(), true);
  assert.equal(f.input.isRaw, false);
  assert.equal((f.text().match(/관리자 비밀번호:/g) ?? []).length, 1);
});
for (const failure of ['connect', 'customer_auth_login password', 'commit']) {
  test(`실패 ${failure}는 고정 오류만 반환하고 DB를 닫는다`, async t => {
    const f = await start(t); f.db.deny(failure);
    const assertion = assert.rejects(f.run, (e: unknown) => e instanceof auto.AutoDbSetupError
      && !e.message.includes(syntheticAdmin) && !e.message.includes('SYNTHETIC_PRIVATE_QUERY_ERROR'));
    f.input.write(syntheticAdmin + '\r'); await assertion;
    assert.equal(f.db.ended(), true);
    assert.equal(f.input.isRaw, false);
    assert.equal(f.db.queries.some(sql => /^alter role .*\blogin\b/i.test(sql)), false);
    if (failure !== 'commit') assert.equal(fs.readFileSync(f.path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=true\n');
    if (failure !== 'connect') assert.equal(f.db.queries.includes('rollback'), true);
  });
}
for (const failure of ['permissions', 'lock', 'rename']) {
  test(`권한·동시 실행·로컬 저장 실패 ${failure}는 커밋하지 않는다`, async t => {
    const f = await start(t);
    if (failure === 'permissions') f.db.unsafe();
    if (failure === 'lock') f.db.unlock();
    if (failure === 'rename') t.mock.method(fs, 'renameSync', () => { throw new Error(syntheticAdmin); });
    const assertion = assert.rejects(f.run);
    f.input.write(syntheticAdmin + '\r'); await assertion;
    assert.equal(f.db.queries.includes('commit'), false);
    assert.equal(f.db.queries.includes('rollback'), true);
    assert.equal(fs.readFileSync(f.path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=true\n');
    assert.equal(f.db.ended(), true);
  });
}
test('입력 중 파일이 바뀌면 연결 전에 중단하고 변경을 보존한다', async t => {
  const f = await start(t); const assertion = assert.rejects(f.run);
  fs.writeFileSync(f.path, 'CUSTOMER_DB_TEST_APPROVED=false\n');
  f.input.write(syntheticAdmin + '\r'); await assertion;
  assert.equal(f.db.connected(), false);
  assert.equal(fs.readFileSync(f.path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=false\n');
});
test('Ctrl+C는 입력을 숨긴 채 취소하고 파일·DB를 변경하지 않는다', async t => {
  const f = await start(t); const assertion = assert.rejects(f.run);
  f.input.write('synthetic-incomplete\x03'); await assertion;
  assert.equal(f.db.connected(), false);
  assert.equal(f.input.isRaw, false);
  assert.equal(f.text().includes('synthetic-incomplete'), false);
  assert.equal(fs.readFileSync(f.path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=true\n');
});
test('위험한 기존 파일은 입력과 연결 전에 거부한다', async t => {
  const file = fixture(t), tty = terminal(); fs.chmodSync(file.path, 0o644);
  let called = false;
  await assert.rejects(auto.runAdminDbSetup({ ...file, ...tty, createClient: () => { called = true; throw new Error(); } }));
  assert.equal(tty.text(), ''); assert.equal(called, false);
});
test('종료 오류도 고정 코드로 처리하고 터미널 숨김 상태를 복원한다', async t => {
  const f = await start(t);
  f.db.client.end = async () => { throw new Error(syntheticAdmin); };
  const assertion = assert.rejects(f.run, (e: unknown) => e instanceof auto.AutoDbSetupError
    && e.stage === 'close' && e.fileSaved === true && !e.message.includes(syntheticAdmin));
  f.input.write(syntheticAdmin + '\r'); await assertion;
  assert.equal(f.input.isRaw, false);
});
test('네트워크 응답 읽기에도 클라이언트 제한을 적용한다', async t => {
  const f = await start(t); f.input.write(syntheticAdmin + '\r'); await f.run;
  assert.equal(f.queryTimeout(), 20000);
});
test('터미널 복원 오류는 원문 대신 close 단계와 저장 상태로 전달한다', async t => {
  const f = await start(t), original = f.input.setRawMode.bind(f.input);
  f.input.setRawMode = mode => { original(mode); if (!mode) throw new Error(syntheticAdmin); return f.input; };
  const assertion = assert.rejects(f.run, (e: unknown) => e instanceof auto.AutoDbSetupError
    && e.stage === 'close' && e.fileSaved && !e.message.includes(syntheticAdmin));
  f.input.write(syntheticAdmin + '\r'); await assertion;
});
for (const cancellation of ['signal', 'ctrl-c'] as const) {
  test(`응답이 멈춘 질의에서 ${cancellation} 취소는 응답 없이 종료하고 연결 종료 전에 TTY를 복원한다`, async t => {
    const file = fixture(t), tty = terminal(), db = clientFixture(file.path, t), controller = new AbortController();
    let announce!: () => void;
    const waiting = new Promise<void>(resolve => { announce = resolve; });
    const original = db.client.query;
    db.client.query = async sql => {
      if (sql.includes('as admin_user')) { announce(); return new Promise(() => {}); }
      return original(sql);
    };
    let rawAtClose: boolean | undefined;
    const end = db.client.end;
    db.client.end = async () => { rawAtClose = tty.input.isRaw; await end(); };
    const run = auto.runAdminDbSetup({ ...file, ...tty, signal: controller.signal, createClient: () => db.client });
    const assertion = assert.rejects(run, (e: unknown) => e instanceof auto.AutoDbSetupError
      && e.stage === 'role_preflight' && !e.fileSaved);
    let finished = false;
    void assertion.then(() => { finished = true; }, () => {});
    tty.input.write(syntheticAdmin + '\r'); await waiting;
    if (cancellation === 'signal') controller.abort(); else tty.input.write('\x03');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, true);
    await assertion;
    assert.equal(rawAtClose, false);
    assert.equal(tty.input.isRaw, false); assert.equal(db.ended(), true);
    assert.equal(db.queries.some(sql => sql.startsWith('alter role') || sql === 'commit'), false);
    assert.equal(fs.readFileSync(file.path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=true\n');
  });
}
test('입력 후 취소는 비밀번호 재설정·커밋 전에 중단한다', async t => {
  const f = await start(t);
  const original = f.db.client.query;
  f.db.client.query = async sql => {
    const result = await original(sql);
    if (sql.includes('as admin_user')) f.input.write('\x03');
    return result;
  };
  const assertion = assert.rejects(f.run);
  f.input.write(syntheticAdmin + '\r'); await assertion;
  assert.equal(f.db.queries.some(sql => sql.startsWith('alter role')), false);
  assert.equal(f.db.queries.includes('commit'), false);
  assert.equal(f.db.ended(), true);
  assert.equal(fs.readFileSync(f.path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=true\n');
  assert.equal(f.input.isRaw, false);
});
for (const args of [[], ['--unexpected']]) {
  test(`실행 승인이 없는 CLI는 입력·실제 파일·DB를 사용하지 않는다: 인자 수 ${args.length}`, () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/setup-db-auto.ts', ...args], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), env: {}, input: syntheticAdmin + '\n',
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 78);
    assert.equal((result.stdout + result.stderr).includes(syntheticAdmin), false);
    assert.equal(result.stdout.includes('관리자 비밀번호:'), false);
  });
}

for (const target of ['connect', 'query', 'commit', 'rollback', 'close'] as const) {
  test(`${target} 응답 정지는 정해진 상한에서 실패하고 TTY·파일 상태를 보존한다`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const file = fixture(t), tty = terminal(), db = clientFixture(file.path, t);
    const limit = target === 'connect' ? 6000 : target === 'rollback' || target === 'close' ? 5000 : 20000;
    let announce!: () => void;
    const waiting = new Promise<void>(resolve => { announce = resolve; });
    const pending = () => { announce(); return new Promise<never>(() => {}); };
    const query = db.client.query, end = db.client.end;
    let endCalls = 0, rawAtClose: boolean | undefined, rawAtRollback: boolean | undefined;
    if (target === 'connect') db.client.connect = pending;
    db.client.query = async sql => {
      if (target === 'rollback' && sql.includes('pg_try_advisory_xact_lock')) throw new Error(syntheticAdmin);
      if (target === 'rollback' && sql === 'rollback') { rawAtRollback = tty.input.isRaw; return pending(); }
      if ((target === 'query' && sql.includes('as admin_user')) || (target === 'commit' && sql === 'commit')) return pending();
      return query(sql);
    };
    db.client.end = async () => {
      endCalls++; rawAtClose = tty.input.isRaw;
      if (target === 'close') return pending();
      await end();
    };
    let outcome: unknown;
    const readOutcome = (): unknown => outcome;
    const run = auto.runAdminDbSetup({ ...file, ...tty, createClient: () => db.client });
    const settled = run.then(() => { outcome = 'unexpected-success'; }, error => { outcome = error; });
    tty.input.write(syntheticAdmin + '\r'); await waiting;
    t.mock.timers.tick(limit - 1); await new Promise(resolve => setImmediate(resolve));
    assert.equal(readOutcome(), undefined);
    t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve));
    assert.ok(outcome instanceof auto.AutoDbSetupError);
    await settled;
    const saved = target === 'commit' || target === 'close';
    assert.equal(outcome.stage, target === 'connect' ? 'admin_connect'
      : target === 'query' || target === 'rollback' ? 'role_preflight' : target);
    assert.equal(outcome.fileSaved, saved);
    assert.equal(outcome.message.includes(syntheticAdmin), false);
    assert.equal(tty.input.isRaw, false); assert.equal(rawAtClose, false); assert.equal(endCalls, 1);
    if (target === 'rollback') assert.equal(rawAtRollback, false);
    if (!saved) {
      assert.equal(fs.readFileSync(file.path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=true\n');
      assert.equal(db.queries.some(sql => sql.startsWith('alter role') || sql === 'commit'), false);
    } else {
      assert.equal(Object.keys(parseEnv(fs.readFileSync(file.path, 'utf8'))).length, 5);
      assert.equal(fs.statSync(file.path).mode & 0o7777, 0o600);
    }
  });
}

for (const cleanup of ['reject', 'timeout', 'restore'] as const) {
  test(`최초 인증 실패는 ${cleanup} 정리 오류로 덮어쓰지 않는다`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const file = fixture(t), tty = terminal(), db = clientFixture(file.path, t);
    db.deny('connect');
    let closeStarted!: () => void;
    const closing = new Promise<void>(resolve => { closeStarted = resolve; });
    db.client.end = async () => {
      closeStarted();
      if (cleanup === 'timeout') return new Promise(() => {});
      if (cleanup === 'reject') throw new Error(syntheticAdmin);
    };
    if (cleanup === 'restore') {
      const setRawMode = tty.input.setRawMode.bind(tty.input);
      tty.input.setRawMode = mode => { setRawMode(mode); if (!mode) throw new Error(syntheticAdmin); return tty.input; };
    }
    let outcome: unknown;
    const settled = auto.runAdminDbSetup({ ...file, ...tty, createClient: () => db.client })
      .then(() => { outcome = 'unexpected-success'; }, error => { outcome = error; });
    tty.input.write(syntheticAdmin + '\r'); await closing;
    if (cleanup === 'timeout') {
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(5000);
    }
    await settled;
    assert.ok(outcome instanceof auto.AutoDbSetupError);
    assert.equal(outcome.stage, 'admin_auth'); assert.equal(outcome.fileSaved, false);
    assert.equal(outcome.message.includes(syntheticAdmin), false);
    assert.equal(tty.input.isRaw, false);
    assert.equal(fs.readFileSync(file.path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=true\n');
  });
}

for (const scenario of ['auth', 'commit', 'close', 'success'] as const) {
  test(`CLI ${scenario} 경로는 실제 pg 종료 응답과 ref 핸들이 멈춰도 복원·출력 후 종료한다`, t => {
    const file = fixture(t);
    const source = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { Duplex, PassThrough } from 'node:stream';
      import { TLSSocket } from 'node:tls';
      import { mock } from 'node:test';
      import pg from 'pg';
      import { runAdminDbSetup, AutoDbSetupError } from './scripts/db-auto-setup.ts';
      import { runDbAutoSetupCli } from './scripts/setup-db-auto.ts';
      const scenario = ${JSON.stringify(scenario)};
      const path = ${JSON.stringify(file.path)};
      const secret = 'SYNTHETIC-NEVER-PRINT';
      const interval = setInterval(() => {}, 1000);
      let terminate = 0, notifyEnd;
      const ending = new Promise(resolve => { notifyEnd = resolve; });
      class SyntheticStream extends Duplex {
        _read() {}
        setNoDelay() {}
        setKeepAlive() {}
        connect() { queueMicrotask(() => this.emit('connect')); }
        _write(chunk, encoding, callback) {
          if (chunk[0] === 0x58) { terminate++; notifyEnd(); return; }
          callback();
          queueMicrotask(() => this.push(Buffer.from('5200000008000000005a0000000549', 'hex')));
        }
      }
      const stream = new SyntheticStream();
      const client = new pg.Client({ stream, ssl: false, user: 'synthetic', password: secret, database: 'synthetic' });
      // 종료 정지용 실제 pg stream과 구분한 합성 frontend TLS 관측 fixture다.
      const frontend = new TLSSocket(new PassThrough());
      frontend.authorized = true;
      frontend.getPeerCertificate = () => ({ subjectaltname: 'DNS:aws-0-ap-northeast-2.pooler.supabase.com', raw: Buffer.from('synthetic-peer') });
      const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
        setRawMode(mode) { this.isRaw = mode; return this; } });
      const output = Object.assign(new PassThrough(), { isTTY: true });
      output.resume();
      // 실제 출력 write callback을 늦춰 명시 종료가 고정 메시지를 자르지 않는지 검사한다.
      for (const target of [process.stdout, process.stderr]) {
        const write = target.write.bind(target);
        target.write = (chunk, encoding, callback) => {
          if (String(chunk).includes('customer_db_auto_') || String(chunk).includes('저장 완료')) assert.equal(input.isRaw, false);
          if (chunk === '') {
            assert.equal(process.listenerCount('SIGINT'), 0);
            assert.equal(process.listenerCount('SIGTERM'), 0);
          }
          const done = typeof encoding === 'function' ? encoding : callback;
          setImmediate(() => write(chunk, typeof encoding === 'string' ? encoding : undefined, done));
          return true;
        };
      }
      mock.timers.enable({ apis: ['setTimeout'] });
      await runDbAutoSetupCli(async () => {
        if (scenario === 'success') {
          // controller에 성공 결과를 주입하되 실제 pg 종료 정지와 ref 핸들은 유지한다.
          await client.connect(); void client.end(); await ending;
          assert.equal(stream.destroyed, false); assert.equal(terminate, 1);
          mock.timers.reset();
          process.stdout.write('synthetic_cli_restored_before_report\\n');
          return;
        }
        const run = runAdminDbSetup({ input, output, path, createClient: () => ({
          connection: { stream: frontend },
          async connect() {
            await client.connect();
            if (scenario === 'auth') throw Object.assign(new Error(secret), { code: '28P01' });
          },
          async query(sql) {
            if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
            if (sql.includes('as admin_user')) return { rows: ${JSON.stringify(safeRows())} };
            if (scenario === 'commit' && sql === 'commit') throw new Error(secret);
            return { rows: [] };
          },
          end: () => client.end(),
        }) });
        const result = run.then(() => undefined, error => error);
        input.write(secret + '\\r');
        await ending;
        assert.equal(input.isRaw, false);
        await new Promise(resolve => setImmediate(resolve));
        mock.timers.tick(5000);
        const error = await result;
        mock.timers.reset();
        assert.ok(error instanceof AutoDbSetupError);
        assert.equal(error.stage, scenario === 'auth' ? 'admin_auth' : scenario === 'commit' ? 'commit' : 'close');
        assert.equal(error.fileSaved, scenario !== 'auth');
        assert.equal(input.isRaw, false); assert.equal(stream.destroyed, false); assert.equal(terminate, 1);
        if (scenario === 'auth') assert.equal(fs.readFileSync(path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=true\\n');
        process.stdout.write('synthetic_cli_restored_before_report\\n');
        throw error;
      });
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), env: {}, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL',
    });
    assert.equal(result.error?.message, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, scenario === 'success' ? 0 : scenario === 'auth' ? 78 : 1);
    assert.equal(result.stdout, 'synthetic_cli_restored_before_report\n' + (scenario === 'success'
      ? '저장 완료. Codex 채팅에 "입력 완료"라고 알려주세요.\n두 서비스 접속은 아직 비활성 상태입니다. Codex가 확인 후 활성화와 실제 DB 테스트를 이어갑니다.\n' : ''));
    const fixedError = scenario === 'auth' ? 'customer_db_auto_admin_auth_failed'
      : scenario === 'commit' ? 'customer_db_auto_commit_failed_file_saved' : 'customer_db_auto_close_failed_file_saved';
    if (scenario !== 'success') assert.equal(result.stderr.split('\n').filter(line => !line.startsWith('(node:')
      && !line.startsWith('(Use ')).join('\n'), fixedError + '\n자동 설정이 완료되지 않았습니다. 오류 코드만 Codex에 알려주세요. 비밀번호나 화면은 보내지 마세요.\n');
    assert.equal((result.stdout + result.stderr).includes('SYNTHETIC-NEVER-PRINT'), false);
  });
}

test('CLI 출력 flush가 멈춰도 1000ms 상한에서 원래 실패 코드로 종료한다', () => {
  const source = `
    import { mock } from 'node:test';
    import { AutoDbSetupError } from './scripts/db-auto-setup.ts';
    import { runDbAutoSetupCli } from './scripts/setup-db-auto.ts';
    setInterval(() => {}, 1000);
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      stream.write = (chunk, ...args) => chunk === '' ? true : write(chunk, ...args);
    }
    mock.timers.enable({ apis: ['setTimeout'] });
    await runDbAutoSetupCli(async () => {
      setImmediate(() => {
        mock.timers.tick(999);
        process.stdout.write('synthetic_flush_waited_before_limit\\n');
        mock.timers.tick(1);
      });
      throw new AutoDbSetupError('commit', true);
    });
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: {}, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL',
  });
  assert.equal(result.error?.message, undefined);
  assert.equal(result.signal, null); assert.equal(result.status, 1);
  assert.equal(result.stdout, 'synthetic_flush_waited_before_limit\n');
  assert.equal(result.stderr.split('\n').filter(line => !line.startsWith('(node:') && !line.startsWith('(Use ')).join('\n'),
    'customer_db_auto_commit_failed_file_saved\n자동 설정이 완료되지 않았습니다. 오류 코드만 Codex에 알려주세요. 비밀번호나 화면은 보내지 마세요.\n');
});

test('CLI 모듈 import는 입력·파일·DB 설정을 시작하지 않는다', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "await import('./scripts/setup-db-auto.ts'); process.stdout.write('synthetic_cli_import_only\\n');"], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: {}, encoding: 'utf8', timeout: 2000,
  });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'synthetic_cli_import_only\n');
});
