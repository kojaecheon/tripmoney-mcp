/** All timestamps and validity decisions originate from the auth database clock. */
export type ChallengeInput = {
  hash: string; emailCipher: string; emailKey: string; clientHash: string;
};
export type NewAuthSession = {
  hash: string; userId: string; providerSessionId: string; tokensCipher: string;
};
export type StoredAuthSession = NewAuthSession & {
  expiresAt: string; version: number; revoked: boolean; refreshPending: boolean;
  usable: boolean; nowSeconds: number;
};
export interface ChallengeLease {
  /** Commits one of at most five attempts before returning the encrypted email. */
  reserveAttempt(): Promise<{ emailCipher: string }>;
  /** Rechecks the challenge and atomically consumes it and inserts a 24-hour session. */
  consumeAndCreateSession(session: NewAuthSession): Promise<{ expiresAt: string }>;
}
export interface SessionLease {
  read(): Promise<StoredAuthSession | null>;
  /** Phase A: commit the durable gate before any remote refresh call. */
  markRefreshPending(version: number): Promise<void>;
  /** Phase B: commit ciphertext + version, keeping refresh_pending true. */
  saveRefresh(version: number, tokensCipher: string): Promise<number>;
  /** Phase C: only after a confirmed save, reopen that exact version. */
  activateRefresh(version: number): Promise<void>;
  /** Commit local revocation before returning data for best-effort provider logout. */
  revoke(): Promise<Pick<NewAuthSession, 'tokensCipher' | 'userId' | 'providerSessionId'> | null>;
}
export interface AuthStore {
  reserveChallenge(input: ChallengeInput): Promise<void>;
  markChallengeReady(hash: string): Promise<void>;
  markChallengeFailed(hash: string): Promise<void>;
  withChallenge<T>(hash: string, work: (lease: ChallengeLease) => Promise<T>): Promise<T>;
  withSession<T>(hash: string, work: (lease: SessionLease) => Promise<T>): Promise<T>;
}
