import { calculateSettlement, splitEqually, type ExpenseForCalc, type Member } from "./settlement.js";
import { tossSendLink } from "./links.js";
import { buildSettlementExport } from "./settlementExport.js";
import { betaLeadStats } from "./betaLeads.js";
import { recommendTripItinerary } from "./itinerary.js";

type Trip = {
  id: string;
  name: string;
  base_currency: string;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
};

type MemberRow = Member & {
  trip_id: string;
  role: "owner" | "editor" | "viewer";
  bank_name: string | null;
  account_no: string | null;
  created_at: string;
};

type Schedule = {
  id: string;
  trip_id: string;
  title: string;
  start_at: string | null;
  end_at: string | null;
  location: string | null;
  planned_budget: number;
  status: "planned" | "ongoing" | "done" | "canceled";
};

type Expense = {
  id: string;
  trip_id: string;
  schedule_id: string | null;
  payer_member_id: string | null;
  title: string;
  amount: number;
  currency: string;
  exchange_rate: number;
  amount_base: number;
  pay_method: "card" | "cash";
  source: "manual" | "receipt";
  spent_at: string;
};

type Share = { expense_id: string; member_id: string; share_base: number };

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const round = (n: number) => Math.round(n * 100) / 100;

const trips: Trip[] = [
  {
    id: "trip_bangkok",
    name: "방콕 3박 4일",
    base_currency: "KRW",
    start_date: "2026-07-01",
    end_date: "2026-07-04",
    created_at: now(),
  },
];

const members: MemberRow[] = [
  { id: "mem_minsu", trip_id: "trip_bangkok", name: "민수", role: "owner", bank_name: "토스뱅크", account_no: "100012341234", created_at: now() },
  { id: "mem_jiyoung", trip_id: "trip_bangkok", name: "지영", role: "editor", bank_name: "카카오뱅크", account_no: "3333123412345", created_at: now() },
  { id: "mem_hyunwoo", trip_id: "trip_bangkok", name: "현우", role: "editor", bank_name: null, account_no: null, created_at: now() },
];

const schedules: Schedule[] = [
  { id: "sch_spa", trip_id: "trip_bangkok", title: "오아시스 스파", start_at: "2026-07-01T14:00:00+09:00", end_at: "2026-07-01T16:00:00+09:00", location: "Sukhumvit", planned_budget: 100000, status: "planned" },
  { id: "sch_dinner", trip_id: "trip_bangkok", title: "쩟페어 야시장", start_at: "2026-07-01T19:00:00+09:00", end_at: "2026-07-01T21:30:00+09:00", location: "Jodd Fairs", planned_budget: 85000, status: "planned" },
];

const expenses: Expense[] = [
  { id: "exp_spa", trip_id: "trip_bangkok", schedule_id: "sch_spa", payer_member_id: "mem_minsu", title: "스파 예약금", amount: 2000, currency: "THB", exchange_rate: 38.5, amount_base: 77000, pay_method: "card", source: "manual", spent_at: "2026-07-01T15:00:00+09:00" },
  { id: "exp_taxi", trip_id: "trip_bangkok", schedule_id: null, payer_member_id: "mem_jiyoung", title: "공항 택시", amount: 900, currency: "THB", exchange_rate: 38.5, amount_base: 34650, pay_method: "cash", source: "receipt", spent_at: "2026-07-01T12:00:00+09:00" },
];

const shares: Share[] = [];
for (const expense of expenses) {
  const tripMembers = members.filter((m) => m.trip_id === expense.trip_id);
  const parts = splitEqually(expense.amount_base, tripMembers.length); // 공유 N빵 (잔차 손실 없음)
  tripMembers.forEach((member, i) => {
    shares.push({ expense_id: expense.id, member_id: member.id, share_base: parts[i] });
  });
}

function tripSummary(t: Trip) {
  const tripMembers = members.filter((m) => m.trip_id === t.id).length;
  const spent = expenses
    .filter((e) => e.trip_id === t.id)
    .reduce((sum, e) => sum + e.amount_base, 0);
  return { id: t.id, name: t.name, base_currency: t.base_currency, members: tripMembers, spent: round(spent) };
}

function matchSchedule(tripId: string, spentAt?: string | null) {
  if (!spentAt) return null;
  const ts = Date.parse(spentAt);
  if (!Number.isFinite(ts)) return null;
  return schedules.find((s) => {
    if (s.trip_id !== tripId || !s.start_at || !s.end_at) return false;
    return Date.parse(s.start_at) <= ts && ts <= Date.parse(s.end_at);
  }) ?? null;
}

