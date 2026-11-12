import { createClient } from '@supabase/supabase-js';
import { IdentityError, type ProviderTokens } from '../../core/contracts.js';
import { createProviderAccessVerifier,
  type ProviderBinding, type VerifiedProviderAccess } from './provider-access.js';
import { readProviderTokens } from './provider-tokens.js';

export type EmailLinkTokens = { accessToken: string; refreshToken: string };

export function readEmailLinkTokens(value: unknown): EmailLinkTokens {
  if (!record(value) || Object.keys(value).length !== 2
    || typeof value.accessToken !== 'string' || value.accessToken.length > 8192
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.accessToken)
    || typeof value.refreshToken !== 'string' || value.refreshToken.length < 8
    || value.refreshToken.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value.refreshToken)) {
    throw new IdentityError('validation', '입력 형식을 확인해 주세요.');
  }
  return { accessToken: value.accessToken, refreshToken: value.refreshToken };
}

export interface AuthProvider {
  requestCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<ProviderTokens>;
  verifyEmailLink?(email: string, tokens: EmailLinkTokens): Promise<ProviderTokens>;
  validate(tokens: ProviderTokens): Promise<{ userId: string; email: string }>;
  refresh(tokens: ProviderTokens): Promise<ProviderTokens>;
  revoke(tokens: ProviderTokens): Promise<void>;
}
export interface VerifiedAuthProvider extends AuthProvider {
  refreshVerified(tokens: ProviderTokens): Promise<{
    tokens: ProviderTokens; identity: { userId: string; email: string };
  }>;
}
export type AuthProviderConfig = {
  url: string; publishableKey: string; fetcher?: typeof fetch; now?: () => number; emailRedirectTo?: string;
};

type Operation = {
  fetcher: typeof fetch; status?: number; body?: unknown; failed: boolean;
};
const DENIAL_STATUS = new Set([400, 401, 403, 404, 422]);
const VERIFY_DENIAL = new Set(['otp_expired', 'invalid_credentials', 'user_not_found', 'user_banned']);
const REFRESH_DENIAL = new Set(['refresh_token_not_found', 'refresh_token_already_used',
  'session_not_found', 'session_expired', 'bad_jwt', 'user_not_found', 'user_banned']);
const unavailable = () => new IdentityError('unavailable', '인증 확인을 잠시 사용할 수 없습니다.');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizedEmail(value: unknown): string {
  if (typeof value !== 'string') throw new IdentityError('validation', '이메일 형식을 확인해 주세요.', 'email');
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || /[\s\p{Cc}]/u.test(email)
    || !/^[^ @]+@[^ @]+[.][^ @]+$/.test(email)) {
    throw new IdentityError('validation', '이메일 형식을 확인해 주세요.', 'email');
  }
  return email;
}

// The entire SDK operation, including initialization and body reads, owns one deadline.
async function remote<T>(fetcher: typeof fetch, work: (operation: Operation) => Promise<T>,
  cancelSuccessBody = false): Promise<T> {
  const controller = new AbortController();
  let active = true;
  let used = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const safeFailure = () => new Response('{}', {
    status: 400, headers: { 'Content-Type': 'application/json' },
  });
  const operation: Operation = {
    failed: false,
    fetcher: async (input, init) => {
      // SDK background work and retries must never send another real request.
      if (!active || used) return safeFailure();
      used = true;
      try {
        const response = await fetcher(input, { ...init, signal: controller.signal,
          redirect: 'error', cache: 'no-store' });
        if (!active) { void response.body?.cancel().catch(() => {}); return safeFailure(); }
        operation.status = response.status;
        if (cancelSuccessBody && response.ok) {
          await response.body?.cancel();
          return response;
        }
        if (response.status === 429 || response.status >= 500) {
          // Do not expose retryable responses to auth-js's refresh backoff loop.
          await response.body?.cancel();
          return safeFailure();
        }
        const body = await response.text();
        if (!active) return safeFailure();
        operation.body = JSON.parse(body);
        if (!record(operation.body)) { operation.failed = true; return safeFailure(); }
        return new Response(body, { status: response.status, headers: response.headers });
      } catch {
        operation.failed = true;
        return safeFailure();
      }
    },
  };
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      active = false;
      controller.abort();
      reject(unavailable());
    }, 5_000);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(operation)), deadline]);
  } catch (error) {
    if (error instanceof IdentityError) throw error;
    throw unavailable();
  } finally {
    active = false;
    clearTimeout(timer);
  }
}

