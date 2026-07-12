import { one, q } from "./db.js";

export type BetaLeadInput = {
  name?: string | null;
  contact?: string | null;
  trip_name?: string | null;
  destination?: string | null;
  group_size?: number | string | null;
  trip_date?: string | null;
  segment?: string | null;
  price_interest?: string | null;
  pain?: string | null;
  source?: string | null;
  website?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type BetaLeadRow = {
  id: string;
  name: string | null;
  contact: string;
  trip_name: string | null;
  destination: string | null;
  group_size: number | null;
  trip_date: string | null;
  segment: string | null;
  price_interest: string | null;
  pain: string | null;
  source: string;
  status: string;
  created_at: string;
};

const memoryLeads: BetaLeadRow[] = [];
const trim = (value: unknown) => String(value ?? "").trim();

function usingDatabase() {
  return Boolean(process.env.DATABASE_URL) && process.env.TRIPMONEY_PROTOTYPE_MODE !== "mock";
}

function parseGroupSize(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

export function normalizeBetaLead(input: BetaLeadInput): Omit<BetaLeadRow, "id" | "status" | "created_at"> & { metadata: Record<string, unknown> } {
  if (trim(input.website)) {
    throw new Error("spam detected");
  }
  const contact = trim(input.contact);
  if (!contact) throw new Error("contact required");
  if (contact.length > 160) throw new Error("contact too long");
  const groupSize = parseGroupSize(input.group_size);
  return {
    name: trim(input.name) || null,
    contact,
    trip_name: trim(input.trip_name) || null,
    destination: trim(input.destination) || null,
    group_size: groupSize,
    trip_date: trim(input.trip_date) || null,
    segment: trim(input.segment) || null,
    price_interest: trim(input.price_interest) || null,
    pain: trim(input.pain) || null,
    source: trim(input.source) || "landing",
    metadata: input.metadata ?? {},
  };
}

export async function submitBetaLead(input: BetaLeadInput): Promise<{ id: string; stored: "database" | "memory" }> {
  const lead = normalizeBetaLead(input);
  if (usingDatabase()) {
    const row = (await one<{ id: string }>(
      `insert into tripmoney.beta_leads(name,contact,trip_name,destination,group_size,trip_date,segment,price_interest,pain,source,metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       returning id`,
      [
        lead.name,
        lead.contact,
        lead.trip_name,
        lead.destination,
        lead.group_size,
        lead.trip_date,
        lead.segment,
        lead.price_interest,
        lead.pain,
        lead.source,
        JSON.stringify(lead.metadata),
      ]
    ))!;
    return { id: row.id, stored: "database" };
  }

  const id = `lead_${Math.random().toString(36).slice(2, 10)}`;
  memoryLeads.unshift({
    id,
    name: lead.name,
    contact: lead.contact,
    trip_name: lead.trip_name,
    destination: lead.destination,
    group_size: lead.group_size,
    trip_date: lead.trip_date,
    segment: lead.segment,
    price_interest: lead.price_interest,
    pain: lead.pain,
    source: lead.source,
    status: "new",
    created_at: new Date().toISOString(),
  });
  return { id, stored: "memory" };
}

export async function betaLeadStats(): Promise<{
  total: number;
  last_7d: number;
  by_status: Array<{ status: string; count: number }>;
  by_price: Array<{ price_interest: string; count: number }>;
  recent: BetaLeadRow[];
  storage: "database" | "memory";
}> {
  if (usingDatabase()) {
    const [totalRow, recent, byStatus, byPrice] = await Promise.all([
      one<{ total: number; last_7d: number }>(
        `select count(*)::int as total,
                count(*) filter (where created_at >= now() - interval '7 days')::int as last_7d
           from tripmoney.beta_leads`
      ),
      q<BetaLeadRow>(
        `select id,name,contact,trip_name,destination,group_size,trip_date,segment,price_interest,pain,source,status,created_at::text
           from tripmoney.beta_leads order by created_at desc limit 20`
      ),
      q<{ status: string; count: number }>(
        `select status, count(*)::int as count from tripmoney.beta_leads group by status order by count desc`
      ),
      q<{ price_interest: string; count: number }>(
        `select coalesce(price_interest,'미정') as price_interest, count(*)::int as count
           from tripmoney.beta_leads group by coalesce(price_interest,'미정') order by count desc`
      ),
    ]);
    return {
      total: totalRow?.total ?? 0,
      last_7d: totalRow?.last_7d ?? 0,
      by_status: byStatus,
      by_price: byPrice,
      recent,
      storage: "database",
    };
  }

  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const byStatusMap = new Map<string, number>();
  const byPriceMap = new Map<string, number>();
  memoryLeads.forEach((row) => {
    byStatusMap.set(row.status, (byStatusMap.get(row.status) ?? 0) + 1);
    byPriceMap.set(row.price_interest || "미정", (byPriceMap.get(row.price_interest || "미정") ?? 0) + 1);
  });
  return {
    total: memoryLeads.length,
    last_7d: memoryLeads.filter((row) => Date.parse(row.created_at) >= since).length,
    by_status: [...byStatusMap.entries()].map(([status, count]) => ({ status, count })),
    by_price: [...byPriceMap.entries()].map(([price_interest, count]) => ({ price_interest, count })),
    recent: memoryLeads.slice(0, 20),
    storage: "memory",
  };
}
