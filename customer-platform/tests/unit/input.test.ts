import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrip, normalizeAlias, assertInviteRole } from '../../core/input.js';
import { IdentityError, type TripInput } from '../../core/contracts.js';

const valid: TripInput = Object.freeze({
  name: '방콕 여행', destination: '방콕', startDate: '2026-11-01', endDate: '2026-11-03',
  timeZone: 'Asia/Bangkok', budgetKrw: 100000, alias: 'A',
  settlementMode: 'daily', dailyTime: '20:00',
});
const validation = (field?: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === 'validation' &&
  (field === undefined || error.field === field);

test('여행 입력을 복제하고 공백과 별칭 NFC를 정규화한다', () => {
  const input = Object.freeze({ ...valid, name: ' 여행 ', destination: ' 방콕 ', alias: ' \u1100\u1161 ' });
  const result = normalizeTrip(input);
  assert.deepEqual(result, { ...valid, name: '여행', alias: '가' });
  assert.notEqual(result, input);
  assert.equal(input.alias, ' \u1100\u1161 ');
});
test('분해형 라틴 별칭은 NFC로 합치고 여행명·목적지는 승인 계약대로 유지한다', () => {
  const result = normalizeTrip({ ...valid, alias: 'e\u0301', name: 'e\u0301', destination: 'e\u0301' });
  assert.equal(result.alias, '\u00e9');
  assert.equal(result.name, 'e\u0301');
  assert.equal(result.destination, 'e\u0301');
});
test('별칭의 대소문자를 구분한다', () => {
  assert.equal(normalizeAlias(' A '), 'A');
  assert.equal(normalizeAlias('a'), 'a');
});
test('길이는 UTF-16 길이가 아닌 유니코드 코드 포인트로 검사한다', () => {
  assert.equal(normalizeAlias('😀'.repeat(40)), '😀'.repeat(40));
  assert.equal(normalizeTrip({ ...valid, name: '😀'.repeat(80) }).name, '😀'.repeat(80));
  assert.equal(normalizeTrip({ ...valid, destination: '가'.repeat(100) }).destination, '가'.repeat(100));
});
for (const value of ['', ' ', '가'.repeat(41), '\u0000A', 'A\nB', 'A\u007fB', null, 1]) {
  test(`잘못된 별칭 ${JSON.stringify(value)}는 alias 오류로 거부한다`, () => {
    assert.throws(() => normalizeAlias(value as string), validation('alias'));
  });
}

const badInputs: [string, unknown][] = [
  ['name', ''], ['name', '가'.repeat(81)], ['name', 'A\nB'], ['name', 1],
  ['destination', ' '], ['destination', '가'.repeat(101)], ['destination', '\u0000'],
  ['startDate', '2026-02-30'], ['startDate', '1900-02-29'], ['startDate', '0000-01-01'],
  ['startDate', '2026-2-01'], ['startDate', '2026-11-01T00:00:00Z'],
  ['startDate', null], ['startDate', ''], ['endDate', '2026-10-31'],
  ['endDate', '2026-11-15'], ['endDate', '2026-11-31'], ['endDate', undefined],
  ['timeZone', 'Mars/Unknown'], ['timeZone', ''], ['timeZone', '+09:00'],
  ['timeZone', '-03:30'], ['timeZone', null],
  ['budgetKrw', -1], ['budgetKrw', 1.1], ['budgetKrw', '1000'], ['budgetKrw', null],
  ['budgetKrw', NaN], ['budgetKrw', Infinity], ['budgetKrw', Number.MAX_SAFE_INTEGER + 1],
  ['settlementMode', 'weekly'], ['settlementMode', null],
  ['dailyTime', '24:00'], ['dailyTime', '9:00'], ['dailyTime', '20:60'],
  ['dailyTime', '20:00:00'], ['dailyTime', 20],
  ['dailyTime', '20:00\n'], ['startDate', '2026-11-01\n'],
];
for (const [field, value] of badInputs) {
  test(`잘못된 ${field}=${String(value)}는 저장할 수 없다`, () => {
    assert.throws(() => normalizeTrip({ ...valid, [field]: value } as TripInput), validation(field));
  });
}
test('여행 기간은 양 끝 날짜를 포함해 14일까지 허용한다', () => {
  assert.equal(normalizeTrip({ ...valid, endDate: '2026-11-14' }).endDate, '2026-11-14');
  assert.equal(normalizeTrip({ ...valid, endDate: valid.startDate }).endDate, valid.startDate);
});
test('실제 윤년의 날짜를 허용한다', () => {
  assert.equal(normalizeTrip({ ...valid, startDate: '2000-02-29', endDate: '2000-03-01' }).startDate,
    '2000-02-29');
});
test('예산 0원과 안전 정수 최댓값을 허용한다', () => {
  assert.equal(normalizeTrip({ ...valid, budgetKrw: 0 }).budgetKrw, 0);
  assert.equal(normalizeTrip({ ...valid, budgetKrw: Number.MAX_SAFE_INTEGER }).budgetKrw,
    Number.MAX_SAFE_INTEGER);
});
test('UTC와 현지 IANA 시간대, 하루의 양 끝 시각을 허용한다', () => {
  assert.equal(normalizeTrip({ ...valid, timeZone: 'UTC', dailyTime: '00:00' }).timeZone, 'UTC');
  assert.equal(normalizeTrip({ ...valid, dailyTime: '23:59' }).dailyTime, '23:59');
  assert.equal(normalizeTrip({ ...valid, timeZone: 'asia/bangkok' }).timeZone, 'Asia/Bangkok');
});
for (const input of [null, [], 'trip', {}, { ...valid, actor: 'forged' }, Object.create(valid)]) {
  test('잘못된 여행 구조나 지정되지 않은 필드를 거부한다', () => {
    assert.throws(() => normalizeTrip(input as TripInput), validation());
  });
}
for (const role of ['editor', 'viewer'] as const) {
  test(`${role} 초대를 허용한다`, () => assert.equal(assertInviteRole(role), role));
}
for (const role of ['owner', 'admin', '__proto__', null, {}, 1]) {
  test(`${String(role)} 초대 권한을 거부한다`, () => {
    assert.throws(() => assertInviteRole(role), validation('role'));
  });
}
