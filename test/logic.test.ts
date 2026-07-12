// 정산 로직 단위 테스트 (DB/네트워크 불필요)
import { calculateSettlement, splitEqually, rescaleShares, type Member, type ExpenseForCalc } from "../lib/settlement.js";
import { getRate } from "../lib/fx.js";
import { validateCustomShareTotal, validateExpenseTripRefs } from "../lib/validation.js";
import { buildSettlementExport } from "../lib/settlementExport.js";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

const members: Member[] = [
  { id: "A", name: "민수" },
  { id: "B", name: "지영" },
  { id: "C", name: "현우" },
];

// 시나리오: 민수가 30000 결제(전원 N빵), 지영이 15000 결제(전원 N빵)
const expenses: ExpenseForCalc[] = [
  {
    id: "e1",
    payer_member_id: "A",
    amount_base: 30000,
    shares: [
      { member_id: "A", share_base: 10000 },
      { member_id: "B", share_base: 10000 },
      { member_id: "C", share_base: 10000 },
    ],
  },
  {
    id: "e2",
    payer_member_id: "B",
    amount_base: 15000,
    shares: [
      { member_id: "A", share_base: 5000 },
      { member_id: "B", share_base: 5000 },
      { member_id: "C", share_base: 5000 },
    ],
  },
];

console.log("[equal 모드 - N빵]");
{
  const r = calculateSettlement(members, expenses, "equal");
  assert(r.total === 45000, `총액 45000 (got ${r.total})`);
  const A = r.per_member.find((m) => m.member_id === "A")!;
  const C = r.per_member.find((m) => m.member_id === "C")!;
  // 1인당 15000 부담. A: 낸 30000 - 15000 = +15000 / C: 0 - 15000 = -15000
  assert(A.net === 15000, `민수 순액 +15000 (got ${A.net})`);
  assert(C.net === -15000, `현우 순액 -15000 (got ${C.net})`);
  const sumNet = r.per_member.reduce((s, m) => s + m.net, 0);
  assert(Math.abs(sumNet) < 0.01, `순액 합계 0 (got ${sumNet})`);
  const sumTransfers = r.transfers.reduce((s, t) => s + t.amount, 0);
  assert(Math.abs(sumTransfers - 15000) < 0.01, `송금 총액 = 부족분 15000 (got ${sumTransfers})`);
  console.log("  transfers:", JSON.stringify(r.transfers));
}

console.log("[shares 모드 - 분담기록]");
{
  const r = calculateSettlement(members, expenses, "shares");
  const A = r.per_member.find((m) => m.member_id === "A")!;
  assert(A.owed === 15000, `민수 부담 15000 (got ${A.owed})`);
  assert(A.net === 15000, `민수 순액 +15000 (got ${A.net})`);
}

console.log("[individual 모드 - 각자부담]");
{
  const r = calculateSettlement(members, expenses, "individual");
  // owed = paid → 모두 net 0, 송금 없음
  assert(r.transfers.length === 0, `송금 없음 (got ${r.transfers.length})`);
  assert(r.per_member.every((m) => m.net === 0), "모든 멤버 순액 0");
}

console.log("[payer 미상 지출 - 정산 제외 + sum(net)=0 불변식]");
{
  // 멤버 삭제(on delete set null) 등으로 payer 를 특정할 수 없는 지출은
  // 정산에서 제외하고 excluded 로 보고해야 한다 (포함 시 sum(net)=0 이 깨짐)
  const withOrphan: ExpenseForCalc[] = [
    ...expenses,
    {
      id: "e9",
      payer_member_id: null,
      amount_base: 9000,
      shares: [
        { member_id: "A", share_base: 3000 },
        { member_id: "B", share_base: 3000 },
        { member_id: "C", share_base: 3000 },
      ],
    },
  ];
  for (const mode of ["equal", "shares", "individual"] as const) {
    const r = calculateSettlement(members, withOrphan, mode);
    const sumNet = r.per_member.reduce((s, m) => s + m.net, 0);
    assert(Math.abs(sumNet) < 0.01, `${mode}: 순액 합계 0 (got ${sumNet})`);
    assert(r.total === 45000, `${mode}: 총액은 정산 가능 지출만 45000 (got ${r.total})`);
    assert(
      r.excluded.count === 1 && r.excluded.total === 9000,
      `${mode}: 제외 내역 1건/9000 보고 (got ${r.excluded.count}건/${r.excluded.total})`
    );
  }
  // 멤버 목록에 없는 payer id(다른 여행방 등)도 동일하게 제외
  const unknownPayer: ExpenseForCalc[] = [{ id: "e10", payer_member_id: "GHOST", amount_base: 1000, shares: [] }];
  const r2 = calculateSettlement(members, unknownPayer, "individual");
  assert(r2.total === 0 && r2.excluded.total === 1000, `미상 payer id 제외 (got total ${r2.total}, excluded ${r2.excluded.total})`);
  // 정상 데이터에서는 excluded 가 0 이어야 한다
  const r3 = calculateSettlement(members, expenses, "equal");
  assert(r3.excluded.count === 0 && r3.excluded.total === 0, "정상 데이터는 제외 없음");
}

