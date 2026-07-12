import { q } from "./db.js";

type CheckStatus = "ok" | "warn" | "error";

export type ReadinessCheck = {
  name: string;
  status: CheckStatus;
  message: string;
};

export type ReadinessReport = {
  ok: boolean;
  service: string;
  version: string;
  environment: string;
  prototype_mode: boolean;
  checks: ReadinessCheck[];
  time: string;
};

const REQUIRED_RELATIONS = [
  "trips",
  "members",
  "schedules",
  "expenses",
  "expense_shares",
  "audit_events",
  "beta_leads",
];

const REQUIRED_COLUMNS = [
  ["trips", "api_key"],
  ["trips", "share_token"],
  ["members", "bank_name"],
  ["members", "account_no"],
  ["expenses", "updated_at"],
] as const;

function configured(name: string): boolean {
  return Boolean(process.env[name]);
}

export async function getReadinessReport(): Promise<ReadinessReport> {
  const environment = process.env.NODE_ENV || "development";
  const prototypeMode = process.env.TRIPMONEY_PROTOTYPE_MODE === "mock";
  const checks: ReadinessCheck[] = [];

  checks.push({
    name: "DATABASE_URL",
    status: configured("DATABASE_URL") ? "ok" : prototypeMode ? "warn" : "error",
    message: configured("DATABASE_URL")
      ? "configured"
      : prototypeMode
        ? "missing; mock prototype mode is enabled"
        : "missing",
  });

  // TRIPMONEY_API_KEY 미설정은 의도된 구성(PlayMCP 공개 등록 — api/mcp.ts checkAuth 참조).
  // 방 단위 보호는 trip_key 로 강제되므로 error 가 아닌 warn 으로 보고한다.
  checks.push({
    name: "TRIPMONEY_API_KEY",
    status: configured("TRIPMONEY_API_KEY") ? "ok" : "warn",
    message: configured("TRIPMONEY_API_KEY")
      ? "configured"
      : "missing; MCP endpoint is keyless by design (PlayMCP public registration) — per-trip protection via trip_key",
  });

  checks.push({
    name: "TRIPMONEY_WEB_DEMO_KEY",
    status: configured("TRIPMONEY_WEB_DEMO_KEY") ? "ok" : environment === "production" ? "error" : "warn",
    message: configured("TRIPMONEY_WEB_DEMO_KEY")
      ? "configured"
      : environment === "production"
        ? "missing in production"
        : "missing; operator web API is open only outside production",
  });

  checks.push({
    name: "TRIPMONEY_PROTOTYPE_MODE",
    status: prototypeMode && environment === "production" ? "error" : prototypeMode ? "warn" : "ok",
    message: prototypeMode
      ? environment === "production"
        ? "mock mode must not be enabled in production"
        : "mock mode enabled"
      : "off",
  });

  if (configured("DATABASE_URL")) {
    try {
      const relations = await q<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'tripmoney'
            and table_name = any($1::text[])`,
        [REQUIRED_RELATIONS]
      );
      const relationSet = new Set(relations.map((r) => r.table_name));
      const missingRelations = REQUIRED_RELATIONS.filter((name) => !relationSet.has(name));
      checks.push({
        name: "schema.tables",
        status: missingRelations.length ? "error" : "ok",
        message: missingRelations.length
          ? `missing: ${missingRelations.join(", ")}`
          : "required tripmoney tables exist",
      });

      const columns = await q<{ table_name: string; column_name: string }>(
        `select table_name, column_name
           from information_schema.columns
          where table_schema = 'tripmoney'
            and (table_name, column_name) in (
              ('trips','api_key'),
              ('trips','share_token'),
              ('members','bank_name'),
              ('members','account_no'),
              ('expenses','updated_at')
            )`
      );
      const columnSet = new Set(columns.map((c) => `${c.table_name}.${c.column_name}`));
      const missingColumns = REQUIRED_COLUMNS
        .map(([table, column]) => `${table}.${column}`)
        .filter((name) => !columnSet.has(name));
      checks.push({
        name: "schema.columns",
        status: missingColumns.length ? "error" : "ok",
        message: missingColumns.length
          ? `missing: ${missingColumns.join(", ")}`
          : "required migration columns exist",
      });
    } catch (e: any) {
      checks.push({
        name: "database.connection",
        status: "error",
        message: e?.message ? String(e.message) : "database readiness check failed",
      });
    }
  }

  const ok = checks.every((check) => check.status !== "error");
  return {
    ok,
    service: "tripmoney-mcp",
    version: "0.1.0",
    environment,
    prototype_mode: prototypeMode,
    checks,
    time: new Date().toISOString(),
  };
}
