import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { seal, open } from '../../server/auth/crypto.js';

const keys = { k1: Buffer.alloc(32, 4), k2: Buffer.alloc(32, 5) };
const aad = 'session:synthetic-id';
const payload = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' };

function fixedError(message: string) {
  return (error: unknown) => error instanceof Error && error.message === message
    && !Object.hasOwn(error, 'cause');
}
const configError = fixedError('crypto_config');
const envelopeError = fixedError('crypto_envelope');

// The fixture encrypts raw text independently so open must authenticate before parsing JSON.
function encryptText(text: string, boundAad = aad): string {
  const iv = Buffer.alloc(12, 9);
  const cipher = createCipheriv('aes-256-gcm', keys.k1, iv);
  cipher.setAAD(Buffer.from(boundAad));
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['k1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

test('AES-256-GCM 독립 fixture를 복호화한다', () => {
  assert.deepEqual(open(encryptText('{"ok":true}'), keys, aad), { ok: true });
});

test('발급한 envelope는 독립 AES-256-GCM 복호화와 일치한다', () => {
  const parts = seal(payload, 'k1', keys, aad).split('.');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'k1');
  const iv = Buffer.from(parts[1]!, 'base64url');
  const tag = Buffer.from(parts[2]!, 'base64url');
  assert.equal(iv.length, 12);
  assert.equal(tag.length, 16);
  const decipher = createDecipheriv('aes-256-gcm', keys.k1, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]);
  assert.deepEqual(JSON.parse(plain.toString('utf8')), payload);
  assert.equal(parts.slice(1).every(part => part === Buffer.from(part, 'base64url').toString('base64url')), true);
});

const roundTrips: Array<[string, unknown, unknown]> = [
  ['객체', payload, payload], ['배열', [1, null, '합성'], [1, null, '합성']],
  ['문자열', '합성 토큰 😀', '합성 토큰 😀'], ['빈 문자열', '', ''],
  ['숫자', 42, 42], ['참', true, true], ['거짓', false, false], ['null', null, null],
  ['NaN', NaN, null], ['무한대', Infinity, null], ['음의 0', -0, 0],
  ['누락 필드', { a: undefined, b: 1 }, { b: 1 }],
  ['배열 undefined', [undefined], [null]],
  ['toJSON', { toJSON() { return { json: true }; } }, { json: true }],
];
for (const [name, value, expected] of roundTrips) {
  test(`${name} payload는 JSON 왕복 규칙을 따른다`, () => {
    assert.deepEqual(open(seal(value, 'k1', keys, aad), keys, aad), expected);
  });
}

test('같은 payload를 반복 암호화해도 nonce를 재사용하지 않는다', () => {
  const nonces = Array.from({ length: 64 }, () => seal(payload, 'k1', keys, aad).split('.')[1]);
  assert.equal(new Set(nonces).size, 64);
});

test('key rotation 중 과거 키와 새 키를 모두 복호화한다', () => {
  const old = seal(payload, 'k1', keys, aad);
  const current = seal(payload, 'k2', keys, aad);
  assert.deepEqual(open(old, keys, aad), payload);
  assert.deepEqual(open(current, { k2: keys.k2 }, aad), payload);
  assert.throws(() => open(old, { k2: keys.k2 }, aad), envelopeError);
  assert.throws(() => open(old, { k1: Buffer.alloc(31) }, aad), envelopeError);
});

test('다른 AAD와 다른 키는 고정 오류로 거부한다', () => {
  const cipher = seal(payload, 'k1', keys, aad);
  for (const other of ['session:other-id', 'challenge:synthetic-id', ` ${aad}`, `${aad} `, `${aad}\n`]) {
    assert.throws(() => open(cipher, keys, other), envelopeError);
  }
  assert.throws(() => open(cipher, { k1: keys.k2 }, aad), envelopeError);
});

test('AAD는 정규화 없이 전달한 UTF-8 바이트를 인증한다', () => {
  for (const boundAad of [' ', '종류:합성', 'session:é', 'session:e\u0301']) {
    assert.deepEqual(open(seal(payload, 'k1', keys, boundAad), keys, boundAad), payload);
  }
  assert.throws(() => open(seal(payload, 'k1', keys, 'session:é'), keys, 'session:e\u0301'), envelopeError);
});

test('kid와 nonce, tag, data의 변조를 모두 거부한다', () => {
  const parts = seal(payload, 'k1', keys, aad).split('.');
  const alias = { ...keys, alias: keys.k2 };
  assert.throws(() => open(['alias', ...parts.slice(1)].join('.'), alias, aad), envelopeError);
  for (const index of [1, 2, 3]) {
    const changed = [...parts];
    const bytes = Buffer.from(changed[index]!, 'base64url');
    bytes[0] = bytes[0]! ^ 1;
    changed[index] = bytes.toString('base64url');
    assert.throws(() => open(changed.join('.'), keys, aad), envelopeError);
  }
});

test('envelope는 정확히 네 부분이며 문자열만 허용한다', () => {
  const cipher = seal(payload, 'k1', keys, aad);
  const invalid: unknown[] = ['', null, undefined, 1, {}, [], 'k1', 'k1.a.b', `${cipher}.extra`, `.${cipher}`];
  for (const value of invalid) {
    assert.throws(() => open(value as string, keys, aad), envelopeError);
  }
});

