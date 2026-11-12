import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSecretEnvFile } from '../../server/config/secret-env.js';

const allowed = ['CUSTOMER_UNIT_VALUE', 'CUSTOMER_UNIT_APPROVED'];
function fixture(t: { after(fn: () => void): void }, content = 'CUSTOMER_UNIT_VALUE=synthetic-only\n', mode = 0o600) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'tripmoney-secret-env-'));
  const path = join(directory, 'synthetic.env');
  fs.writeFileSync(path, content, { mode });
  fs.chmodSync(path, mode);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, path };
}
const rejected = (error: unknown) => error instanceof Error && error.message === 'customer_secret_env_configuration';

test('검사한 동일 fd의 허용 키만 parseEnv로 읽고 process.env에 대입하지 않는다', (t) => {
  const { path } = fixture(t, '# fixture\nexport CUSTOMER_UNIT_VALUE="synthetic # value"\nCUSTOMER_UNIT_APPROVED=true\n');
  const before = process.env.CUSTOMER_UNIT_VALUE;
  const value = readSecretEnvFile(path, allowed);
  assert.equal(value.CUSTOMER_UNIT_VALUE, 'synthetic # value');
  assert.equal(value.CUSTOMER_UNIT_APPROVED, 'true');
  assert.deepEqual(Object.keys(value).sort(), ['CUSTOMER_UNIT_APPROVED', 'CUSTOMER_UNIT_VALUE']);
  assert.equal(process.env.CUSTOMER_UNIT_VALUE, before);
});

test('여러 줄 값 안의 NODE_OPTIONS·__proto__ 문자열은 코드나 별도 키로 취급하지 않는다', (t) => {
  const { path } = fixture(t, "CUSTOMER_UNIT_VALUE='line1\nNODE_OPTIONS=not-code\n__proto__=not-key\nline2'\n");
  assert.equal(readSecretEnvFile(path, allowed).CUSTOMER_UNIT_VALUE,
    'line1\nNODE_OPTIONS=not-code\n__proto__=not-key\nline2');
});

for (const mode of [0o644, 0o400, 0o660, 0o4600]) {
  test(`비밀 파일 모드 ${mode.toString(8)}는 내용 읽기 전에 거부하고 fd를 닫는다`, (t) => {
    const { path } = fixture(t, 'DO_NOT_LEAK=synthetic\n', mode);
    const read = t.mock.method(fs, 'readSync');
    const close = t.mock.method(fs, 'closeSync');
    assert.throws(() => readSecretEnvFile(path, allowed), rejected);
    assert.equal(read.mock.callCount(), 0);
    assert.equal(close.mock.callCount(), 1);
  });
}

test('현재 사용자 소유가 아니면 읽기 전에 거부한다', (t) => {
  const { path } = fixture(t);
  const fstat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
    const stat = fstat(...args);
    return Object.assign(stat, { uid: Number(stat.uid) + 1 });
  });
  const read = t.mock.method(fs, 'readSync');
  assert.throws(() => readSecretEnvFile(path, allowed), rejected);
  assert.equal(read.mock.callCount(), 0);
});

test('일반 파일 이외의 경로와 심볼릭 링크를 거부한다', (t) => {
  const { directory, path } = fixture(t);
  const link = join(directory, 'link.env');
  fs.symlinkSync(path, link);
  assert.throws(() => readSecretEnvFile(directory, allowed), rejected);
  assert.throws(() => readSecretEnvFile(link, allowed), rejected);
  assert.throws(() => readSecretEnvFile(join(directory, 'missing.env'), allowed), rejected);
});

test('O_NOFOLLOW로 열고 검사와 읽기가 끝나면 fd를 닫는다', (t) => {
  const { path } = fixture(t);
  const open = fs.openSync;
  let opened: number | undefined;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    assert.equal(typeof args[1], 'number');
    assert.notEqual(Number(args[1]) & fs.constants.O_NOFOLLOW, 0);
    opened = open(...args);
    return opened;
  });
  const close = t.mock.method(fs, 'closeSync');
  readSecretEnvFile(path, allowed);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(close.mock.calls[0]!.arguments[0], opened);
});

test('fstat 뒤 경로가 교체돼도 검증한 원래 fd에서만 읽는다', (t) => {
  const { path } = fixture(t);
  const fstat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
    const stat = fstat(...args);
    fs.renameSync(path, path + '.original');
    fs.writeFileSync(path, 'NODE_OPTIONS=--import=DO_NOT_LEAK\n', { mode: 0o600 });
    return stat;
  });
  assert.equal(readSecretEnvFile(path, allowed).CUSTOMER_UNIT_VALUE, 'synthetic-only');
});

test('64KiB 상한을 넘긴 파일은 내용 읽기 전에 거부한다', (t) => {
  const { path } = fixture(t, '#'.repeat(65_537));
  const read = t.mock.method(fs, 'readSync');
  const close = t.mock.method(fs, 'closeSync');
  assert.throws(() => readSecretEnvFile(path, allowed), rejected);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(close.mock.callCount(), 1);
});

test('정확히 64KiB인 허용 키 파일은 읽을 수 있다', (t) => {
  // CUSTOMER_UNIT_VALUE= 접두사는 20바이트다.
  const { path } = fixture(t, 'CUSTOMER_UNIT_VALUE=' + 'x'.repeat(65_516));
  assert.equal(readSecretEnvFile(path, allowed).CUSTOMER_UNIT_VALUE?.length, 65_516);
});

test('검사 뒤 파일이 커져도 실제 읽기 상한을 적용한다', (t) => {
  const { path } = fixture(t);
  const fstat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
    const stat = fstat(...args);
    fs.appendFileSync(path, '#'.repeat(65_537));
    return stat;
  });
  const close = t.mock.method(fs, 'closeSync');
  assert.throws(() => readSecretEnvFile(path, allowed), rejected);
  assert.equal(close.mock.callCount(), 1);
});

for (const key of ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'PATH', 'PGOPTIONS', 'CUSTOMER_OTHER', '__proto__']) {
  test(`allowlist 밖 ${key}는 실행·환경 대입 없이 거부한다`, (t) => {
    const { path } = fixture(t, `CUSTOMER_UNIT_VALUE=synthetic\n${key}=DO_NOT_LEAK\n`);
    const close = t.mock.method(fs, 'closeSync');
    assert.throws(() => readSecretEnvFile(path, allowed), rejected);
    assert.equal(close.mock.callCount(), 1);
  });
}

test('읽기 오류 원문을 버리고 fd를 정리한다', (t) => {
  const { path } = fixture(t);
  t.mock.method(fs, 'readSync', () => { throw new Error('DO_NOT_LEAK'); });
  const close = t.mock.method(fs, 'closeSync');
  assert.throws(() => readSecretEnvFile(path, allowed), rejected);
  assert.equal(close.mock.callCount(), 1);
});
