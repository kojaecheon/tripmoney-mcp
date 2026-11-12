import { createClient, isAuthSessionMissingError } from '@supabase/supabase-js';
import { IdentityError } from '../../core/contracts.js';

export type ProviderBinding =
  | { kind: 'login'; normalizedEmail: string }
  | { kind: 'session'; userId: string; providerSessionId: string };

export type VerifiedProviderAccess = {
  userId: string; providerSessionId: string; email: string; expiresAtSeconds: number;
};

export type ProviderDenial = 'session_not_found' | 'session_expired' | 'bad_jwt'
  | 'user_not_found' | 'user_banned' | 'invalid_claims';

export class ProviderAccessFailure extends IdentityError {
  constructor(public readonly reason: ProviderDenial) {
    super('unauthenticated', '다시 로그인해 주세요.');
  }
}

export type VerifyProviderAccess =
  (jwt: string, expected?: ProviderBinding) => Promise<VerifiedProviderAccess>;

const PROJECT_URL = 'https://agddopryfqsyfshoowgk.supabase.co';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const DENIED = new Set<ProviderDenial>([
  'session_not_found', 'session_expired', 'bad_jwt', 'user_not_found', 'user_banned',
]);

function unavailable(): IdentityError {
  return new IdentityError('unavailable', '인증 확인을 잠시 사용할 수 없습니다.');
}

function invalidClaims(): never {
  throw new ProviderAccessFailure('invalid_claims');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value) && value !== NIL_UUID;
}

function denialReason(error: unknown): ProviderDenial | null {
  // auth-js replaces session_not_found with this class and removes its code.
  if (isAuthSessionMissingError(error)) return 'session_not_found';
  if (!record(error) || typeof error.code !== 'string') return null;
  return DENIED.has(error.code as ProviderDenial) ? error.code as ProviderDenial : null;
}

function verifiedIdentity(user: unknown, jwt: string, now: () => number,
  expected?: ProviderBinding): VerifiedProviderAccess {
  // The SDK's successful /user transform does not validate the response shape.
  if (!record(user) || !uuid(user.id) || typeof user.is_anonymous !== 'boolean'
    || (user.email != null && typeof user.email !== 'string')
    || (user.email_confirmed_at != null && typeof user.email_confirmed_at !== 'string')) {
    throw unavailable();
  }
  if (user.is_anonymous || typeof user.email !== 'string' || !user.email.trim()
    || typeof user.email_confirmed_at !== 'string' || !user.email_confirmed_at.trim()) {
    invalidClaims();
  }
  if (!Number.isFinite(Date.parse(user.email_confirmed_at))) throw unavailable();

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
  } catch {
    invalidClaims();
  }
  const nowSeconds = now() / 1000;
  if (!Number.isFinite(nowSeconds)) throw unavailable();
  if (!record(payload) || payload.iss !== `${PROJECT_URL}/auth/v1`
    || !uuid(payload.sub) || payload.sub !== user.id || !uuid(payload.session_id)
    || !(payload.aud === 'authenticated'
      || (Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === 'authenticated'))
    || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= nowSeconds) {
    invalidClaims();
  }

  const email = user.email.trim().toLowerCase();
  if (expected !== undefined) {
    if (!record(expected)) invalidClaims();
    if (expected.kind === 'login') {
      if (typeof expected.normalizedEmail !== 'string'
        || expected.normalizedEmail.trim().toLowerCase() !== email) invalidClaims();
    } else if (expected.kind === 'session') {
      if (!uuid(expected.userId) || !uuid(expected.providerSessionId)
        || expected.userId !== user.id || expected.providerSessionId !== payload.session_id) invalidClaims();
    } else {
      invalidClaims();
    }
  }
  return {
    userId: user.id, providerSessionId: payload.session_id, email, expiresAtSeconds: payload.exp,
  };
}

export function createProviderAccessVerifier(config: {
  url: string; publishableKey: string; fetcher?: typeof fetch; now?: () => number;
}): VerifyProviderAccess {
  if (config.url !== PROJECT_URL || typeof config.publishableKey !== 'string'
    || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey)) {
    throw unavailable();
  }
  const publishableKey = config.publishableKey;
  const fetcher = config.fetcher ?? fetch;
  const now = config.now ?? Date.now;

  return async (jwt, expected) => {
    if (typeof jwt !== 'string' || Buffer.byteLength(jwt, 'utf8') > 16 * 1024
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) invalidClaims();

    const controller = new AbortController();
    let timedOut = false;
    let httpStatus: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(unavailable());
      }, 5_000);
    });
    const providerUnavailable = () => timedOut || httpStatus === 429
      || (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599);

    try {
      const client = createClient(PROJECT_URL, publishableKey, {
        auth: {
          persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false,
        },
        global: {
          fetch: async (input, init) => {
            const response = await fetcher(input, {
              ...init, signal: controller.signal, cache: 'no-store',
            });
            httpStatus = response.status;
            return response;
          },
        },
      });
      // Keep the timer alive until the SDK finishes reading the response body.
      const { data, error } = await Promise.race([client.auth.getUser(jwt), deadline]);
      if (providerUnavailable()) throw unavailable();
      if (error) {
        const reason = denialReason(error);
        if (reason) throw new ProviderAccessFailure(reason);
        throw unavailable();
      }
      return verifiedIdentity(data?.user, jwt, now, expected);
    } catch (error) {
      if (!providerUnavailable() && error instanceof ProviderAccessFailure) throw error;
      // Never retain raw provider errors, response bodies, request headers, or tokens.
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  };
}
