import { createClient } from '@supabase/supabase-js';
import { createProviderAccessVerifier } from '../../server/auth/provider-access.js';
import type { VerifiedProviderAccess } from '../../server/auth/provider-access.js';
import { ProviderProbeFailure, runProviderProbe } from './probe.js';
import type { ProviderProbeReport } from './probe.js';

export type PreparedProviderResult = {
  status: 'passed' | 'failed' | 'cancelled'; code?: string;
  report: ProviderProbeReport | null; cleanupComplete: boolean; cleanupUncertain: boolean;
};

const PROJECT_URL = 'https://agddopryfqsyfshoowgk.supabase.co';
const prefix = 'customer_provider_prepare_';
type OwnedSession = { token: string; access: VerifiedProviderAccess; attempted: boolean;
  complete: boolean; uncertain: boolean };

function alreadyAbsent(response: Response, body: ArrayBuffer): boolean {
  if (![401, 403, 404].includes(response.status)) return false;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    const value = parsed as Record<string, unknown>;
    return (value.code === 'session_not_found' || value.error_code === 'session_not_found')
      && (value.code === undefined || value.code === 'session_not_found')
      && (value.error_code === undefined || value.error_code === 'session_not_found');
  } catch { return false; }
}

export async function runPreparedProviderProbe(options: {
  email: string; password: string; publishableKey: string; signal?: AbortSignal;
}, deps: { fetcher?: typeof fetch; now?: () => number } = {}): Promise<PreparedProviderResult> {
  const result: PreparedProviderResult = { status: 'failed', report: null,
    cleanupComplete: true, cleanupUncertain: false };
  if (typeof options.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email.trim())
    || typeof options.password !== 'string' || options.password.length === 0
    || typeof options.publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(options.publishableKey)) {
    return { ...result, code: `${prefix}configuration` };
  }
  const email = options.email.trim().toLowerCase();
  const now = deps.now ?? Date.now;
  const rawFetch = deps.fetcher ?? fetch;
  const owned: OwnedSession[] = [];
  let unknownIssuance = false;
  let phase = 'login_p';
  let firstFailure: string | undefined;
  let loginStarted = false;
  let loginRejected = false;
  const fail = (code: string) => { firstFailure ??= `${prefix}${code}`; };

  // Reading the body belongs to the same deadline as receiving its headers.
  // Logout uses a fresh signal so user cancellation never skips local cleanup.
  const boundedFetch: typeof fetch = async (resource, init) => {
    const target = new URL(String(resource));
    const logout = target.pathname === '/auth/v1/logout';
    const login = target.pathname === '/auth/v1/token';
    const bearer = new Headers(init?.headers).get('authorization');
    const session = logout ? owned.find(value => bearer === `Bearer ${value.token}`) : undefined;
    if (logout && !session) throw new Error(`${prefix}cleanup`);
    if (!logout && options.signal?.aborted) {
      fail('cancelled');
      throw new Error(`${prefix}cancelled`);
    }
    if (login) loginStarted = true;
    if (session) session.attempted = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (reason: Error) => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abort = () => {
      if (!logout) fail('cancelled');
      controller.abort();
      rejectAbort(new Error(`${prefix}${logout ? 'cleanup' : 'cancelled'}`));
    };
    if (!logout) options.signal?.addEventListener('abort', abort, { once: true });
    try {
      timer = setTimeout(() => {
        controller.abort();
        if (session) session.uncertain = true;
        rejectAbort(new Error(`${prefix}transport`));
      }, 5000);
      return await Promise.race([
        (async () => {
          const response = await rawFetch(resource, { ...init, signal: controller.signal,
            cache: 'no-store', redirect: 'error' });
          const body = await response.arrayBuffer();
          if (!logout && options.signal?.aborted) throw new Error(`${prefix}cancelled`);
          if (login && response.status >= 400 && response.status < 500 && response.status !== 429) {
            loginRejected = true;
            fail(phase);
          }
          if (session) session.complete = (response.status >= 200 && response.status < 300)
            || alreadyAbsent(response, body);
          if (!logout && phase === 'probe' && target.pathname.startsWith('/rest/v1/')
            && response.status !== 406) fail('probe');
          return new Response(response.status === 204 || response.status === 205 || response.status === 304
            ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
        })(), interrupted,
      ]);
    } catch {
      if (session) session.uncertain = true;
      else if (options.signal?.aborted) fail('cancelled');
      else fail(phase === 'probe' ? 'probe' : phase);
      throw new Error(`${prefix}transport`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!logout) options.signal?.removeEventListener('abort', abort);
    }
  };
  const verify = createProviderAccessVerifier({ url: PROJECT_URL, publishableKey: options.publishableKey,
    fetcher: boundedFetch, now });
  const login = async (): Promise<{ token: string; access: VerifiedProviderAccess }> => {
    loginStarted = false;
    loginRejected = false;
    const client = createClient(PROJECT_URL, options.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false },
      global: { fetch: boundedFetch },
    });
    try {
      const { data, error } = await client.auth.signInWithPassword({ email, password: options.password });
      if (error || !data.session?.access_token) throw new Error();
      const access = await verify(data.session.access_token, { kind: 'login', normalizedEmail: email });
      return { token: data.session.access_token, access };
    } catch {
      if (loginStarted && !loginRejected) unknownIssuance = true;
      throw new Error(`${prefix}${phase}`);
    }
  };
  try {
    if (options.signal?.aborted) { fail('cancelled'); throw new Error(); }
    const p = await login();
    owned.push({ ...p, attempted: false, complete: false, uncertain: false });
    phase = 'session_pair';
    if (p.access.expiresAtSeconds - now() / 1000 < 300) throw new Error();
    if (options.signal?.aborted) { fail('cancelled'); throw new Error(); }
    phase = 'login_q';
    const q = await login();
    phase = 'session_pair';
    if (p.access.userId !== q.access.userId || p.access.providerSessionId === q.access.providerSessionId) {
      // Do not terminate a returned session belonging to an unexpected identity.
      unknownIssuance = p.access.providerSessionId !== q.access.providerSessionId;
      throw new Error();
    }
    owned.push({ ...q, attempted: false, complete: false, uncertain: false });
    phase = 'probe';
    result.report = await runProviderProbe({ url: PROJECT_URL, publishableKey: options.publishableKey,
      tokenP: p.token, tokenQ: q.token }, { fetcher: boundedFetch, now });
  } catch (error) {
    if (error instanceof ProviderProbeFailure) {
      result.report = error.report;
      fail(error.phase === 'cleanup' ? 'cleanup' : 'probe');
    } else fail(phase);
  } finally {
    // Probe already attempts each owned session. A failed logout is never retried here.
    for (const session of owned) {
      if (!session.attempted) {
        try {
          const response = await boundedFetch(`${PROJECT_URL}/auth/v1/logout?scope=local`, {
            method: 'POST', headers: { apikey: options.publishableKey, Authorization: `Bearer ${session.token}`,
              'X-Supabase-Api-Version': '2024-01-01' },
          });
          await response.body?.cancel();
        } catch { /* Fixed result fields below carry cleanup uncertainty. */ }
      }
    }
    result.cleanupUncertain = unknownIssuance || owned.some(session => session.uncertain);
    result.cleanupComplete = !result.cleanupUncertain && owned.every(session => session.complete);
    if (!result.cleanupComplete) fail(result.cleanupUncertain ? 'cleanup_unknown' : 'cleanup');
  }
  if (firstFailure) {
    result.code = firstFailure;
    result.status = firstFailure === `${prefix}cancelled` ? 'cancelled' : 'failed';
  } else result.status = 'passed';
  return result;
}
