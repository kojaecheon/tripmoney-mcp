import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createState, approveOrganizer, decideParticipant, revokeShare } from '../model.mjs';
const require = createRequire(import.meta.url);
const data = require('../../docs/design/mockups/data.js');
let renderView;
try { ({ renderView } = await import('../view.mjs')); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
const at = '2026-10-08T00:00:00.000Z';

test('운영 화면은 지출 수정 폼과 12개 합성 지출을 제공한다', () => {
  assert.equal(typeof renderView, 'function');
  const html = renderView(createState(data), 'operator', 'm_jieun');
  assert.match(html, /id="expense-form"/);
  assert.match(html, /id="expense-amount"/);
  assert.match(html, /원화 환산/);
  assert.equal((html.match(/data-expense-id=/g) || []).length, 12);
});

test('모바일 카드가 표의 최소 너비와 관계없이 화면 안에서 축소된다', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /\.mvp-main\s*>\s*\*\s*\{[^}]*min-width:0/);
  assert.match(css, /\.mvp-columns\s*>\s*\*\s*\{[^}]*min-width:0/);
});

test('좁은 모바일에서 큰 금액이 옆 집계 항목을 덮지 않는다', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.ok(/@media\(max-width:420px\)\{\.mvp-stats\{[^}]*grid-template-columns:1fr/.test(css), '큰 금액을 표시할 단일 열 집계 필요');
});

test('총무 화면의 참여자 상태는 실제 결정과 일치한다', () => {
  assert.equal(typeof renderView, 'function');
  let state = approveOrganizer(createState(data), 1, at);
  state = decideParticipant(state, 'm_jieun', 'objection', 'amount', 1, at);
  const html = renderView(state, 'organizer', 'm_jieun');
  assert.match(html, /이의 1/);
  assert.match(html, /금액을 다시 확인/);
  assert.match(html, /data-action="close-review" disabled/);
});

test('버전과 지출 건수에 통화 기호를 붙이지 않는다', () => {
  const state = createState(data); state.version = 10;
  const html = renderView(state, 'operator', 'm_jieun');
  assert.match(html, /현재 버전<\/span><strong class="num">10<\/strong>/);
  assert.match(html, /지출 건수<\/span><strong class="num">12<\/strong>/);
});

test('참여자 화면에 타인 지출과 타인 결과를 노출하지 않는다', () => {
  assert.equal(typeof renderView, 'function');
  const state = approveOrganizer(createState(data), 1, at);
  const html = renderView(state, 'participant', 'm_jieun');
  assert.match(html, /지은님의 결과/);
  assert.doesNotMatch(html, /수완나품|오아시스 스파|data-expense-id=|계좌번호|toss/i);
  const ended = renderView(revokeShare(state, at), 'participant', 'm_jieun');
  assert.match(ended, /공유 시연이 종료/);
  assert.doesNotMatch(ended, /방콕|지은님의 결과/);
});
