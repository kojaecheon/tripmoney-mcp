import { IdentityError, type Action, type Role } from './contracts.js';

const permissions: Readonly<Record<Role, readonly Action[]>> = {
  owner: ['trip:read', 'trip:update', 'member:read', 'member:manage', 'invite:issue', 'invite:revoke', 'ledger:edit'],
  editor: ['trip:read', 'member:read', 'ledger:edit'],
  viewer: ['trip:read', 'member:read'],
};

// 인증은 호출자가 담당한다. 요청 본문의 role을 이 함수에 전달해서는 안 된다.
export function assertPermission(role: Role | null, action: Action): void {
  if (typeof role !== 'string' || !Object.hasOwn(permissions, role) ||
      !permissions[role].includes(action)) {
    throw new IdentityError('forbidden', '이 작업을 할 권한이 없습니다.');
  }
}
