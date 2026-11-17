// docs/design/mockups/tests/render-landing.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, read } = require("./helpers.cjs");

function page(state) {
  const d = load("data.js");
  const r = load("render-landing.js");
  return r.render(d, state);
}
const filled = (html) => (html.match(/class="btn(?: block)?"/g) || []).length;
const between = (html, a, b) => html.slice(html.indexOf(a), b ? html.indexOf(b) : undefined);

test("구획 순서가 스펙 5.1과 같다", () => {
  const html = page("intake_on");
  const ids = ["top", "features", "flow", "pricing", "eligibility", "notices", "apply", "cta", "policy"];
  const pos = ids.map((id) => html.indexOf(`id="${id}"`));
  pos.forEach((p, i) => assert.ok(p >= 0, `${ids[i]} 없음`));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos);
});

test("헤드라인과 h1 하나", () => {
  const html = page("intake_on");
  assert.equal((html.match(/<h1/g) || []).length, 1);
  assert.match(html, /<h1>근거가 남는 해외여행 최종 정산<\/h1>/);
  assert.match(html, /3~8명 여행이 운영 범위/);
});

test("특징 카드 5장, 표현색 연속 반복 없음, 각 카드에 UI 조각", () => {
  const html = page("intake_on");
  const colors = [...html.matchAll(/class="feature (\w+)"/g)].map((m) => m[1]);
  assert.equal(colors.length, 5);
  for (let i = 1; i < colors.length; i++) assert.notEqual(colors[i], colors[i - 1]);
  assert.equal((html.match(/class="fragment"/g) || []).length, 5);
});

test("채운 버튼은 히어로·가격·마무리 CTA에 하나씩, 헤더는 보조형", () => {
  const html = page("intake_on");
  assert.equal(filled(html), 3);
  const header = between(html, "<header", "<main");
  assert.equal(filled(header), 0);
  assert.match(header, /btn btn-secondary/);
  assert.equal(filled(between(html, 'id="apply"', 'id="cta"')), 0);
});

test("가격 셀 2개, 마감 대행형은 반전 강조", () => {
  const html = between(page("intake_on"), 'id="pricing"', 'id="eligibility"');
  assert.match(html, /₩29,000/);
  assert.match(html, /₩59,000/);
  assert.equal((html.match(/class="price featured"/g) || []).length, 1);
  assert.match(html, /완전한 자료 접수 후 24시간/);
  assert.match(html, /최종 잠금 전 취소 시 전액 환불/);
});

test("적격·제외 조건 6+6과 고지 4칸", () => {
  const html = page("intake_on");
  const el = between(html, 'id="eligibility"', 'id="notices"');
  assert.equal((el.match(/<li>/g) || []).length, 12);
  const no = between(html, 'id="notices"', 'id="apply"');
  assert.equal((no.match(/class="card notice"/g) || []).length, 4);
  assert.ok((no.match(/검토 전 문구/g) || []).length >= 2);
});

test("신청 폼은 연락수단 1개, 기본 해제 동의, 정책 버전이며 모티프가 없다", () => {
  const d = load("data.js");
  const form = between(page("intake_on"), "<form", "</form>");
  assert.match(form, /name="contact"/);
  assert.match(form, /type="checkbox" name="consent"/);
  assert.doesNotMatch(form, /checked/);
  assert.ok(form.includes(d.policy_version));
  assert.deepEqual(load("components.js").motifKinds(form), []);
  assert.doesNotMatch(form, /name="(name|trip_name|destination|price)"/);
});

test("접수 비활성 변형은 폼 대신 안내만 둔다", () => {
  const html = page("intake_off");
  assert.doesNotMatch(html, /<form/);
  assert.match(html, /지금은 신청을 받지 않습니다/);
});

test("푸터는 워드마크와 정책 링크 3개, 계좌·Toss 없음, 대문자·그라데이션 없음", () => {
  const html = page("intake_on");
  const footer = between(html, "<footer");
  assert.match(footer, /class="wordmark latin"/);
  assert.equal((footer.match(/검토 전 문구/g) || []).length, 3);
  assert.doesNotMatch(html, /toss|\d{2,6}-\d{2,6}-\d{4,8}|계좌번호\s*[:：]|은행명\s*[:：]/i);
  assert.doesNotMatch(read("tokens.css") + read("landing.html"), /text-transform\s*:\s*uppercase|linear-gradient/);
  assert.ok(load("components.js").motifKinds(html).length <= 3);
});

test("landing.html은 스크립트를 순서대로 불러오고 모듈·fetch를 쓰지 않는다", () => {
  const html = read("landing.html");
  const order = ["data.js", "components.js", "render-landing.js"].map((f) => html.indexOf(`src="${f}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order[0] > 0);
  assert.doesNotMatch(html, /type="module"|fetch\(|Space\+Grotesk|Inter/);
  assert.match(html, /lang="ko"/);
});
