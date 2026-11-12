import type { ExpenseInput, ScheduleInput } from '../ledger/contracts.js';

export type DraftDTO = {
  tripId: string; baseRevision: number; kind: 'schedule' | 'expense';
  fields: Partial<ScheduleInput> | Partial<ExpenseInput>;
  missing: string[]; source: 'synthetic' | 'claude'; warnings: string[];
};
