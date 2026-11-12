import { randomUUID } from 'node:crypto';
import { assertPermission } from '../../core/access.js';
import type { Actor, Trip } from '../../core/contracts.js';
import type { ExpenseDTO, ExpenseInput, LedgerCommand, LedgerDTO, LedgerSummary, ScheduleDTO, ScheduleInput } from '../../core/ledger/contracts.js';
import { allocateShares, amountCents, convertKrw, invalid, safeSum } from '../../core/ledger/money.js';
import { addExpenseBalance, emptyBalances } from '../../core/ledger/settlement.js';
import { occurredAt } from '../../core/ledger/time.js';
import type { TripSettings } from '../identity/contracts.js';
import type { LedgerRepository } from '../ledger/contracts.js';
import { assertExpenseUnlocked, viewSettlement, writePayment, writeSnapshot } from './settlement-store.js';
import { access, bump, expected, failure, replay, tripMembers,
  type LedgerRows, type LocalTravelState, type TravelState } from './travel-state.js';

function emptyRows(): LedgerRows {
  return {items:[], expenses:[], fx:{source:'demo',rateMilli:38600}, snapshots:[], payments:[],
    expenseRevision:0,confirmedPaymentRevision:0};
}
function inPeriod(date: string, trip: Pick<Trip,'startDate'|'endDate'>, field: string) {
  if (date < trip.startDate || date > trip.endDate) return invalid(field);
}
export function assertTravelSettings(s: TravelState, id: string, settings: TripSettings) {
  const rows = s.ledgers.get(id);
  if (!rows) return;
  const trip = s.trips.get(id)!;
  if (trip.timeZone !== settings.timeZone &&
      (rows.expenses.length || rows.snapshots.length || rows.payments.some(p => p.confirmedDate !== null))) {
    return invalid('timeZone');
  }
  for (const snapshot of rows.snapshots) {
    if (snapshot.reopenedAt !== null) continue;
    if (trip.settlementMode !== settings.settlementMode) return invalid('settlementMode');
    if (snapshot.date === null) {
      if (trip.startDate !== settings.startDate) return invalid('startDate');
      if (trip.endDate !== settings.endDate) return invalid('endDate');
    } else {
      inPeriod(snapshot.date,settings,snapshot.date < settings.startDate ? 'startDate' : 'endDate');
    }
  }
  for (const item of rows.items) {
    if (item.status === 'active') inPeriod(item.date,settings,item.date < settings.startDate ? 'startDate' : 'endDate');
  }
  for (const expense of rows.expenses) {
    if (expense.status === 'active') inPeriod(expense.localDate,settings,expense.localDate < settings.startDate ? 'startDate' : 'endDate');
  }
}

function summarize(trip: Trip, rows: LedgerRows, memberIds: string[]): LedgerSummary {
  const members = emptyBalances(memberIds);
  const amounts = new Map<string,number>(), dates = new Map<string,number>();
  let spentKrw = 0, unassignedKrw = 0, allocatedKrw = 0;
  for (const e of rows.expenses) {
    if (e.status === 'cancelled') continue;
    spentKrw = safeSum(spentKrw,e.amountKrw);
    dates.set(e.localDate,safeSum(dates.get(e.localDate) ?? 0,e.amountKrw));
    if (e.itineraryId) amounts.set(e.itineraryId,safeSum(amounts.get(e.itineraryId) ?? 0,e.amountKrw));
    else unassignedKrw = safeSum(unassignedKrw,e.amountKrw);

    addExpenseBalance(members,e);
  }
  const byItem = rows.items.map(i => {
    if (i.status === 'active') allocatedKrw = safeSum(allocatedKrw,i.budgetKrw);
    const spentKrw = amounts.get(i.id) ?? 0;
    return {itineraryId:i.id,budgetKrw:i.budgetKrw,spentKrw,remainingKrw:safeSum(i.budgetKrw,-spentKrw)};
  });
  const byMember = [...members.values()];
  for (const m of byMember) m.netKrw = safeSum(m.paidKrw,-m.owedKrw);
  if (safeSum(...byMember.map(m=>m.netKrw)) !== 0 ||
      safeSum(...byMember.map(m=>m.paidKrw)) !== spentKrw ||
      safeSum(...byMember.map(m=>m.owedKrw)) !== spentKrw) return invalid('splitIds');
  const byDate = [...dates].sort(([a],[b])=>a.localeCompare(b)).map(([date,spentKrw])=>({date,spentKrw}));
  return { allocatedKrw, spentKrw, remainingKrw:safeSum(trip.budgetKrw,-spentKrw), unassignedKrw, byItem, byDate, byMember };
}

