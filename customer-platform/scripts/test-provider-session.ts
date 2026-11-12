import { readSecretEnvFile } from '../server/config/secret-env.js';
import { readProviderProbeConfig } from './provider-test/config.js';

const allowedKeys = ['CUSTOMER_PROVIDER_TEST_APPROVED', 'CUSTOMER_PROVIDER_TEST_ALLOW_LOCAL_SIGNOUT',
  'CUSTOMER_PROVIDER_TEST_PROJECT_REF', 'CUSTOMER_SUPABASE_URL', 'CUSTOMER_SUPABASE_PUBLISHABLE_KEY',
  'CUSTOMER_PROVIDER_TEST_ACCESS_TOKEN_P', 'CUSTOMER_PROVIDER_TEST_ACCESS_TOKEN_Q'] as const;

async function main(): Promise<void> {
  let config;
  let failedReport: import('./provider-test/probe.js').ProviderProbeReport | undefined;
  let failedPhase: string | undefined;
  try {
    // 상위 승인도 파일 안 승인도 모두 필요한 실행 방어 장치다.
    if (process.env.CUSTOMER_PROVIDER_TEST_APPROVED !== 'true') throw new Error();
    const secret = readSecretEnvFile(new URL('../.env.provider-test', import.meta.url), allowedKeys);
    config = readProviderProbeConfig(secret);
  } catch {
    console.error('customer_provider_configuration');
    process.exitCode = 78;
    return;
  }
  try {
    // 승인·대상·파일 검사를 마치기 전에는 SDK나 네트워크 모듈을 로드하지 않는다.
    const { runProviderProbe, ProviderProbeFailure } = await import('./provider-test/probe.js');
    let report;
    try {
      report = await runProviderProbe(config);
    } catch (error) {
      if (error instanceof ProviderProbeFailure) {
        failedReport = error.report;
        failedPhase = error.phase;
      }
      throw error;
    }
    console.log(JSON.stringify(report));
    const counts = Object.values(report.dataApi);
    process.exitCode = report.normalP && report.normalQ && report.revokedP && report.tokenPStillUnexpired
      && report.otherQStillActive && report.cleanupP && report.cleanupQ && counts.every((count) => count === 3) ? 0 : 1;
  } catch {
    if (failedReport) console.log(JSON.stringify(failedReport));
    if (failedPhase) console.error(`customer_provider_probe_${failedPhase}`);
    else console.error('customer_provider_probe_failed');
    process.exitCode = 1;
  }
}

void main();
