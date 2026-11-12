export type Role = 'owner' | 'editor' | 'viewer';
export type Mode = 'daily' | 'end_of_trip';
export type Action = 'trip:read' | 'trip:update' | 'member:read'
  | 'member:manage' | 'invite:issue' | 'invite:revoke' | 'ledger:edit';
export type ErrorCode = 'unauthenticated' | 'forbidden' | 'not_found'
  | 'conflict' | 'invite_unavailable' | 'validation' | 'rate_limited' | 'unavailable';

export class IdentityError extends Error {
  constructor(public code: ErrorCode, message: string, public field?: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

// 이후 DB·인증 작업이 소비할 계약이다. 타입 선언은 실제 인증·저장을 수행하지 않는다.
export type Actor = { userId: string; sessionHash: string };
export type TripInput = {
  name: string; destination: string; startDate: string; endDate: string;
  timeZone: string; budgetKrw: number; alias: string;
  settlementMode: Mode; dailyTime: string;
};
export type Member = {
  id: string; tripId: string; userId: string; alias: string; role: Role; active: boolean;
};
export type Trip = Omit<TripInput, 'alias'> & {
  id: string; ownerUserId: string; revision: number; status: 'active'; createdAt: string;
};
export type Invite = {
  id: string; tripId: string; role: 'editor' | 'viewer'; keyId: string;
  tokenHash: string; expiresAt: string; status: 'pending' | 'accepted' | 'revoked';
  acceptedBy: string | null;
};
export type Change<T> = { value: T; tripRevision: number; replayed: boolean };
export type ProviderTokens = {
  accessToken: string; refreshToken: string;
  expiresAt: number; // Unix epoch seconds. Date.now()의 밀리초와 구분한다.
  userId: string; providerSessionId: string;
};
export type VerifiedSession = { actor: Actor; email: string; expiresAt: string };
