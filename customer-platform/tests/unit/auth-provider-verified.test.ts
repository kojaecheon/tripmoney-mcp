import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthProvider, type AuthProvider } from '../../server/auth/provider.js';

test('refreshVerified는 갱신과 getUser를 각 1회 호출하고 검증한 identity를 반환한다', async () => {
  const url = 'https://agddopryfqsyfshoowgk.supabase.co';
  const userId = '11111111-1111-4111-8111-111111111111';
  const providerSessionId = '22222222-2222-4222-8222-222222222222';
  const accessToken = `e30.${Buffer.from(JSON.stringify({ iss: `${url}/auth/v1`, sub: userId,
    aud: 'authenticated', exp: 1800001200, session_id: providerSessionId })).toString('base64url')}.c3ludGhldGlj`;
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'tester@example.com',
    is_anonymous: false, email_confirmed_at: '2026-10-01T00:00:00Z', app_metadata: {}, user_metadata: {},
    created_at: '2026-10-01T00:00:00Z' };
  const calls: string[] = [];
  const provider = createAuthProvider({ url, publishableKey: 'sb_publishable_unit_only_not_a_real_key',
    now: () => 1800000000000, fetcher: async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify(String(input).endsWith('/user') ? user : {
        access_token: accessToken, refresh_token: 'rotated_synthetic', expires_at: 1800001200,
        expires_in: 1200, token_type: 'bearer', user }), { status: 200,
        headers: { 'Content-Type': 'application/json' } });
    } });
  const legacy: AuthProvider = provider;
  assert.equal(typeof legacy.refresh, 'function');
  const result = await provider.refreshVerified({ accessToken, refreshToken: 'old_synthetic',
    expiresAt: 1799999999, userId, providerSessionId });
  assert.deepEqual(result, { tokens: { accessToken, refreshToken: 'rotated_synthetic',
    expiresAt: 1800001200, userId, providerSessionId }, identity: { userId, email: 'tester@example.com' } });
  assert.deepEqual(calls, [`${url}/auth/v1/token?grant_type=refresh_token`, `${url}/auth/v1/user`]);
});
