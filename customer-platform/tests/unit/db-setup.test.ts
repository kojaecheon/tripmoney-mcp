import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDbSetupEnv, readHiddenPassword, saveDbSetupEnv, runDbSetup } from '../../scripts/db-setup.js';
import { readDbTestConfig } from '../../server/db/config.js';

const passwords = { admin: 'synthetic-admin@:/#%"\'!', app: 'synthetic-app-한글🙂', auth: 'synthetic-auth-$`\\' };
const rejected = (e: unknown) => e instanceof Error && e.message === 'customer_db_setup_configuration';
function fixture(t: { after(fn: () => void): void }) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'tripmoney-db-setup-'));
  const path = join(directory, '.env.db-test');
  fs.writeFileSync(path, 'CUSTOMER_DB_TEST_APPROVED=true\n', { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, path };
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
  output.on('data', (chunk) => { text += String(chunk); });
  return { input, output, text: () => text };
}

test('세 비밀번호를 URL 인코딩해 고정 신규 DB의 다섯 설정만 만든다', () => {
  const previousEnv = process.env.CUSTOMER_DB_TEST_ADMIN_URL;
  const env = parseEnv(buildDbSetupEnv(passwords));
  const config = readDbTestConfig(env);
  assert.equal(env.CUSTOMER_DB_TEST_APPROVED, 'true');
  assert.equal(env.CUSTOMER_DB_TEST_ID, 'aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres');
  assert.equal(Object.keys(env).length, 5);
  for (const [role, url] of [['admin', config.adminUrl], ['app', config.appUrl], ['auth', config.authUrl]] as const) {
    assert.equal(decodeURIComponent(new URL(url).password), passwords[role]);
    assert.equal(new URL(url).search, '');
    assert.equal(new URL(url).hash, '');
  }
  assert.ok(env.CUSTOMER_DB_TEST_ADMIN_URL?.includes('%40%3A%2F%23%25%22%27%21'));
  // 상속된 실제 URL이 있어도 assertion 오류에 값을 넣지 않는다.
  assert.equal(process.env.CUSTOMER_DB_TEST_ADMIN_URL === previousEnv, true);
});

