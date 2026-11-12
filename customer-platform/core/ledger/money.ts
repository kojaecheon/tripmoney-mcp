import { IdentityError } from '../contracts.js';
import type { ExpenseInput, ExpenseShare } from './contracts.js';

export function invalid(field: string): never {
  throw new IdentityError('validation', '입력 내용을 확인해 주세요.', field);
}
function safeInteger(n: bigint, field: string): number {
  const value = Number(n);
  if (!Number.isSafeInteger(value)) return invalid(field);
  return value;
}
export function safeSum(...values: number[]): number {
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) return invalid('budgetKrw');
    total += BigInt(value);
  }
  return safeInteger(total,'budgetKrw');
}
export function amountCents(currency: ExpenseInput['currency'], raw: string): number {
  const syntax = currency === 'KRW' ? /^[0-9]+$/ : /^[0-9]+(?:\.[0-9]{1,2})?$/;
  if ((currency !== 'THB' && currency !== 'KRW') || typeof raw !== 'string' ||
      !syntax.test(raw) || /\s/u.test(raw)) return invalid('amount');
  const [whole, fraction = ''] = raw.split('.');
  const units = Number(whole!) * 100 + Number(fraction.padEnd(2,'0'));
  if (!Number.isSafeInteger(units) || units < 1 || units > 100_000_000) return invalid('amount');
  return units;
}
export function convertKrw(cents: number, rateMilli: number): number {
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 100_000_000 ||
      !Number.isSafeInteger(rateMilli) || rateMilli < 1 || rateMilli > 1_000_000_000) return invalid('amount');
  const krw = safeInteger((BigInt(cents) * BigInt(rateMilli) + 50000n) / 100000n,'amount');
  return krw >= 1 ? krw : invalid('amount');
}
export function allocateShares(krw: number, ids: string[]): ExpenseShare[] {
  if (!Number.isSafeInteger(krw) || krw < 1) return invalid('amount');
  if (ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length) return invalid('splitIds');
  const divisor = BigInt(ids.length), amount = BigInt(krw);
  const base = Number(amount / divisor), remainder = Number(amount % divisor);
  return [...ids].sort().map((memberId,index) => ({ memberId, amountKrw: base + Number(index < remainder) }));
}
