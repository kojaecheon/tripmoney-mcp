import { randomUUID } from 'node:crypto';
import { IdentityError } from '../../core/contracts.js';
export class AccountChanged extends Error {}
export class AcceptConflict extends IdentityError {
  constructor(readonly reason: 'alias_taken'|'member_limit') { super('conflict', '초대 수락 조건을 확인해 주세요.'); }
}
const errors = {
  account_changed: [412, '로그인한 계정이 변경되었습니다.'],
  unauthenticated: [401, '다시 로그인해 주세요.'], forbidden: [403, '허용되지 않은 요청입니다.'],
  not_found: [404, '요청한 경로를 찾을 수 없습니다.'], validation: [422, '입력 형식을 확인해 주세요.'],
  conflict: [409, '최신 정보를 확인한 뒤 다시 시도해 주세요.'], invite_unavailable: [410, '사용할 수 없는 초대입니다.'],
  rate_limited: [429, '잠시 뒤 다시 요청해 주세요.'], unavailable: [503, '인증 확인을 잠시 사용할 수 없습니다.'],
} as const;
export function publicError(error: unknown) {
  const candidate = error instanceof AccountChanged ? 'account_changed' : error instanceof IdentityError ? error.code : 'unavailable';
  const code = Object.hasOwn(errors, candidate) ? candidate as keyof typeof errors : 'unavailable';
  const [status, message] = errors[code];
  const field = error instanceof IdentityError && code === 'validation' && [
    'email', 'code', 'trip', 'name', 'destination', 'startDate', 'endDate', 'timeZone', 'budgetKrw',
    'alias', 'settlementMode', 'dailyTime', 'operationId', 'expectedRevision', 'tripId', 'memberId', 'inviteId', 'role', 'active', 'token',
    'title', 'date', 'startTime', 'endTime', 'place', 'amount', 'currency', 'occurredLocal', 'itineraryId',
    'payerId', 'splitIds', 'rateMilli', 'source', 'refreshRate', 'ids', 'settlementLocked', 'toMemberId', 'amountKrw',
    'expectedPaymentRevision',
  ].includes(error.field ?? '') ? error.field : undefined;
  const reason = error instanceof AcceptConflict && ['alias_taken','member_limit'].includes(error.reason) ? error.reason : undefined;
  return { status, body: { error: { code, message, ...(reason ? { reason } : {}), ...(field ? { field } : {}) }, requestId: randomUUID() } };
}