console.log("[custom shares - 일부만 참여]");
{
  // A와 B만 먹은 카페 20000을 A가 결제, A/B 각 10000 부담
  const cafe: ExpenseForCalc[] = [
    {
      id: "e3",
      payer_member_id: "A",
      amount_base: 20000,
      shares: [
        { member_id: "A", share_base: 10000 },
        { member_id: "B", share_base: 10000 },
      ],
    },
  ];
  const r = calculateSettlement(members, cafe, "shares");
  const B = r.per_member.find((m) => m.member_id === "B")!;
  const C = r.per_member.find((m) => m.member_id === "C")!;
  assert(B.net === -10000, `지영 -10000 (got ${B.net})`);
  assert(C.net === 0, `현우 미참여 0 (got ${C.net})`);
  assert(r.transfers.length === 1 && r.transfers[0].from === "B" && r.transfers[0].to === "A", "지영→민수 1건");
}

console.log("[M1 - 나누어떨어지지 않는 N빵 잔차]");
{
  // 10000 을 3명 → 33.33×3=99.99 가 아니라 합이 정확히 10000 이어야 함
  const parts = splitEqually(10000, 3);
  const sum = parts.reduce((s, n) => s + n, 0);
  assert(Math.abs(sum - 10000) < 1e-9, `3등분 합계 = 10000 (got ${sum})`);
  assert(parts.length === 3, `3개 분배 (got ${parts.length})`);

  // calculateSettlement equal 모드도 owed 합 = total 보장
  const e: ExpenseForCalc[] = [{ id: "x", payer_member_id: "A", amount_base: 10000, shares: [] }];
  const r = calculateSettlement(members, e, "equal");
  const sumOwed = r.per_member.reduce((s, m) => s + m.owed, 0);
  assert(Math.abs(sumOwed - r.total) < 1e-9, `owed 합 = total ${r.total} (got ${sumOwed})`);
  const sumNet = r.per_member.reduce((s, m) => s + m.net, 0);
  assert(Math.abs(sumNet) < 1e-9, `순액 합계 0 (got ${sumNet})`);
}

console.log("[M2 - 환율 graceful degradation]");
{
  const realFetch = globalThis.fetch;
  // 1) 성공 응답 → 캐시 적재
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ result: "success", rates: { KRW: 38.5 } }),
  })) as any;
  const r1 = await getRate("THB", "KRW");
  assert(r1 === 38.5, `정상 조회 38.5 (got ${r1})`);

  // 2) 외부 API 장애 → 캐시 보유 시 throw 없이 폴백 (서비스 연속성)
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as any;
  let r2: number | null = null;
  try {
    r2 = await getRate("THB", "KRW");
  } catch {
    r2 = null;
  }
  assert(r2 === 38.5, `장애 시 캐시 폴백 38.5 (got ${r2})`);

  // 3) 캐시 없는 통화 + 장애 → 명확한 예외(수동 환율 안내)
  let threw = false;
  try {
    await getRate("ZZZ", "KRW");
  } catch {
    threw = true;
  }
  assert(threw, "캐시 없는 장애는 예외 발생");

  // 4) 동일통화는 항상 1
  assert((await getRate("KRW", "KRW")) === 1, "동일통화 1");
  globalThis.fetch = realFetch;
}

