import type { IncomingMessage } from 'node:http';
import { IdentityError } from '../../core/contracts.js';
import { readEmailLinkTokens } from '../auth/provider.js';
import type { AuthService } from '../auth/service.js';
import type { HttpConfig } from './config.js';
import { cookieNames, readCookie, serializeCookie } from './cookies.js';
import { readJsonBody } from './json-body.js';

// The caller applies the server's exact Host, Origin, content type and request-header boundary.
export async function handleAuthLinkRoute(req: IncomingMessage,
  { config, authService }: { config: HttpConfig; authService: AuthService }) {
  const challenge = readCookie(req.headers.cookie, cookieNames(config).challenge);
  if (!challenge) throw new IdentityError('unauthenticated', '다시 로그인해 주세요.');
  const tokens = readEmailLinkTokens(await readJsonBody(req));
  if (!authService.verifyEmailLink) throw new IdentityError('unavailable', '인증 확인을 잠시 사용할 수 없습니다.');
  const result = await authService.verifyEmailLink(challenge, tokens);
  const me = { userId: result.me.userId, email: result.me.email, expiresAt: result.me.expiresAt };
  return { me, cookies: [
    serializeCookie(config, 'session', result.sessionToken, (Date.parse(me.expiresAt) - Date.now()) / 1000),
    serializeCookie(config, 'challenge', '', 0),
  ] };
}
