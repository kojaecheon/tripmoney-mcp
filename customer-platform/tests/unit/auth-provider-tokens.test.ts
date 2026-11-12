import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityError } from '../../core/contracts.js';
import { readProviderTokens } from '../../server/auth/provider-tokens.js';

const valid = {
  accessToken: 'e30.e30.c3ludGhldGlj',
  refreshToken: 'synthetic-refresh',
  expiresAt: 1_800_000_000,
  userId: '11111111-1111-4111-8111-111111111111',
  providerSessionId: '22222222-2222-4222-8222-222222222222',
};

function rejects(value: unknown, expected?: { userId: string; providerSessionId: string }) {
  assert.throws(() => readProviderTokens(value, expected), (error: unknown) =>
    error instanceof IdentityError && error.code === 'unavailable'
      && error.message === '인증 확인을 잠시 사용할 수 없습니다.'
      && !Object.hasOwn(error, 'cause'));
}

test('초 단위 기한을 유지하고 이미 만료된 정상 형식을 허용한다', () => {
  assert.deepEqual(readProviderTokens(valid), valid);
  assert.equal(readProviderTokens({ ...valid, expiresAt: 1 }).expiresAt, 1);
  assert.equal(readProviderTokens({ ...valid, expiresAt: Number.MAX_SAFE_INTEGER }).expiresAt,
    Number.MAX_SAFE_INTEGER);
});

test('필수 필드 다섯 개만 새로운 객체로 복사한다', () => {
  const input = { ...valid, ignored: 'synthetic-extra' };
  const result = readProviderTokens(input);
  assert.deepEqual(result, valid);
  assert.notEqual(result, input);
});

test('null과 배열 및 객체가 아닌 입력을 고정 오류로 거부한다', () => {
  for (const value of [null, undefined, [], Object.assign([], valid), 'synthetic', 1, true]) {
    rejects(value);
  }
});

test('필드가 누락되거나 상속된 입력은 거부한다', () => {
  for (const field of Object.keys(valid)) {
    const input: Record<string, unknown> = { ...valid };
    delete input[field];
    rejects(input);
    rejects(Object.assign(Object.create({ [field]: valid[field as keyof typeof valid] }), input));
  }
});

test('필수 필드 getter를 실행하지 않고 거부한다', () => {
  for (const field of Object.keys(valid)) {
    let calls = 0;
    const input = Object.defineProperty({ ...valid }, field, {
      get() { calls += 1; throw new Error('synthetic-private-content'); },
    });
    rejects(input);
    assert.equal(calls, 0);
  }
});

test('descriptor 조회 실패의 원문과 cause를 오류에 보존하지 않는다', () => {
  rejects(new Proxy(valid, {
    ownKeys() { throw new Error('synthetic-private-content'); },
  }));
});

test('기한의 잘못된 타입과 양수가 아닌 값 및 안전하지 않은 정수를 거부한다', () => {
  for (const expiresAt of [undefined, null, '1800000000', NaN, Infinity, -Infinity,
    0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    rejects({ ...valid, expiresAt });
  }
});

test('access token은 verifier와 같은 세 구간 base64url JWT 형식만 허용한다', () => {
  for (const accessToken of ['', 'synthetic', 'a.b', 'a.b.c.d', '.b.c', 'a..c',
    'a.b.', 'a.b.c=', 'a.b.c+', 'a.b.c/', 1, null]) {
    rejects({ ...valid, accessToken });
  }
});

test('토큰은 공백과 제어문자를 거부한다', () => {
  for (const field of ['accessToken', 'refreshToken']) {
    for (const separator of [' ', '\t', '\r', '\n', '\0', '\x1f', '\x7f', '\u0085', '\u00a0']) {
      rejects({ ...valid, [field]: `${valid[field as 'accessToken' | 'refreshToken']}${separator}` });
    }
  }
});

test('refresh token은 비어 있지 않은 문자열이어야 한다', () => {
  for (const refreshToken of ['', undefined, null, 1, {}]) rejects({ ...valid, refreshToken });
});

test('각 토큰의 16KiB 경계와 refresh token의 UTF-8 바이트 상한을 검사한다', () => {
  const accessToken = `a.b.${'c'.repeat(16 * 1024 - 4)}`;
  assert.equal(readProviderTokens({ ...valid, accessToken }).accessToken, accessToken);
  rejects({ ...valid, accessToken: `${accessToken}c` });
  const refreshToken = 'r'.repeat(16 * 1024);
  assert.equal(readProviderTokens({ ...valid, refreshToken }).refreshToken, refreshToken);
  rejects({ ...valid, refreshToken: `${refreshToken}r` });
  rejects({ ...valid, refreshToken: '가'.repeat(6000) });
});

test('사용자와 세션 식별자는 nil을 제외한 UUID여야 한다', () => {
  for (const field of ['userId', 'providerSessionId']) {
    for (const value of [undefined, null, 1, '', 'synthetic',
      '00000000-0000-0000-0000-000000000000', '11111111-1111-4111-8111-11111111111g']) {
      rejects({ ...valid, [field]: value });
    }
  }
  const userId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  assert.equal(readProviderTokens({ ...valid, userId }).userId, userId);
});

test('저장된 사용자와 세션 식별자가 둘 다 정확히 일치해야 한다', () => {
  const expected = { userId: valid.userId, providerSessionId: valid.providerSessionId };
  assert.deepEqual(readProviderTokens(valid, expected), valid);
  rejects(valid, { ...expected, userId: '33333333-3333-4333-8333-333333333333' });
  rejects(valid, { ...expected, providerSessionId: '33333333-3333-4333-8333-333333333333' });
  const userId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  rejects({ ...valid, userId }, { ...expected, userId: userId.toLowerCase() });
});
