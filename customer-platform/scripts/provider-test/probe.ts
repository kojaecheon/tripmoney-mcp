import { IdentityError } from '../../core/contracts.js';
import { createProviderAccessVerifier, ProviderAccessFailure } from '../../server/auth/provider-access.js';
import type { VerifiedProviderAccess } from '../../server/auth/provider-access.js';
import type { ProviderProbeConfig } from './config.js';
import { checkCustomerDataApi, DataApiFailure } from './data-api.js';
import type { DataApiReport } from './data-api.js';

export type ProviderProbeReport = {
  normalP: boolean; normalQ: boolean; dataApi: DataApiReport;
  revokedP: boolean; tokenPStillUnexpired: boolean; otherQStillActive: boolean;
  cleanupP: boolean; cleanupQ: boolean;
};
type ProbePhase = 'normal_p' | 'normal_q' | 'session_pair' | 'data_api' | 'revoke_p'
  | 'revoked_p' | 'q_active' | 'cleanup';

export class ProviderProbeFailure extends IdentityError {
  constructor(public readonly phase: ProbePhase, public readonly report: ProviderProbeReport) {
    super('unavailable', 'customer_provider_probe_failed');
  }
}

async function localLogout(config: ProviderProbeConfig, accessToken: string,
  cleanup: boolean, fetcher: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(`${config.url}/auth/v1/logout?scope=local`, {
          method: 'POST', headers: { apikey: config.publishableKey, Authorization: `Bearer ${accessToken}`,
            'X-Supabase-Api-Version': '2024-01-01' },
          redirect: 'error', cache: 'no-store', signal: controller.signal,
        });
        if (response.status >= 200 && response.status < 300) {
          await response.body?.cancel();
          return true;
        }
        if (!cleanup || ![401, 403, 404].includes(response.status)) {
          await response.body?.cancel();
          return false;
        }
        const body: unknown = await response.json();
        if (typeof body !== 'object' || body === null) return false;
        const code = 'code' in body ? body.code : undefined;
        const legacy = 'error_code' in body ? body.error_code : undefined;
        return (code === 'session_not_found' || legacy === 'session_not_found')
          && (code === undefined || code === 'session_not_found')
          && (legacy === undefined || legacy === 'session_not_found');
      })(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(false); }, 5000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runProviderProbe(config: ProviderProbeConfig, deps: {
  fetcher?: typeof fetch; now?: () => number;
} = {}): Promise<ProviderProbeReport> {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  const report: ProviderProbeReport = { normalP: false, normalQ: false,
    dataApi: { anonymousRest: 0, authenticatedRest: 0, anonymousRpc: 0, authenticatedRpc: 0 },
    revokedP: false, tokenPStillUnexpired: false, otherQStillActive: false, cleanupP: false, cleanupQ: false };
  let phase: ProbePhase = 'normal_p';
  let failure: ProbePhase | undefined;
  let verifiedP: VerifiedProviderAccess | undefined;
  let verifiedQ: VerifiedProviderAccess | undefined;
  const live = (access: VerifiedProviderAccess) => {
    const time = now();
    return Number.isFinite(time) && access.expiresAtSeconds > time / 1000;
  };
  try {
    const verify = createProviderAccessVerifier({ url: config.url, publishableKey: config.publishableKey, fetcher, now });
    verifiedP = await verify(config.tokenP);
    report.normalP = true;
    phase = 'normal_q';
    const q = await verify(config.tokenQ);
    report.normalQ = true;
    phase = 'session_pair';
    if (verifiedP.userId !== q.userId || verifiedP.providerSessionId === q.providerSessionId) throw new Error();
    verifiedQ = q;
    if (verifiedP.expiresAtSeconds - now() / 1000 < 300) throw new Error();
    phase = 'data_api';
    if (!live(q)) throw new Error();
    try {
      report.dataApi = await checkCustomerDataApi(config, config.tokenQ, fetcher);
    } catch (error) {
      if (error instanceof DataApiFailure) report.dataApi = error.report;
      throw error;
    }
    if (!live(q)) throw new Error();
    phase = 'revoke_p';
    if (!await localLogout(config, config.tokenP, false, fetcher)) throw new Error();
    phase = 'revoked_p';
    report.tokenPStillUnexpired = live(verifiedP);
    if (!report.tokenPStillUnexpired) throw new Error();
    try {
      await verify(config.tokenP, { kind: 'session', userId: verifiedP.userId,
        providerSessionId: verifiedP.providerSessionId });
    } catch (error) {
      if (error instanceof ProviderAccessFailure && error.reason === 'session_not_found') report.revokedP = true;
      else throw error;
    }
    report.tokenPStillUnexpired = live(verifiedP);
    if (!report.revokedP || !report.tokenPStillUnexpired) throw new Error();
    phase = 'q_active';
    await verify(config.tokenQ, { kind: 'session', userId: q.userId, providerSessionId: q.providerSessionId });
    report.otherQStillActive = true;
  } catch {
    failure = phase;
  } finally {
    // 정상 검증한 P와 같은 사용자의 독립 세션으로 확인한 Q만 정리한다.
    if (verifiedP) report.cleanupP = await localLogout(config, config.tokenP, true, fetcher);
    if (verifiedQ) report.cleanupQ = await localLogout(config, config.tokenQ, true, fetcher);
  }
  if (failure) throw new ProviderProbeFailure(failure, report);
  if (!report.cleanupP || !report.cleanupQ) throw new ProviderProbeFailure('cleanup', report);
  return report;
}
