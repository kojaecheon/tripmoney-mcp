import { IdentityError, type TripInput } from './contracts.js';

function invalid(field: string): never {
  throw new IdentityError('validation', '입력 내용을 확인해 주세요.', field);
}

function text(value: unknown, max: number, field: string, nfc = false): string {
  if (typeof value !== 'string') return invalid(field);
  const clean = (nfc ? value.normalize('NFC') : value).trim();
  if (!clean || [...clean].length > max || /[\u0000-\u001f\u007f]/u.test(clean)) {
    return invalid(field);
  }
  return clean;
}

export function normalizeAlias(value: string): string {
  return text(value, 40, 'alias', true);
}

export function assertInviteRole(value: unknown): 'editor' | 'viewer' {
  if (value !== 'editor' && value !== 'viewer') return invalid('role');
  return value;
}

function day(value: unknown, field: string): number {
  if (typeof value !== 'string' || value.length !== 10 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return invalid(field);
  const ms = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return invalid(field);
  return ms;
}

const tripFields = new Set([
  'name', 'destination', 'startDate', 'endDate', 'timeZone',
  'budgetKrw', 'alias', 'settlementMode', 'dailyTime',
]);

export function normalizeTrip(input: TripInput): TripInput {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).some(key => !tripFields.has(key))) return invalid('trip');

  const start = day(input.startDate, 'startDate');
  const end = day(input.endDate, 'endDate');
  if (end < start || end - start > 13 * 86400000) return invalid('endDate');

  // Node 22의 Intl은 고정 오프셋도 받지만, 제품 계약은 IANA 이름만 허용한다.
  if (typeof input.timeZone !== 'string' || !input.timeZone || input.timeZone.length > 100 ||
      /^[+-]/.test(input.timeZone)) return invalid('timeZone');
  let timeZone: string;
  try {
    timeZone = new Intl.DateTimeFormat('ko', { timeZone: input.timeZone }).resolvedOptions().timeZone;
  } catch {
    return invalid('timeZone');
  }

  if (!Number.isSafeInteger(input.budgetKrw) || input.budgetKrw < 0) return invalid('budgetKrw');
  if (input.settlementMode !== 'daily' && input.settlementMode !== 'end_of_trip') {
    return invalid('settlementMode');
  }
  if (typeof input.dailyTime !== 'string' || input.dailyTime.length !== 5 ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.dailyTime)) return invalid('dailyTime');

  return {
    name: text(input.name, 80, 'name'), destination: text(input.destination, 100, 'destination'),
    startDate: input.startDate, endDate: input.endDate, timeZone, budgetKrw: input.budgetKrw,
    alias: normalizeAlias(input.alias), settlementMode: input.settlementMode, dailyTime: input.dailyTime,
  };
}
