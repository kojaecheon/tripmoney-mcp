import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

let model = {};
try { model = await import('../model.mjs'); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const seed = {
  trip: { id: 'sample', name: '합성 여행', organizer_id: 'a' },
  members: [
    { id: 'a', alias: '총무', role: 'organizer' },
    { id: 'b', alias: '참여자 B', role: 'participant' },
    { id: 'c', alias: '참여자 C', role: 'participant' },
  ],
  expenses: [
    { id: 'e1', title: '합성 식사', amount: 101, currency: 'KRW', rate: 1, payer_id: 'a', split_ids: ['a', 'b', 'c'] },
    { id: 'e2', title: '합성 교통', amount: 50, currency: 'KRW', rate: 1, payer_id: 'b', split_ids: ['b', 'c'] },
  ],
};
const at = '2026-10-08T00:00:00.000Z';
const fresh = () => model.createState(seed);

test('환산액 분담 합계와 멤버 순액이 보존된다', () => {
  assert.equal(typeof model.createState, 'function', '공유 샘플 상태 모델 필요');
  const result = model.calculate(fresh());
  assert.equal(result.total, 151);
  assert.deepEqual(result.members.map(m => [m.id, m.paid, m.owed, m.net]), [
    ['a', 101, 34, 67], ['b', 50, 59, -9], ['c', 0, 58, -58],
  ]);
  assert.deepEqual(result.transfers.map(t => [t.from_id, t.to_id, t.amount]), [['c', 'a', 58], ['b', 'a', 9]]);
});

test('잔여 1원 배분은 저장된 분담 배열 순서가 아니라 고정 멤버 순서를 따른다', () => {
  const state = fresh();
  state.expenses[0].splitIds.reverse();
  assert.deepEqual(model.calculate(state), model.calculate(fresh()));
});

test('초기 또는 저장된 분담 순서만 달라도 무변경 저장은 승인과 검토 상태를 유지한다', () => {
  for (const fromStorage of [false, true]) {
    const reversedSeed = structuredClone(seed);
    if (!fromStorage) reversedSeed.expenses[0].split_ids.reverse();
    let state = model.approveOrganizer(model.createState(reversedSeed), 1, at);
    state = model.decideParticipant(state, 'b', 'approved', null, 1, at);
    state = model.markQa(state, 1, at);
    state = model.closeReview(state, 1, at);
    if (fromStorage) {
      state.expenses[0].splitIds.reverse();
      state = model.createStore(seed, { getItem: () => JSON.stringify(state), removeItem() {} }).load();
    }
    const next = model.updateExpense(state, 'e1', { amount: '101', payerId: 'a', splitIds: ['a', 'b', 'c'] }, 1, at);
    assert.equal(next.version, 1);
    assert.equal(next.organizerApprovedAt, at);
    assert.equal(next.decisions.b.status, 'approved');
    assert.equal(next.qaAt, at);
    assert.equal(next.reviewClosedAt, at);
    assert.deepEqual(next, state);
  }
});

test('지출 수정은 새 버전을 만들고 기존 승인과 이의를 무효화한다', () => {
  assert.equal(typeof model.updateExpense, 'function');
  let state = model.approveOrganizer(fresh(), 1, at);
  state = model.decideParticipant(state, 'b', 'objection', 'amount', 1, at);
  const next = model.updateExpense(state, 'e1', { amount: '102', payerId: 'a', splitIds: ['a', 'b', 'c'] }, 1, at);
  assert.equal(next.version, 2);
  assert.equal(model.calculate(next).total, 152);
  assert.equal(next.organizerApprovedAt, null);
  assert.equal(next.decisions.b.status, 'not_responded');
  assert.equal(next.decisions.b.reason, null);
  assert.equal(state.version, 1);
  assert.equal(model.calculate(state).total, 151);
});

test('음수, 빈값, 과대 금액, 지수표기, 모르는 결제자를 거부한다', () => {
  assert.equal(typeof model.updateExpense, 'function');
  for (const amount of ['-1', '', '0', '1000001', '1e3', '1.001', 'Infinity']) {
    assert.throws(() => model.updateExpense(fresh(), 'e1', { amount, payerId: 'a', splitIds: ['a'] }, 1, at));
  }
  assert.throws(() => model.updateExpense(fresh(), 'e1', { amount: '10', payerId: 'unknown', splitIds: ['a'] }, 1, at));
  assert.throws(() => model.updateExpense(fresh(), 'e1', { amount: '10', payerId: 'a', splitIds: [] }, 1, at));
  assert.throws(() => model.updateExpense(fresh(), 'e1', { amount: '10', payerId: 'a', splitIds: ['a', 'a'] }, 1, at));
});

test('이전 버전에서 누른 승인과 수정은 거부한다', () => {
  assert.equal(typeof model.approveOrganizer, 'function');
  const state = model.updateExpense(fresh(), 'e1', { amount: '102', payerId: 'a', splitIds: ['a'] }, 1, at);
  assert.throws(() => model.approveOrganizer(state, 1, at), /버전/);
  assert.throws(() => model.updateExpense(state, 'e1', { amount: '103', payerId: 'a', splitIds: ['a'] }, 1, at), /버전/);
});

test('총무 승인 전 참여자 결정은 불가능하다', () => {
  assert.equal(typeof model.decideParticipant, 'function');
  assert.throws(() => model.decideParticipant(fresh(), 'b', 'approved', null, 1, at), /총무/);
});

test('이의는 고정 사유만 받으며 철회해도 승인으로 바뀌지 않는다', () => {
  assert.equal(typeof model.withdrawObjection, 'function');
  const approved = model.approveOrganizer(fresh(), 1, at);
  assert.throws(() => model.decideParticipant(approved, 'b', 'objection', 'customer@example.invalid', 1, at));
  assert.throws(() => model.decideParticipant(approved, 'a', 'approved', null, 1, at));
  const objected = model.decideParticipant(approved, 'b', 'objection', 'split', 1, at);
  assert.throws(() => model.closeReview(objected, 1, at), /이의/);
  const withdrawn = model.withdrawObjection(objected, 'b', 1, at);
  assert.equal(withdrawn.decisions.b.status, 'not_responded');
});

test('검수와 검토 종료 없이는 잠글 수 없고 종료 후 무응답은 그대로 남는다', () => {
  assert.equal(typeof model.finalize, 'function');
  let state = model.approveOrganizer(fresh(), 1, at);
  assert.throws(() => model.finalize(state, 1, at));
  state = model.markQa(state, 1, at);
  assert.throws(() => model.finalize(state, 1, at));
  state = model.closeReview(state, 1, at);
  assert.equal(state.decisions.b.status, 'not_responded');
  assert.throws(() => model.decideParticipant(state, 'b', 'approved', null, 1, at), /종료/);
  const locked = model.finalize(state, 1, at);
  assert.equal(locked.lockedAt, at);
  assert.throws(() => model.updateExpense(locked, 'e1', { amount: '200', payerId: 'a', splitIds: ['a'] }, 1, at), /잠금/);
});

test('같은 버전의 검수 재요청은 최초 시각과 이력을 유지한다', () => {
  const state = model.markQa(fresh(), 1, at);
  const repeated = model.markQa(state, 1, '2026-10-08T00:01:00.000Z');
  assert.equal(repeated.qaAt, at);
  assert.equal(repeated.history.length, 1);
  assert.deepEqual(repeated, state);
});

test('참여자 결과는 본인 금액과 본인 관련 송금만 제공한다', () => {
  assert.equal(typeof model.participantResult, 'function');
  const state = model.approveOrganizer(fresh(), 1, at);
  const result = model.participantResult(state, 'b');
  assert.equal(result.member.id, 'b');
  assert.equal(result.member.net, -9);
  assert.equal(result.transfers.length, 1);
  assert.equal(result.transfers[0].from_id, 'b');
  assert.equal(result.expenses, undefined);
  assert.equal(result.members, undefined);
  assert.equal(model.participantResult(model.revokeShare(state, at), 'b'), null);
});

test('실제 샘플 12개 지출의 합계가 기존 샘플 정산과 일치한다', () => {
  assert.equal(typeof model.calculate, 'function');
  const require = createRequire(import.meta.url);
  const data = require('../../docs/design/mockups/data.js');
  const result = model.calculate(model.createState(data));
  assert.equal(result.total, data.versions[1].result.total);
  assert.equal(result.members.reduce((sum, m) => sum + m.net, 0), 0);
  for (const member of data.versions[1].result.per_member) {
    assert.equal(result.members.find(m => m.id === member.id).net, member.net);
  }
});

test('저장과 복원은 샘플 수정과 승인 상태를 보존하고 초기화는 원본으로 돌아간다', () => {
  assert.equal(typeof model.createStore, 'function');
  const values = new Map();
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  const store = model.createStore(seed, storage);
  const next = model.approveOrganizer(model.updateExpense(store.load(), 'e1', { amount: '102', payerId: 'a', splitIds: ['a'] }, 1, at), 2, at);
  assert.equal(store.save(next), true);
  const restored = model.createStore(seed, storage).load();
  assert.equal(restored.version, 2);
  assert.equal(restored.organizerApprovedAt, at);
  assert.equal(model.calculate(restored).total, 152);
  assert.equal(store.reset().version, 1);
  assert.equal(model.createStore(seed, storage).load().organizerApprovedAt, null);
});

test('손상 또는 다른 샘플 저장값은 실행하지 않고 초기 상태로 복구한다', () => {
  assert.equal(typeof model.createStore, 'function');
  const storage = { getItem: () => '{invalid', setItem() {}, removeItem() {} };
  const store = model.createStore(seed, storage);
  assert.equal(model.calculate(store.load()).total, 151);
  assert.equal(store.status().recovered, true);
  for (const mutate of [
    s => { s.dataClass = 'real'; }, s => { s.expenses[0].amountCents = -1; },
    s => { s.members[0].alias = 'injected'; }, s => { s.contact = 'customer@example.invalid'; },
    s => { s.decisions.b.reason = '<script>'; }, s => { s.version = 0; },
  ]) {
    const state = fresh(); mutate(state);
    const invalid = model.createStore(seed, { getItem: () => JSON.stringify(state), setItem() {}, removeItem() {} });
    assert.equal(model.calculate(invalid.load()).total, 151);
    assert.equal(invalid.status().recovered, true);
  }
});

test('브라우저 저장 실패는 성공으로 표시하지 않고 메모리 상태를 유지한다', () => {
  assert.equal(typeof model.createStore, 'function');
  const store = model.createStore(seed, { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } });
  const next = model.updateExpense(store.load(), 'e1', { amount: '102', payerId: 'a', splitIds: ['a'] }, 1, at);
  assert.equal(store.save(next), false);
  assert.equal(store.status().persistent, false);
  assert.equal(model.calculate(store.load()).total, 152);
});
