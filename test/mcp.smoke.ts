// MCP 프로토콜 레이어 스모크 테스트 (DB 불필요)
// 서버에 핵심 Tool 이 정상 등록되고 JSON-RPC tools/list 가 동작하는지 검증
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../lib/server.js";

const EXPECTED = [
  "createTrip",
  "addMember",
  "addSchedule",
  "updateSchedule",
  "addExpense",
  "scanReceipt",
  "getBudgetSummary",
  "calculateSettlement",
  "updateExpense",
  "deleteExpense",
  "createShareLink",
];

const server = buildServer();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(clientTransport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log("등록된 Tool:", names.join(", "));

let failed = 0;
for (const e of EXPECTED) {
  if (names.includes(e)) console.log(`  ✅ ${e}`);
  else {
    console.error(`  ❌ 누락: ${e}`);
    failed++;
  }
}
if (names.length !== EXPECTED.length) {
  console.error(`  ❌ Tool 개수 불일치: ${names.length} (기대 ${EXPECTED.length})`);
  failed++;
}

// inputSchema 가 JSON-RPC 로 직렬화되어 노출되는지 확인 (PlayMCP 가 읽는 부분)
const ct = tools.find((t) => t.name === "createTrip");
if (ct?.inputSchema?.properties?.name) console.log("  ✅ createTrip inputSchema 노출 정상");
else {
  console.error("  ❌ inputSchema 미노출");
  failed++;
}

await client.close();
await server.close();

console.log(`\n결과: ${failed === 0 ? "PASS" : "FAIL (" + failed + ")"}`);
process.exit(failed === 0 ? 0 : 1);
