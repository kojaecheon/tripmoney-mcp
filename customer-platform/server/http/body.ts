import type { IncomingMessage } from 'node:http';
import { IdentityError } from '../../core/contracts.js';
import { readJsonBody } from './json-body.js';
const invalid = (field?: string) => new IdentityError('validation', '입력 형식을 확인해 주세요.', field);
export async function readBody(req: IncomingMessage, field?: 'email' | 'code'): Promise<Record<string, string>> {
  const value = await readJsonBody(req);
  const keys = Object.keys(value);
  if (keys.length !== (field ? 1 : 0) || (field && keys[0] !== field)) throw invalid();
  if (!field) return {};
  const raw = (value as Record<string, unknown>)[field];
  if (typeof raw !== 'string') throw invalid(field);
  if (field === 'code' && !/^[0-9]{6}$/.test(raw)) throw invalid(field);
  if (field === 'email') {
    const email = raw.trim().toLowerCase();
    if (!email || email.length > 254 || /[\s\p{Cc}]/u.test(email) || !/^[^ @]+@[^ @]+[.][^ @]+$/.test(email)) throw invalid(field);
  }
  return { [field]: raw };
}
