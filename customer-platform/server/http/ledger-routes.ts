import type { IncomingMessage } from 'node:http';
import { IdentityError } from '../../core/contracts.js';
import { invalid } from '../../core/ledger/money.js';
import { ledgerId, normalizeLedgerCommand } from '../../core/ledger/normalize.js';
import type { AuthService } from '../auth/service.js';
import type { LedgerService } from '../ledger/contracts.js';
import type { HttpConfig } from './config.js';
import { cookieNames, readCookie } from './cookies.js';
import { AccountChanged } from './errors.js';
import { readJsonBody } from './json-body.js';

type LedgerRoute = { action: 'get' | 'execute'; tripId: string };

export function matchLedgerRoute(method: string | undefined, path: string): LedgerRoute | undefined {
  const match = /^\/api\/customer\/trips\/([^/]+)\/ledger(\/commands)?$/.exec(path);
  if (!match) return;
  const [, tripId, commands] = match;
  if (method === 'GET' && !commands) return { action: 'get', tripId: tripId! };
  if (method === 'POST' && commands) return { action: 'execute', tripId: tripId! };
}

export async function handleLedgerRoute(req: IncomingMessage, route: LedgerRoute, { authService, ledgerService, config }: {
  authService: AuthService; ledgerService: LedgerService; config: HttpConfig;
}) {
  const session = readCookie(req.headers.cookie, cookieNames(config).session);
  if (!session) throw new IdentityError('unauthenticated', '다시 로그인해 주세요.');
  const { actor } = await authService.authenticate(session);
  const expectedAccount = req.headers['x-tripmoney-expected-account'];
  if (expectedAccount !== undefined && expectedAccount !== actor.userId) throw new AccountChanged();

  const tripId = ledgerId(route.tripId, 'tripId');
  if (route.action === 'get') return { ledger: await ledgerService.get(actor, tripId) };

  const body = await readJsonBody(req);
  if (Object.keys(body).length !== 3 || !['command', 'expectedRevision', 'operationId'].every(key => Object.hasOwn(body, key))) {
    throw new IdentityError('validation', '입력 형식을 확인해 주세요.');
  }
  const { command, expectedRevision, operationId } = body;
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return invalid('expectedRevision');
  }
  return ledgerService.execute(actor, tripId, normalizeLedgerCommand(command), expectedRevision, ledgerId(operationId, 'operationId'));
}
