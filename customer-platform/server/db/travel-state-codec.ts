import { failure, type TravelState } from '../local/travel-state.js';

export type SerializedTravelState = {
  trips: unknown[]; members: unknown[]; invites: unknown[];
  receipts: unknown[]; audits: unknown[]; ledgers: unknown[];
};
export function encodeTravelState(state: TravelState): SerializedTravelState {
  return {trips:[...state.trips.values()],members:[...state.members.values()],invites:[...state.invites.values()],
    receipts:[...state.receipts],audits:state.audits,ledgers:[...state.ledgers]};
}
function record(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('unavailable');
  return value as Record<string,unknown>;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw failure('unavailable');
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw failure('unavailable');
  return value;
}
function entityMap(value: unknown): Map<string,unknown> {
  const result = new Map<string,unknown>();
  for (const item of rows(value)) {
    const key = id(record(item).id);
    if (result.has(key)) throw failure('unavailable');
    result.set(key,item);
  }
  return result;
}
function pairs(value: unknown): Map<string,unknown> {
  const result = new Map<string,unknown>();
  for (const pair of rows(value)) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || result.has(pair[0])) throw failure('unavailable');
    record(pair[1]); result.set(pair[0],pair[1]);
  }
  return result;
}
export function decodeTravelState(value: unknown): TravelState {
  const source = record(value);
  const state = {trips:entityMap(source.trips),members:entityMap(source.members),invites:entityMap(source.invites),
    receipts:pairs(source.receipts),audits:rows(source.audits),ledgers:pairs(source.ledgers)} as TravelState;
  for (const trip of state.trips.values()) {
    id(trip.ownerUserId);
    if (!Number.isSafeInteger(trip.revision) || trip.revision < 1 || trip.status !== 'active') throw failure('unavailable');
  }
  for (const member of state.members.values()) {
    id(member.userId);
    if (!state.trips.has(member.tripId) || !['owner','editor','viewer'].includes(member.role) || typeof member.active !== 'boolean') throw failure('unavailable');
  }
  for (const invite of state.invites.values()) {
    if (!state.trips.has(invite.tripId) || !['pending','accepted','revoked'].includes(invite.status) ||
        !['editor','viewer'].includes(invite.role)) throw failure('unavailable');
  }
  for (const [tripId,ledger] of state.ledgers) {
    if (!state.trips.has(tripId)) throw failure('unavailable');
    for (const field of ['items','expenses','snapshots','payments'] as const) rows(ledger[field]);
    record(ledger.fx);
  }
  for (const audit of state.audits) if (!state.trips.has(record(audit).tripId as string)) throw failure('unavailable');
  for (const receipt of state.receipts.values()) {
    if (!/^[0-9a-f]{64}$/.test(receipt.hash) || typeof record(receipt.result).replayed !== 'boolean') throw failure('unavailable');
  }
  return state;
}
