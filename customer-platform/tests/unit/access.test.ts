import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPermission } from '../../core/access.js';
import { IdentityError, type Action, type Role } from '../../core/contracts.js';

const actions: Action[] = [
  'trip:read', 'trip:update', 'member:read', 'member:manage',
  'invite:issue', 'invite:revoke', 'ledger:edit',
];
// 이 표의 허용/거부는 승인된 역할 계약에서 직접 가져온 기대값이다.
const grants: [Role, boolean[]][] = [
  ['owner',  [true, true, true, true, true, true, true]],
  ['editor', [true, false, true, false, false, false, true]],
  ['viewer', [true, false, true, false, false, false, false]],
];
const forbidden = (error: unknown) =>
  error instanceof IdentityError && error.code === 'forbidden';

for (const [role, allowed] of grants) {
  actions.forEach((action, i) => {
    test(`${role}의 ${action} 요청은 ${allowed[i] ? '허용' : '거부'}한다`, () => {
      if (allowed[i]) assert.doesNotThrow(() => assertPermission(role, action));
      else assert.throws(() => assertPermission(role, action), forbidden);
    });
  });
}

for (const role of [null, undefined, '', 'OWNER', 'admin', '__proto__', 'constructor', 1, {}, []]) {
  test(`허용 역할이 아닌 ${String(role)}는 고객 권한 오류로 거부한다`, () => {
    assert.throws(() => assertPermission(role as Role, 'trip:read'), forbidden);
  });
}
for (const action of ['trip:delete', '__proto__', 'constructor', '', null, {}]) {
  test(`허용 동작이 아닌 ${String(action)}는 소유자도 실행할 수 없다`, () => {
    assert.throws(() => assertPermission('owner', action as Action), forbidden);
  });
}
