// docs/design/mockups/tests/components.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers.cjs");

test("esc는 HTML 특수문자를 이스케이프한다", () => {
  const ui = load("components.js");
  assert.equal(ui.esc('<a href="x">&\'</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

test("js는 JS 문자열 리터럴 경계를 지킨다", () => {
  const ui = load("components.js");
  assert.equal(ui.js("O'Neil \\ x\nline"), "O\\'Neil \\\\ x\\nline");
  assert.equal(ui.js(null), "");
});

test("won은 원화 기호와 천 단위 구분 정수를 만든다", () => {
  const ui = load("components.js");
  assert.equal(ui.won(37217), "₩37,217");
  assert.equal(ui.won(1240000.4), "₩1,240,000");
});

test("money는 외화 뒤 통화 코드, 다음 줄 환산 원화", () => {
  const ui = load("components.js");
  const html = ui.money(2000, "THB", 77800);
  assert.match(html, /2,000 THB/);
  assert.match(html, /<br>/);
  assert.match(html, /₩77,800/);
  assert.doesNotMatch(ui.money(48000, "KRW", 48000), /<br>/);
});

test("스탬프는 여섯 종류만 허용한다", () => {
  const ui = load("components.js");
  assert.deepEqual(Object.keys(ui.STAMPS), ["organizer", "participant", "objection", "withdrawn", "qa", "locked"]);
  const html = ui.stamp("locked", "2026-09-09", "v2");
  assert.match(html, /class="stamp locked"/);
  assert.match(html, /잠금 · v2/);
  assert.match(html, /role="img"/);
  assert.throws(() => ui.stamp("approved", "2026-09-09"), /unknown stamp/);
});

test("수하물 태그는 네 상태만 허용한다", () => {
  const ui = load("components.js");
  assert.deepEqual(Object.keys(ui.TAGS), ["verified", "ocr_only", "manual", "deleted"]);
  assert.match(ui.tag("ocr_only"), /OCR 미검수/);
  assert.throws(() => ui.tag("pending"), /unknown tag/);
});

test("보딩패스는 상대와 금액만 담고 계좌를 담지 않는다", () => {
  const ui = load("components.js");
  const html = ui.pass({ from: "현우", to: "민수", amount: 37217 }, { index: 1, total: 2, action: { label: "이름·금액 복사", onclick: "copyLeg(0)" } });
  assert.match(html, /송금 1 \/ 2/);
  assert.match(html, /현우 → 민수/);
  assert.match(html, /₩37,217/);
  assert.match(html, /btn btn-secondary/);
  assert.doesNotMatch(html, /계좌|은행|toss/i);
});

test("여정 레일은 6단계, 현재 단계와 SLA 표시, 배지를 그린다", () => {
  const d = load("data.js");
  const ui = load("components.js");
  const html = ui.rail(d.stages, "awaiting_organizer", { badge: "일시정지 · 고객 답변 대기" });
  assert.equal((html.match(/rail-step/g) || []).length, 6);
  assert.equal((html.match(/rail-step done/g) || []).length, 2);
  assert.equal((html.match(/rail-step current/g) || []).length, 1);
  assert.match(html, /SLA 시작/);
  assert.match(html, /rail-badge[^>]*>일시정지 · 고객 답변 대기/);
  assert.match(html, /총무가 해당 버전을 승인함/);
  assert.equal((ui.rail(d.stages, "delivered").match(/rail-step done/g) || []).length, 5);
});

test("btn과 pill", () => {
  const ui = load("components.js");
  assert.match(ui.btn("신청하기", { href: "#apply" }), /<a class="btn" href="#apply">신청하기<\/a>/);
  assert.match(ui.btn("잠금 요청", { secondary: true, disabled: true }), /class="btn btn-secondary is-disabled" disabled/);
  assert.match(ui.pill("승인 2", "ok"), /class="pill ok"/);
});

test("stateFromUrl은 허용 목록 밖이면 기본값을 준다", () => {
  const ui = load("components.js");
  globalThis.location = { search: "?state=finalized" };
  assert.equal(ui.stateFromUrl("awaiting_organizer", ["awaiting_organizer", "finalized"]), "finalized");
  globalThis.location = { search: "?state=hack" };
  assert.equal(ui.stateFromUrl("awaiting_organizer", ["awaiting_organizer", "finalized"]), "awaiting_organizer");
  delete globalThis.location;
});

test("mocknav와 motifKinds", () => {
  const ui = load("components.js");
  const nav = ui.mocknav("review", ["awaiting_organizer", "finalized"], "finalized");
  assert.match(nav, /href="index.html"/);
  assert.match(nav, /href="review.html\?state=awaiting_organizer"/);
  assert.match(nav, /class="cur"[^>]*>finalized/);
  assert.deepEqual(ui.motifKinds('<div class="pass"></div><span class="tag verified"></span>'), ["pass", "tag"]);
});

test("motifKinds는 클래스 토큰만 세고 보조 클래스는 세지 않는다", () => {
  const ui = load("components.js");
  assert.deepEqual(ui.motifKinds('<div class="stamp-inline"></div>'), []);
  assert.deepEqual(ui.motifKinds('<span class="foo stamp organizer">'), ["stamp"]);
  assert.deepEqual(ui.motifKinds('<div class="pass-body">'), []);
});

test("revealRail은 document가 없으면 조용히 반환한다", () => {
  const ui = load("components.js");
  assert.equal(typeof ui.revealRail, "function");
  delete globalThis.document;
  assert.doesNotThrow(() => ui.revealRail());
  let asked = null, scrolled = null;
  globalThis.document = { querySelector: (s) => { asked = s; return { scrollIntoView: (o) => { scrolled = o; } }; } };
  ui.revealRail();
  assert.equal(asked, ".rail-step.current");
  assert.deepEqual(scrolled, { inline: "center", block: "nearest" });
  delete globalThis.document;
});

test("레일 컨테이너는 group, 단계는 role 없이 초점만 받는다", () => {
  const d = load("data.js");
  const ui = load("components.js");
  const html = ui.rail(d.stages, "reviewing");
  assert.match(html, /<div class="rail" role="group" aria-label="정산 진행 단계">/);
  assert.doesNotMatch(html, /role="list"|role="listitem"/);
  assert.equal((html.match(/tabindex="0"/g) || []).length, 6);
});

test("trapModal은 첫 요소에 포커스하고 Tab을 가두며 Escape로 닫는다", () => {
  const ui = load("components.js");
  const focused = [];
  const mk = (n) => ({ n, hidden: false, focus() { focused.push(n); globalThis.document.activeElement = this; } });
  const items = [mk("a"), mk("b")];
  let handler = null;
  let closed = 0;
  globalThis.document = { activeElement: null };
  const root = {
    addEventListener: (t, h) => { handler = h; },
    removeEventListener: () => { handler = null; },
    querySelectorAll: () => items,
  };
  const release = ui.trapModal(root, () => { closed++; });
  assert.deepEqual(focused, ["a"]);
  handler({ key: "Tab", shiftKey: false, preventDefault() {} });
  assert.deepEqual(focused, ["a"]);
  globalThis.document.activeElement = items[1];
  handler({ key: "Tab", shiftKey: false, preventDefault() {} });
  assert.equal(focused[focused.length - 1], "a");
  globalThis.document.activeElement = items[0];
  handler({ key: "Tab", shiftKey: true, preventDefault() {} });
  assert.equal(focused[focused.length - 1], "b");
  handler({ key: "Escape", preventDefault() {} });
  assert.equal(closed, 1);
  release();
  assert.equal(handler, null);
  delete globalThis.document;
});
