import { q, one, tx } from "./db.js";
import { toBase } from "./fx.js";
import {
  calculateSettlement,
  type ExpenseForCalc,
  type Member,
  type SettleMode,
} from "./settlement.js";
import {
  createShares,
  requireExpenseTripRefs,
  requireReadAccess,
  requireTripKey,
  requireWriteRole,
  tripBaseCurrency,
} from "./guards.js";
import type { ExpenseRow, MemberRow, ScheduleRow, TripRow } from "./types.js";
import {
  assertBase64Size,
  assertSafeImageUrl,
  isConfigured as ocrConfigured,
  runReceiptOcr,
  sniffImageFormat,
  stripDataUri,
} from "./ocr.js";
import { kakaoPayLink, settlementMessage, tossSendLink, type SettleTransferView } from "./links.js";
import { recordAuditEvent } from "./audit.js";
import { buildSettlementExport } from "./settlementExport.js";
import { validateCustomShareTotal } from "./validation.js";

export type MpcCreateTripInput = {
  name: string;
  base_currency?: string;
  start_date?: string | null;
  end_date?: string | null;
  members?: {
    name: string;
    role?: "owner" | "editor" | "viewer";
    bank_name?: string | null;
    account_no?: string | null;
  }[];
};

export type McpExpenseInput = {
  trip_id: string;
  title?: string;
  amount?: number;
  currency?: string;
  payer_member_id?: string | null;
  schedule_id?: string | null;
  pay_method?: "card" | "cash";
  exchange_rate?: number;
  spent_at?: string | null;
  note?: string | null;
  actor_member_id?: string | null;
  trip_key?: string | null;
  split_mode?: "equal" | "custom" | "payer";
  split_member_ids?: string[];
  custom_shares?: { member_id: string; amount: number }[];
  receipt_url?: string | null;
  receipt_image_base64?: string;
  image_format?: "jpg" | "jpeg" | "png" | "pdf" | "tiff";
};

export async function mcpCreateTrip(input: MpcCreateTripInput) {
  const apiKey = crypto.randomUUID().replace(/-/g, "");
  const trip = (await one<TripRow>(
    "insert into tripmoney.trips(name,base_currency,start_date,end_date,api_key) values ($1,$2,$3,$4,$5) returning *",
    [input.name, input.base_currency ?? "KRW", input.start_date ?? null, input.end_date ?? null, apiKey]
  ))!;
  const members: MemberRow[] = [];
  const list = input.members ?? [];
  for (let i = 0; i < list.length; i++) {
    const m = (await one<MemberRow>(
      "insert into tripmoney.members(trip_id,name,role,bank_name,account_no) values ($1,$2,$3,$4,$5) returning *",
      [trip.id, list[i].name, list[i].role ?? (i === 0 ? "owner" : "editor"), list[i].bank_name ?? null, list[i].account_no ?? null]
    ))!;
    members.push(m);
  }
  return { trip, members, trip_key: apiKey };
}

export async function mcpAddMember(input: {
  trip_id: string;
  name: string;
  role?: "owner" | "editor" | "viewer";
  bank_name?: string | null;
  account_no?: string | null;
  trip_key?: string | null;
}) {
  await requireTripKey(input.trip_id, input.trip_key);
  return tx(async (db) => {
    const member = (await db.one<MemberRow>(
      "insert into tripmoney.members(trip_id,name,role,bank_name,account_no) values ($1,$2,$3,$4,$5) returning *",
      [input.trip_id, input.name, input.role ?? "editor", input.bank_name ?? null, input.account_no ?? null]
    ))!;
    await recordAuditEvent(
      {
        trip_id: input.trip_id,
        action: "member.add",
        target_type: "member",
        target_id: member.id,
        payload: { surface: "web-mcp", name: input.name, role: input.role ?? "editor" },
      },
      db
    );
    return { member };
  });
}

