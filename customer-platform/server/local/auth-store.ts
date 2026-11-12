import { IdentityError, type Actor } from '../../core/contracts.js';
import type { AuthStore, ChallengeInput, NewAuthSession, StoredAuthSession } from '../auth/store-contract.js';
const denied = () => new IdentityError('unauthenticated', '다시 로그인해 주세요.');
const unavailable = () => new IdentityError('unavailable', '인증 확인을 잠시 사용할 수 없습니다.');
type Challenge = ChallengeInput & { expires: number; ready: boolean; attempts: number; reserved: boolean };
type LocalSession = StoredAuthSession & { refreshGate: { baseVersion: number; savedVersion: number | null } | null };
/** Bounded process-only storage. All clock values are milliseconds. */
export function createLocalAuthStore({ now = Date.now }: { now?: () => number } = {}): AuthStore & { assertActor(actor: Actor): void; close(): void } {
  const challenges = new Map<string, Challenge>();
  const sessions = new Map<string, LocalSession>();
  const rates: { email: string; client: string; at: number }[] = [];
  const locks = new Map<string, Promise<void>>();
  let closed = false;
  const check = () => { if (closed) throw unavailable(); };
  const cleanup = () => {
    check(); const time = now();
    for (const [hash, row] of challenges) if (row.expires <= time) challenges.delete(hash);
    for (const [hash, row] of sessions) if (Date.parse(row.expiresAt) <= time || row.revoked) sessions.delete(hash);
    while (rates.length && rates[0]!.at <= time - 3600_000) rates.shift();
  };
  async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    check(); const prior = locks.get(key) ?? Promise.resolve();
    let release!: () => void; const next = new Promise<void>(resolve => { release = resolve; });
    locks.set(key, next);
    await prior;
    try { check(); return await work(); }
    finally { release(); if (locks.get(key) === next) locks.delete(key); }
  }
  return {
    assertActor(actor) {
      check();
      const row = sessions.get(actor.sessionHash);
      if (!row || row.hash !== actor.sessionHash || row.userId !== actor.userId
        || row.revoked || row.refreshPending || Date.parse(row.expiresAt) <= now()) throw denied();
    },
    async reserveChallenge(input) {
      cleanup(); const time = now(); const emailRates = rates.filter(v => v.email === input.emailKey);
      if (emailRates.some(v => time - v.at < 60_000) || emailRates.length >= 5
        || rates.filter(v => v.client === input.clientHash).length >= 20) {
        throw new IdentityError('rate_limited', '잠시 뒤 다시 요청해 주세요.');
      }
      if (challenges.size >= 2048 || rates.length >= 8192) throw unavailable();
      for (const [hash, row] of challenges) if (row.emailKey === input.emailKey) challenges.delete(hash);
      rates.push({ email: input.emailKey, client: input.clientHash, at: time });
      challenges.set(input.hash, { ...input, expires: time + 600_000, ready: false, attempts: 0, reserved: false });
    },
    async markChallengeReady(hash) { check(); const row = challenges.get(hash); if (!row || row.expires <= now()) throw denied(); row.ready = true; },
    async markChallengeFailed(hash) { check(); challenges.delete(hash); },
    withChallenge(hash, work) { return locked(`challenge:${hash}`, async () => {
      const active = () => { check(); const row = challenges.get(hash); if (!row || !row.ready || row.expires <= now()) throw denied(); return row; };
      return work({
        async reserveAttempt() { const row = active(); if (row.attempts >= 5) throw denied(); row.attempts++; row.reserved = true; return { emailCipher: row.emailCipher }; },
        async consumeAndCreateSession(input: NewAuthSession) {
          const row = active(); if (!row.reserved) throw denied(); cleanup(); if (sessions.size >= 2048 || sessions.has(input.hash)) throw unavailable();
          const expiresAt = new Date(now() + 86400_000).toISOString();
          sessions.set(input.hash, { ...input, expiresAt, version: 1, revoked: false, refreshPending: false, refreshGate: null, usable: true, nowSeconds: Math.floor(now() / 1000) });
          challenges.delete(hash); return { expiresAt };
        },
      });
    }); },
    withSession(hash, work) { return locked(`session:${hash}`, async () => {
      const row = () => { check(); return sessions.get(hash); };
      const active = () => { const value = row(); if (!value || value.revoked || Date.parse(value.expiresAt) <= now()) throw denied(); return value; };
      return work({
        async read() {
          const value = row(); if (!value) return null;
          const { refreshGate, ...stored } = value;
          return { ...stored, usable: !value.revoked && Date.parse(value.expiresAt) > now(), nowSeconds: Math.floor(now() / 1000) };
        },
        async markRefreshPending(version) {
          const value = active();
          if (value.version !== version || value.refreshPending || value.refreshGate) throw unavailable();
          value.refreshPending = true;
          value.refreshGate = { baseVersion: version, savedVersion: null };
        },
        async saveRefresh(version, tokensCipher) {
          const value = active(); const gate = value.refreshGate;
          if (value.version !== version || !value.refreshPending || !gate
            || gate.baseVersion !== version || gate.savedVersion !== null) throw unavailable();
          value.tokensCipher = tokensCipher;
          gate.savedVersion = ++value.version;
          return value.version;
        },
        async activateRefresh(version) {
          const value = active(); const gate = value.refreshGate;
          if (value.version !== version || !value.refreshPending || !gate
            || gate.savedVersion !== version || gate.baseVersion + 1 !== version) throw unavailable();
          value.refreshPending = false;
          value.refreshGate = null;
        },
        async revoke() { const value = row(); if (!value || value.revoked) return null; value.revoked = true; return { tokensCipher: value.tokensCipher, userId: value.userId, providerSessionId: value.providerSessionId }; },
      });
    }); },
    close() { closed = true; challenges.clear(); sessions.clear(); rates.length = 0; },
  };
}
