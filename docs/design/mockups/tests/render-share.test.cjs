// docs/design/mockups/tests/render-share.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, read } = require("./helpers.cjs");

function page(state) {
  const d = load("data.js");
  return { d, html: load("render-share.js").render(d, state) };
}
const filled = (html) => (html.match(/class="btn(?: block)?"/g) || []).length;
const between = (html, a, b) => html.slice(html.indexOf(a), b ? html.indexOf(b) : undefined);

test("고지 화면: 여섯 항목, 세 선택지, 검토 전 표시, 금액 없음", () => {
  const { html } = page("notice");
  for (const k of ["운영자", "목적", "항목", "보유기간", "국외처리", "권리"]) assert.match(html, new RegExp(`<dt>${k}</dt>`));
  assert.match(html, /class="btn"[^>]*>계속</);
  assert.match(html, />삭제 요청</);
  assert.match(html, />이의 경로</);
  assert.match(html, /검토 전 문구/);
  assert.doesNotMatch(html, /₩/);
  assert.equal(filled(html), 1);
  assert.deepEqual(load("components.js").motifKinds(html), []);
});

test("활성 화면: 본인(지은) 중심, 본인 송금만, 지출 상세 없음", () => {
  const { d, html } = page("active");
  const r = load("render-share.js");
  const v = d.versions[1].result;
  const mine = r.myTransfers(v, "m_jieun");
  assert.ok(mine.length >= 1);
  assert.match(html, /<h2>지은 님<\/h2>/);
  const tr = between(html, 'id="transfers"', 'id="basis"');
  assert.equal((tr.match(/class="pass"/g) || []).length, mine.length);
  for (const m of tr.matchAll(/class="route">([^<]+)</g)) assert.match(m[1], /지은/);
  assert.match(tr, /이름·금액 복사/);
  assert.doesNotMatch(html, /<tr class="expense">|오아시스 스파|짐톰슨 기념품/);
  assert.doesNotMatch(html, /toss|\d{2,6}-\d{2,6}-\d{4,8}|계좌번호\s*[:：]|은행명\s*[:：]/i);
});

test("활성 화면: 근거 항목과 결정 버튼, 무응답 안내, 구획 순서", () => {
  const { html } = page("active");
  const basis = between(html, 'id="basis"', 'id="decide"');
  assert.match(basis, /38\.9/);
  assert.match(basis, /반올림/);
  assert.match(basis, /원본 검수 \d+건/);
  assert.match(basis, /2026-09-04 16:20/);
  assert.match(basis, /D-2/);
  const decide = between(html, 'id="decide"');
  assert.match(decide, /class="btn"[^>]*>승인</);
  assert.match(decide, /btn btn-secondary[^>]*>이의 제기</);
  assert.match(decide, /무응답은 승인이 아닙니다/);
  assert.equal(filled(html), 1);
  const ids = ["me", "transfers", "basis", "decide"].map((id) => html.indexOf(`id="${id}"`));
  assert.deepEqual([...ids].sort((a, b) => a - b), ids);
  assert.match(html, /고지 확인 /);
  const kinds = load("components.js").motifKinds(html);
  assert.ok(kinds.every((k) => k === "pass" || k === "stamp"));
});

test("결정 후에는 스탬프와 철회 링크가 버튼을 대신한다", () => {
  const d = load("data.js");
  const r = load("render-share.js");
  const st = JSON.parse(JSON.stringify(d.scenes.share.active));
  st.decisions = st.decisions.map((x) => (x.member_id === "m_jieun" ? { member_id: "m_jieun", decision: "objection", at: "2026-09-06 15:00", reason: "스파 분담 확인 부탁" } : x));
  const html = r.renderState(d, st, "active");
  assert.match(html, /class="stamp objection"/);
  assert.match(html, />이의 철회</);
  assert.equal(filled(html), 0);
});

test("만료 화면: 여행명 없이 안내만", () => {
  const { html } = page("expired");
  assert.match(html, /더 이상 열 수 없습니다/);
  assert.match(html, /총무에게/);
  assert.doesNotMatch(html, /방콕|₩|class="rail"/);
  assert.equal(filled(html), 0);
});

test("share.html 스크립트 순서와 제약", () => {
  const html = read("share.html");
  const order = ["data.js", "components.js", "render-share.js"].map((f) => html.indexOf(`src="${f}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(html, /type="module"|fetch\(/);
});