function checkResult(operation: Operation, error: unknown, kind: 'request' | 'verify' | 'refresh') {
  if (operation.failed) throw unavailable();
  if (operation.status === 429 && kind === 'request') {
    throw new IdentityError('rate_limited', '잠시 뒤 다시 요청해 주세요.');
  }
  if (operation.status === undefined || operation.status === 429
    || operation.status >= 500) throw unavailable();
  if (operation.status < 200 || operation.status >= 300 || error) {
    const body = operation.body;
    const code = record(body) ? (typeof body.code === 'string' ? body.code : body.error_code) : undefined;
    const allowed = kind === 'verify' ? VERIFY_DENIAL : kind === 'refresh' ? REFRESH_DENIAL : undefined;
    if (DENIAL_STATUS.has(operation.status) && typeof code === 'string' && allowed?.has(code)) {
      throw new IdentityError('unauthenticated', '다시 로그인해 주세요.');
    }
    throw unavailable();
  }
}

// Raw expiry is optional in auth-js; validate it when present and validate
// the SDK-resolved expiry before invoking the verifier.
// Identity and claim decisions remain exclusively in the existing verifier.
function checkSessionFields(value: unknown, allowMissingExpiry = false) {
  if (!record(value)) throw unavailable();
  const validToken = (token: unknown): token is string => typeof token === 'string'
    && token.length > 0 && Buffer.byteLength(token, 'utf8') <= 16 * 1024
    && !/[\s\p{Cc}]/u.test(token);
  if (!validToken(value.access_token)
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.access_token)
    || !validToken(value.refresh_token)) throw unavailable();
  if ((!allowMissingExpiry || Object.hasOwn(value, 'expires_at'))
    && (typeof value.expires_at !== 'number' || !Number.isSafeInteger(value.expires_at)
      || value.expires_at <= 0)) throw unavailable();
}

function matchSdkUser(value: unknown, verified: VerifiedProviderAccess) {
  if (!record(value) || value.id !== verified.userId || typeof value.email !== 'string'
    || value.email.trim().toLowerCase() !== verified.email || value.is_anonymous !== false
    || typeof value.email_confirmed_at !== 'string' || !Number.isFinite(Date.parse(value.email_confirmed_at))) {
    throw unavailable();
  }
}

