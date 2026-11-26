// docs/design/mockups/tests/render-review.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, read } = require("./helpers.cjs");

function page(state) {
  const d = load("data.js");
  return { d, html: load("render-review.js").render(d, state) };
}
const filled = (html) => (html.match(/class="btn(?: block)?"/g) || []).length;
const between = (html, a, b) => html.slice(html.indexOf(a), b ? html.indexOf(b) : undefined);

test("승인 대기: 현재 단계 탑승 승인, 채운 버튼은 승인 하나, 잠금 조건 3개 미충족, 공유 구획 없음", () => {
  const { html } = page("awaiting_organizer");
  assert.match(html, /rail-step current[^>]*>(?:(?!<\/div>).)*탑승 승인/s);
  assert.equal(filled(html), 1);
  assert.match(html, /class="btn"[^>]*onclick="TM_RENDER_REVIEW.approve\(\)"[^>]*>이 버전 승인/);
  const lock = between(html, 'id="lock-conditions"', 'id="revision"');
  assert.equal((lock.match(/class="pill wait"/g) || []).length, 3);
  assert.doesNotMatch(html, /id="share"/);
  assert.doesNotMatch(html, /class="stamp organizer"/);
  assert.match(html, /정산 제외 항목 없음/);
});

test("구획 순서가 스펙 5.2와 같다", () => {
  const { html } = page("participant_review");
  const ids = ["result", "evidence", "lock-conditions", "revision", "approval", "participants", "lock-request", "share"];
  const pos = ids.map((id) => html.indexOf(`id="${id}"`));
  pos.forEach((p, i) => assert.ok(p >= 0, `${ids[i]} 없음`));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos);
});

test("참여자 검토 중: 총무 스탬프, 승인 2·이의 1·무응답 1, 잠금 요청 비활성 사유, 채운 버튼은 링크 복사", () => {
  const { html } = page("participant_review");
  assert.match(html, /class="stamp organizer"/);
  assert.match(html, />승인 2</);
  assert.match(html, />이의 1</);
  assert.match(html, />무응답 1</);
  assert.match(html, /택시비 2건이 중복 같아요/);
  const lock = between(html, 'id="lock-request"', 'id="share"');
  assert.match(lock, /is-disabled" disabled[^>]*>최종 잠금 요청/);
  assert.match(lock, /검토창 종료 후 활성화/);
  assert.equal(filled(html), 1);
  assert.match(between(html, 'id="share"'), /class="btn"[^>]*>참여자 링크 복사/);
});

test("잠금 완료: 잠금 스탬프 v2, 수정 요청 없음, 원본 삭제 태그, 조건 모두 충족", () => {
  const { html } = page("finalized");
  assert.match(html, /class="stamp locked"[^>]*aria-label="잠금 · v2 2026-09-09 11:00"/);
  assert.doesNotMatch(html, /id="revision"|<textarea/);
  assert.match(html, /원본 삭제/);
  assert.doesNotMatch(html, /원본 검수/);
  const lock = between(html, 'id="lock-conditions"', 'id="approval"');
  assert.equal((lock.match(/class="pill ok"/g) || []).length, 3);
  assert.match(html, /class="stamp qa"/);
  assert.equal(filled(html), 1);
});

test("결과와 근거: 멤버 5행, 송금 수는 v2 제안과 같고, 환율 출처 2건", () => {
  const { d, html } = page("participant_review");
  const result = between(html, 'id="result"', 'id="evidence"');
  assert.equal((result.match(/<tr class="member">/g) || []).length, 5);
  assert.equal((result.match(/class="pass"/g) || []).length, d.versions[1].result.transfers.length);
  assert.match(result, new RegExp(d.versions[1].result.total.toLocaleString("ko-KR")));
  const ev = between(html, 'id="evidence"', 'id="lock-conditions"');
  assert.equal((ev.match(/<tr class="expense">/g) || []).length, 12);
  assert.match(ev, /open\.er-api\.com/);
  assert.match(ev, /현지 환전소 영수증 기준/);
});

test("수정 요청 폼과 표에는 모티프가 없고 남은 묶음 횟수를 표시한다", () => {
  const { html } = page("awaiting_organizer");
  const rev = between(html, 'id="revision"', 'id="approval"');
  assert.match(rev, /남은 수정 묶음 1회/);
  assert.deepEqual(load("components.js").motifKinds(between(rev, "<form", "</form>")), []);
  assert.doesNotMatch(html, /toss|\d{2,6}-\d{2,6}-\d{4,8}|계좌번호\s*[:：]|은행명\s*[:：]/i);
  assert.ok(load("components.js").motifKinds(html).length <= 3);
});

test("lockConditions 규칙", () => {
  const d = load("data.js");
  const r = load("render-review.js");
  assert.deepEqual(r.lockConditions(d.scenes.review.awaiting_organizer).map((c) => c.ok), [false, false, false]);
  assert.deepEqual(r.lockConditions(d.scenes.review.participant_review).map((c) => c.ok), [true, false, false]);
  assert.deepEqual(r.lockConditions(d.scenes.review.finalized).map((c) => c.ok), [true, true, true]);
});

test("review.html 스크립트 순서와 제약", () => {
  const html = read("review.html");
  const order = ["data.js", "components.js", "render-review.js"].map((f) => html.indexOf(`src="${f}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(html, /type="module"|fetch\(/);
});
