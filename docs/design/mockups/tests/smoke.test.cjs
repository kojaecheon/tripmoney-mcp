// docs/design/mockups/tests/smoke.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MOCK_DIR } = require("./helpers.cjs");

test("목업 필수 파일이 존재한다", () => {
  for (const f of ["tokens.css", "data.js", "components.js"]) {
    assert.ok(fs.existsSync(path.join(MOCK_DIR, f)), `${f} 없음`);
  }
});
