// docs/design/mockups/tests/tokens.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { read } = require("./helpers.cjs");

const css = () => read("tokens.css");

test("스펙 4.1 색 토큰 값이 정확하다", () => {
  const c = css();
  const expected = {
    "--canvas": "#FFFAF0", "--paper": "#F5EFE3", "--panel": "#FFFDF7", "--ink": "#172133",
    "--mut": "#5E574B", "--line": "#DDD0BA", "--green": "#1F6B4A", "--amber": "#B86718",
    "--rose": "#B14B3F", "--blue": "#305D88", "--lavender": "#B8A4ED", "--peach": "#FFB084",
    "--ochre": "#E8B94A", "--mint": "#A4D4C5", "--navy": "#233049",
  };
  for (const [k, v] of Object.entries(expected)) {
    assert.match(c, new RegExp(`${k}\\s*:\\s*${v}`, "i"), `${k} 값이 ${v}가 아니다`);
  }
});

test("서체 토큰과 금지 서체", () => {
  const c = css();
  assert.match(c, /--disp\s*:\s*'Pretendard Variable'/);
  assert.match(c, /--disp-latin\s*:\s*'Fraunces'/);
  assert.match(c, /--mono\s*:\s*'Space Mono'/);
  assert.doesNotMatch(c, /Space Grotesk|Inter/);
});

test("제목 굵기 상한과 자간", () => {
  const c = css();
  assert.match(c, /h1[^{]*\{[^}]*font-weight\s*:\s*600/s);
  assert.match(c, /letter-spacing\s*:\s*-0?\.02em/);
  assert.doesNotMatch(c, /font-weight\s*:\s*(700|800|900|bold)/);
});

test("버튼·입력 규격과 모서리 단계", () => {
  const c = css();
  assert.match(c, /\.btn[^{]*\{[^}]*height\s*:\s*44px/s);
  assert.match(c, /\.btn[^{]*\{[^}]*border-radius\s*:\s*12px/s);
  assert.match(c, /\.input[^{]*\{[^}]*height\s*:\s*44px/s);
  assert.match(c, /\.card[^{,]*\{[^}]*border-radius\s*:\s*16px/s);
  assert.match(c, /\.feature[^{,]*\{[^}]*border-radius\s*:\s*24px/s);
});

test("필수 컴포넌트 클래스가 정의된다", () => {
  const c = css();
  for (const cls of [".rail", ".rail-dot", ".rail-badge", ".pass", ".pass-stub", ".stamp", ".tag",
    ".stamp.organizer", ".stamp.locked", ".tag.verified", ".tag.deleted", ".feature.navy", ".mocknav", ".sr-only", ".band-paper"]) {
    assert.ok(c.includes(cls), `${cls} 없음`);
  }
});

test("터치 대상: 탭과 레일 단계는 44px 이상", () => {
  const c = css();
  assert.match(c, /\.tabs \.pill\s*\{[^}]*min-height\s*:\s*44px/s);
  assert.match(c, /\.rail-step\s*\{[^}]*min-height\s*:\s*44px/s);
});

test("포커스 링은 호박색 3px", () => {
  assert.match(css(), /:focus-visible\s*\{[^}]*outline\s*:\s*3px solid var\(--amber\)/s);
});
