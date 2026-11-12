import type { HttpConfig } from './config.js';
export const cookieNames = (config: HttpConfig) => config.secure
  ? { session: '__Host-tripmoney_session', challenge: '__Host-tripmoney_challenge' }
  : { session: 'tripmoney_session_dev', challenge: 'tripmoney_challenge_dev' };
export function canonicalToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 8192) return undefined;
  const parts = header.split(';').map(value => value.trim());
  // Malformed pairs invalidate the entire cookie header, including duplicate target names.
  if (parts.some(value => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[\x21-\x3A\x3C-\x7E]*$/.test(value))) return undefined;
  const values = parts.filter(value => value.slice(0, value.indexOf('=')) === name);
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(name.length + 1);
  return canonicalToken(value) ? value : undefined;
}
export function serializeCookie(config: HttpConfig, kind: 'session' | 'challenge', token: string, age: number): string {
  if (token && !canonicalToken(token)) throw new Error('Invalid cookie token');
  return `${cookieNames(config)[kind]}=${token}; Max-Age=${Math.max(0, Math.min(86400, Math.floor(age)))}; Path=/; HttpOnly; SameSite=Lax${config.secure ? '; Secure' : ''}`;
}
