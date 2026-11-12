import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { IdentityError } from './contracts.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenPattern = /^([A-Za-z0-9_-]{1,16})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const reservedKeys = new Set(['__proto__', 'prototype', 'constructor']);

function validKid(kid: string): boolean {
  return typeof kid === 'string' && kid.length >= 1 && kid.length <= 16 &&
    !/[^A-Za-z0-9_-]/.test(kid) && !reservedKeys.has(kid);
}

function unavailable(): never {
  // 입력·키·토큰 원문을 오류 응답에 포함하지 않는다.
  throw new IdentityError('invite_unavailable', '사용할 수 없는 초대입니다.');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function makeInviteToken(id: string, kid: string, key: Buffer): string {
  if (typeof id !== 'string' || id.length !== 36 || !uuidPattern.test(id) ||
      !validKid(kid) || !Buffer.isBuffer(key) || key.length !== 32) {
    throw new IdentityError('validation', '초대 설정을 확인해 주세요.');
  }
  const prefix = `${kid}.${id.toLowerCase()}`;
  const mac = createHmac('sha256', key).update(`tripmoney-invite-v1:${prefix}`).digest('base64url');
  return `${prefix}.${mac}`;
}

export function verifyInviteToken(token: string, keys: Record<string, Buffer>): {
  id: string; kid: string; hash: string;
} {
  if (typeof token !== 'string' || token.length > 97 || !keys || typeof keys !== 'object') {
    return unavailable();
  }
  const match = tokenPattern.exec(token);
  if (!match || match[0] !== token) return unavailable();
  const kid = match[1]!;
  const id = match[2]!;
  if (!validKid(kid)) return unavailable();
  // 상속된 필드나 getter를 서버 키로 해석하지 않는다.
  const descriptor = Object.getOwnPropertyDescriptor(keys, kid);
  const key: unknown = descriptor?.value;
  if (!Buffer.isBuffer(key) || key.length !== 32) return unavailable();
  const expected = Buffer.from(makeInviteToken(id, kid, key));
  const actual = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return unavailable();
  return { id, kid, hash: sha256(token) };
}

export function canonicalHash(value: Record<string, unknown>): string {
  const invalid = (): never => {
    throw new IdentityError('validation', '요청 내용을 확인해 주세요.');
  };
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    return invalid();
  }
  const active = new Set<object>();
  const encode = (v: unknown): string => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || v === null || active.has(v)) return invalid();
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) return invalid();
    if (Object.getOwnPropertySymbols(v).length) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))) return invalid();
    active.add(v);
    try {
      if (Array.isArray(v)) return '[' + Array.from(v, encode).join(',') + ']';
      return '{' + Object.keys(v).sort().map(k =>
        JSON.stringify(k) + ':' + encode(descriptors[k]!.value)).join(',') + '}';
    } finally {
      active.delete(v);
    }
  };
  return sha256(encode(value));
}