export function createAuthProvider(config: AuthProviderConfig): VerifiedAuthProvider {
  // Reuse the verifier's project and publishable-key guard without any network call.
  const { url, publishableKey, now, emailRedirectTo } = config;
  if (emailRedirectTo !== undefined) {
    try {
      const redirect = new URL(emailRedirectTo);
      if (redirect.protocol !== 'https:' || redirect.username || redirect.password
        || emailRedirectTo !== `${redirect.origin}/auth/callback`) throw unavailable();
    } catch { throw unavailable(); }
  }
  const fetcher = config.fetcher ?? fetch;
  const verifierConfig = { url, publishableKey, now };
  createProviderAccessVerifier(verifierConfig);
  const client = (operation: Operation) => createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false },
    global: { fetch: operation.fetcher },
  });
  const verifyAccess = (jwt: string, binding: ProviderBinding) => remote(fetcher, async (operation) => {
    const result = await createProviderAccessVerifier({ ...verifierConfig, fetcher: operation.fetcher })(jwt, binding);
    if (operation.failed || operation.status === 429 || (operation.status !== undefined && operation.status >= 500)) {
      throw unavailable();
    }
    return result;
  });
  const sessionTokens = async (value: unknown, sdkUser: unknown, binding: ProviderBinding) => {
    checkSessionFields(value);
    if (!record(value) || typeof value.access_token !== 'string') throw unavailable();
    const verified = await verifyAccess(value.access_token, binding);
    matchSdkUser(sdkUser, verified);
    const result = readProviderTokens({ accessToken: value.access_token, refreshToken: value.refresh_token,
      expiresAt: value.expires_at, userId: verified.userId, providerSessionId: verified.providerSessionId },
      binding.kind === 'session' ? binding : undefined);
    if (result.expiresAt !== verified.expiresAtSeconds) throw unavailable();
    return { tokens: result, identity: { userId: verified.userId, email: verified.email } };
  };
  const refreshVerified = async (value: ProviderTokens) => {
    const tokens = readProviderTokens(value);
    const data = await remote(fetcher, async (operation) => {
      const result = await client(operation).auth.refreshSession({ refresh_token: tokens.refreshToken });
      checkResult(operation, result.error, 'refresh');
      checkSessionFields(operation.body, true);
      return result.data;
    });
    return sessionTokens(data.session, data.user, { kind: 'session', userId: tokens.userId,
      providerSessionId: tokens.providerSessionId });
  };
  return {
    async requestCode(email) {
      const normalized = normalizedEmail(email);
      await remote(fetcher, async (operation) => {
        const { error } = await client(operation).auth.signInWithOtp({ email: normalized, options: { shouldCreateUser: true, ...(emailRedirectTo ? { emailRedirectTo } : {}) } });
        checkResult(operation, error, 'request');
      });
    },
    async verifyCode(email, code) {
      const normalized = normalizedEmail(email);
      if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) {
        throw new IdentityError('validation', '인증번호 6자리를 확인해 주세요.', 'code');
      }
      const data = await remote(fetcher, async (operation) => {
        const result = await client(operation).auth.verifyOtp({ email: normalized, token: code, type: 'email' });
        checkResult(operation, result.error, 'verify');
        checkSessionFields(operation.body, true);
        return result.data;
      });
      return (await sessionTokens(data.session, data.user, { kind: 'login', normalizedEmail: normalized })).tokens;
    },
    async verifyEmailLink(email, value) {
      const normalized = normalizedEmail(email);
      const tokens = readEmailLinkTokens(value);
      const verified = await verifyAccess(tokens.accessToken, { kind: 'login', normalizedEmail: normalized });
      return readProviderTokens({ ...tokens, expiresAt: verified.expiresAtSeconds,
        userId: verified.userId, providerSessionId: verified.providerSessionId });
    },
    async validate(value) {
      const tokens = readProviderTokens(value);
      const verified = await verifyAccess(tokens.accessToken, { kind: 'session', userId: tokens.userId,
        providerSessionId: tokens.providerSessionId });
      if (verified.expiresAtSeconds !== tokens.expiresAt) throw unavailable();
      return { userId: verified.userId, email: verified.email };
    },
    async refresh(value) {
      return (await refreshVerified(value)).tokens;
    },
    refreshVerified,
    async revoke(value) {
      const tokens = readProviderTokens(value);
      await remote(fetcher, async (operation) => {
        await operation.fetcher(`${url}/auth/v1/logout?scope=local`, { method: 'POST',
          headers: { apikey: publishableKey, Authorization: `Bearer ${tokens.accessToken}`,
            'X-Supabase-Api-Version': '2024-01-01' }, redirect: 'error', cache: 'no-store' });
        if (operation.failed || operation.status === undefined) throw unavailable();
        if (operation.status >= 200 && operation.status < 300) return;
        const body = operation.body;
        if ([401, 403, 404].includes(operation.status) && record(body)
          && (body.code === 'session_not_found' || body.error_code === 'session_not_found')
          && (!Object.hasOwn(body, 'code') || body.code === 'session_not_found')
          && (!Object.hasOwn(body, 'error_code') || body.error_code === 'session_not_found')) return;
        throw unavailable();
      }, true);
    },
  };
}
