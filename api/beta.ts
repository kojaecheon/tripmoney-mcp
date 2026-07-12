import type { IncomingMessage, ServerResponse } from "http";
import { submitBetaLead } from "../lib/betaLeads.js";

export const config = { api: { bodyParser: true } };

function send(res: ServerResponse, code: number, data: any) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.end(JSON.stringify(data));
}

export default async function handler(req: IncomingMessage & { body?: any }, res: ServerResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  try {
    const result = await submitBetaLead({
      ...(req.body || {}),
      source: req.body?.source || "landing",
      metadata: {
        user_agent: req.headers["user-agent"] || null,
        referer: req.headers.referer || null,
      },
    });
    return send(res, 200, { ok: true, id: result.id, stored: result.stored });
  } catch (e: any) {
    const message = String(e?.message || e);
    const status = message === "spam detected" ? 200 : message.includes("required") ? 400 : 500;
    return send(res, status, status === 200 ? { ok: true } : { error: message });
  }
}