function addPrototypeReceiptExpense(b: any, trip: Trip, scheduleId: string | null) {
  const amount = Number(b.amount);
  const currency = String(b.currency || trip.base_currency).toUpperCase();
  const exchange_rate = Number(b.exchange_rate || (currency === "KRW" ? 1 : 38.5));
  const amount_base = round(amount * exchange_rate);
  const exp: Expense = {
    id: id("exp"),
    trip_id: trip.id,
    schedule_id: scheduleId,
    payer_member_id: b.payer_member_id || null,
    title: b.title || b.merchant || "영수증 지출",
    amount,
    currency,
    exchange_rate,
    amount_base,
    pay_method: b.pay_method || "card",
    source: "receipt",
    spent_at: b.spent_at || now(),
  };
  expenses.push(exp);
  const tripMembers = members.filter((m) => m.trip_id === trip.id);
  const parts = splitEqually(amount_base, Math.max(tripMembers.length, 1));
  tripMembers.forEach((member, i) => shares.push({ expense_id: exp.id, member_id: member.id, share_base: parts[i] }));
  return { exp, amount_base, exchange_rate, currency };
}

export function prototypeEnabled() {
  return process.env.TRIPMONEY_PROTOTYPE_MODE === "mock" || !process.env.DATABASE_URL;
}

