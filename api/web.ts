// 웹 프로토타입용 경량 REST API (기존 MCP 서버와 동일한 Supabase tripmoney 스키마 재사용)
// 라우팅: /api/web?action=...
//
// 테넌시 주의: 이 엔드포인트는 TRIPMONEY_WEB_DEMO_KEY 로 보호되는 *운영자 콘솔*이다.
// MCP 도구(lib/server.ts)와 달리 trip_key 검증을 거치지 않고 전체 여행방을 조회한다(의도된 특권 뷰).
// 멀티테넌트 격리는 MCP 표면(trip_key)에서 강제되며, 여기는 단일 운영자 전용으로만 노출할 것.
import type { IncomingMessage, ServerResponse } from "http";
import { q, one, tx } from "../lib/db.js";
import { toBase } from "../lib/fx.js";
import { calculateSettlement, splitEqually, type Member, type ExpenseForCalc, type SettleMode } from "../lib/settlement.js";
import { tossSendLink } from "../lib/links.js";
import {
  mcpAddExpense,
  mcpAddMember,
  mcpAddSchedule,
  mcpCalculateSettlement,
  mcpCreateTrip,
  mcpScanReceipt,
} from "../lib/mcpEngine.js";
import { recommendTripItinerary } from "../lib/itinerary.js";
import { handlePrototypeWeb, prototypeEnabled } from "../lib/prototypeStore.js";
import { validateExpenseTripRefs } from "../lib/validation.js";
import { recordAuditEvent } from "../lib/audit.js";
import { buildSettlementExport } from "../lib/settlementExport.js";
import {
  assertBase64Size,
  assertSafeImageUrl,
  isConfigured as ocrConfigured,
  runReceiptOcr,
  sniffImageFormat,
  stripDataUri,
} from "../lib/ocr.js";
import { betaLeadStats } from "../lib/betaLeads.js";

export const config = { api: { bodyParser: true } };

function send(res: ServerResponse, code: number, data: any) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(data));
}

function checkDemoAuth(req: IncomingMessage): boolean {
  const expected = process.env.TRIPMONEY_WEB_DEMO_KEY;
  // 키 미설정: 프로덕션에서는 fail-closed(전면 차단), 개발 환경에서만 통과 허용
  if (!expected) return process.env.NODE_ENV !== "production";
  const url = new URL(req.url || "", "http://x");
  const headerKey = req.headers["x-demo-key"];
  return headerKey === expected || url.searchParams.get("demo_key") === expected;
}

async function requireExpenseTripRefs(tripId: string, refs: { payer_member_id?: string | null; schedule_id?: string | null }) {
  const [memberRows, scheduleRows] = await Promise.all([
    q<{ id: string }>("select id from tripmoney.members where trip_id=$1", [tripId]),
    q<{ id: string }>("select id from tripmoney.schedules where trip_id=$1", [tripId]),
  ]);
  validateExpenseTripRefs(refs, {
    memberIds: new Set(memberRows.map((m) => m.id)),
    scheduleIds: new Set(scheduleRows.map((s) => s.id)),
  });
}

async function operatorTripKey(tripId: string): Promise<string | null> {
  const trip = await one<{ api_key: string | null }>("select api_key from tripmoney.trips where id=$1", [tripId]);
  if (!trip) throw new Error("not found");
  return trip.api_key;
}

async function matchScheduleByTime(tripId: string, spentAt?: string | null) {
  if (!spentAt) return null;
  return one<{ id: string; title: string }>(
    `select id, title from tripmoney.schedules
     where trip_id=$1 and start_at is not null and end_at is not null
       and $2::timestamptz between start_at and end_at
     order by start_at limit 1`,
    [tripId, spentAt]
  );
}

