import { createHash, createHmac, randomBytes } from 'node:crypto';
import { IdentityError, type ProviderTokens, type VerifiedSession } from '../../core/contracts.js';
import { seal, open } from './crypto.js';
import { readProviderTokens } from './provider-tokens.js';
import { readEmailLinkTokens, type EmailLinkTokens, type VerifiedAuthProvider } from './provider.js';
import type { AuthStore, SessionLease, StoredAuthSession } from './store-contract.js';

export interface AuthService {
  requestCode(email: string, clientHash: string): Promise<{ challengeToken: string }>;
  verifyCode(challengeToken: string, code: string): Promise<{
    sessionToken: string; me: { userId: string; email: string; expiresAt: string };
  }>;
  verifyEmailLink?(challengeToken: string, tokens: EmailLinkTokens): Promise<{
    sessionToken: string; me: { userId: string; email: string; expiresAt: string };
  }>;
  authenticate(sessionToken: string): Promise<VerifiedSession>;
  logout(sessionToken: string): Promise<void>;
}
export type AuthServiceConfig = {
  store: AuthStore; provider: VerifiedAuthProvider; kid: string;
  keys: Record<string, Buffer>; rateKey: Buffer;
};
const unavailable = () => new IdentityError('unavailable', '인증 확인을 잠시 사용할 수 없습니다.');
const unauthenticated = () => new IdentityError('unauthenticated', '다시 로그인해 주세요.');
const validation = (field: 'email' | 'code' | 'clientHash') =>
  new IdentityError('validation', '입력 형식을 확인해 주세요.', field);
function safe(error: unknown): IdentityError {
  if (error instanceof IdentityError) {
    if (error.code === 'unauthenticated') return unauthenticated();
    if (error.code === 'rate_limited') return new IdentityError('rate_limited', '잠시 뒤 다시 요청해 주세요.');
    if (error.code === 'validation') return new IdentityError('validation', '입력 형식을 확인해 주세요.');
  }
  return unavailable();
}
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw safe(error); }
}
function email(value: unknown): string {
  if (typeof value !== 'string') throw validation('email');
  const result = value.trim().toLowerCase();
  if (!result || result.length > 254 || /[\s\p{Cc}]/u.test(result)
    || !/^[^ @]+@[^ @]+[.][^ @]+$/.test(result)) throw validation('email');
  return result;
}
function nonceHash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 43 || /[^A-Za-z0-9_-]/.test(value)
    || Buffer.from(value, 'base64url').toString('base64url') !== value) throw unauthenticated();
  return createHash('sha256').update(value).digest('hex');
}
function identity(value: { userId: string; email: string }, userId: string) {
  try {
    if (value.userId !== userId || value.email !== email(value.email)) throw unavailable();
    return { userId, email: value.email };
  } catch { throw unavailable(); }
}
function active(row: StoredAuthSession | null): StoredAuthSession {
  if (!row || !row.usable || row.revoked || row.refreshPending) throw unauthenticated();
  return row;
}

