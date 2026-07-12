import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../lib/server.js";
import { getReadinessReport } from "../lib/readiness.js";

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "0.0.0.0";

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-api-key, mcp-session-id, accept",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function checkAuth(req: IncomingMessage): boolean {
  const expected = process.env.TRIPMONEY_API_KEY;
  if (!expected) return true;
  return req.headers["x-api-key"] === expected;
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") return writeJson(res, 204, {});
  if (req.method === "GET" || req.method === "HEAD") {
    return writeJson(res, 200, {
      service: "tripmoney-mcp",
      status: "ok",
      protocol: "MCP Streamable HTTP",
      message: "Use POST for JSON-RPC MCP requests.",
    });
  }
  if (!checkAuth(req)) {
    return writeJson(res, 401, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: invalid x-api-key" },
      id: null,
    });
  }
  if (req.method !== "POST") {
    return writeJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST." },
      id: null,
    });
  }

  const body = await readJson(req);
  const mcpServer = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    mcpServer.close();
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      const report = await getReadinessReport();
      return writeJson(res, 200, { ...report, mcp_endpoint: "/mcp", platform_ready: true });
    }
    if (url.pathname === "/mcp" || url.pathname === "/api/mcp") {
      return await handleMcp(req, res);
    }
    if (url.pathname === "/") {
      return writeJson(res, 200, {
        service: "tripmoney-mcp",
        status: "ok",
        mcp_endpoint: "/mcp",
        health_endpoint: "/health",
      });
    }
    return writeJson(res, 404, { error: "not found" });
  } catch (error: any) {
    if (!res.headersSent) {
      return writeJson(res, 500, { error: String(error?.message ?? error) });
    }
    res.end();
  }
});

server.listen(port, host, () => {
  console.log(`TripMoney MCP server listening on http://${host}:${port}`);
});
