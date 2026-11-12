import type { Change, Mode, Role } from '../contracts.js';
import type { MemberDTO } from '../../server/identity/contracts.js';
import type { PlaceRef } from '../places/contracts.js';

export type LedgerFx = { rateMilli: number; source: 'demo' | 'manual' };
export type ScheduleInput = {
  date: string; startTime: string; endTime: string; title: string; place: string; budgetKrw: number;
  placeRef?: PlaceRef | null;
};
type RecordMetadata = {
  id: string; tripId: string; status: 'active' | 'cancelled'; createdAt: string;
  updatedAt: string; updatedByMemberId: string;
};
export type ScheduleDTO = ScheduleInput & RecordMetadata & { order: number };
export type ExpenseInput = {
  itineraryId: string | null; title: string; occurredLocal: string; currency: 'KRW' | 'THB';
  amount: string; payerId: string; splitIds: string[]; refreshRate: boolean;
};
export type ExpenseShare = { memberId: string; amountKrw: number };
export type ExpenseDTO = Omit<ExpenseInput,'amount'|'refreshRate'> & RecordMetadata & {
  amountCents: number; amountKrw: number; rateMilli: number; rateSource: 'unit' | 'demo' | 'manual';
  occurredAt: string; localDate: string; timeZone: string; shares: ExpenseShare[];
};
export type LedgerCommand =
  | { type: 'schedule.create'; input: ScheduleInput }
  | { type: 'schedule.adopt'; inputs: ScheduleInput[] }
  | { type: 'schedule.update'; id: string; input: ScheduleInput }
  | { type: 'schedule.cancel'; id: string }
  | { type: 'schedule.reorder'; date: string; ids: string[] }
  | { type: 'expense.create'; input: ExpenseInput }
  | { type: 'expense.update'; id: string; input: ExpenseInput }
  | { type: 'expense.cancel'; id: string }
  | { type: 'settlement.finalize'; date: string | null }
  | { type: 'settlement.reopen'; date: string | null }
  | { type: 'payment.report'; toMemberId: string; amountKrw: number }
  | { type: 'payment.confirm'; id: string; expectedPaymentRevision: number }
  | { type: 'payment.requestVoid'; id: string; expectedPaymentRevision: number }
  | { type: 'payment.confirmVoid'; id: string; expectedPaymentRevision: number }
  | ({ type: 'fx.update' } & LedgerFx);
export type LedgerChange = Change<{ targetId: string | null }>;
export type LedgerHistory = {
  memberId: string; action: string; targetId: string | null; at: string; revision: number;
};
export type SettlementBalance = { memberId: string; paidKrw: number; owedKrw: number; netKrw: number };
export type SettlementResult = {
  spentKrw: number; balances: SettlementBalance[];
  transfers: { fromMemberId: string; toMemberId: string; amountKrw: number }[];
};
export type SettlementSnapshot = {
  id: string; date: string | null; sourceRevision: number; expenseRevision: number; confirmedPaymentRevision: number;
  createdAt: string; createdByMemberId: string;
  result: SettlementResult; reopenedAt: string | null; reopenedByMemberId: string | null;
};
export type PaymentDTO = {
  id: string; fromMemberId: string; toMemberId: string; amountKrw: number; revision: number;
  status: 'reported' | 'confirmed' | 'void_requested' | 'voided';
  reportedAt: string; confirmedAt: string | null; confirmedDate: string | null;
  voidRequestedByMemberId: string | null; voidRequestedAt: string | null;
  voidedAt: string | null; voidedByMemberId: string | null;
};
export type SettlementDTO = {
  mode: Mode; today: string; dailyTime: string; due: boolean;
  days: { date: string; spentKrw: number; current: SettlementResult }[];
  final: SettlementResult; snapshots: SettlementSnapshot[]; payments: PaymentDTO[];
};
export type LedgerSummary = {
  allocatedKrw: number; spentKrw: number; remainingKrw: number; unassignedKrw: number;
  byItem: { itineraryId: string; budgetKrw: number; spentKrw: number; remainingKrw: number }[];
  byDate: { date: string; spentKrw: number }[];
  byMember: SettlementBalance[];
};
export type LedgerDTO = {
  tripId: string; revision: number; role: Role; startDate: string; endDate: string; timeZone: string;
  budgetKrw: number; fx: LedgerFx; members: MemberDTO[]; items: ScheduleDTO[]; expenses: ExpenseDTO[];
  summary: LedgerSummary; history: LedgerHistory[]; settlement: SettlementDTO;
};