export function createAuthService(config: AuthServiceConfig): AuthService {
  let keys: Record<string, Buffer>;
  let rateKey: Buffer;
  let kid: string;
  try {
    kid = config.kid;
    if (typeof kid !== 'string' || kid.length < 1 || kid.length > 16 || /[^A-Za-z0-9_-]/.test(kid)
      || !Object.hasOwn(config.keys, kid) || !Buffer.isBuffer(config.rateKey) || config.rateKey.length !== 32) throw unavailable();
    keys = Object.create(null) as Record<string, Buffer>;
    for (const [id, key] of Object.entries(config.keys)) {
      if (id.length < 1 || id.length > 16 || /[^A-Za-z0-9_-]/.test(id)
        || !Buffer.isBuffer(key) || key.length !== 32) throw unavailable();
      keys[id] = Buffer.from(key);
    }
    rateKey = Buffer.from(config.rateKey);
  } catch { throw unavailable(); }
  const { store, provider } = config;
  const readTokens = (row: Pick<StoredAuthSession, 'tokensCipher' | 'userId' | 'providerSessionId'>, hash: string) =>
    readProviderTokens(open(row.tokensCipher, keys, `session:${hash}`), row);
  const revokeOnDenial = async <T>(lease: SessionLease, work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) {
      if (error instanceof IdentityError && error.code === 'unauthenticated') await lease.revoke();
      throw error;
    }
  };
  const verifyChallenge = async (hash: string, resolveTokens: (email: string) => Promise<ProviderTokens>) => {
    return store.withChallenge(hash, async (lease) => {
      const reserved = await lease.reserveAttempt();
      let normalized: string;
      try {
        const value = open(reserved.emailCipher, keys, `challenge:${hash}`);
        normalized = email(value);
        if (value !== normalized) throw unavailable();
      } catch { throw unavailable(); }
      const value = await resolveTokens(normalized);
      let verified: ProviderTokens | undefined;
      try {
        verified = readProviderTokens(value);
        const sessionToken = randomBytes(32).toString('base64url');
        const sessionHash = nonceHash(sessionToken);
        const result = await lease.consumeAndCreateSession({ hash: sessionHash,
          userId: verified.userId, providerSessionId: verified.providerSessionId,
          tokensCipher: seal(verified, kid, keys, `session:${sessionHash}`) });
        return { sessionToken, me: { userId: verified.userId, email: normalized, expiresAt: result.expiresAt } };
      } catch (error) {
        if (verified) { try { await provider.revoke(verified); } catch { /* Best effort after a failed local save. */ } }
        throw error;
      }
    });
  };
  return {
    requestCode(rawEmail, clientHash) { return guarded(async () => {
      const normalized = email(rawEmail);
      if (typeof clientHash !== 'string' || clientHash.length !== 64 || /[^0-9a-f]/.test(clientHash)) throw validation('clientHash');
      const challengeToken = randomBytes(32).toString('base64url');
      const hash = nonceHash(challengeToken);
      await store.reserveChallenge({ hash, emailCipher: seal(normalized, kid, keys, `challenge:${hash}`),
        emailKey: createHmac('sha256', rateKey).update(`auth-email:${normalized}`).digest('hex'), clientHash });
      try {
        await provider.requestCode(normalized);
        await store.markChallengeReady(hash);
      } catch (error) {
        try { await store.markChallengeFailed(hash); } catch { /* Preserve the original fixed failure. */ }
        throw error;
      }
      return { challengeToken };
    }); },
    verifyCode(challengeToken, code) { return guarded(async () => {
      const hash = nonceHash(challengeToken);
      if (typeof code !== 'string' || code.length !== 6 || /[^0-9]/.test(code)) throw validation('code');
      return verifyChallenge(hash, (normalized) => provider.verifyCode(normalized, code));
    }); },
    verifyEmailLink(challengeToken, tokens) { return guarded(async () => {
      const hash = nonceHash(challengeToken);
      const value = readEmailLinkTokens(tokens);
      if (!provider.verifyEmailLink) throw unavailable();
      return verifyChallenge(hash, (normalized) => provider.verifyEmailLink!(normalized, value));
    }); },
    authenticate(sessionToken) { return guarded(async () => {
      const hash = nonceHash(sessionToken);
      return store.withSession(hash, async (lease) => {
        const row = active(await lease.read());
        const tokens = readTokens(row, hash);
        let verifiedIdentity: { userId: string; email: string };
        let version = row.version;
        if (tokens.expiresAt <= row.nowSeconds + 60) {
          await lease.markRefreshPending(row.version);
          const refreshed = await revokeOnDenial(lease, () => provider.refreshVerified(tokens));
          const newTokens = readProviderTokens(refreshed.tokens, row);
          verifiedIdentity = identity(refreshed.identity, row.userId);
          version = await lease.saveRefresh(row.version, seal(newTokens, kid, keys, `session:${hash}`));
          await lease.activateRefresh(version);
        } else {
          verifiedIdentity = identity(await revokeOnDenial(lease, () => provider.validate(tokens)), row.userId);
        }
        const current = active(await lease.read());
        if (current.userId !== row.userId || current.providerSessionId !== row.providerSessionId
          || current.version !== version) throw unavailable();
        return { actor: { userId: current.userId, sessionHash: hash }, email: verifiedIdentity.email,
          expiresAt: current.expiresAt };
      });
    }); },
    logout(sessionToken) { return guarded(async () => {
      const hash = nonceHash(sessionToken);
      await store.withSession(hash, async (lease) => {
        const row = await lease.revoke();
        if (row) { try { await provider.revoke(readTokens(row, hash)); } catch { /* Local revocation is already committed. */ } }
      });
    }); },
  };
}