async function parseReceiptDraft(b: any, baseCurrency: string) {
  const hasImage = !!(b.receipt_image_base64 || b.receipt_url);
  let parsed: { amount?: number; currency?: string; merchant?: string; date?: string } = {};
  if (b.amount === undefined && hasImage) {
    if (!ocrConfigured()) {
      throw new Error("OCR 엔진이 설정되지 않았습니다. 금액을 직접 입력해 초안을 만들어 주세요.");
    }
    if (b.receipt_image_base64) {
      const b64 = stripDataUri(b.receipt_image_base64);
      assertBase64Size(b64);
      parsed = await runReceiptOcr({
        dataBase64: b64,
        format: b.image_format ?? sniffImageFormat(b.receipt_image_base64) ?? "jpg",
      });
    } else {
      assertSafeImageUrl(b.receipt_url);
      parsed = await runReceiptOcr({ url: b.receipt_url, format: b.image_format });
    }
  } else {
    // 금액 직접입력 시에도 첨부 이미지/URL 은 항상 검증 (대용량 base64 조기 거부)
    if (b.receipt_image_base64) assertBase64Size(stripDataUri(b.receipt_image_base64));
    if (b.receipt_url) assertSafeImageUrl(b.receipt_url);
  }

  const amount = Number(b.amount ?? parsed.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("영수증 금액을 인식하지 못했습니다. 금액을 직접 입력해 주세요.");
  }
  const currency = String(b.currency || parsed.currency || baseCurrency).toUpperCase();
  return {
    merchant: b.merchant || parsed.merchant || null,
    title: b.title || b.merchant || parsed.merchant || "영수증 지출",
    amount,
    currency,
    spent_at: b.spent_at || parsed.date || new Date().toISOString(),
    receipt_url: b.receipt_url || null,
    pay_method: b.pay_method || "card",
    payer_member_id: b.payer_member_id || null,
  };
}

