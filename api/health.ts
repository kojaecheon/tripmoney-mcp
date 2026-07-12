import type { IncomingMessage, ServerResponse } from "http";
import { getReadinessReport } from "../lib/readiness.js";

export default async function handler(_req: IncomingMessage, res: ServerResponse) {
  const report = await getReadinessReport();
  res.statusCode = report.ok ? 200 : 503;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ...report, mcp_endpoint: "/mcp" }));
}
