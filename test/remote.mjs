// 배포된 MCP 서버 전체 데이터 플로우 실호출 테스트 (PlayMCP 와 동일한 방식)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "fs";

const URL_MCP = process.env.MCP_URL || "https://tripmoney-alpha.vercel.app/mcp";
const KEY = fs.readFileSync("/tmp/tmapikey", "utf8").trim();

const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
  requestInit: { headers: { "x-api-key": KEY } },
});
const client = new Client({ name: "tripmoney-e2e", version: "0.0.0" });
await client.connect(transport);
console.log("✅ connected:", URL_MCP);

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const sc = r.structuredContent;
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name} 실패: ${text}`);
  console.log(`\n▶ ${name}\n${text.split("\n")[0]}`);
  return sc;
}

const now = new Date();
const iso = (d) => new Date(d).toISOString();

// 1) 여행방 + 멤버
const trip = await call("createTrip", {
  name: "방콕 3박4일",
  base_currency: "KRW",
  start_date: "2026-07-01",
  end_date: "2026-07-04",
  members: [
    { name: "민수", role: "owner" },
    { name: "지영", role: "editor" },
    { name: "현우", role: "viewer" },
  ],
});
const tripId = trip.trip.id;
const idOf = (n) => trip.members.find((m) => m.name === n).id;
console.log("  trip_id:", tripId);

// 2) 일정 (지금 시각 포함 → scanReceipt 자동귀속 테스트용)
const sched = await call("addSchedule", {
  trip_id: tripId,
  title: "오아시스 스파",
  start_at: iso(now.getTime() - 3600e3),
  end_at: iso(now.getTime() + 7200e3),
  location: "방콕 아속",
  planned_budget: 120000,
  actor_member_id: idOf("민수"),
});

// 3) 비용 직접 등록 (THB → KRW 실시간 환율)
await call("addExpense", {
  trip_id: tripId,
  title: "스파 2인",
  amount: 2000,
  currency: "THB",
  payer_member_id: idOf("민수"),
  schedule_id: sched.schedule.id,
  pay_method: "card",
  split_mode: "equal",
});

// 4) 영수증 기반 등록 (spent_at=now → 진행중 일정 자동귀속)
await call("scanReceipt", {
  trip_id: tripId,
  receipt_url: "https://example.com/receipt-taxi.jpg",
  amount: 300,
  currency: "THB",
  title: "택시",
  payer_member_id: idOf("지영"),
  pay_method: "cash",
  spent_at: iso(now),
  split_mode: "equal",
});

// 5) viewer 권한 거부 테스트 (현우가 일정 수정 시도 → 실패해야 정상)
try {
  await call("updateSchedule", {
    schedule_id: sched.schedule.id,
    actor_member_id: idOf("현우"),
    status: "done",
  });
  console.log("  ❌ viewer 권한 거부 실패 (수정됨)");
} catch (e) {
  console.log("  ✅ viewer 수정 차단 확인:", e.message.split(":").pop().trim());
}

// 6) 예산/지출 요약
const sum = await call("getBudgetSummary", { trip_id: tripId });
console.log("  총지출(KRW):", sum.total_spent_base, "| 통화별:", JSON.stringify(sum.by_currency));
console.log("  일정별:", JSON.stringify(sum.by_schedule));

// 7) 정산 (N빵)
const settle = await call("calculateSettlement", { trip_id: tripId, mode: "equal" });
console.log("  멤버별 순액:", settle.per_member.map((m) => `${m.name}:${m.net}`).join(", "));
console.log("  송금제안:", JSON.stringify(settle.transfers));

await client.close();
console.log("\n🎉 전체 플로우 성공. trip_id =", tripId);
