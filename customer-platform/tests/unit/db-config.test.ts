import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { rootCertificates, type ConnectionOptions } from 'node:tls';
import { readDbTestConfig, connectionConfig } from '../../server/db/config.js';

const project = 'agddopryfqsyfshoowgk';
const host = `db.${project}.supabase.co`;
const url = (user: string, hostname = host) => `postgresql://${user}:synthetic-only@${hostname}:5432/postgres`;
const approved = () => ({
  CUSTOMER_DB_TEST_APPROVED: 'true',
  CUSTOMER_DB_TEST_URL: url('customer_app_login'),
  CUSTOMER_DB_TEST_ADMIN_URL: url('postgres'),
  CUSTOMER_DB_AUTH_URL: url('customer_auth_login'),
  CUSTOMER_DB_TEST_ID: `${host}:5432/postgres`,
});

test('승인과 전용 DB 식별값을 확인하고 인증서 검증을 강제한다', () => {
  const config = readDbTestConfig(approved());
  assert.equal(config.appUrl, url('customer_app_login'));
  assert.equal(config.adminUrl, url('postgres'));
  assert.equal(config.authUrl, url('customer_auth_login'));
  const pg = connectionConfig(config.appUrl, 'app');
  assert.equal((pg.ssl as ConnectionOptions).rejectUnauthorized, true);
  const ca = (pg.ssl as ConnectionOptions).ca;
  assert.equal(typeof ca, 'string');
  assert.equal(new X509Certificate(ca as string).fingerprint256,
    '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA');
  assert.deepEqual(Object.keys(pg.ssl as ConnectionOptions).sort(), ['ca', 'rejectUnauthorized']);
  assert.equal(pg.max, 3);
  assert.equal(pg.connectionTimeoutMillis, 5000);
});

for (const scenario of ['missing', 'malformed', 'different-ca', 'extra-ca']) {
  test(`공식 CA 파일 ${scenario}는 검증 해제 없이 고정 오류로 거부한다`, (t) => {
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith('/certs/supabase-root-2021.crt')) {
        if (scenario === 'missing') throw new Error('SYNTHETIC_TLS_DETAIL_NOT_FOR_OUTPUT');
        if (scenario === 'malformed') return 'SYNTHETIC_TLS_DETAIL_NOT_FOR_OUTPUT';
        if (scenario === 'different-ca') return rootCertificates[0]!;
        return String(read(...args)) + '\n' + rootCertificates[0]!;
      }
      return read(...args);
    });
    assert.throws(() => connectionConfig(url('customer_app_login'), 'app'),
      (e: unknown) => e instanceof Error && e.message === 'customer_db_tls_configuration');
  });
}

test('공식 CA 유효기간이 지나면 새 연결을 거부한다', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2032-01-01T00:00:00Z') });
  assert.throws(() => connectionConfig(url('customer_app_login'), 'app'),
    (e: unknown) => e instanceof Error && e.message === 'customer_db_tls_configuration');
});

for (const key of ['CUSTOMER_DB_TEST_APPROVED', 'CUSTOMER_DB_TEST_URL',
  'CUSTOMER_DB_TEST_ADMIN_URL', 'CUSTOMER_DB_TEST_ID', 'CUSTOMER_DB_AUTH_URL'] as const) {
  test(`${key} 누락 시 legacy 설정이 있어도 DB 실행을 거부한다`, () => {
    const config: Record<string, string> = { ...approved(), DATABASE_URL: url('postgres') };
    delete config[key];
    assert.throws(() => readDbTestConfig(config), /customer_db_configuration/);
  });
}