test('nonce와 tag의 길이가 다르거나 빈 data이면 거부한다', () => {
  const parts = seal(payload, 'k1', keys, aad).split('.');
  for (const [index, lengths] of [[1, [0, 11, 13]], [2, [0, 15, 17]], [3, [0]]] as const) {
    for (const length of lengths) {
      const changed = [...parts];
      changed[index] = Buffer.alloc(length).toString('base64url');
      assert.throws(() => open(changed.join('.'), keys, aad), envelopeError);
    }
  }
});

test('모든 이진 필드는 비정규 Base64url과 공백을 거부한다', () => {
  const parts = seal('a', 'k1', keys, aad).split('.');
  for (const index of [1, 2, 3]) {
    for (const bad of [`${parts[index]}=`, `${parts[index]}\n`, ` ${parts[index]}`, `${parts[index]} `,
      `${parts[index]}+`, `${parts[index]}/`, 'A', '*', '\u200b']) {
      const changed = [...parts];
      changed[index] = bad;
      assert.throws(() => open(changed.join('.'), keys, aad), envelopeError);
    }
  }
  // 16-byte tags have four unused low bits in their final Base64url symbol.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const nonCanonical = [...parts];
  const tag = parts[2]!;
  nonCanonical[2] = tag.slice(0, -1) + alphabet[alphabet.indexOf(tag.at(-1)!) + 1];
  assert.throws(() => open(nonCanonical.join('.'), keys, aad), envelopeError);
  const shortPayload = seal('', 'k1', keys, aad).split('.');
  const data = shortPayload[3]!;
  shortPayload[3] = data.slice(0, -1) + alphabet[alphabet.indexOf(data.at(-1)!) + 1];
  assert.throws(() => open(shortPayload.join('.'), keys, aad), envelopeError);
});

test('키 ID는 허용한 문자와 1~16자 경계만 허용한다', () => {
  for (const kid of ['a', 'A_0-', 'x'.repeat(16), '__proto__', 'constructor', 'prototype']) {
    const ownKeys = { [kid]: keys.k1 };
    assert.deepEqual(open(seal(payload, kid, ownKeys, aad), ownKeys, aad), payload);
  }
  const parts = seal(payload, 'k1', keys, aad).split('.');
  const invalid: unknown[] = ['', 'x'.repeat(17), 'k.1', ' k1', 'k1 ', 'k1\n', 'k1\r', '한글', null, 1];
  for (const kid of invalid) {
    const ownKeys = { [String(kid)]: keys.k1 };
    assert.throws(() => seal(payload, kid as string, ownKeys, aad), configError);
    if (typeof kid === 'string') {
      assert.throws(() => open([kid, ...parts.slice(1)].join('.'), ownKeys, aad), envelopeError);
    }
  }
});

test('상속 키와 누락 키를 허용하지 않고 keyring 자체 메서드에 의존하지 않는다', () => {
  const cipher = seal(payload, 'k1', keys, aad);
  for (const keyring of [{}, Object.create({ k1: keys.k1 }), null, undefined]) {
    assert.throws(() => seal(payload, 'k1', keyring, aad), configError);
    assert.throws(() => open(cipher, keyring, aad), envelopeError);
  }
  const nullPrototype = Object.assign(Object.create(null), { k1: keys.k1, hasOwnProperty: null });
  assert.deepEqual(open(seal(payload, 'k1', nullPrototype, aad), nullPrototype, aad), payload);
});

test('키는 정확히 32바이트 Buffer여야 한다', () => {
  const cipher = seal(payload, 'k1', keys, aad);
  const invalid: unknown[] = [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), new Uint8Array(32),
    'x'.repeat(32), { length: 32 }, null, undefined];
  for (const key of invalid) {
    const keyring = { k1: key } as Record<string, Buffer>;
    assert.throws(() => seal(payload, 'k1', keyring, aad), configError);
    assert.throws(() => open(cipher, keyring, aad), envelopeError);
  }
});

test('빈 AAD와 문자열이 아닌 AAD는 고정 오류로 거부한다', () => {
  const cipher = seal(payload, 'k1', keys, aad);
  for (const value of ['', null, undefined, 1, Buffer.from(aad), new String(aad)]) {
    assert.throws(() => seal(payload, 'k1', keys, value as string), configError);
    assert.throws(() => open(cipher, keys, value as string), envelopeError);
  }
});

test('직렬화할 수 없는 payload의 원문 오류와 cause를 노출하지 않는다', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const throws = { toJSON() { throw new Error('synthetic-secret-detail', { cause: 'synthetic-cause' }); } };
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('synthetic-getter'); } });
  for (const value of [undefined, () => 1, Symbol('synthetic'), 1n, cycle, throws, getter]) {
    assert.throws(() => seal(value, 'k1', keys, aad), configError);
  }
});

test('인증에 성공해도 JSON이 아닌 payload는 고정 오류로 거부한다', () => {
  for (const text of ['', 'undefined', '{"synthetic":"secret"', '{"a":1} trailing']) {
    assert.throws(() => open(encryptText(text), keys, aad), envelopeError);
  }
});
