// docs/design/mockups/tests/render-operator.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, read } = require("./helpers.cjs");

function page(state) {
  const d = load("data.js");
  const r = load("render-operator.js");
  return { d, r, html: r.render(d, state) };
}
const filled = (html) => (html.match(/class="btn(?: block)?"/g) || []).length;
const between = (html, a, b) => html.slice(html.indexOf(a), b ? html.indexOf(b) : undefined);

test("로그인: 이메일 하나와 안내, 채운 버튼 하나, 레일·모티프 없음", () => {
  const { html } = page("login");
  assert.match(html, /name="email"/);
  assert.match(html, /공개 가입은 없습니다/);
  assert.equal(filled(html), 1);
  assert.doesNotMatch(html, /class="rail"/);
  assert.match(html, /<h1 class="h3">직원 로그인<\/h1>/);
  assert.deepEqual(load("components.js").motifKinds(html), []);
});

test("큐: SLA 순 정렬, 일시정지는 마지막, 선택은 C-014, 검수 열기 버튼", () => {
  const { d, r, html } = page("queue");
  assert.deepEqual(r.sortQueue(d.cases).map((c) => c.id), ["C-014", "C-012", "C-013"]);
  const rows = [...html.matchAll(/class="case-row( on)?"[^>]*>\s*<b class="num">(C-\d+)</g)].map((m) => [m[2], !!m[1]]);
  assert.deepEqual(rows, [["C-014", true], ["C-012", false], ["C-013", false]]);
  assert.match(html, /SLA 남은 시간 5h/);
  assert.match(html, /일시정지 · 고객 답변 대기/);
  assert.match(html, /class="btn"[^>]*href="operator.html\?state=case"[^>]*>검수 열기/);
  assert.equal(filled(html), 1);
  assert.doesNotMatch(html, /id="receipt"/);
  const cp = between(html, 'id="case-head"', "</section>");
  assert.equal((cp.match(/class="pill ok"/g) || []).length, 2);
  assert.equal((cp.match(/class="pill bad"/g) || []).length, 3);
  assert.match(cp, /통화 미확정 1건 · 미상 결제자 1건/);
});

test("케이스 상세: 구획 순서, 자료수집 5항목, 영수증 3열, 불변식 8개", () => {
  const { html, r, d } = page("case");
  const ids = ["case-head", "collect", "receipt", "fx", "invariants", "objections", "qa", "ops"];
  const pos = ids.map((id) => html.indexOf(`id="${id}"`));
  pos.forEach((p, i) => assert.ok(p >= 0, `${ids[i]} 없음`));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos);
  assert.deepEqual(r.collection(d.cases[0]).map((c) => c.ok), [true, false, false, true, true]);
  const rc = between(html, 'id="receipt"', 'id="fx"');
  for (const h of ["원본", "OCR 추출", "수정 · 승인"]) assert.match(rc, new RegExp(`<h3>${h}</h3>`));
  assert.match(rc, /class="placeholder"/);
  assert.doesNotMatch(rc, /<img/);
  assert.match(rc, /class="btn"[^>]*>검수 승인/);
  const inv = between(html, 'id="invariants"', 'id="objections"');
  assert.equal((inv.match(/<li class="inv">/g) || []).length, 8);
  assert.equal((inv.match(/class="pill ok"/g) || []).length, 3);
  assert.equal((inv.match(/class="pill bad"/g) || []).length, 2);
  assert.equal((inv.match(/class="pill wait"/g) || []).length, 3);
  assert.equal(filled(html), 1);
});

test("QA·잠금·하단 패널: allowlist 상태, 개인정보 금지 안내, 잠금 비활성 사유, details 3개", () => {
  const { html } = page("case");
  const qa = between(html, 'id="qa"', 'id="ops"');
  assert.equal((qa.match(/<option/g) || []).length, 3);
  assert.match(qa, /연락처·원문 개인정보를 입력하지 않습니다/);
  assert.match(qa, /is-disabled" disabled[^>]*>잠금 실행/);
  assert.match(qa, /불변식 2개 실패/);
  const ops = between(html, 'id="ops"');
  assert.equal((ops.match(/<details class="card">/g) || []).length, 3);
  assert.match(ops, /링크 폐기/);
  assert.match(ops, /신규 접수 중단/);
  assert.doesNotMatch(html, /toss|\d{2,6}-\d{2,6}-\d{4,8}|계좌번호\s*[:：]|은행명\s*[:：]/i);
  const ui = load("components.js");
  for (const form of html.split("<form").slice(1)) assert.deepEqual(ui.motifKinds(form.split("</form>")[0]), []);
  assert.ok(ui.motifKinds(html).length <= 3);
});

test("리드 패널은 마스킹된 연락처만 보여준다", () => {
  const { d, r } = page("queue");
  const html = r.renderLeads(d);
  assert.match(html, /\*\*\*/);
  assert.doesNotMatch(html, /[a-z0-9]+@[a-z0-9]+\.[a-z]{2,}/i);
  assert.match(html, /QA 의견/);
  assert.match(html, /추가만 가능/);
});

test("operator.html 스크립트 순서와 제약", () => {
  const html = read("operator.html");
  const order = ["data.js", "components.js", "render-operator.js"].map((f) => html.indexOf(`src="${f}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(html, /type="module"|fetch\(/);
});
