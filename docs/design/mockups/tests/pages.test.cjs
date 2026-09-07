// docs/design/mockups/tests/pages.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, read } = require("./helpers.cjs");

const PAGES = ["index.html", "landing.html", "review.html", "share.html", "operator.html"];
const SCENES = {
  landing: ["intake_on", "intake_off"],
  review: ["awaiting_organizer", "participant_review", "finalized"],
  share: ["notice", "active", "expired"],
  operator: ["queue", "case", "login"],
};
const RENDERERS = { landing: "render-landing.js", review: "render-review.js", share: "render-share.js", operator: "render-operator.js" };

function allScenes() {
  const d = load("data.js");
  const out = [];
  for (const [page, states] of Object.entries(SCENES)) {
    const r = load(RENDERERS[page]);
    for (const st of states) out.push({ page, st, html: r.render(d, st) });
  }
  return out;
}

test("허브는 열한 장면 링크를 모두 가진다", () => {
  const html = read("index.html");
  for (const [page, states] of Object.entries(SCENES)) for (const st of states) assert.ok(html.includes(`${page}.html?state=${st}`), `${page}/${st} 링크 없음`);
  const colors = [...html.matchAll(/class="feature (\w+)"/g)].map((m) => m[1]);
  assert.equal(colors.length, 4);
  for (let i = 1; i < colors.length; i++) assert.notEqual(colors[i], colors[i - 1]);
  assert.match(html, /프로덕션 코드가 아닙니다/);
});

test("모든 HTML 페이지의 공통 제약", () => {
  for (const p of PAGES) {
    const html = read(p);
    assert.match(html, /<html lang="ko">/, p);
    assert.match(html, /name="viewport"/, p);
    assert.equal((html.match(/<title>/g) || []).length, 1, p);
    assert.match(html, /href="tokens\.css"/, p);
    assert.doesNotMatch(html, /Space\+Grotesk|family=Inter|type="module"|fetch\(/, p);
    for (const m of html.matchAll(/<script src="([^"]+)"/g)) assert.doesNotMatch(m[1], /^https?:/, `${p} 외부 스크립트`);
    assert.doesNotMatch(html, /<link[^>]+href="https?:\/\/(?!fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)/, `${p} 허용 외 외부 리소스`);
  }
});

test("장면마다 h1 하나, 헤딩 단계 건너뜀 없음, 빈 버튼 없음", () => {
  for (const { page, st, html } of allScenes()) {
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    assert.equal(levels.filter((l) => l === 1).length, 1, `${page}/${st} h1 수`);
    let prev = 0;
    for (const l of levels) { assert.ok(l <= prev + 1, `${page}/${st} 헤딩 ${prev}→${l} 건너뜀`); prev = l; }
    assert.doesNotMatch(html, /<button[^>]*>\s*<\/button>/, `${page}/${st} 빈 버튼`);
    assert.doesNotMatch(html, /<img(?![^>]*alt=)/, `${page}/${st} alt 없는 이미지`);
    assert.doesNotMatch(html, /toss|\d{2,6}-\d{2,6}-\d{4,8}|계좌번호\s*[:：]|은행명\s*[:：]/i, `${page}/${st} 금지 문구`);
  }
});

test("표현색은 랜딩과 허브에만 있다", () => {
  for (const { page, st, html } of allScenes()) {
    if (page === "landing") continue;
    assert.doesNotMatch(html, /class="feature |lavender|peach|ochre|mint/, `${page}/${st} 표현색 사용`);
  }
});
