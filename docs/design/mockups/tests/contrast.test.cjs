// docs/design/mockups/tests/contrast.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { read } = require("./helpers.cjs");

function lum(hex) {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fg, bg) {
  const [a, b] = [lum(fg), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const T = { canvas: "#FFFAF0", paper: "#F5EFE3", panel: "#FFFDF7", ink: "#172133", mut: "#5E574B", green: "#1F6B4A", amber: "#B86718", rose: "#B14B3F", blue: "#305D88", lavender: "#B8A4ED", peach: "#FFB084", ochre: "#E8B94A", mint: "#A4D4C5", navy: "#233049" };

const PAIRS = [
  ["본문 잉크/캔버스", T.ink, T.canvas, 4.5], ["본문 잉크/종이", T.ink, T.paper, 4.5], ["본문 잉크/카드", T.ink, T.panel, 4.5],
  ["보조 글자/캔버스", T.mut, T.canvas, 4.5], ["보조 글자/종이", T.mut, T.paper, 4.5], ["보조 글자/삭제 태그", T.mut, "#ECE9E2", 4.5],
  ["버튼 글자/잉크", T.panel, T.ink, 4.5], ["흰 글자/딥네이비", T.panel, T.navy, 4.5], ["딥네이비 보조 글자", "#D9DEE8", T.navy, 4.5],
  ["잉크/라벤더", T.ink, T.lavender, 4.5], ["잉크/피치", T.ink, T.peach, 4.5], ["잉크/오커", T.ink, T.ochre, 4.5], ["잉크/민트", T.ink, T.mint, 4.5],
  ["승인 필/초록", T.green, "#E6F0E9", 4.5], ["대기 필/보정 호박", "#7A4410", "#F7EAD8", 4.5], ["이의 필/보정 장미", "#8E3A30", "#F3DEDB", 4.5], ["정보 필/파랑", T.blue, "#E3EBF3", 4.5],
  ["장미 글자/카드", T.rose, T.panel, 4.5], ["초록 글자/카드", T.green, T.panel, 4.5], ["파랑 링크/캔버스", T.blue, T.canvas, 4.5],
  ["포커스 링(비문자)/캔버스", T.amber, T.canvas, 3],
];

test("스펙 4.6 대비 AA", () => {
  for (const [name, fg, bg, min] of PAIRS) {
    const r = ratio(fg, bg);
    assert.ok(r >= min, `${name}: ${r.toFixed(2)} < ${min}`);
  }
});

test("tokens.css가 보정 색을 실제로 쓴다", () => {
  const css = read("tokens.css");
  assert.match(css, /\.pill\.wait\{[^}]*color:#7A4410/);
  assert.match(css, /\.pill\.bad\{[^}]*color:#8E3A30/);
  assert.match(css, /\.tag\.ocr_only\{[^}]*color:#7A4410/);
  assert.doesNotMatch(css, /\.pill\.(wait|bad)\{[^}]*color:var\(--(amber|rose)\)/);
});