type Context = {s: TravelState; trip: Trip; rows: LedgerRows; memberId: string; at: string};
function meta(c: Context) { return {updatedAt:c.at,updatedByMemberId:c.memberId}; }
function activeDay(c: Context, date: string) {
  return c.rows.items.filter(i => i.date === date && i.status === 'active').sort((a,b)=>a.order-b.order);
}
function setOrder(items: ScheduleDTO[], c: Context) {
  items.forEach((item,order) => {
    if (item.order !== order) Object.assign(item,{order},meta(c));
  });
}
function existing<T extends {id:string;status:string}>(rows: T[], id: string): T {
  const row = rows.find(r=>r.id===id);
  if (!row) throw failure('not_found');
  if (row.status !== 'active') throw failure('conflict');
  return row;
}
function writeSchedule(c: Context, input: ScheduleInput, id?: string) {
  inPeriod(input.date,c.trip,'date');
  if (!id) {
    if (c.rows.items.length >= 60) throw failure('conflict');
    const item: ScheduleDTO = {...input,id:randomUUID(),tripId:c.trip.id,status:'active',createdAt:c.at,
      ...meta(c),order:activeDay(c,input.date).length};
    c.rows.items.push(item);
    return item.id;
  }
  const item = existing(c.rows.items,id), oldDate = item.date;
  if (!Object.hasOwn(input,'placeRef') && item.placeRef && input.place !== item.place) item.placeRef = null;
  if (oldDate !== input.date) item.order = activeDay(c,input.date).length;
  Object.assign(item,input,meta(c));
  if (oldDate !== input.date) setOrder(activeDay(c,oldDate),c);
  return id;
}
function reorder(c: Context, date: string, ids: string[]) {
  inPeriod(date,c.trip,'date');
  const current = activeDay(c,date);
  if (current.length !== ids.length || current.some(i=>!ids.includes(i.id))) return invalid('ids');
  const byId = new Map(current.map(i=>[i.id,i]));
  setOrder(ids.map(id=>byId.get(id)!),c);
}
function checkExpenseRefs(c: Context, e: ExpenseInput, old?: ExpenseDTO) {
  if (e.itineraryId !== null) {
    const item = c.rows.items.find(i => i.id === e.itineraryId);
    if (!item || (item.status !== 'active' && old?.itineraryId !== item.id)) return invalid('itineraryId');
  }
  const allowed = (id: string, retained: boolean) => {
    const member = c.s.members.get(id);
    return member?.tripId === c.trip.id && (member.active || retained);
  };
  if (!allowed(e.payerId,old?.payerId === e.payerId)) return invalid('payerId');
  if (e.splitIds.some(id=>!allowed(id,old?.splitIds.includes(id) ?? false))) return invalid('splitIds');
}
function expenseRate(c: Context, e: ExpenseInput, old?: ExpenseDTO) {
  if (e.currency === 'KRW') return {rateMilli:1000,rateSource:'unit' as const};
  if (old?.currency === e.currency && !e.refreshRate) return {rateMilli:old.rateMilli,rateSource:old.rateSource};
  return {rateMilli:c.rows.fx.rateMilli,rateSource:c.rows.fx.source};
}
function writeExpense(c: Context, input: ExpenseInput, id?: string) {
  const old = id ? existing(c.rows.expenses,id) : undefined;
  const localDate = input.occurredLocal.slice(0,10);
  assertExpenseUnlocked(c.rows,old?.localDate ?? localDate,localDate);
  if (!old && c.rows.expenses.length >= 80) throw failure('conflict');
  checkExpenseRefs(c,input,old);
  const {amount,refreshRate,...fields} = input;
  inPeriod(localDate,c.trip,'occurredLocal');
  const utc = occurredAt(input.occurredLocal,c.trip.timeZone);
  const rate = expenseRate(c,input,old);
  const cents = amountCents(input.currency,amount), krw = convertKrw(cents,rate.rateMilli);
  const row: ExpenseDTO = {...fields,id:old?.id ?? randomUUID(),tripId:c.trip.id,status:'active',
    ...rate,amountCents:cents,amountKrw:krw,shares:allocateShares(krw,input.splitIds),localDate,
    timeZone:c.trip.timeZone,occurredAt:utc,createdAt:old?.createdAt ?? c.at,...meta(c)};
  if (old) Object.assign(old,row);
  else c.rows.expenses.push(row);
  return row.id;
}
function apply(c: Context, cmd: LedgerCommand): string | null {
  switch (cmd.type) {
    case 'schedule.create': return writeSchedule(c,cmd.input);
    case 'schedule.adopt': {
      let firstId: string | null = null;
      for (const input of cmd.inputs) {
        const id = writeSchedule(c,input);
        firstId ??= id;
      }
      return firstId;
    }
    case 'schedule.update': return writeSchedule(c,cmd.input,cmd.id);
    case 'schedule.cancel': {
      const item = existing(c.rows.items,cmd.id);
      Object.assign(item,{status:'cancelled'},meta(c));
      setOrder(activeDay(c,item.date),c);
      return item.id;
    }
    case 'schedule.reorder': reorder(c,cmd.date,cmd.ids); return null;
    case 'expense.create': return writeExpense(c,cmd.input);
    case 'expense.update': return writeExpense(c,cmd.input,cmd.id);
    case 'expense.cancel': {
      const e = existing(c.rows.expenses,cmd.id);
      assertExpenseUnlocked(c.rows,e.localDate);
      Object.assign(e,{status:'cancelled'},meta(c));
      return e.id;
    }
    case 'fx.update': c.rows.fx = {rateMilli:cmd.rateMilli,source:cmd.source}; return null;
    case 'settlement.finalize': case 'settlement.reopen': return writeSnapshot(c,cmd);
    case 'payment.report': case 'payment.confirm': case 'payment.requestVoid': case 'payment.confirmVoid':
      return writePayment(c,cmd);
  }
}
function dto(s: TravelState, actor: Actor, id: string, stamp: () => string): LedgerDTO {
  const {role} = access(s,actor,id);
  const trip = s.trips.get(id)!, rows = s.ledgers.get(id) ?? emptyRows();
  const members = tripMembers(s,id).map(({id,tripId,alias,role,active,userId}) => ({
    id,tripId,alias,role,active,isMe:userId === actor.userId
  }));
  const items = [...rows.items].sort((a,b)=>a.date.localeCompare(b.date) || a.status.localeCompare(b.status) ||
    a.order-b.order || a.id.localeCompare(b.id));
  const history = s.audits.filter(h=>h.tripId===id).slice(-30).reverse().map(({tripId,...entry})=>entry);
  const summary = summarize(trip,rows,members.map(m=>m.id));
  return {tripId:id,revision:trip.revision,role,startDate:trip.startDate,endDate:trip.endDate,timeZone:trip.timeZone,
    budgetKrw:trip.budgetKrw,fx:rows.fx,members,items,expenses:rows.expenses,history,summary,
    settlement:viewSettlement(trip,rows,summary,stamp())};
}
export function buildLedgerRepository(shared: LocalTravelState): LedgerRepository {
  return {
    get(actor,id) { return shared.read(actor,s=>dto(s,actor,id,shared.stamp)); },
    execute(actor,id,prepare) {
      let ownerOnly = false;
      const authorize = (s: TravelState) => {
        const member = access(s,actor,id,ownerOnly);
        assertPermission(member.role,'ledger:edit');
        return member;
      };
      return shared.write(actor,s=>{
        const member = authorize(s);
        const {command,expectedRevision,operation} = prepare();
        ownerOnly = command.type === 'fx.update' || command.type === 'settlement.finalize' || command.type === 'settlement.reopen';
        if (ownerOnly) assertPermission(member.role,'trip:update');
        const saved = replay<{targetId:string|null}>(s,actor,command.type,operation);
        if (saved) return saved;
        expected(s,id,expectedRevision);
        const rows = s.ledgers.get(id) ?? emptyRows();
        const trip = s.trips.get(id)!;
        const targetId = apply({s,trip,rows,memberId:member.id,at:shared.stamp()},command);
        if (command.type.startsWith('expense.')) rows.expenseRevision = trip.revision + 1;
        summarize(trip,rows,tripMembers(s,id).map(m=>m.id));
        s.ledgers.set(id,rows);
        bump(s,id);
        return shared.save(s,actor,command.type,operation,id,{targetId},targetId);
      },authorize);
    }
  };
}
