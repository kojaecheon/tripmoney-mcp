import pg, { type Pool } from 'pg';
import { IdentityError } from '../../core/contracts.js';
import { connectionConfig } from './config.js';
import { identityDbError } from './actor.js';
import { inspectClientTransport, validateBackendTls, type DatabaseTransport } from './transport.js';

type RuntimeRole = 'app' | 'auth';
export function validateRuntimeRole(row: Record<string, unknown>, kind: RuntimeRole, transport: DatabaseTransport = 'direct'): void {
  try { validateBackendTls(row.backend_ssl, transport); }
  catch { throw new IdentityError('unavailable', 'DB 실행 권한 설정을 확인해 주세요.'); }
  const user = kind === 'app' ? 'customer_app_login' : 'customer_auth_login';
  if (row.current_user !== user || row.database !== 'postgres' || row.canlogin !== true
    || row.expected_role !== true || row.unexpected_memberships !== 0 || row.schema_create !== false
    || row.provider_table_read !== false || row.superuser !== false || row.bypassrls !== false
    || row.owns_customer_objects !== false
    || row.createdb !== false || row.createrole !== false || row.replication !== false
    || row.runtime_inherit !== true || row.runtime_set !== false || row.runtime_admin !== false
    || (row.actor_context !== null && row.actor_context !== '')
    || (row.session_context !== null && row.session_context !== '')) {
    throw new IdentityError('unavailable', 'DB 실행 권한 설정을 확인해 주세요.');
  }
}

const inspectionSql = `select current_user, current_database() as database,
  s.ssl as backend_ssl, r.rolsuper as superuser, r.rolbypassrls as bypassrls, r.rolcreatedb as createdb,
  r.rolcreaterole as createrole, r.rolreplication as replication, r.rolcanlogin as canlogin,
  m.inherit_option as runtime_inherit, m.set_option as runtime_set, m.admin_option as runtime_admin,
  pg_catalog.pg_has_role(current_user,$1,'USAGE') as expected_role,
  (select count(*)::integer from pg_catalog.pg_roles other
    where other.rolname not in (current_user,$1)
      and pg_catalog.pg_has_role(current_user,other.oid,'MEMBER')) as unexpected_memberships,
  (pg_catalog.has_schema_privilege(current_user,'public','CREATE')
    or pg_catalog.has_schema_privilege(current_user,'customer','CREATE')
    or pg_catalog.has_schema_privilege(current_user,'customer_private','CREATE')
    or pg_catalog.has_schema_privilege(current_user,'customer_auth','CREATE')) as schema_create,
  (exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('customer','customer_private','customer_auth')
        and pg_catalog.pg_has_role(current_user,c.relowner,'USAGE'))
    or exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('customer','customer_private','customer_auth')
        and pg_catalog.pg_has_role(current_user,p.proowner,'USAGE'))
    or exists(select 1 from pg_catalog.pg_namespace n
      where n.nspname in ('customer','customer_private','customer_auth')
        and pg_catalog.pg_has_role(current_user,n.nspowner,'USAGE'))) as owns_customer_objects,
  pg_catalog.has_any_column_privilege(current_user,
    (select c.oid from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='auth' and c.relname='sessions'),'SELECT') as provider_table_read,
  pg_catalog.current_setting('customer.actor_id',true) as actor_context,
  pg_catalog.current_setting('customer.session_hash',true) as session_context
  from pg_catalog.pg_roles r left join pg_catalog.pg_stat_ssl s on s.pid=pg_catalog.pg_backend_pid()
  left join pg_catalog.pg_auth_members m on m.member=r.oid
    and m.roleid=(select oid from pg_catalog.pg_roles where rolname=$1)
  where r.rolname=current_user`;

async function inspect(pool: Pool, kind: RuntimeRole, hostname: string): Promise<void> {
  const db = await pool.connect();
  try {
    const transport = inspectClientTransport(db, hostname);
    const result = await db.query(inspectionSql, [kind === 'app' ? 'customer_app' : 'customer_auth_runtime']);
    if (result.rows.length !== 1) throw new IdentityError('unavailable', 'DB 실행 권한 설정을 확인해 주세요.');
    validateRuntimeRole(result.rows[0] as Record<string, unknown>, kind, transport);
  } catch (error) { db.release(true); throw error; }
  db.release();
}

export async function createPools(config: { appUrl: string; authUrl: string }): Promise<{ app: Pool; auth: Pool }> {
  let app: Pool;
  let auth: Pool;
  try {
    const appConfig = connectionConfig(config.appUrl, 'app');
    const authConfig = connectionConfig(config.authUrl, 'auth');
    const verify = (hostname: string) => (client: pg.ClientBase) => {
      if (!(client instanceof pg.Client)) throw new Error('customer_db_transport_configuration');
      try { inspectClientTransport(client, hostname); }
      catch {
        // hook 실패 시 pg-pool은 Client.end callback을 기다린다. Node close 수명주기로 먼저 끊는다.
        try { client.connection.stream.destroy(); } catch { /* 정리 오류 원문은 노출하지 않는다. */ }
        throw new Error('customer_db_transport_configuration');
      }
    };
    // pg-pool 3.14.0의 onConnect는 새 연결을 acquire하기 전에 실행한다.
    app = new pg.Pool({ ...appConfig, onConnect: verify(new URL(config.appUrl).hostname) });
    auth = new pg.Pool({ ...authConfig, onConnect: verify(new URL(config.authUrl).hostname) });
  } catch (error) { throw identityDbError(error); }
  const idleError = () => { console.error('customer_db_idle_connection_error'); };
  app.on('error', idleError);
  auth.on('error', idleError);
  try {
    await inspect(app, 'app', new URL(config.appUrl).hostname);
    await inspect(auth, 'auth', new URL(config.authUrl).hostname);
    return { app, auth };
  } catch (error) {
    await Promise.allSettled([app.end(), auth.end()]);
    throw identityDbError(error);
  }
}
