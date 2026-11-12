import type { PoolConfig } from 'pg';
import { databaseTls } from './tls.js';

// 공개 식별값이다. 다른 DB를 대상으로 바꾸려면 대상·비용·변경 범위를 다시 승인받는다.
export const approvedDevelopmentProjectRef = 'agddopryfqsyfshoowgk';
export type ConnectionRole = 'app' | 'auth' | 'admin';
export type DbTestConfig = { appUrl: string; authUrl: string; adminUrl: string; targetId: string };
const login = { app: 'customer_app_login', auth: 'customer_auth_login', admin: 'postgres' } as const;
const configError = (): never => { throw new Error('customer_db_configuration'); };

function checkedUrl(value: string | undefined, role: ConnectionRole): URL {
  if (!value) return configError();
  let parsed: URL;
  try { parsed = new URL(value); } catch { return configError(); }
  const direct = parsed.hostname === `db.${approvedDevelopmentProjectRef}.supabase.co`;
  const pooled = parsed.hostname === 'aws-0-ap-northeast-2.pooler.supabase.com'
    || parsed.hostname === 'aws-1-ap-northeast-2.pooler.supabase.com';
  const expectedUser = pooled ? `${login[role]}.${approvedDevelopmentProjectRef}` : login[role];
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch { return configError(); }
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol) || (!direct && !pooled)
    || username !== expectedUser || !password || password === '[YOUR-PASSWORD]'
    || password === 'REPLACE_WITH_URL_ENCODED_PASSWORD'
    || parsed.pathname !== '/postgres' || (parsed.port && parsed.port !== '5432')
    || parsed.search || parsed.hash) return configError();
  parsed.port = '5432';
  return parsed;
}

export function connectionConfig(value: string, role: ConnectionRole): PoolConfig {
  const parsed = checkedUrl(value, role);
  return {
    connectionString: parsed.toString(),
    ssl: databaseTls(),
    max: 3,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    application_name: `tripmoney-customer-${role}`,
    options: '-c search_path=pg_catalog',
  };
}

export function readDbTestConfig(env: NodeJS.ProcessEnv): DbTestConfig {
  if (env.CUSTOMER_DB_TEST_APPROVED !== 'true') return configError();
  const app = checkedUrl(env.CUSTOMER_DB_TEST_URL, 'app');
  const admin = checkedUrl(env.CUSTOMER_DB_TEST_ADMIN_URL, 'admin');
  const auth = checkedUrl(env.CUSTOMER_DB_AUTH_URL, 'auth');
  const id = (url: URL) => `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  if (!env.CUSTOMER_DB_TEST_ID || id(app) !== env.CUSTOMER_DB_TEST_ID
    || id(admin) !== env.CUSTOMER_DB_TEST_ID || id(auth) !== env.CUSTOMER_DB_TEST_ID) return configError();
  return { appUrl: app.toString(), authUrl: auth.toString(), adminUrl: admin.toString(), targetId: env.CUSTOMER_DB_TEST_ID };
}
