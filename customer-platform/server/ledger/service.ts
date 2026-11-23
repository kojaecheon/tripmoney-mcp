import { canonicalHash } from '../../core/token.js';
import { IdentityError } from '../../core/contracts.js';
import { invalid } from '../../core/ledger/money.js';
import { ledgerId, normalizeLedgerCommand } from '../../core/ledger/normalize.js';
import type { LedgerRepository, LedgerService } from './contracts.js';

export function createLedgerService({repository, closureEnabled = true}: {repository: LedgerRepository; closureEnabled?: boolean}): LedgerService {
  return {
    async get(actor, tripId) {
      const ledger = await repository.get(actor,ledgerId(tripId,'tripId'));
      return closureEnabled ? ledger : {...ledger, settlement: {...ledger.settlement, canClose: false}};
    },
    async execute(actor, rawTripId, input, expectedRevision, rawOperationId) {
      const tripId = ledgerId(rawTripId,'tripId');
      // The repository checks the actor and membership before invoking this callback.
      return repository.execute(actor,tripId,() => {
        const command = normalizeLedgerCommand(input);
        if (!closureEnabled && command.type === 'settlement.close') {
          throw new IdentityError('unavailable','여행 정산 마감은 로컬 체험에서 사용할 수 있습니다.');
        }
        const operationId = ledgerId(rawOperationId,'operationId');
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return invalid('expectedRevision');
        const hash = canonicalHash({tripId,command,expectedRevision});
        return {command,expectedRevision,operation:{operationId,hash}};
      });
    }
  };
}
