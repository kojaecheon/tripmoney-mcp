// 고도화 기능 원격 테스트: 방 접근키 / 송금 딥링크 / OCR 폴백
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "fs";

const URL_MCP = process.env.MCP_URL || "https://tripmoney-alpha.vercel.app/mcp";
const KEY = fs.readFileSync("/tmp/tmapikey", "utf8").trim();
const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
  requestInit: { headers: { "x-api-key": KEY } },
});
const client = new Client({ name: "tm-adv", version: "0" });
await client.connect(transport);
console.log("✅ connected");

async function call(name, args, { expectError = false } = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError && !expectError) throw new Error(`${name} 실패: ${text}`);
  if (!r.isError && expectError) throw new Error(`${name} 가 차단되지 않음`);
  return { sc: r.structuredContent, text, isError: r.isError };
}

// 1) 여행방 생성 (모든 방은 기본 보호 — trip_key 자동 발급) + 민수 계좌
const t = await call("createTrip", {
  name: "보호테스트 여행",
  members: [
    { name: "민수", role: "owner", bank_name: "카카오뱅크", account_no: "3333-01-1234567" },
    { name: "지영", role: "editor" },
  ],
});
const tripId = t.sc.trip.id;
const tripKey = t.sc.trip_key;
const idOf = (n) => t.sc.members.find((m) => m.name === n).id;
console.log(`\n1) 보호 여행방 생성 — trip_key=${tripKey ? "발급됨" : "없음"}`);

// 2) trip_key 없이 비용 등록 → 차단되어야 정상
const blocked = await call(
  "addExpense",
  { trip_id: tripId, title: "무단지출", amount: 10000, payer_member_id: idOf("민수") },
  { expectError: true }
);
console.log("2) 키 없이 호출 차단 ✅:", blocked.text.replace("❌ ", ""));

// 3) trip_key 와 함께 → 성공
await call("addExpense", {
  trip_id: tripId,
  trip_key: tripKey,
  title: "저녁 회식",
  amount: 90000,
  payer_member_id: idOf("민수"),
  pay_method: "card",
  split_mode: "equal",
});
console.log("3) 키 동반 비용 등록 ✅");

// 4) OCR 폴백 (금액 미전달, CLOVA 미설정) → 안내 메시지
const ocr = await call("scanReceipt", {
  trip_id: tripId,
  trip_key: tripKey,
  receipt_url: "https://example.com/r.jpg",
});
console.log("4) OCR 폴백 ✅: ocr_connected =", ocr.sc?.ocr_connected, "|", ocr.text.slice(0, 40), "...");

// 5) 정산 + 송금 딥링크/공유메시지
const s = await call("calculateSettlement", { trip_id: tripId, trip_key: tripKey, mode: "equal" });
console.log("\n5) 정산 + 송금 딥링크:");
console.log("  transfers_detail:");
for (const tv of s.sc.transfers_detail) {
  console.log(`   ${tv.from}→${tv.to} ${tv.amount} | toss=${tv.toss_link ?? "(계좌없음)"} | 계좌=${tv.payee_account ?? "-"}`);
}
console.log("  --- share_message ---");
console.log(s.sc.share_message.split("\n").map((l) => "  " + l).join("\n"));

await client.close();
console.log("\n🎉 고도화 테스트 성공. (정리용) trip_id =", tripId);
fs.writeFileSync("/tmp/adv_trip", tripId);
