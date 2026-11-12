import { canonicalHash } from '../../core/token.js';
import { invalid } from '../../core/ledger/money.js';
import { ledgerId, normalizeLedgerCommand } from '../../core/ledger/normalize.js';
import type { LedgerRepository, LedgerService } from './contracts.js';

export function createLedgerService({repository}: {repository: LedgerRepository}): LedgerService {
  return {
    async get(actor, tripId) {
      return repository.get(actor,ledgerId(tripId,'tripId'));
    },
    async execute(actor, rawTripId, input, expectedRevision, rawOperationId) {
      const tripId = ledgerId(rawTripId,'tripId');
      // The repository checks the actor and membership before invoking this callback.
      return repository.execute(actor,tripId,() => {
        const command = normalizeLedgerCommand(input);
        const operationId = ledgerId(rawOperationId,'operationId');
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return invalid('expectedRevision');
        const hash = canonicalHash({tripId,command,expectedRevision});
        return {command,expectedRevision,operation:{operationId,hash}};
      });
    }
  };
}
