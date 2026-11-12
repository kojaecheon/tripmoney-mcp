import { randomUUID } from 'node:crypto';
import { IdentityError } from '../../core/contracts.js';
import type { ProviderProbeConfig } from './config.js';

export type DataApiReport = {
  anonymousRest: number; authenticatedRest: number; anonymousRpc: number; authenticatedRpc: number;
};

const unavailable = () => new IdentityError('unavailable', '고객 스키마의 API 비노출을 확인하지 못했습니다.');

export class DataApiFailure extends IdentityError {
  constructor(public readonly report: DataApiReport) {
    super('unavailable', '고객 스키마의 API 비노출을 확인하지 못했습니다.');
  }
}

async function checkBlocked(url: string, init: RequestInit, fetcher: typeof fetch): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const response = await fetcher(url, { ...init, redirect: 'error', cache: 'no-store', signal: controller.signal });
        const body: unknown = await response.json();
        if (response.status !== 406 || typeof body !== 'object' || body === null
          || !('code' in body) || body.code !== 'PGRST106') throw unavailable();
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, 5000);
      }),
    ]);
  } catch {
    throw unavailable();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function checkCustomerDataApi(config: ProviderProbeConfig, accessToken: string,
  fetcher: typeof fetch = fetch): Promise<DataApiReport> {
  const report: DataApiReport = { anonymousRest: 0, authenticatedRest: 0, anonymousRpc: 0, authenticatedRpc: 0 };
  const requests = [
    { path: '/rest/v1/trips?select=created_at&limit=0', profile: 'customer', method: 'GET' },
    { path: '/rest/v1/audit_events?select=created_at&limit=0', profile: 'customer_private', method: 'GET' },
    { path: '/rest/v1/sessions?select=created_at&limit=0', profile: 'customer_auth', method: 'GET' },
    { path: '/rest/v1/rpc/tripmoney_schema_probe_not_a_function', profile: 'customer', method: 'POST', body: {} },
    { path: '/rest/v1/rpc/is_member', profile: 'customer_private', method: 'POST', body: { t: randomUUID() } },
    { path: '/rest/v1/rpc/session_live', profile: 'customer_auth', method: 'POST', body: {} },
  ];
  for (const authenticated of [false, true]) {
    for (const request of requests) {
      const rest = request.method === 'GET';
      const headers: Record<string, string> = { apikey: config.publishableKey,
        [rest ? 'Accept-Profile' : 'Content-Profile']: request.profile };
      if (authenticated) headers.Authorization = `Bearer ${accessToken}`;
      if (!rest) headers['Content-Type'] = 'application/json';
      try {
        await checkBlocked(config.url + request.path, { method: request.method, headers,
          ...(!rest ? { body: JSON.stringify(request.body) } : {}) }, fetcher);
      } catch {
        throw new DataApiFailure({ ...report });
      }
      report[rest ? (authenticated ? 'authenticatedRest' : 'anonymousRest')
        : (authenticated ? 'authenticatedRpc' : 'anonymousRpc')]++;
    }
  }
  return report;
}