export async function handlePrototypeWeb(action: string | null, req: { method?: string; body?: any }, tripId?: string) {
  if (action === "trips") return { trips: trips.map(tripSummary), prototype: true };

  if (action === "metrics") {
    const spent = round(expenses.reduce((sum, e) => sum + e.amount_base, 0));
    return {
      trips: trips.length,
      members: members.length,
      expenses: expenses.length,
      spent,
      leads: await betaLeadStats(),
      prototype: true,
    };
  }

  if (action === "recommendItinerary" && req.method === "POST") {
    const b = req.body || {};
    const trip = trips.find((t) => t.id === b.trip_id);
    if (!trip) return { status: 404, body: { error: "not found" } };
    const tripMembers = members.filter((m) => m.trip_id === trip.id);
    const recommendation = recommendTripItinerary({
      destination: b.destination || trip.name.replace(/\s*\d+박.*$/, "") || trip.name,
      start_date: b.start_date || trip.start_date,
      end_date: b.end_date || trip.end_date,
      days: b.days ? Number(b.days) : undefined,
      members_count: b.members_count ? Number(b.members_count) : tripMembers.length,
      interests: Array.isArray(b.interests)
        ? b.interests
        : String(b.interests || "맛집,카페,관광,쇼핑").split(/[,，]/).map((x) => x.trim()).filter(Boolean),
      budget_level: b.budget_level || "mid",
      pace: b.pace || "balanced",
      base_currency: trip.base_currency,
    });
    const saved: Schedule[] = [];
    for (const item of recommendation.schedules) {
      const schedule: Schedule = {
        id: id("sch"),
        trip_id: trip.id,
        title: item.title,
        start_at: item.start_at,
        end_at: item.end_at,
        location: item.location,
        planned_budget: item.planned_budget,
        status: "planned",
      };
      schedules.push(schedule);
      saved.push(schedule);
    }
    return { ok: true, recommendation, saved_schedules: saved, prototype: true };
  }

  if (action === "trip") {
    const trip = trips.find((t) => t.id === tripId);
    if (!trip) return { status: 404, body: { error: "not found" } };
    const tripMembers = members.filter((m) => m.trip_id === trip.id);
    const tripSchedules = schedules
      .filter((s) => s.trip_id === trip.id)
      .map((s) => ({
        id: s.id,
        title: s.title,
        start_at: s.start_at,
        end_at: s.end_at,
        location: s.location,
        planned: s.planned_budget,
        status: s.status,
        actual: round(expenses.filter((e) => e.schedule_id === s.id).reduce((sum, e) => sum + e.amount_base, 0)),
      }));
    const tripExpenses = expenses
      .filter((e) => e.trip_id === trip.id)
      .map((e) => ({ ...e, payer: tripMembers.find((m) => m.id === e.payer_member_id)?.name ?? null }))
      .sort((a, b) => b.spent_at.localeCompare(a.spent_at));
    const total = round(tripExpenses.reduce((sum, e) => sum + e.amount_base, 0));
    const byMethod = ["card", "cash"].map((pay_method) => ({
      pay_method,
      total: round(tripExpenses.filter((e) => e.pay_method === pay_method).reduce((sum, e) => sum + e.amount_base, 0)),
    }));
    return { trip, members: tripMembers, schedules: tripSchedules, expenses: tripExpenses, total, count: tripExpenses.length, byMethod, prototype: true };
  }

  if (action === "settle") {
    const trip = trips.find((t) => t.id === tripId);
    if (!trip) return { status: 404, body: { error: "not found" } };
    const tripMembers = members.filter((m) => m.trip_id === trip.id);
    const mode = req.body?.mode ?? "equal";
    const efc: ExpenseForCalc[] = expenses
      .filter((e) => e.trip_id === trip.id)
      .map((e) => ({
        id: e.id,
        payer_member_id: e.payer_member_id,
        amount_base: e.amount_base,
        shares: shares.filter((s) => s.expense_id === e.id).map((s) => ({ member_id: s.member_id, share_base: s.share_base })),
      }));
    const result = calculateSettlement(tripMembers, efc, mode, trip.base_currency);
    const nameOf = new Map(tripMembers.map((m) => [m.id, m.name]));
    const accOf = new Map(tripMembers.map((m) => [m.id, m]));
    const perMember = result.per_member.map((m) => ({ ...m, name: nameOf.get(m.member_id) }));
    const transfers = result.transfers.map((t) => {
      const payee = accOf.get(t.to);
      const payee_account = payee?.bank_name && payee?.account_no ? `${payee.bank_name} ${payee.account_no}` : null;
      const toss = tossSendLink(t.amount, payee); // lib/links 공유
      return { from: nameOf.get(t.from) ?? t.from, to: nameOf.get(t.to) ?? t.to, amount: t.amount, toss, payee_account };
    });
    return {
      ...result,
      per_member: perMember,
      transfers,
      settlement_export: buildSettlementExport({
        tripName: trip.name,
        baseCurrency: result.base_currency,
        mode: result.mode,
        total: result.total,
        perMember,
        transfers,
      }),
      prototype: true,
    };
  }

  if (action === "expense" && req.method === "POST") {
    const b = req.body || {};
    const trip = trips.find((t) => t.id === b.trip_id);
    if (!trip) return { status: 404, body: { error: "not found" } };
    const amount = Number(b.amount);
    const currency = String(b.currency || trip.base_currency).toUpperCase();
    const exchange_rate = Number(b.exchange_rate || (currency === "KRW" ? 1 : 38.5));
    const amount_base = round(amount * exchange_rate);
    const exp: Expense = {
      id: id("exp"),
      trip_id: trip.id,
      schedule_id: b.schedule_id || null,
      payer_member_id: b.payer_member_id || null,
      title: b.title || "새 비용",
      amount,
      currency,
      exchange_rate,
      amount_base,
      pay_method: b.pay_method || "card",
      source: "manual",
      spent_at: now(),
    };
    expenses.push(exp);
    const tripMembers = members.filter((m) => m.trip_id === trip.id);
    const parts = splitEqually(amount_base, Math.max(tripMembers.length, 1)); // 공유 N빵
    tripMembers.forEach((member, i) => shares.push({ expense_id: exp.id, member_id: member.id, share_base: parts[i] }));
    return { ok: true, amount_base, exchange_rate, currency, base: trip.base_currency, prototype: true };
  }

  if (action === "receiptDraft" && req.method === "POST") {
    const b = req.body || {};
    const trip = trips.find((t) => t.id === b.trip_id);
    if (!trip) return { status: 404, body: { error: "not found" } };
    const spent_at = b.spent_at || "2026-07-01T19:30:00+09:00";
    const matched = b.schedule_id ? schedules.find((s) => s.id === b.schedule_id && s.trip_id === trip.id) ?? null : matchSchedule(trip.id, spent_at);
    const currency = String(b.currency || "THB").toUpperCase();
    const amount = Number(b.amount || 1280);
    const exchange_rate = Number(b.exchange_rate || (currency === "KRW" ? 1 : 38.5));
    return {
      ok: true,
      draft: {
        trip_id: trip.id,
        merchant: b.merchant || "Jodd Fairs Night Market",
        title: b.title || b.merchant || "야시장 저녁",
        amount,
        currency,
        amount_base: round(amount * exchange_rate),
        exchange_rate,
        base: trip.base_currency,
        spent_at,
        receipt_url: b.receipt_url || null,
        pay_method: b.pay_method || "card",
        payer_member_id: b.payer_member_id || members.find((m) => m.trip_id === trip.id)?.id || null,
        schedule_id: matched?.id || null,
        matched_schedule: matched ? { id: matched.id, title: matched.title } : null,
        source: "mock-ocr",
      },
      prototype: true,
    };
  }

  if (action === "confirmReceipt" && req.method === "POST") {
    const b = req.body || {};
    const trip = trips.find((t) => t.id === b.trip_id);
    if (!trip) return { status: 404, body: { error: "not found" } };
    const matched = b.schedule_id ? null : matchSchedule(trip.id, b.spent_at);
    const scheduleId = b.schedule_id || matched?.id || null;
    const r = addPrototypeReceiptExpense(b, trip, scheduleId);
    return { ok: true, amount_base: r.amount_base, exchange_rate: r.exchange_rate, currency: r.currency, base: trip.base_currency, schedule_id: scheduleId, prototype: true };
  }

  if (action === "createTrip" && req.method === "POST") {
    const b = req.body || {};
    const trip: Trip = { id: id("trip"), name: b.name || "새 여행", base_currency: b.base_currency || "KRW", start_date: null, end_date: null, created_at: now() };
    trips.unshift(trip);
    const inputMembers = Array.isArray(b.members) ? b.members.filter((m: any) => String(m?.name || "").trim()) : [];
    for (let i = 0; i < inputMembers.length; i++) {
      const m = inputMembers[i];
      members.push({
        id: id("mem"),
        trip_id: trip.id,
        name: String(m.name).trim(),
        role: m.role || (i === 0 ? "owner" : "editor"),
        bank_name: m.bank_name || null,
        account_no: m.account_no || null,
        created_at: now(),
      });
    }
    return { ok: true, id: trip.id, prototype: true };
  }

  if (action === "addMember" && req.method === "POST") {
    const b = req.body || {};
    const trip = trips.find((t) => t.id === b.trip_id);
    if (!trip) return { status: 404, body: { error: "not found" } };
    const name = String(b.name || "").trim();
    if (!name) return { status: 400, body: { error: "name required" } };
    const member: MemberRow = {
      id: id("mem"),
      trip_id: trip.id,
      name,
      role: b.role || "editor",
      bank_name: b.bank_name || null,
      account_no: b.account_no || null,
      created_at: now(),
    };
    members.push(member);
    return { ok: true, id: member.id, prototype: true };
  }

  if (action === "updateExpense" && req.method === "POST") {
    const b = req.body || {};
    const exp = expenses.find((e) => e.id === b.expense_id);
    if (!exp) return { status: 404, body: { error: "not found" } };
    const trip = trips.find((t) => t.id === exp.trip_id)!;
    if (b.title !== undefined) exp.title = b.title;
    if (b.pay_method !== undefined) exp.pay_method = b.pay_method;
    if (b.payer_member_id !== undefined) exp.payer_member_id = b.payer_member_id;
    const recompute = b.amount !== undefined || b.currency !== undefined;
    if (recompute) {
      exp.amount = Number(b.amount ?? exp.amount);
      exp.currency = String(b.currency || exp.currency).toUpperCase();
      exp.exchange_rate = Number(b.exchange_rate || (exp.currency === "KRW" ? 1 : 38.5));
      exp.amount_base = round(exp.amount * exp.exchange_rate);
      // N빵 재배분
      for (let i = shares.length - 1; i >= 0; i--) if (shares[i].expense_id === exp.id) shares.splice(i, 1);
      const tripMembers = members.filter((m) => m.trip_id === trip.id);
      const parts = splitEqually(exp.amount_base, Math.max(tripMembers.length, 1));
      tripMembers.forEach((m, i) => shares.push({ expense_id: exp.id, member_id: m.id, share_base: parts[i] }));
    }
    return { ok: true, id: exp.id, amount_base: exp.amount_base, exchange_rate: exp.exchange_rate, prototype: true };
  }

  if (action === "deleteExpense" && req.method === "POST") {
    const b = req.body || {};
    const idx = expenses.findIndex((e) => e.id === b.expense_id);
    if (idx < 0) return { status: 404, body: { error: "not found" } };
    expenses.splice(idx, 1);
    for (let i = shares.length - 1; i >= 0; i--) if (shares[i].expense_id === b.expense_id) shares.splice(i, 1);
    return { ok: true, deleted: b.expense_id, prototype: true };
  }

  return { status: 400, body: { error: "unknown action" } };
}
