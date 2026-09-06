"use strict";
const fs = require("node:fs");
const path = require("node:path");

const MOCK_DIR = path.resolve(__dirname, "..");

function read(rel) {
  // Handle .cjs extension for CommonJS files in ES module project
  let filePath = path.join(MOCK_DIR, rel);
  if (!fs.existsSync(filePath)) {
    const cjsPath = path.join(MOCK_DIR, rel.replace(/\.js$/, ".cjs"));
    if (fs.existsSync(cjsPath)) {
      filePath = cjsPath;
    }
  }
  return fs.readFileSync(filePath, "utf8");
}

function fresh(rel) {
  const abs = path.join(MOCK_DIR, rel);
  delete require.cache[abs];
  return require(abs);
}

// 전역을 심는 순서: data → components(있으면) → 요청 모듈
function load(name) {
  // Handle .cjs extension for CommonJS files in ES module project
  const dataFile = path.join(MOCK_DIR, "data.cjs");
  if (fs.existsSync(dataFile)) {
    globalThis.TM_DATA = fresh("data.cjs");
  } else {
    globalThis.TM_DATA = fresh("data.js");
  }
  const compPath = path.join(MOCK_DIR, "components.js");
  if (fs.existsSync(compPath)) {
    globalThis.TM_UI = fresh("components.js");
  }
  if (name === "data.js") return globalThis.TM_DATA;
  if (name === "components.js") return globalThis.TM_UI;
  return fresh(name);
}

module.exports = { MOCK_DIR, read, load };
