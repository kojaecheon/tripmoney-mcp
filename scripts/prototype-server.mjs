import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handlePrototypeWeb } from "../lib/prototypeStore.js";
import { getReadinessReport } from "../lib/readiness.js";
import { submitBetaLead } from "../lib/betaLeads.js";

process.env.TRIPMONEY_PROTOTYPE_MODE = "mock";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-demo-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") return sendJson(res, 204, {});

    if (url.pathname === "/api/health" || url.pathname === "/health") {
      const report = await getReadinessReport();
      return sendJson(res, report.ok ? 200 : 503, { ...report, mcp_endpoint: "/mcp" });
    }

    if (url.pathname === "/api/web") {
      const body = await readBody(req);
      const action = url.searchParams.get("action");
      const tripId = url.searchParams.get("id") || undefined;
      const result = await handlePrototypeWeb(
        action,
        { method: req.method, body: { ...body, mode: url.searchParams.get("mode") || undefined } },
        tripId
      );
      if ("status" in result && "body" in result) return sendJson(res, result.status, result.body);
      return sendJson(res, 200, result);
    }

    if (url.pathname === "/api/beta") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readBody(req);
      try {
        const result = await submitBetaLead({ ...body, source: body.source || "landing-local" });
        return sendJson(res, 200, { ok: true, id: result.id, stored: result.stored });
      } catch (error) {
        const message = String(error?.message || error);
        return sendJson(res, message.includes("required") ? 400 : 500, { error: message });
      }
    }

    const file = url.pathname === "/"
      ? "public/index.html"
      : url.pathname === "/prototype"
        ? "public/app.html"
        : `public${url.pathname}`;
    const fullPath = path.resolve(root, file);
    if (!fullPath.startsWith(path.join(root, "public"))) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    const data = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    const type = ext === ".html" ? "text/html; charset=utf-8" : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  } catch (error) {
    const status = error?.code === "ENOENT" ? 404 : 500;
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(status === 404 ? "Not found" : String(error?.message || error));
  }
});

server.listen(port, host, () => {
  console.log(`TripMoney prototype ready: http://${host}:${port}/`);
});
