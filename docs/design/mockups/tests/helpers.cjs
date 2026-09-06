"use strict";
const fs = require("node:fs");
const path = require("node:path");

const MOCK_DIR = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(MOCK_DIR, rel), "utf8");
}

function fresh(rel) {
  const abs = path.join(MOCK_DIR, rel);
  delete require.cache[abs];
  return require(abs);
}

// 전역을 심는 순서: data → components → 요청 모듈
function load(name) {
  globalThis.TM_DATA = fresh("data.js");
  globalThis.TM_UI = fresh("components.js");
  if (name === "data.js") return globalThis.TM_DATA;
  if (name === "components.js") return globalThis.TM_UI;
  return fresh(name);
}

module.exports = { MOCK_DIR, read, load };
