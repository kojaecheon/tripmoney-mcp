import { IdentityError } from '../../core/contracts.js';
import type { ProviderTokens } from '../../core/contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const FIELDS = ['accessToken', 'refreshToken', 'expiresAt', 'userId', 'providerSessionId'] as const;

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value) && value !== NIL_UUID;
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 16 * 1024 && !/[\s\p{Cc}]/u.test(value);
}

function unavailable(): never {
  throw new IdentityError('unavailable', '인증 확인을 잠시 사용할 수 없습니다.');
}

export function readProviderTokens(
  value: unknown,
  expected?: { userId: string; providerSessionId: string },
): ProviderTokens {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) unavailable();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!FIELDS.every(name => {
      const descriptor = descriptors[name];
      return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
    })) unavailable();

    const accessToken: unknown = descriptors.accessToken!.value;
    const refreshToken: unknown = descriptors.refreshToken!.value;
    const expiresAt: unknown = descriptors.expiresAt!.value;
    const userId: unknown = descriptors.userId!.value;
    const providerSessionId: unknown = descriptors.providerSessionId!.value;

    if (!token(accessToken)
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)
      || !token(refreshToken) || typeof expiresAt !== 'number'
      || !Number.isSafeInteger(expiresAt) || expiresAt <= 0
      || !uuid(userId) || !uuid(providerSessionId)) unavailable();
    if (expected !== undefined
      && (expected.userId !== userId || expected.providerSessionId !== providerSessionId)) unavailable();

    return { accessToken, refreshToken, expiresAt, userId, providerSessionId };
  } catch {
    // Never retain malformed token data or errors raised while inspecting it.
    unavailable();
  }
}
