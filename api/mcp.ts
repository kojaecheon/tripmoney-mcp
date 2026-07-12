// Vercel 서버리스 MCP 엔드포인트 (Streamable HTTP, stateless)
// PlayMCP 등록 URL: https://<your-app>.vercel.app/mcp  (vercel.json 에서 /mcp -> /api/mcp 라우팅)
import type { IncomingMessage, ServerResponse } from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../lib/server.js";

export const config = { api: { bodyParser: true } };

function checkAuth(req: IncomingMessage): boolean {
  const expected = process.env.TRIPMONEY_API_KEY;
  // 키 미설정 = "인증 사용 안 함"(PlayMCP 등록값과 일치). 누구나 접근 가능(공개 데모).
  // 방 단위 보호가 필요하면 createTrip 의 protect=true → trip_key 로 제어한다.
  // 키를 설정하면 그때부터 x-api-key 헤더 검증으로 전면 잠금 전환.
  if (!expected) return true;
  return req.headers["x-api-key"] === expected;
}

export default async function handler(req: IncomingMessage & { body?: any }, res: ServerResponse) {
  // CORS / preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-api-key, mcp-session-id, accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!checkAuth(req)) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: invalid x-api-key" }, id: null }));
    return;
  }

  // stateless: GET/DELETE(세션 기반) 미지원
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST." }, id: null }));
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, (req as any).body);
  } catch (err: any) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(err?.message ?? err) }, id: null }));
    }
  }
}