export default async function handler(req: IncomingMessage & { body?: any }, res: ServerResponse) {
  try {
    const url = new URL(req.url || "", "http://x");
    const action = url.searchParams.get("action");
    const id = url.searchParams.get("id") || undefined;

    if (!checkDemoAuth(req)) {
      return send(res, 401, { error: "unauthorized" });
    }

    if (prototypeEnabled()) {
      const body = await handlePrototypeWeb(
        action,
        { method: req.method, body: { ...(req.body || {}), mode: url.searchParams.get("mode") || undefined } },
        id
      );
      if ("status" in body && "body" in body) {
        const response = body as { status: number; body: any };
        return send(res, response.status, response.body);
      }
      return send(res, 200, body);
    }

    if (action === "trips") {
      const rows = await q(
        `select t.id, t.name, t.base_currency,
                (select count(*) from tripmoney.members m where m.trip_id=t.id)::int as members,
                coalesce((select sum(e.amount_base) from tripmoney.expenses e where e.trip_id=t.id),0)::float as spent
         from tripmoney.trips t order by t.created_at desc limit 50`
      );
      return send(res, 200, { trips: rows });
    }

    if (action === "trip") {
      const trip = await one("select id,name,base_currency,start_date,end_date from tripmoney.trips where id=$1", [id]);
      if (!trip) return send(res, 404, { error: "not found" });
      const members = await q("select id,name,role,bank_name,account_no from tripmoney.members where trip_id=$1 order by created_at", [id]);
      const schedules = await q(
        `select s.id,s.title,s.start_at,s.end_at,s.location,s.planned_budget::float as planned,s.status,
                coalesce((select sum(e.amount_base) from tripmoney.expenses e where e.schedule_id=s.id),0)::float as actual
         from tripmoney.schedules s where s.trip_id=$1 order by s.start_at nulls last`, [id]);
      const expenses = await q(
        `select e.id,e.title,e.amount::float,e.currency,e.amount_base::float,e.pay_method,e.source,e.spent_at,
                e.payer_member_id, m.name as payer
         from tripmoney.expenses e left join tripmoney.members m on m.id=e.payer_member_id
         where e.trip_id=$1 order by e.spent_at desc limit 100`, [id]);
      const tot = await one("select coalesce(sum(amount_base),0)::float as total, count(*)::int as cnt from tripmoney.expenses where trip_id=$1", [id]);
      const byMethod = await q("select pay_method, sum(amount_base)::float as total from tripmoney.expenses where trip_id=$1 group by pay_method", [id]);
      return send(res, 200, { trip, members, schedules, expenses, total: (tot as any)?.total ?? 0, count: (tot as any)?.cnt ?? 0, byMethod });
    }

    if (action === "metrics") {
      const [tripTotals, expenseTotals, leads] = await Promise.all([
        one<{ trips: number; members: number }>(
          `select count(*)::int as trips,
                  coalesce((select count(*) from tripmoney.members),0)::int as members
             from tripmoney.trips`
        ),
        one<{ expenses: number; spent: number }>(
          `select count(*)::int as expenses, coalesce(sum(amount_base),0)::float as spent
             from tripmoney.expenses`
        ),
        betaLeadStats(),
      ]);
      return send(res, 200, {
        trips: tripTotals?.trips ?? 0,
        members: tripTotals?.members ?? 0,
        expenses: expenseTotals?.expenses ?? 0,
        spent: expenseTotals?.spent ?? 0,
        leads,
      });
    }

    if (action === "recommendItinerary" && req.method === "POST") {
      const b = req.body || {};
      const recommendation = recommendTripItinerary({
        destination: b.destination || b.trip_name || "여행지",
        start_date: b.start_date || null,
        end_date: b.end_date || null,
        days: b.days ? Number(b.days) : undefined,
        members_count: b.members_count ? Number(b.members_count) : undefined,
        interests: Array.isArray(b.interests) ? b.interests : String(b.interests || "").split(/[,，]/).map((x) => x.trim()).filter(Boolean),
        budget_level: b.budget_level || "mid",
        pace: b.pace || "balanced",
        base_currency: b.base_currency || "KRW",
      });
      const saved = [];
      if (b.trip_id && b.save_to_trip !== false) {
        const tripKey = await operatorTripKey(b.trip_id);
        for (const item of recommendation.schedules) {
          const r = await mcpAddSchedule({
            trip_id: b.trip_id,
            title: item.title,
            start_at: item.start_at,
            end_at: item.end_at,
            location: item.location,
            planned_budget: item.planned_budget,
            trip_key: tripKey,
          });
          saved.push(r.schedule);
        }
      }
      return send(res, 200, { ok: true, recommendation, saved_schedules: saved });
    }

    if (action === "settle") {
      const mode = (url.searchParams.get("mode") || "equal") as SettleMode;
      const r = await mcpCalculateSettlement({
        trip_id: id!,
        mode,
        trip_key: await operatorTripKey(id!),
      });
      const transfers = r.transfers_detail.map((t) => ({
        from: t.from,
        to: t.to,
        amount: t.amount,
        toss: t.toss_link,
        payee_account: t.payee_account,
      }));
      return send(res, 200, { ...r, transfers });
    }

    if (action === "expense" && req.method === "POST") {
      const b = req.body || {};
      const r = await mcpAddExpense({
        ...b,
        trip_key: await operatorTripKey(b.trip_id),
        amount: Number(b.amount),
      });
      return send(res, 200, { ok: true, amount_base: r.amount_base, exchange_rate: r.exchange_rate, currency: r.currency, base: r.base });
    }

    if (action === "receiptDraft" && req.method === "POST") {
      const b = req.body || {};
      const trip = await one<{ id: string; base_currency: string }>("select id, base_currency from tripmoney.trips where id=$1", [b.trip_id]);
      if (!trip) return send(res, 404, { error: "not found" });
      const draft = await parseReceiptDraft(b, trip.base_currency);
      const { amount_base, exchange_rate } = await toBase(draft.amount, draft.currency, trip.base_currency, b.exchange_rate);
      const matched = await matchScheduleByTime(trip.id, draft.spent_at);
      await requireExpenseTripRefs(trip.id, {
        payer_member_id: draft.payer_member_id,
        schedule_id: b.schedule_id || matched?.id || null,
      });
      return send(res, 200, {
        ok: true,
        draft: {
          ...draft,
          trip_id: trip.id,
          schedule_id: b.schedule_id || matched?.id || null,
          matched_schedule: matched,
          amount_base,
          exchange_rate,
          base: trip.base_currency,
          source: b.amount === undefined ? "ocr" : "manual-review",
        },
      });
    }

    if (action === "confirmReceipt" && req.method === "POST") {
      const b = req.body || {};
      const r = await mcpScanReceipt({
        ...b,
        trip_key: await operatorTripKey(b.trip_id),
        title: b.title || b.merchant || "영수증 지출",
        amount: Number(b.amount),
        note: b.merchant ? `reviewed receipt: ${b.merchant}` : "reviewed receipt",
      });
      return send(res, 200, {
        ok: true,
        amount_base: r.amount_base,
        exchange_rate: r.exchange_rate,
        currency: r.currency,
        base: r.base,
        schedule_id: r.auto_matched_schedule,
      });
    }

    if (action === "createTrip" && req.method === "POST") {
      const b = req.body || {};
      const inputMembers = Array.isArray(b.members) ? b.members.filter((m: any) => String(m?.name || "").trim()) : [];
      const created = await mcpCreateTrip({
        name: b.name || "새 여행",
        base_currency: b.base_currency || "KRW",
        start_date: b.start_date || null,
        end_date: b.end_date || null,
        members: inputMembers.map((m: any, i: number) => ({
          name: String(m.name).trim(),
          role: m.role || (i === 0 ? "owner" : "editor"),
          bank_name: m.bank_name || null,
          account_no: m.account_no || null,
        })),
      });
      return send(res, 200, { ok: true, id: created.trip.id, trip_key: created.trip_key });
    }

    if (action === "addMember" && req.method === "POST") {
      const b = req.body || {};
      const name = String(b.name || "").trim();
      if (!name) return send(res, 400, { error: "name required" });
      const member = await mcpAddMember({
        trip_id: b.trip_id,
        name,
        role: b.role || "editor",
        bank_name: b.bank_name || null,
        account_no: b.account_no || null,
        trip_key: await operatorTripKey(b.trip_id),
      });
      return send(res, 200, { ok: true, id: member.member.id });
    }

    if (action === "updateExpense" && req.method === "POST") {
      const b = req.body || {};
      const cur = await one<{ trip_id: string; currency: string; amount: number }>(
        "select trip_id, currency, amount::float as amount from tripmoney.expenses where id=$1", [b.expense_id]);
      if (!cur) return send(res, 404, { error: "not found" });
      const base = (await one<{ base_currency: string }>("select base_currency from tripmoney.trips where id=$1", [cur.trip_id]))?.base_currency || "KRW";
      await requireExpenseTripRefs(cur.trip_id, {
        payer_member_id: b.payer_member_id ?? null,
      });
      const recompute = b.amount !== undefined || b.currency !== undefined;
      const currency = (b.currency || cur.currency).toUpperCase();
      let amount_base: number | undefined, exchange_rate: number | undefined;
      if (recompute) ({ amount_base, exchange_rate } = await toBase(Number(b.amount ?? cur.amount), currency, base, b.exchange_rate));
      const exp = (await tx(async (db) => {
        const updated = (await db.one<{ id: string }>(
          `update tripmoney.expenses set
             title = coalesce($2, title),
             amount = coalesce($3, amount),
             currency = $4,
             pay_method = coalesce($5, pay_method),
             payer_member_id = coalesce($6, payer_member_id),
             exchange_rate = coalesce($7, exchange_rate),
             amount_base = coalesce($8, amount_base),
             updated_at = now()
           where id = $1 returning id`,
          [b.expense_id, b.title ?? null, b.amount ?? null, currency, b.pay_method ?? null, b.payer_member_id ?? null, exchange_rate ?? null, amount_base ?? null]))!;
        // 금액 변경 시 N빵 재배분(웹은 전원 균등)
        if (amount_base !== undefined) {
          const mids = (await db.q<{ id: string }>("select id from tripmoney.members where trip_id=$1", [cur.trip_id])).map((m) => m.id);
          await db.q("delete from tripmoney.expense_shares where expense_id=$1", [b.expense_id]);
          if (mids.length) {
            const parts = splitEqually(amount_base, mids.length);
            for (let i = 0; i < mids.length; i++) await db.q("insert into tripmoney.expense_shares(expense_id,member_id,share_base) values ($1,$2,$3)", [updated.id, mids[i], parts[i]]);
          }
        }
        await recordAuditEvent(
          {
            trip_id: cur.trip_id,
            action: "expense.update",
            target_type: "expense",
            target_id: updated.id,
            payload: { surface: "web", amount_base_after: amount_base ?? null },
          },
          db
        );
        return updated;
      }))!;
      return send(res, 200, { ok: true, id: exp.id, amount_base, exchange_rate });
    }

    if (action === "deleteExpense" && req.method === "POST") {
      const b = req.body || {};
      const del = await tx(async (db) => {
        const deleted = await db.one<{ id: string; trip_id: string }>("delete from tripmoney.expenses where id=$1 returning id, trip_id", [b.expense_id]);
        if (deleted) {
          await recordAuditEvent(
            {
              trip_id: deleted.trip_id,
              action: "expense.delete",
              target_type: "expense",
              target_id: deleted.id,
              payload: { surface: "web" },
            },
            db
          );
        }
        return deleted;
      });
      if (!del) return send(res, 404, { error: "not found" });
      return send(res, 200, { ok: true, deleted: del.id });
    }

    return send(res, 400, { error: "unknown action" });
  } catch (e: any) {
    return send(res, 500, { error: String(e?.message ?? e) });
  }
}
