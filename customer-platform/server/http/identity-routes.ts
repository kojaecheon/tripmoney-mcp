import { createHmac } from 'node:crypto';
import {clientAddress} from './client-address.js';
import type { IncomingMessage } from 'node:http';
import { IdentityError } from '../../core/contracts.js';
import type { AuthService } from '../auth/service.js';
import type { IdentityService } from '../identity/contracts.js';
import type { HttpConfig } from './config.js';
import { cookieNames, readCookie } from './cookies.js';
import { AccountChanged, AcceptConflict } from './errors.js';
import { readJsonBody } from './json-body.js';

type Action = 'list' | 'create' | 'get' | 'update' | 'members' | 'manage' | 'invites' | 'issue' | 'link' | 'revoke' | 'inspect' | 'accept';
export type IdentityRoute = { action: Action; tripId?: string; memberId?: string; inviteId?: string };

export function matchIdentityRoute(method: string | undefined, path: string): IdentityRoute | undefined {
  if (path === '/api/customer/trips') {
    if (method === 'GET') return { action: 'list' };
    if (method === 'POST') return { action: 'create' };
  }
  if (method === 'POST' && path === '/api/customer/invites/inspect') return { action: 'inspect' };
  if (method === 'POST' && path === '/api/customer/invites/accept') return { action: 'accept' };
  const match = /^\/api\/customer\/trips\/([^/]+)(?:\/(members|invites)(?:\/([^/]+)(\/link)?)?)?$/.exec(path);
  if (!match) return;
  const [, tripId, collection, target, link] = match;
  if (!collection) {
    if (method === 'GET') return { action: 'get', tripId };
    if (method === 'PATCH') return { action: 'update', tripId };
  }
  if (collection === 'members' && !link) {
    if (method === 'GET' && !target) return { action: 'members', tripId };
    if (method === 'PATCH' && target) return { action: 'manage', tripId, memberId: target };
  }
  if (collection === 'invites') {
    if (!target && method === 'GET') return { action: 'invites', tripId };
    if (!target && method === 'POST') return { action: 'issue', tripId };
    if (target && !link && method === 'DELETE') return { action: 'revoke', tripId, inviteId: target };
    if (target && link && method === 'POST') return { action: 'link', tripId, inviteId: target };
  }
}

const invalid = (field?: string): never => { throw new IdentityError('validation', '입력 형식을 확인해 주세요.', field); };
const text = (value: unknown, field: string): string => typeof value === 'string' ? value : invalid(field);
const uuid = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) return invalid(field);
  return value.toLowerCase();
};
const revision = (value: unknown, field: string): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : invalid(field);
const budget = (value: unknown, field: string): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid(field);
const boolean = (value: unknown, field: string): boolean => typeof value === 'boolean' ? value : invalid(field);
const role = (value: unknown, field: string): 'editor' | 'viewer' => value === 'editor' || value === 'viewer' ? value : invalid(field);
const mode = (value: unknown, field: string): 'daily' | 'end_of_trip' => value === 'daily' || value === 'end_of_trip' ? value : invalid(field);
const settings = { name: text, destination: text, startDate: text, endDate: text, timeZone: text, budgetKrw: budget, settlementMode: mode, dailyTime: text };
const operation = { expectedRevision: revision, operationId: uuid };
type Parser = (value: unknown, field: string) => unknown;
async function body<T extends Record<string, Parser>>(req: IncomingMessage, schema: T): Promise<{ [K in keyof T]: ReturnType<T[K]> }> {
  const value = await readJsonBody(req);
  if (Object.keys(value).some(key => !Object.hasOwn(schema, key))) return invalid();
  const result: Record<string, unknown> = {};
  for (const [field, parse] of Object.entries(schema)) result[field] = parse(value[field], field);
  return result as { [K in keyof T]: ReturnType<T[K]> };
}

export async function handleIdentityRoute(req: IncomingMessage, route: IdentityRoute, { authService, identityService: service, config }: {
  authService: AuthService; identityService: IdentityService; config: HttpConfig;
}): Promise<unknown> {
  const session = readCookie(req.headers.cookie, cookieNames(config).session);
  if (!session) throw new IdentityError('unauthenticated', '다시 로그인해 주세요.');
  const { actor } = await authService.authenticate(session);
  const expectedAccount = req.headers['x-tripmoney-expected-account'];
  if (expectedAccount !== undefined && expectedAccount !== actor.userId) throw new AccountChanged();
  const tripId = route.tripId === undefined ? '' : uuid(route.tripId, 'tripId');
  const memberId = route.memberId === undefined ? '' : uuid(route.memberId, 'memberId');
  const inviteId = route.inviteId === undefined ? '' : uuid(route.inviteId, 'inviteId');
  switch (route.action) {
    case 'list': return { trips: await service.listTrips(actor) };
    case 'create': {
      const { operationId, ...input } = await body(req, { ...settings, alias: text, operationId: uuid });
      return service.createTrip(actor, input, operationId);
    }
    case 'get': return { trip: await service.getTrip(actor, tripId) };
    case 'update': {
      const { expectedRevision, operationId, ...input } = await body(req, { ...settings, ...operation });
      return service.updateTrip(actor, tripId, input, expectedRevision, operationId);
    }
    case 'members': return { members: await service.listMembers(actor, tripId) };
    case 'manage': {
      const input = await body(req, { role, active: boolean, ...operation });
      return service.manageMember(actor, tripId, memberId, input.role, input.active, input.expectedRevision, input.operationId);
    }
    case 'invites': return { invites: await service.listInvites(actor, tripId) };
    case 'issue': {
      const input = await body(req, { role, ...operation });
      return service.issueInvite(actor, tripId, input.role, input.expectedRevision, input.operationId);
    }
    case 'link': await body(req, {}); return service.getInviteLink(actor, tripId, inviteId);
    case 'revoke': {
      const input = await body(req, operation);
      return service.revokeInvite(actor, tripId, inviteId, input.expectedRevision, input.operationId);
    }
    case 'inspect': {
      const input = await body(req, { token: text });
      return service.inspectInvite(actor, input.token, clientHash(req, config));
    }
    case 'accept': {
      const input = await body(req, { token: text, alias: text, operationId: uuid });
      try { return await service.acceptInvite(actor, input.token, input.alias, input.operationId, clientHash(req, config)); }
      catch (error) {
        if (error instanceof IdentityError && error.code === 'conflict' && 'reason' in error &&
          (error.reason === 'alias_taken' || error.reason === 'member_limit')) throw new AcceptConflict(error.reason);
        throw error;
      }
    }
  }
}
function clientHash(req: IncomingMessage, config: HttpConfig): string {
  return createHmac('sha256', config.clientKey).update(`identity-client:${clientAddress(req,config)}`).digest('hex');
}
