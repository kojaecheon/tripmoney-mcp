import { randomBytes, randomUUID } from 'node:crypto';
import { IdentityError, type ProviderTokens } from '../../core/contracts.js';
import type { VerifiedAuthProvider } from '../auth/provider.js';
type Session = { email: string; tokens: ProviderTokens; expires: number };
export function createLocalAuthProvider({ now = Date.now }: { now?: () => number } = {}): VerifiedAuthProvider & { close(): void } {
  const identities = new Map<string, string>();
  const sessions = new Map<string, Session>();
  let closed = false;
  const denied = () => new IdentityError('unauthenticated', '다시 로그인해 주세요.');
  const check = () => { if (closed) throw new IdentityError('unavailable', '인증 확인을 잠시 사용할 수 없습니다.'); };
  const cleanup = () => { check(); for (const [id, row] of sessions) if (row.expires <= now()) sessions.delete(id); };
  const tokens = (userId: string, providerSessionId: string): ProviderTokens => ({
    userId, providerSessionId, expiresAt: Math.floor(now() / 1000) + 3600,
    accessToken: `${Buffer.from('{"alg":"local-demo"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, session_id: providerSessionId, local: true })).toString('base64url')}.${randomBytes(32).toString('base64url')}`,
    refreshToken: randomUUID(),
  });
  const find = (value: ProviderTokens) => {
    cleanup(); const row = sessions.get(value.providerSessionId);
    if (!row || row.tokens.userId !== value.userId || row.tokens.accessToken !== value.accessToken || row.tokens.refreshToken !== value.refreshToken) throw denied();
    return row;
  };
  const refreshVerified: VerifiedAuthProvider['refreshVerified'] = async value => {
    const row = find(value); row.tokens = tokens(value.userId, value.providerSessionId);
    return { tokens: { ...row.tokens }, identity: { userId: value.userId, email: row.email } };
  };
  return {
    async requestCode() { check(); },
    async verifyCode(email, code) {
      cleanup(); if (code !== '123456') throw denied();
      if (sessions.size >= 2048 || (!identities.has(email) && identities.size >= 2048)) throw new IdentityError('unavailable', '인증 확인을 잠시 사용할 수 없습니다.');
      const userId = identities.get(email) ?? randomUUID(); identities.set(email, userId);
      const value = tokens(userId, randomUUID()); sessions.set(value.providerSessionId, { email, tokens: value, expires: now() + 86400_000 }); return { ...value };
    },
    async validate(value) { const row = find(value); if (value.expiresAt <= Math.floor(now() / 1000)) throw denied(); return { userId: value.userId, email: row.email }; },
    async refresh(value) { return (await refreshVerified(value)).tokens; },
    refreshVerified,
    async revoke(value) { check(); sessions.delete(value.providerSessionId); },
    close() { closed = true; identities.clear(); sessions.clear(); },
  };
}
