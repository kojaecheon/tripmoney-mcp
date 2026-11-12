import { IdentityError, type Actor } from '../../core/contracts.js';
import type { DraftDTO } from '../../core/drafts/contracts.js';
import type { LedgerDTO } from '../../core/ledger/contracts.js';
import { amountCents, invalid } from '../../core/ledger/money.js';
import { ledgerId } from '../../core/ledger/normalize.js';
import { calendarDate, clockTime, localMinute, occurredAt } from '../../core/ledger/time.js';
import type { AiProvider } from '../ai/contracts.js';
import type { LedgerService } from '../ledger/contracts.js';

const scheduleKeys = ['date', 'startTime', 'endTime', 'title', 'place', 'budgetKrw'];
const expenseKeys = ['itineraryId', 'title', 'occurredLocal', 'currency', 'amount', 'payerId', 'splitIds', 'refreshRate'];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return invalid('draft');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'))) return invalid('draft');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, field: string, min = 1): string {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) return invalid(field);
  const clean = value.trim();
  if ([...clean].length < min || [...clean].length > max) return invalid(field);
  return clean;
}
function authorize(ledger: LedgerDTO, tripId: string, revision: number) {
  if (ledger.tripId !== tripId) throw new IdentityError('not_found', '여행을 찾을 수 없습니다.');
  if (ledger.role !== 'owner' && ledger.role !== 'editor') throw new IdentityError('forbidden', '편집 권한을 확인해 주세요.');
  if (ledger.revision !== revision) throw new IdentityError('conflict', '최신 장부를 확인한 뒤 다시 시도해 주세요.');
}
function bounded(value: unknown, seen = new Set<object>(), budget = {remaining: 16384}): void {
  // Reject accessors, cycles and oversized trees before serializing provider output.
  if (typeof value === 'string') budget.remaining -= value.length * 3;
  else if (value && typeof value === 'object') {
    if (seen.has(value)) return invalid('draft');
    seen.add(value);
    if (!Array.isArray(value)) record(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) return invalid('draft');
      budget.remaining -= key.length * 3 + 8;
      if (budget.remaining < 0) return invalid('draft');
      bounded(descriptor.value, seen, budget);
    }
    seen.delete(value);
  } else if (!['number','boolean','undefined'].includes(typeof value) && value !== null) return invalid('draft');
  else budget.remaining -= 16;
  if (budget.remaining < 0) return invalid('draft');
}
function project(output: unknown, ledger: LedgerDTO, source: DraftDTO['source']): DraftDTO {
  bounded(output);
  const raw = record(output), input = record(raw.fields);
  if (raw.kind !== 'schedule' && raw.kind !== 'expense') return invalid('draft');
  const keys = raw.kind === 'schedule' ? scheduleKeys : expenseKeys;
  const fields: Record<string, unknown> = {};
  const inTrip = (date: string, field: string) => {
    if (date < ledger.startDate || date > ledger.endDate) return invalid(field);
    return date;
  };
  const member = (value: unknown, field: string) => {
    const id = ledgerId(value, field);
    if (!ledger.members.some(row => row.id === id && row.active && row.role !== 'viewer')) return invalid(field);
    return id;
  };
  for (const key of keys) {
    if (!Object.hasOwn(input,key)) continue;
    const value = input[key];
    switch (key) {
      case 'title': fields[key] = text(value,100,key); break;
      case 'place': fields[key] = text(value,200,key,0); break;
      case 'date': fields[key] = inTrip(calendarDate(value),key); break;
      case 'startTime': case 'endTime': fields[key] = value === '' ? '' : clockTime(value,key); break;
      case 'budgetKrw':
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid(key);
        fields[key] = value; break;
      case 'occurredLocal': {
        const local = localMinute(value);
        inTrip(local.slice(0,10),key); occurredAt(local,ledger.timeZone); fields[key] = local; break;
      }
      case 'currency':
        if (value !== 'KRW' && value !== 'THB') return invalid(key);
        fields[key] = value; break;
      case 'amount':
        if (typeof value !== 'string' || value.length > 30 || !/^\d+(?:\.\d{1,2})?$/.test(value)) return invalid(key);
        amountCents(input.currency === 'KRW' ? 'KRW' : 'THB',value);
        fields[key] = value; break;
      case 'itineraryId': {
        if (value === null) {fields[key] = null; break;}
        const id = ledgerId(value,key);
        if (!ledger.items.some(row => row.id === id && row.status === 'active')) return invalid(key);
        fields[key] = id; break;
      }
      // Candidate participants are validated, but must be explicitly confirmed in
      // the existing expense form. Provider output alone never confirms consent.
      case 'payerId': member(value,key); break;
      case 'splitIds':
        if (!Array.isArray(value) || value.length < 1 || value.length > 8 || new Set(value).size !== value.length) return invalid(key);
        for (const id of value) member(id,key);
        break;
      case 'refreshRate':
        if (typeof value !== 'boolean') return invalid(key);
        // A provider cannot request a rate refresh on the user's behalf.
        break;
    }
  }
  if (Object.hasOwn(fields,'startTime') && Object.hasOwn(fields,'endTime') &&
      ((fields.startTime === '') !== (fields.endTime === '') || String(fields.endTime) < String(fields.startTime))) return invalid('endTime');
  return {tripId: ledger.tripId, baseRevision: ledger.revision, kind: raw.kind, fields,
    missing: keys.filter(key => !Object.hasOwn(fields,key)), source,
    warnings: [source === 'synthetic' ? '정해진 예문만 처리하는 합성 체험입니다. 저장 전에 내용을 확인해 주세요.' : '생성된 초안입니다. 저장 전에 내용과 결제자·분담자를 확인해 주세요.']};
}
export function createDraftService({ledgerService, provider, now = () => new Date()}: {
  ledgerService: LedgerService; provider: AiProvider; now?: () => Date;
}) {
  return {async extract(actor: Actor, rawTripId: string, message: string, expectedRevision: number): Promise<DraftDTO> {
    const tripId = ledgerId(rawTripId,'tripId');
    const ledger = await ledgerService.get(actor,tripId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return invalid('expectedRevision');
    authorize(ledger,tripId,expectedRevision);
    const clean = typeof message === 'string' ? message.trim() : '';
    if (!clean || [...message].length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(clean)) return invalid('message');
    const output = await provider.extract({message: clean, startDate: ledger.startDate, endDate: ledger.endDate, timeZone: ledger.timeZone, now: now().toISOString()});
    const current = await ledgerService.get(actor,tripId);
    authorize(current,tripId,expectedRevision);
    if (provider.source !== 'synthetic' && provider.source !== 'claude') return invalid('source');
    return project(output,current,provider.source);
  }};
}
