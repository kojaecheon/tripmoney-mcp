import type { Actor } from '../../core/contracts.js';
import type { LedgerChange, LedgerCommand, LedgerDTO } from '../../core/ledger/contracts.js';
import type { Awaitable, Operation } from '../identity/contracts.js';

export interface LedgerService {
  get(actor: Actor, tripId: string): Promise<LedgerDTO>;
  execute(actor: Actor, tripId: string, command: LedgerCommand, expectedRevision: number, operationId: string): Promise<LedgerChange>;
}
export interface PreparedCommand {
  command: LedgerCommand; expectedRevision: number; operation: Operation;
}
export interface LedgerRepository {
  get(actor: Actor, tripId: string): Awaitable<LedgerDTO>;
  execute(actor: Actor, tripId: string, prepare: () => PreparedCommand): Awaitable<LedgerChange>;
}
