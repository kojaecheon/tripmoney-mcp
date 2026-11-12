// docs/design/mockups/tests/data.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, read } = require("./helpers.cjs");

test("멤버 5명, 총무 1명, 별칭만 있다", () => {
  const d = load("data.js");
  assert.equal(d.members.length, 5);
  assert.equal(d.members.filter((m) => m.role === "organizer").length, 1);
  for (const m of d.members) assert.deepEqual(Object.keys(m).sort(), ["alias", "id", "role"]);
});

test("지출 12건, 근거 상태 3종이 모두 나타난다", () => {
  const d = load("data.js");
  assert.equal(d.expenses.length, 12);
  const states = new Set(d.expenses.map((e) => e.evidence));
  for (const s of ["verified", "ocr_only", "manual"]) assert.ok(states.has(s), `${s} 없음`);
  assert.ok(d.expenses.some((e) => e.currency === "KRW"));
  assert.ok(d.expenses.some((e) => e.currency === "THB"));
});

test("정산 불변식: 분담 합계 = 환산액, net 합계 0, 송금은 양수 정수", () => {
  const d = load("data.js");
  for (const v of d.versions) {
    const r = v.result;
    assert.equal(r.per_member.reduce((s, m) => s + m.net, 0), 0, `v${v.version} net 합계`);
    for (const t of r.transfers) {
      assert.ok(Number.isInteger(t.amount) && t.amount > 0, "송금액");
      assert.notEqual(t.from_id, t.to_id);
    }
    for (const [id, shares] of Object.entries(r.shares)) {
      const e = d.expenses.find((x) => x.id === id);
      assert.equal(shares.reduce((s, x) => s + x.share, 0), d.krw(e), `${id} 분담 합계`);
    }
    assert.equal(r.total, d.expenses.reduce((s, e) => s + d.krw(e), 0));
  }
});

test("버전 2개: v1은 스파 분담에 지은 포함, v2는 제외", () => {
  const d = load("data.js");
  assert.equal(d.versions.length, 2);
  assert.equal(d.versions[1].status, "current");
  assert.ok(d.versions[0].result.shares.e09.some((s) => s.id === "m_jieun"));
  assert.ok(!d.versions[1].result.shares.e09.some((s) => s.id === "m_jieun"));
});

test("장면 키가 스펙 3.3과 같다", () => {
  const d = load("data.js");
  assert.deepEqual(Object.keys(d.scenes.landing), ["intake_on", "intake_off"]);
  assert.deepEqual(Object.keys(d.scenes.review), ["awaiting_organizer", "participant_review", "finalized"]);
  assert.deepEqual(Object.keys(d.scenes.share), ["notice", "active", "expired"]);
  assert.deepEqual(Object.keys(d.scenes.operator), ["queue", "case", "login"]);
});

test("참여자 검토 장면: 승인 2, 이의 1, 무응답 1", () => {
  const d = load("data.js");
  const ds = d.scenes.review.participant_review.decisions;
  const count = (k) => ds.filter((x) => x.decision === k).length;
  assert.equal(count("approved"), 2);
  assert.equal(count("objection"), 1);
  assert.equal(count("not_responded"), 1);
  assert.equal(d.scenes.review.finalized.decisions.filter((x) => x.decision === "objection").length, 0);
  assert.ok(d.scenes.review.finalized.locked_at);
});

test("케이스 3건, C-014 차단 2건, 불변식 8개, 단계 6개", () => {
  const d = load("data.js");
  assert.deepEqual(d.cases.map((c) => c.id), ["C-014", "C-013", "C-012"]);
  assert.equal(d.cases[0].blockers.length, 2);
  assert.ok(d.cases[1].paused_reason);
  assert.equal(d.invariants.length, 8);
  assert.deepEqual(d.stages.map((s) => s.key), ["collecting", "reviewing", "awaiting_organizer", "participant_review", "finalized", "delivered"]);
  assert.equal(d.stages.filter((s) => s.sla).length, 1);
});

test("개인정보·계좌·Toss 흔적이 없다", () => {
  const src = read("data.js");
  assert.doesNotMatch(src, /\d{10,}/, "10자리 이상 숫자열");
  assert.doesNotMatch(src, /toss|\d{2,6}-\d{2,6}-\d{4,8}|계좌번호|@[a-z0-9.-]+\.[a-z]{2,}/i);
});

test("가격 셀 2개와 적격·제외 조건", () => {
  const d = load("data.js");
  assert.deepEqual(d.pricing.map((p) => p.price), [29000, 59000]);
  assert.equal(d.pricing.filter((p) => p.featured).length, 1);
  assert.equal(d.eligibility.include.length, 6);
  assert.equal(d.eligibility.exclude.length, 6);
  assert.equal(d.revision_quota.total, 2);
});