export async function mcpAddSchedule(input: {
  trip_id: string;
  title: string;
  start_at?: string | null;
  end_at?: string | null;
  location?: string | null;
  lat?: number | null;
  lng?: number | null;
  planned_budget?: number;
  actor_member_id?: string | null;
  trip_key?: string | null;
}) {
  await requireTripKey(input.trip_id, input.trip_key);
  await requireWriteRole(input.actor_member_id, input.trip_id);
  const schedule = await tx(async (db) => {
    const row = (await db.one<ScheduleRow>(
      `insert into tripmoney.schedules(trip_id,title,start_at,end_at,location,lat,lng,planned_budget,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [
        input.trip_id,
        input.title,
        input.start_at ?? null,
        input.end_at ?? null,
        input.location ?? null,
        input.lat ?? null,
        input.lng ?? null,
        input.planned_budget ?? 0,
        input.actor_member_id ?? null,
      ]
    ))!;
    await recordAuditEvent(
      {
        trip_id: input.trip_id,
        actor_member_id: input.actor_member_id ?? null,
        action: "schedule.add",
        target_type: "schedule",
        target_id: row.id,
        payload: { surface: "web-mcp", title: input.title },
      },
      db
    );
    return row;
  });
  return { schedule };
}

export async function mcpAddExpense(input: McpExpenseInput, source: "manual" | "receipt" = "manual") {
  await requireTripKey(input.trip_id, input.trip_key);
  await requireWriteRole(input.actor_member_id, input.trip_id);
  if (!input.title) throw new Error("title is required");
  if (!Number.isFinite(input.amount) || Number(input.amount) <= 0) throw new Error("amount is required");

  const base = await tripBaseCurrency(input.trip_id);
  const currency = String(input.currency || base).toUpperCase();
  const { amount_base, exchange_rate } = await toBase(Number(input.amount), currency, base, input.exchange_rate);
  let scheduleId = input.schedule_id ?? null;
  if (!scheduleId && input.spent_at) {
    const matched = await one<{ id: string }>(
      `select id from tripmoney.schedules
       where trip_id=$1 and start_at is not null and end_at is not null
         and $2::timestamptz between start_at and end_at
       order by start_at limit 1`,
      [input.trip_id, input.spent_at]
    );
    if (matched) scheduleId = matched.id;
  }

  await requireExpenseTripRefs(input.trip_id, {
    payer_member_id: input.payer_member_id ?? undefined,
    schedule_id: scheduleId ?? undefined,
    split_member_ids: input.split_member_ids,
    custom_shares: input.custom_shares,
  });
  const splitMode = input.split_mode ?? "equal";
  if (splitMode === "custom") validateCustomShareTotal(input.custom_shares, amount_base);

  const exp = await tx(async (db) => {
    const inserted = (await db.one<ExpenseRow>(
      `insert into tripmoney.expenses(trip_id,schedule_id,payer_member_id,title,amount,currency,exchange_rate,amount_base,pay_method,receipt_url,source,note,spent_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,coalesce($13::timestamptz, now())) returning *`,
      [
        input.trip_id,
        scheduleId,
        input.payer_member_id ?? null,
        input.title,
        Number(input.amount),
        currency,
        exchange_rate,
        amount_base,
        input.pay_method ?? "card",
        input.receipt_url ?? null,
        source,
        input.note ?? null,
        input.spent_at ?? null,
      ]
    ))!;
    await createShares(db, input.trip_id, inserted.id, amount_base, splitMode, input.split_member_ids, input.custom_shares);
    await recordAuditEvent(
      {
        trip_id: input.trip_id,
        actor_member_id: input.actor_member_id ?? null,
        action: "expense.add",
        target_type: "expense",
        target_id: inserted.id,
        payload: {
          surface: "web-mcp",
          source,
          title: input.title,
          amount: Number(input.amount),
          currency,
          amount_base,
          schedule_id: scheduleId,
          split_mode: splitMode,
        },
      },
      db
    );
    return inserted;
  });
  return { expense: exp, base, currency, amount_base, exchange_rate, auto_matched_schedule: scheduleId };
}

export async function mcpScanReceipt(input: McpExpenseInput) {
  const args = { ...input };
  // 인증을 이미지 처리보다 먼저 수행: 잘못된 trip_key 로는 OCR(외부 fetch/과금)을 시작하지 않는다
  await requireTripKey(args.trip_id, args.trip_key);
  await requireWriteRole(args.actor_member_id, args.trip_id);
  const hasImage = !!(args.receipt_image_base64 || args.receipt_url);
  if (!hasImage && args.amount === undefined) {
    throw new Error("영수증 이미지 또는 amount 중 하나는 반드시 필요합니다.");
  }
  if (args.amount === undefined) {
    if (!ocrConfigured()) throw new Error("OCR 엔진이 설정되지 않았습니다. 금액을 직접 입력해 주세요.");
    let parsed;
    if (args.receipt_image_base64) {
      const b64 = stripDataUri(args.receipt_image_base64);
      assertBase64Size(b64);
      parsed = await runReceiptOcr({
        dataBase64: b64,
        format: args.image_format ?? sniffImageFormat(args.receipt_image_base64) ?? "jpg",
      });
    } else {
      assertSafeImageUrl(args.receipt_url!);
      parsed = await runReceiptOcr({ url: args.receipt_url!, format: args.image_format });
    }
    if (parsed.amount === undefined) throw new Error("영수증 이미지에서 금액을 인식하지 못했습니다.");
    args.amount = parsed.amount;
    args.title = args.title ?? parsed.merchant ?? "영수증 지출";
    if (!args.spent_at && parsed.date) args.spent_at = parsed.date;
  } else {
    // 금액 직접입력 시에도 첨부 이미지/URL 은 항상 검증 (대용량 base64 조기 거부)
    if (args.receipt_image_base64) assertBase64Size(stripDataUri(args.receipt_image_base64));
    if (args.receipt_url) assertSafeImageUrl(args.receipt_url);
  }
  return mcpAddExpense({ ...args, title: args.title ?? "영수증 지출" }, "receipt");
}

export async function mcpCalculateSettlement(input: {
  trip_id: string;
  mode?: SettleMode;
  trip_key?: string | null;
  share_token?: string | null;
}) {
  await requireReadAccess(input.trip_id, input.trip_key ?? input.share_token);
  const trip = await one<{ name: string; base_currency: string }>("select name,base_currency from tripmoney.trips where id=$1", [input.trip_id]);
  if (!trip) throw new Error("존재하지 않는 trip_id 입니다.");
  const members = await q<Member & { bank_name: string | null; account_no: string | null }>(
    "select id,name,bank_name,account_no from tripmoney.members where trip_id=$1 order by created_at",
    [input.trip_id]
  );
  if (!members.length) throw new Error("멤버가 없습니다.");
  const exps = await q<{ id: string; payer_member_id: string | null; amount_base: number }>(
    "select id,payer_member_id,amount_base::float as amount_base from tripmoney.expenses where trip_id=$1",
    [input.trip_id]
  );
  const shareRows = await q<{ expense_id: string; member_id: string; share_base: number }>(
    `select sh.expense_id, sh.member_id, sh.share_base::float as share_base
     from tripmoney.expense_shares sh join tripmoney.expenses e on e.id=sh.expense_id
     where e.trip_id=$1`,
    [input.trip_id]
  );
  const shareMap = new Map<string, { member_id: string; share_base: number }[]>();
  for (const s of shareRows) {
    if (!shareMap.has(s.expense_id)) shareMap.set(s.expense_id, []);
    shareMap.get(s.expense_id)!.push({ member_id: s.member_id, share_base: s.share_base });
  }
  const expenses: ExpenseForCalc[] = exps.map((e) => ({
    id: e.id,
    payer_member_id: e.payer_member_id,
    amount_base: e.amount_base,
    shares: shareMap.get(e.id) ?? [],
  }));
  const result = calculateSettlement(members, expenses, input.mode ?? "equal", trip.base_currency);
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const accOf = new Map(members.map((m) => [m.id, m]));
  const transfers_detail: SettleTransferView[] = result.transfers.map((t) => {
    const payee = accOf.get(t.to);
    return {
      from: nameOf.get(t.from) ?? t.from,
      to: nameOf.get(t.to) ?? t.to,
      amount: t.amount,
      toss_link: tossSendLink(t.amount, payee),
      kakaopay_link: kakaoPayLink(),
      payee_account: payee?.bank_name && payee?.account_no ? `${payee.bank_name} ${payee.account_no}` : null,
    };
  });
  const per_member = result.per_member.map((m) => ({ ...m, name: nameOf.get(m.member_id) }));
  let share_message = settlementMessage(trip.name, trip.base_currency, result.total, transfers_detail);
  if (result.excluded.count > 0) {
    share_message += `\n⚠️ 결제자 미지정 지출 ${result.excluded.count}건(${result.excluded.total.toLocaleString()} ${trip.base_currency})은 누가 냈는지 알 수 없어 정산에서 제외됐어요. 해당 비용에 payer_member_id 를 지정하면 정산에 포함됩니다.`;
  }
  const settlement_export = buildSettlementExport({
    tripName: trip.name,
    baseCurrency: trip.base_currency,
    mode: result.mode,
    total: result.total,
    perMember: per_member,
    transfers: transfers_detail,
  });
  return { ...result, per_member, transfers_detail, share_message, settlement_export };
}
