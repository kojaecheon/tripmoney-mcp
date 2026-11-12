export type ProviderProbeConfig = {
  url: string; publishableKey: string; tokenP: string; tokenQ: string;
};

const configurationError = (): never => { throw new Error('customer_provider_configuration'); };
const projectRef = 'agddopryfqsyfshoowgk';
const nonemptyHeader = (value: string | undefined): value is string =>
  typeof value === 'string' && value.length > 0 && !/\s/.test(value);

export function readProviderProbeConfig(env: NodeJS.ProcessEnv): ProviderProbeConfig {
  const { CUSTOMER_SUPABASE_URL: url, CUSTOMER_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    CUSTOMER_PROVIDER_TEST_ACCESS_TOKEN_P: tokenP, CUSTOMER_PROVIDER_TEST_ACCESS_TOKEN_Q: tokenQ } = env;
  if (env.CUSTOMER_PROVIDER_TEST_APPROVED !== 'true'
    || env.CUSTOMER_PROVIDER_TEST_ALLOW_LOCAL_SIGNOUT !== 'true'
    || env.CUSTOMER_PROVIDER_TEST_PROJECT_REF !== projectRef
    || url !== `https://${projectRef}.supabase.co`
    || !publishableKey || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)
    || !nonemptyHeader(tokenP) || !nonemptyHeader(tokenQ) || tokenP === tokenQ) return configurationError();
  return { url, publishableKey, tokenP, tokenQ };
}
