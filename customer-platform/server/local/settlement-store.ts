import { randomUUID } from 'node:crypto';
import { IdentityError, type Trip } from '../../core/contracts.js';
import type { LedgerCommand, LedgerSummary, PaymentDTO, SettlementDTO } from '../../core/ledger/contracts.js';
import { invalid, safeSum } from '../../core/ledger/money.js';
import { addExpenseBalance, calculateSettlement, emptyBalances } from '../../core/ledger/settlement.js';
import { occurredAt, tripClock } from '../../core/ledger/time.js';
import { failure, tripMembers, type LedgerRows, type TravelState } from './travel-state.js';

type Context = {s: TravelState; trip: Trip; rows: LedgerRows; memberId: string; at: string};
type PaymentCommand = Extract<LedgerCommand,{type:`payment.${string}`}>;
type SettlementCommand = Extract<LedgerCommand,{type:`settlement.${string}`}>;

function activeSnapshot(rows: LedgerRows, date: string | null) {
  return rows.snapshots.find(snapshot => snapshot.date === date && snapshot.reopenedAt === null);
}

export function assertExpenseUnlocked(rows: LedgerRows, ...dates: string[]) {
  if (activeSnapshot(rows,null) || dates.some(date => activeSnapshot(rows,date))) return invalid('settlementLocked');
}

function passedDailyTime(trip: Trip, at: string, date: string, wallTime: string): boolean {
  try {
    const cutoff = occurredAt(date+'T'+trip.dailyTime,trip.timeZone);
    return Date.parse(at) >= Date.parse(cutoff);
  } catch (error) {
    if (error instanceof IdentityError && error.code === 'validation' && error.field === 'occurredLocal') {
      return wallTime >= trip.dailyTime;
    }
    throw error;
  }
}

export function viewSettlement(trip: Trip, rows: LedgerRows, summary: LedgerSummary, at: string): SettlementDTO {
  const {date:today,time} = tripClock(at,trip.timeZone);
  const {settlementMode:mode,dailyTime} = trip;
  const balances = emptyBalances(summary.byMember.map(b => b.memberId));
  const expenses = rows.expenses.filter(e => e.status === 'active');
  const days: SettlementDTO['days'] = [];
  const end = Date.parse(trip.endDate+'T00:00:00Z');
  let cumulativeKrw = 0;
  for (let ms = Date.parse(trip.startDate+'T00:00:00Z'); ms <= end; ms += 86_400_000) {
    const date = new Date(ms).toISOString().slice(0,10);
    const spentKrw = summary.byDate.find(d => d.date === date)?.spentKrw ?? 0;
    cumulativeKrw = safeSum(cumulativeKrw,spentKrw);
    for (const expense of expenses) {
      if (expense.localDate === date) addExpenseBalance(balances,expense);
    }
    days.push({date,spentKrw,current:calculateSettlement(cumulativeKrw,balances.values(),rows.payments,date)});
  }
  const due = mode === 'daily' && today >= trip.startDate && today <= trip.endDate &&
    !activeSnapshot(rows,today) && !activeSnapshot(rows,null) && passedDailyTime(trip,at,today,time);
  return {mode,today,dailyTime,due,days,final:calculateSettlement(summary.spentKrw,summary.byMember,rows.payments,null),
    snapshots:rows.snapshots,payments:rows.payments};
}

export function writeSnapshot({s,trip,rows,memberId,at}: Context, {type,date}: SettlementCommand): string {
  const current = activeSnapshot(rows,date);
  if (date !== null && (trip.settlementMode !== 'daily' || activeSnapshot(rows,null))) throw failure('conflict');
  if (type === 'settlement.reopen') {
    if (!current) throw failure('conflict');
    current.reopenedAt = at;
    current.reopenedByMemberId = memberId;
    return current.id;
  }
  if (date !== null && (date < trip.startDate || date > trip.endDate || date > tripClock(at,trip.timeZone).date)) {
    return invalid('date');
  }
  if (current || rows.snapshots.length >= 64) throw failure('conflict');
  const balances = emptyBalances(tripMembers(s,trip.id).map(m => m.id));
  let spentKrw = 0;
  for (const expense of rows.expenses) {
    if (expense.status !== 'active' || (date !== null && expense.localDate > date)) continue;
    addExpenseBalance(balances,expense);
    spentKrw = safeSum(spentKrw,expense.amountKrw);
  }
  const id = randomUUID();
  rows.snapshots.push({id,date,sourceRevision:trip.revision,expenseRevision:rows.expenseRevision,
    confirmedPaymentRevision:rows.confirmedPaymentRevision,createdAt:at,createdByMemberId:memberId,
    result:calculateSettlement(spentKrw,balances.values(),rows.payments,date),reopenedAt:null,reopenedByMemberId:null});
  return id;
}

function forbidden(): never {
  throw new IdentityError('forbidden','이 작업을 할 권한이 없습니다.');
}

export function writePayment({s,trip,rows,memberId,at}: Context, cmd: PaymentCommand): string {
  const revision = trip.revision + 1;
  if (cmd.type === 'payment.report') {
    const recipient = s.members.get(cmd.toMemberId);
    if (!recipient?.active || recipient.tripId !== trip.id || recipient.role === 'viewer' || recipient.id === memberId) {
      return invalid('toMemberId');
    }
    if (rows.payments.length >= 256) throw failure('conflict');
    const id = randomUUID();
    rows.payments.push({id,fromMemberId:memberId,toMemberId:recipient.id,amountKrw:cmd.amountKrw,revision,status:'reported',
      reportedAt:at,confirmedAt:null,confirmedDate:null,voidRequestedByMemberId:null,voidRequestedAt:null,
      voidedAt:null,voidedByMemberId:null});
    return id;
  }
  const payment = rows.payments.find(p => p.id === cmd.id);
  if (!payment) throw failure('not_found');
  if (payment.fromMemberId !== memberId && payment.toMemberId !== memberId) return forbidden();
  if (payment.revision !== cmd.expectedPaymentRevision) throw failure('conflict');
  switch (cmd.type) {
    case 'payment.confirm':
      if (payment.toMemberId !== memberId) return forbidden();
      if (payment.status !== 'reported') throw failure('conflict');
      payment.status = 'confirmed';
      payment.confirmedAt = at;
      payment.confirmedDate = tripClock(at,trip.timeZone).date;
      rows.confirmedPaymentRevision = revision;
      break;
    case 'payment.requestVoid':
      if (payment.status === 'reported') {
        if (payment.fromMemberId !== memberId) return forbidden();
        voidPayment(payment,memberId,at);
        break;
      }
      if (payment.status !== 'confirmed') throw failure('conflict');
      payment.status = 'void_requested';
      payment.voidRequestedByMemberId = memberId;
      payment.voidRequestedAt = at;
      break;
    case 'payment.confirmVoid':
      if (payment.status !== 'void_requested') throw failure('conflict');
      if (payment.voidRequestedByMemberId === memberId) return forbidden();
      voidPayment(payment,memberId,at);
      rows.confirmedPaymentRevision = revision;
      break;
  }
  payment.revision = revision;
  return payment.id;
}

function voidPayment(payment: PaymentDTO, memberId: string, at: string) {
  payment.status = 'voided';
  payment.voidedAt = at;
  payment.voidedByMemberId = memberId;
}
