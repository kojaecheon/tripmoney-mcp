import type { ExpenseInput, LedgerCommand, LedgerDTO, LedgerFx, ScheduleInput } from '../../core/ledger/contracts.js';
import type { TripDTO } from '../../server/identity/contracts.js';
import type { ChangesApi, LedgerApi } from '../api.mjs';
import type { PlaceRef } from '../../core/places/contracts.js';
import type { DraftDTO } from '../../core/drafts/contracts.js';

export type ScheduleDraft = Omit<ScheduleInput, 'budgetKrw'> & {budgetKrw: string};
export type ExpenseDraft = ExpenseInput;
export type FxDraft = Omit<LedgerFx, 'rateMilli'> & {rateMilli: string};
export type PaymentDraft = {toMemberId: string; amountKrw: string};
type SettlementAction = 'settlement.finalize' | 'settlement.reopen';
type PaymentAction = 'payment.confirm' | 'payment.requestVoid' | 'payment.confirmVoid';
export type LedgerFilters = {date: string; itineraryId: string; payerId: string};
export interface LedgerState {
  accountId: string | null;
  tripId: string | null;
  ledger: LedgerDTO | null;
  day: string;
  filters: LedgerFilters;
  canEdit: boolean;
  canSetFx: boolean;
  canSettle: boolean;
  settlementDate: string;
  settlementReview: {type: SettlementAction; date: string | null; revision: number; stale: boolean} | null;
  busy: 'load' | 'refresh' | 'write' | 'conflict' | null;
  error: {scope: string; code: string; field?: string; message: string} | null;
  status: string;
  scheduleDraft: ScheduleDraft;
  scheduleId: string | null;
  expenseDraft: ExpenseDraft;
  expenseId: string | null;
  fxDraft: FxDraft;
  paymentDraft: PaymentDraft;
  confirmation: {scope: 'schedule' | 'expense'; id: string; title: string; revision: number} | null;
  pendingKind: LedgerCommand['type'] | null;
  conflict: {
    type: LedgerCommand['type']; revision: number | null; latestChecked: boolean; freshAction: boolean;
    differences: {label: string; latest: string; proposed: string}[];
  } | null;
}
export interface LedgerController {
  readonly state: LedgerState;
  subscribe(listener: (state: LedgerState) => void): () => void;
  setContext(accountId: string | null, trip: TripDTO | null): Promise<boolean>;
  refresh(): Promise<boolean>;
  refreshConflict(): Promise<boolean>;
  resume(): Promise<boolean>;
  selectDay(date: string): void;
  selectSettlementDate(date: string): void;
  setFilter(field: keyof LedgerFilters, value: string): void;
  editSchedule(id?: string | null): void;
  applyPlace(candidate: {ref: PlaceRef; name: string}): boolean;
  applyDraft(draft: DraftDTO): boolean;
  editExpense(id?: string | null): void;
  addExpenseFor(id: string): void;
  setScheduleField<K extends keyof ScheduleDraft>(field: K, value: ScheduleDraft[K]): void;
  setExpenseField<K extends keyof ExpenseDraft>(field: K, value: ExpenseDraft[K]): void;
  setFxField<K extends keyof FxDraft>(field: K, value: FxDraft[K]): void;
  setPaymentField<K extends keyof PaymentDraft>(field: K, value: PaymentDraft[K]): void;
  saveSchedule(): Promise<boolean>;
  saveExpense(): Promise<boolean>;
  saveFx(): Promise<boolean>;
  savePayment(): Promise<boolean>;
  changeSettlement(type: SettlementAction, date: string | null): Promise<boolean>;
  reviewSettlement(type: SettlementAction, date: string | null): void;
  closeSettlementReview(): void;
  confirmSettlement(): Promise<boolean>;
  changePayment(type: PaymentAction, id: string, expectedPaymentRevision: number): Promise<boolean>;
  moveSchedule(id: string, offset: -1 | 1): Promise<boolean>;
  confirmCancel(scope: 'schedule' | 'expense', id: string | null): void;
  cancelConfirmed(): Promise<boolean>;
  retryPending(): Promise<boolean>;
  discardPending(): void;
  reapply(): Promise<boolean>;
  destroy(): void;
}
export function createLedgerController(api: LedgerApi, options?: {
  onUnauthorized?: () => void;
  onChanged?: (accountId: string, tripId: string, revision: number) => void;
  onUnavailable?: (accountId: string, tripId: string) => void;
  pollMs?: number;
  isVisible?: () => boolean;
}): LedgerController;
export function createTravelRefreshQueue(travel: {
  readonly state: {accountId: string | null; selectedTripId: string | null; busy: string | null};
  refresh(): Promise<boolean>;
}): {
  request(accountId: string, tripId: string): void;
  sync(): void;
  destroy(): void;
};

export interface TripChangesController {
  configure(enabled: boolean): void;
  setContext(context: {accountId: string | null; tripId: string | null; revision: number | null}): void;
  resume(): void;
  destroy(): void;
}
export function createTripChangesController(api: ChangesApi, options?: {
  onChanged?: (accountId: string, tripId: string, revision: number) => void;
  onUnavailable?: (accountId: string, tripId: string) => void;
  isVisible?: () => boolean;
  isOnline?: () => boolean;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (handle: any) => void;
}): TripChangesController;