for (const value of ['', '   ', '[YOUR-PASSWORD]', 'REPLACE_WITH_URL_ENCODED_PASSWORD', 'a\nb', 'a\rb', 'a\0b', 'a\tb', '\ud800', 'x'.repeat(1025)]) {
  test('잘못된 비밀번호는 저장 전 거부한다: 합성 사례 ' + JSON.stringify(value).slice(0, 20), () => {
    assert.throws(() => buildDbSetupEnv({ ...passwords, app: value }), rejected);
  });
}
test('관리자·서비스 계정에 같은 비밀번호를 재사용하지 않는다', () => {
  assert.throws(() => buildDbSetupEnv({ ...passwords, app: passwords.admin }), rejected);
  assert.throws(() => buildDbSetupEnv({ ...passwords, auth: passwords.app }), rejected);
});
test('검증된 기존 파일만 0600으로 원자 교체하고 임시 파일을 남기지 않는다', (t) => {
  const { directory, path } = fixture(t);
  saveDbSetupEnv(path, passwords);
  assert.equal(fs.statSync(path).mode & 0o7777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ['.env.db-test']);
  assert.equal(decodeURIComponent(new URL(readDbTestConfig(parseEnv(fs.readFileSync(path, 'utf8'))).appUrl).password), passwords.app);
});
test('기존 umask가 소유자 권한을 제한해도 저장 파일은 정확히 0600이다', (t) => {
  const { path } = fixture(t);
  const previousMask = process.umask(0o777);
  try {
    saveDbSetupEnv(path, passwords);
    assert.equal(fs.statSync(path).mode & 0o7777, 0o600);
  } finally { process.umask(previousMask); }
});
for (const mode of [0o644, 0o400]) {
  test(`기존 파일 권한 ${mode.toString(8)}은 변경하지 않고 거부한다`, (t) => {
    const { path } = fixture(t);
    fs.chmodSync(path, mode);
    const before = fs.readFileSync(path, 'utf8');
    assert.throws(() => saveDbSetupEnv(path, passwords), rejected);
    assert.equal(fs.readFileSync(path, 'utf8'), before);
    assert.equal(fs.statSync(path).mode & 0o7777, mode);
  });
}
test('심볼릭 링크·하드 링크·임의 키가 있는 기존 파일을 덮어쓰지 않는다', (t) => {
  const { directory, path } = fixture(t);
  const link = join(directory, 'link.env');
  fs.symlinkSync(path, link);
  assert.throws(() => saveDbSetupEnv(link, passwords), rejected);
  fs.unlinkSync(link);
  fs.linkSync(path, link);
  assert.throws(() => saveDbSetupEnv(path, passwords), rejected);
  fs.unlinkSync(link);
  fs.writeFileSync(path, 'NODE_OPTIONS=synthetic\n');
  assert.throws(() => saveDbSetupEnv(path, passwords), rejected);
  assert.equal(fs.readFileSync(path, 'utf8'), 'NODE_OPTIONS=synthetic\n');
});
test('교체 실패 시 기존 내용 유지·임시 파일 정리·오류 원문 비노출', (t) => {
  const { directory, path } = fixture(t);
  const before = fs.readFileSync(path, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw new Error('SYNTHETIC_SECRET_DO_NOT_PRINT'); });
  assert.throws(() => saveDbSetupEnv(path, passwords), rejected);
  assert.equal(fs.readFileSync(path, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(directory), ['.env.db-test']);
});
test('입력값은 출력하지 않고 유니코드·백스페이스를 처리한 뒤 터미널을 복원한다', async () => {
  const tty = terminal();
  const result = readHiddenPassword(tty.input, tty.output, '합성 프롬프트: ');
  assert.equal(tty.input.isRaw, true);
  tty.input.write(Buffer.from('비밀🙂x\x7f\r'));
  assert.equal(await result, '비밀🙂');
  assert.equal(tty.input.isRaw, false);
  assert.equal(tty.text(), '합성 프롬프트: \n');
  assert.equal(tty.input.listenerCount('data'), 0);
});
test('붙여넣은 비밀번호의 선행 U+FEFF 문자도 제거하지 않는다', async () => {
  const tty = terminal();
  const result = readHiddenPassword(tty.input, tty.output, '입력: ');
  tty.input.write(Buffer.from('\ufeffsynthetic\r'));
  assert.equal(await result, '\ufeffsynthetic');
  assert.equal(tty.text().includes('synthetic'), false);
});
for (const event of ['ctrl-c', 'ctrl-d', 'end', 'abort', 'error', 'escape', 'overlong']) {
  test(`입력 중 ${event}는 취소하며 비밀 출력 없이 raw 모드를 복원한다`, async () => {
    const tty = terminal();
    const controller = new AbortController();
    const result = readHiddenPassword(tty.input, tty.output, '비밀번호: ', controller.signal);
    const assertion = assert.rejects(result, (e: unknown) => e instanceof Error
      && ['customer_db_setup_cancelled', 'customer_db_setup_configuration'].includes(e.message));
    tty.input.write('synthetic-hidden');
    if (event === 'ctrl-c') tty.input.write('\x03');
    if (event === 'ctrl-d') tty.input.write('\x04');
    if (event === 'end') tty.input.emit('end');
    if (event === 'abort') controller.abort();
    if (event === 'error') tty.input.emit('error', new Error('SYNTHETIC_SECRET_DO_NOT_PRINT'));
    if (event === 'escape') tty.input.write('\x1b');
    if (event === 'overlong') tty.input.write('x'.repeat(1025));
    await assertion;
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.input.listenerCount('data'), 0);
    assert.equal(tty.text().includes('synthetic-hidden'), false);
  });
}
test('비 TTY 입력과 출력은 읽기 전에 거부한다', async () => {
  const tty = terminal();
  tty.input.isTTY = false;
  await assert.rejects(readHiddenPassword(tty.input, tty.output, '입력: '), rejected);
  assert.equal(tty.text(), '');
  tty.input.isTTY = true;
  tty.output.isTTY = false;
  await assert.rejects(readHiddenPassword(tty.input, tty.output, '입력: '), rejected);
});
test('세 프롬프트 내내 숨김 상태를 유지하고 마지막에만 지정 파일에 저장한다', async (t) => {
  const { path } = fixture(t);
  const tty = terminal();
  const before = fs.readFileSync(path, 'utf8');
  const run = runDbSetup({ input: tty.input, output: tty.output, path });
  for (const [index, password] of [passwords.admin, passwords.app, passwords.auth].entries()) {
    assert.equal(tty.input.isRaw, true);
    if (index < 2) assert.equal(fs.readFileSync(path, 'utf8'), before);
    tty.input.write(password + '\r');
    await new Promise((resolve) => setImmediate(resolve));
  }
  await run;
  assert.equal(tty.input.isRaw, false);
  readDbTestConfig(parseEnv(fs.readFileSync(path, 'utf8')));
  for (const password of Object.values(passwords)) assert.equal(tty.text().includes(password), false);
});
test('두 번째 프롬프트에서 취소하면 기존 파일을 보존한다', async (t) => {
  const { path } = fixture(t);
  const before = fs.readFileSync(path, 'utf8');
  const tty = terminal();
  const run = runDbSetup({ input: tty.input, output: tty.output, path });
  const assertion = assert.rejects(run);
  tty.input.write(passwords.admin + '\r');
  await new Promise((resolve) => setImmediate(resolve));
  tty.input.write('\x03');
  await assertion;
  assert.equal(tty.input.isRaw, false);
  assert.equal(fs.readFileSync(path, 'utf8'), before);
});
test('입력 도중 파일이 바뀌면 사용자 변경을 덮어쓰지 않는다', async (t) => {
  const { path } = fixture(t);
  const tty = terminal();
  const run = runDbSetup({ input: tty.input, output: tty.output, path });
  const assertion = assert.rejects(run, rejected);
  for (const password of Object.values(passwords)) {
    tty.input.write(password + '\r');
    if (password === passwords.app) fs.writeFileSync(path, 'CUSTOMER_DB_TEST_APPROVED=false\n');
    await new Promise((resolve) => setImmediate(resolve));
  }
  await assertion;
  assert.equal(fs.readFileSync(path, 'utf8'), 'CUSTOMER_DB_TEST_APPROVED=false\n');
  assert.equal(tty.input.isRaw, false);
});
for (const extraArgs of [[], ['--unexpected']]) {
  test(`CLI는 비 TTY·추가 인자를 비밀 출력 없이 거부한다: 인자 수 ${extraArgs.length}`, () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/setup-db.ts', ...extraArgs], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), env: {},
      input: 'SYNTHETIC_INPUT_NOT_A_REAL_PASSWORD\n', encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 78);
    assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_INPUT_NOT_A_REAL_PASSWORD'), false);
    assert.equal(result.stderr.includes('customer_db_setup_not_saved'), true);
    assert.equal(result.stdout.includes('1/3'), false);
  });
}