console.log("[비용 수정 - 분담 비례 재배분]");
{
  // 균등(30000=10000×3)을 45000 으로 인상 → 비율 보존 + 합 정확
  const old = [
    { member_id: "A", share_base: 10000 },
    { member_id: "B", share_base: 10000 },
    { member_id: "C", share_base: 10000 },
  ];
  const r = rescaleShares(old, 45000);
  const sum = r.reduce((s, x) => s + x.share_base, 0);
  assert(Math.abs(sum - 45000) < 1e-9, `재배분 합 = 45000 (got ${sum})`);
  assert(r.every((x) => Math.abs(x.share_base - 15000) < 0.01), "균등 비율 보존 15000");

  // custom 비율(2:1) 보존: 20000(A 13333.33, B 6666.67 가정) → 30000
  const cu = [
    { member_id: "A", share_base: 13333.34 },
    { member_id: "B", share_base: 6666.66 },
  ];
  const r2 = rescaleShares(cu, 30000);
  const sum2 = r2.reduce((s, x) => s + x.share_base, 0);
  assert(Math.abs(sum2 - 30000) < 1e-9, `custom 재배분 합 = 30000 (got ${sum2})`);
  const A2 = r2.find((x) => x.member_id === "A")!.share_base;
  assert(A2 > 19000 && A2 < 21000, `custom 2:1 비율 보존 (A≈20000, got ${A2})`);
}

console.log("[P0 - same-trip 참조 검증]");
{
  const allowed = {
    memberIds: new Set(["A", "B", "C"]),
    scheduleIds: new Set(["S1", "S2"]),
  };
  let ok = true;
  try {
    validateExpenseTripRefs(
      {
        payer_member_id: "A",
        schedule_id: "S1",
        split_member_ids: ["A", "B"],
        custom_shares: [{ member_id: "A", amount: 5000 }],
      },
      allowed
    );
  } catch {
    ok = false;
  }
  assert(ok, "같은 여행방 멤버/일정 참조 허용");

  let blockedPayer = false;
  try {
    validateExpenseTripRefs({ payer_member_id: "OTHER" }, allowed);
  } catch {
    blockedPayer = true;
  }
  assert(blockedPayer, "다른 여행방 payer_member_id 차단");

  let blockedSchedule = false;
  try {
    validateExpenseTripRefs({ schedule_id: "OTHER_S" }, allowed);
  } catch {
    blockedSchedule = true;
  }
  assert(blockedSchedule, "다른 여행방 schedule_id 차단");

  let blockedSplit = false;
  try {
    validateExpenseTripRefs({ split_member_ids: ["A", "OTHER"] }, allowed);
  } catch {
    blockedSplit = true;
  }
  assert(blockedSplit, "다른 여행방 split_member_ids 차단");

  let blockedCustom = false;
  try {
    validateExpenseTripRefs({ custom_shares: [{ member_id: "OTHER", amount: 1 }] }, allowed);
  } catch {
    blockedCustom = true;
  }
  assert(blockedCustom, "다른 여행방 custom_shares 차단");

  let totalOk = true;
  try {
    validateCustomShareTotal(
      [
        { member_id: "A", amount: 6000 },
        { member_id: "B", amount: 4000 },
      ],
      10000
    );
  } catch {
    totalOk = false;
  }
  assert(totalOk, "custom_shares 합계 일치 허용");

  let totalBlocked = false;
  try {
    validateCustomShareTotal(
      [
        { member_id: "A", amount: 6000 },
        { member_id: "B", amount: 3000 },
      ],
      10000
    );
  } catch {
    totalBlocked = true;
  }
  assert(totalBlocked, "custom_shares 합계 불일치 차단");

  let emptyCustomBlocked = false;
  try {
    validateCustomShareTotal([], 10000);
  } catch {
    emptyCustomBlocked = true;
  }
  assert(emptyCustomBlocked, "빈 custom_shares 차단");
}

console.log("[P1 - 정산 내보내기]");
{
  const r = calculateSettlement(members, expenses, "shares", "KRW");
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const transfers = r.transfers.map((t) => ({
    from: nameOf.get(t.from) || t.from,
    to: nameOf.get(t.to) || t.to,
    amount: t.amount,
    payee_account: t.to === "A" ? "토스뱅크 100012341234" : null,
  }));
  const exp = buildSettlementExport({
    tripName: "방콕 3박 4일",
    baseCurrency: "KRW",
    mode: r.mode,
    total: r.total,
    perMember: r.per_member,
    transfers,
  });
  assert(exp.kakao_text.includes("[TripMoney] 방콕 3박 4일 정산 결과"), "카톡용 정산 제목 포함");
  assert(exp.kakao_text.includes("송금 요청"), "카톡용 송금 요청 섹션 포함");
  assert(exp.csv.startsWith("section,name,paid,owed,net,from,to,amount,account"), "CSV 헤더 포함");
  assert(exp.csv.includes("member,민수"), "CSV 멤버 행 포함");
  assert(exp.card.title === "방콕 3박 4일 정산 카드", "정산 카드 제목 생성");
  assert(exp.card.transfers.length === transfers.length, "정산 카드 송금 건수 일치");
}

console.log(`\n결과: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
