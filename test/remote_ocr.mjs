// 배포 서버 scanReceipt OCR 자동인식 E2E
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "fs";

const BASE = "https://tripmoney-alpha.vercel.app";
const KEY = fs.readFileSync("/tmp/tmapikey", "utf8").trim();
const IMG = `${BASE}/test-receipt.png`;

// 1) 이미지 공개 접근 확인
const head = await fetch(IMG, { method: "GET" });
console.log("이미지 접근:", head.status, head.headers.get("content-type"));

const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
  requestInit: { headers: { "x-api-key": KEY } },
});
const client = new Client({ name: "ocr-e2e", version: "0" });
await client.connect(transport);

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name} 실패: ${text}`);
  return { sc: r.structuredContent, text };
}

const t = await call("createTrip", { name: "OCR테스트 여행", base_currency: "KRW" });
const tripId = t.sc.trip.id;

// amount 없이 영수증만 → OCR 자동 추출되어야 함
const r = await call("scanReceipt", { trip_id: tripId, receipt_url: IMG });
console.log("\nscanReceipt 결과:");
console.log(" ", r.text.split("\n")[0]);
console.log("  amount_base:", r.sc?.amount_base, "| amount:", r.sc?.amount, r.sc?.currency, "| source:", r.sc?.source);

const sum = await call("getBudgetSummary", { trip_id: tripId });
console.log("  총지출:", sum.sc.total_spent_base, sum.sc.trip.base_currency);

await client.close();
fs.writeFileSync("/tmp/ocr_trip", tripId);
console.log("\n🎉 OCR E2E 완료. trip_id =", tripId);
