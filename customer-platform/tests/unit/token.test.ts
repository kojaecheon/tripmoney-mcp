import test from 'node:test';
import assert from 'node:assert/strict';
import { makeInviteToken, verifyInviteToken, sha256, canonicalHash } from '../../core/token.js';
import { IdentityError } from '../../core/contracts.js';

const id = '11111111-1111-4111-8111-111111111111';
const key = Buffer.alloc(32, 7);
// OpenSSL HMAC-SHA256으로 별도 계산한 합성 데이터의 고정 벡터.
const known = 'v1.11111111-1111-4111-8111-111111111111.MaviBLFaDgwpYu9YPmeyY2g44hSp7MhxnbFlE7ew-tY';
const unavailable = (error: unknown) => error instanceof IdentityError && error.code === 'invite_unavailable';
const validation = (error: unknown) => error instanceof IdentityError && error.code === 'validation';

test('초대 서명은 독립적으로 계산한 고정 벡터와 일치한다', () => {
  assert.equal(makeInviteToken(id, 'v1', key), known);
  assert.equal(makeInviteToken(id, 'v1', key), known);
  assert.deepEqual(verifyInviteToken(known, { v1: key }), { id, kid: 'v1', hash: sha256(known) });
});
test('SHA-256은 알려진 표준 벡터와 일치한다', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('생성한 UUID는 소문자로 정규화한다', () => {
  const value = makeInviteToken('ABCDEFAB-1234-4234-8234-ABCDEFABCDEF', 'v1', key);
  assert.equal(verifyInviteToken(value, { v1: key }).id, 'abcdefab-1234-4234-8234-abcdefabcdef');
});
test('키가 바뀌면 같은 초대 ID라도 서명이 달라진다', () => {
  assert.notEqual(makeInviteToken(id, 'v1', Buffer.alloc(32, 8)), known);
  assert.notEqual(makeInviteToken(id, 'v2', key), known);
  assert.notEqual(makeInviteToken('22222222-2222-4222-8222-222222222222', 'v1', key), known);
});
test('키 교체 후에도 저장된 과거 kid의 초대를 검증할 수 있다', () => {
  assert.equal(verifyInviteToken(known, { v1: key, v2: Buffer.alloc(32, 8) }).kid, 'v1');
});
const badTokens: unknown[] = [
  '', null, 123, {}, 'v1.id.mac', ` ${known}`, `${known} `, `${known}\n`, `${known}.extra`,
  known.replace('11111111', '21111111'), known.replace('.Mavi', '.Navi'),
  known.replace('v1.', 'v2.'), `${known}=`, known.replace('-tY', '+tY'),
  known.replace('v1.', '__proto__.'), known.replace('v1.', 'constructor.'),
  known.replace('v1.', 'prototype.'), known.replace('4111', '411A'),
  known.replace('.Mavi', '.M\navi'), 'x'.repeat(500),
];
for (const token of badTokens) {
  test(`잘못된 초대 입력 ${String(token).slice(0, 18)}는 일반 초대 오류로 거부한다`, () => {
    assert.throws(() => verifyInviteToken(token as string, { v1: key }), unavailable);
  });
}
test('없는 키·틀린 키·상속된 키는 허용하지 않는다', () => {
  assert.throws(() => verifyInviteToken(known, {}), unavailable);
  assert.throws(() => verifyInviteToken(known, { v1: Buffer.alloc(32, 8) }), unavailable);
  assert.throws(() => verifyInviteToken(known, Object.create({ v1: key })), unavailable);
});
for (const [uuid, kid, bytes] of [
  ['bad-id', 'v1', key], [id, '', key], [id, 'v'.repeat(17), key],
  [id, 'v.1', key], [id, '__proto__', key], [id, 'constructor', key],
  [id, 'prototype', key], [id, 'v1', Buffer.alloc(31)], [id, 'v1', Buffer.alloc(33)],
  [`${id}\n`, 'v1', key], [id, 'v1\n', key],
] as const) {
  test('잘못된 발급 설정은 고객 입력 오류로 거부한다', () => {
    assert.throws(() => makeInviteToken(uuid, kid, bytes), validation);
  });
}

test('객체 키 순서는 달라도 같은 요청의 해시는 같다', () => {
  const expected = '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777';
  assert.equal(canonicalHash({ b: 2, a: 1 }), expected);
  assert.equal(canonicalHash({ a: 1, b: 2 }), expected);
  assert.equal(canonicalHash({ a: { y: 2, x: 1 } }), canonicalHash({ a: { x: 1, y: 2 } }));
});
test('배열 순서·null·누락·요청 대상·revision 변경은 구분한다', () => {
  assert.notEqual(canonicalHash({ a: [1, 2] }), canonicalHash({ a: [2, 1] }));
  assert.notEqual(canonicalHash({ a: null }), canonicalHash({}));
  assert.notEqual(canonicalHash({ tripId: 'A', expectedRevision: 1 }),
    canonicalHash({ tripId: 'B', expectedRevision: 1 }));
  assert.notEqual(canonicalHash({ expectedRevision: 1 }), canonicalHash({ expectedRevision: 2 }));
});
test('음의 0과 0은 같은 JSON 금액으로 중복 판정한다', () => {
  assert.equal(canonicalHash({ budgetKrw: -0 }), canonicalHash({ budgetKrw: 0 }));
});
test('해시 계산이 원문 객체와 배열을 변경하지 않는다', () => {
  const input = Object.freeze({ b: Object.freeze([2, 1]), a: Object.freeze({ y: 2, x: 1 }) });
  canonicalHash(input);
  assert.deepEqual(input, { b: [2, 1], a: { y: 2, x: 1 } });
});
for (const value of [undefined, NaN, Infinity, BigInt(1), () => 1, Symbol('test'), new Date(), new Map(), Object.create(null)]) {
  test('JSON 명령으로 표현할 수 없는 값은 해시 계산을 거부한다', () => {
    assert.throws(() => canonicalHash({ value }), validation);
  });
}
test('순환·배열 빈칸·최상위 원시값을 거부한다', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => canonicalHash(cycle), validation);
  assert.throws(() => canonicalHash({ values: Array(1) }), validation);
  assert.throws(() => canonicalHash('string' as unknown as Record<string, unknown>), validation);
});
test('getter를 실행하거나 symbol 필드를 조용히 누락하지 않는다', () => {
  let called = false;
  const accessor = Object.defineProperty({}, 'a', { enumerable: true, get() { called = true; return 1; } });
  assert.throws(() => canonicalHash(accessor), validation);
  assert.equal(called, false);
  assert.throws(() => canonicalHash({ [Symbol('hidden')]: 1 }), validation);
});