for (const patch of [
  { CUSTOMER_DB_TEST_APPROVED: 'TRUE' },
  { CUSTOMER_DB_TEST_URL: url('postgres') },
  { CUSTOMER_DB_TEST_URL: url('customer_auth_login') },
  { CUSTOMER_DB_TEST_ADMIN_URL: url('customer_app_login') },
  { CUSTOMER_DB_TEST_URL: url('customer_app_login', 'db.otherproject.supabase.co') },
  { CUSTOMER_DB_TEST_ADMIN_URL: url('postgres', 'db.otherproject.supabase.co') },
  { CUSTOMER_DB_TEST_URL: url('customer_app_login') + '?sslmode=no-verify' },
  { CUSTOMER_DB_TEST_URL: url('customer_app_login') + '?options=-c%20role%3Dpostgres' },
  { CUSTOMER_DB_TEST_URL: url('customer_app_login').replace(':5432/', ':6543/') },
  { CUSTOMER_DB_TEST_URL: url('customer_app_login').replace('/postgres', '/other') },
  { CUSTOMER_DB_TEST_URL: 'not-a-url' },
  { CUSTOMER_DB_TEST_ID: 'legacy:5432/postgres' },
]) {
  test(`미승인 대상·역할·TLS 우회 설정을 거부한다: ${Object.keys(patch)[0]}`, () => {
    assert.throws(() => readDbTestConfig({ ...approved(), ...patch }), /customer_db_configuration/);
  });
}

test('무료 session pooler도 프로젝트가 포함된 계정과 5432 포트로 한정한다', () => {
  const pooler = 'aws-1-ap-northeast-2.pooler.supabase.com';
  const config = readDbTestConfig({ ...approved(),
    CUSTOMER_DB_TEST_URL: url(`customer_app_login.${project}`, pooler),
    CUSTOMER_DB_TEST_ADMIN_URL: url(`postgres.${project}`, pooler),
    CUSTOMER_DB_AUTH_URL: url(`customer_auth_login.${project}`, pooler),
    CUSTOMER_DB_TEST_ID: `${pooler}:5432/postgres`,
  });
  assert.equal(config.appUrl, url(`customer_app_login.${project}`, pooler));
  assert.throws(() => readDbTestConfig({ ...approved(),
    CUSTOMER_DB_TEST_URL: url('customer_app_login.someotherproject', pooler),
    CUSTOMER_DB_TEST_ADMIN_URL: url(`postgres.${project}`, pooler),
    CUSTOMER_DB_AUTH_URL: url(`customer_auth_login.${project}`, pooler),
    CUSTOMER_DB_TEST_ID: `${pooler}:5432/postgres`,
  }), /customer_db_configuration/);
});

test('환경 오류 메시지에 연결 URL·비밀번호를 포함하지 않는다', () => {
  try { readDbTestConfig({ ...approved(), CUSTOMER_DB_TEST_ADMIN_URL: 'postgresql://bad:DO_NOT_LEAK@bad/db' }); }
  catch (error) {
    assert.equal((error as Error).message, 'customer_db_configuration');
    return;
  }
  assert.fail('invalid configuration accepted');
});

for (const password of ['[YOUR-PASSWORD]', 'REPLACE_WITH_URL_ENCODED_PASSWORD']) {
  test(`실제 비밀값이 아닌 자리표시자 ${password}로 접속하지 않는다`, () => {
    assert.throws(() => connectionConfig(`postgresql://customer_app_login:${encodeURIComponent(password)}@${host}:5432/postgres`, 'app'),
      /customer_db_configuration/);
  });
}

test('PGOPTIONS 환경변수의 역할 변경 옵션을 연결에 상속하지 않는다', () => {
  const previous = process.env.PGOPTIONS;
  process.env.PGOPTIONS = '-c role=postgres';
  try {
    const client = new pg.Client(connectionConfig(url('customer_app_login'), 'app'));
    const parameters = (client as unknown as { connectionParameters: { options: string } }).connectionParameters;
    assert.equal(parameters.options, '-c search_path=pg_catalog');
  } finally {
    if (previous === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previous;
  }
});

test('DB 실행 명령은 승인값이 없으면 접속 전 종료 코드 78을 반환한다', () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CUSTOMER_DB_')) delete env[key];
  env.DATABASE_URL = 'postgresql://never:DO_NOT_LEAK@127.0.0.1:1/legacy';
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/test-db.ts'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /customer_db_configuration/);
  assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_LEAK|never:|legacy/);
});
