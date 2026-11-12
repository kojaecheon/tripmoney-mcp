import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import pg, { type ClientConfig } from 'pg';
import { connectionConfig, readDbTestConfig } from '../server/db/config.js';
import { inspectClientTransport, validateBackendTls, type DatabaseTransport, type DatabaseTransportClient } from '../server/db/transport.js';
import { buildDbSetupEnv, checkedSnapshot, readHiddenPassword, saveDbSetupEnv } from './db-setup.js';

type Stage = 'local_preflight' | 'input' | 'admin_connect' | 'admin_auth' | 'role_preflight'
  | 'password_reset' | 'local_save' | 'commit' | 'postcheck' | 'close';
type ResetClient = DatabaseTransportClient & {
  connect(): Promise<unknown>;
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
type Input = Parameters<typeof readHiddenPassword>[0];
type Output = Parameters<typeof readHiddenPassword>[1];
const preflightDetails = ['client_transport', 'begin', 'settings', 'lock', 'inspection_query', 'role_guard'] as const;
type PreflightDetail = typeof preflightDetails[number];
export class AutoDbSetupError extends Error {
  readonly detail: PreflightDetail | undefined;
  constructor(public readonly stage: Stage, public readonly fileSaved: boolean, detail?: PreflightDetail,
    public readonly cancelled = false) {
    const safeDetail = stage === 'role_preflight' && detail !== undefined && preflightDetails.includes(detail) ? detail : undefined;
    super(`customer_db_auto_${stage}_failed${fileSaved ? '_file_saved' : ''}${safeDetail ? `_${safeDetail}` : ''}`);
    this.detail = safeDetail;
    this.name = 'AutoDbSetupError';
  }
}
const invalid = () => new Error('customer_db_auto_configuration');

export function generateServicePasswords(): { app: string; auth: string } {
  const app = randomBytes(32).toString('base64url');
  const auth = randomBytes(32).toString('base64url');
  if (app === auth) throw invalid();
  return { app, auth };
}

// 생성한 ASCII 비밀번호 전용이다. 관리자 비밀번호를 변경하거나 이 함수에 전달하지 않는다.
// PostgreSQL 17 src/common/scram-common.c와 RFC7677의 SHA256 계산·저장 형식이다.
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(password) || !Buffer.isBuffer(salt) || salt.length !== 16) throw invalid();
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
  salted.fill(0); clientKey.fill(0);
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

export function validateResetRoles(rows: Record<string, unknown>[], transport: DatabaseTransport = 'direct'): void {
  if (rows.length !== 2 || new Set(rows.map(row => row.login_name)).size !== 2) throw invalid();
  for (const row of rows) {
    validateBackendTls(row.backend_ssl, transport);
    if (!['customer_app_login', 'customer_auth_login'].includes(row.login_name as string)
      || row.admin_user !== 'postgres' || row.database !== 'postgres'
      || row.canlogin !== false || row.inherit !== true || row.superuser !== false
      || row.createdb !== false || row.createrole !== false || row.replication !== false
      || row.bypassrls !== false || row.runtime_inherit !== true || row.runtime_set !== false
      || row.runtime_admin !== false || row.membership_count !== 1 || row.unexpected_memberships !== 0
      || row.expected_runtime !== true || row.schema_create !== false || row.owns_customer_objects !== false
      || row.provider_table_read !== false || row.helper_absent !== true || row.can_manage !== true) throw invalid();
  }
}

const inspectionSql = `select current_user as admin_user,current_database() as database,s.ssl as backend_ssl,
  r.rolname as login_name,r.rolcanlogin as canlogin,r.rolinherit as inherit,
  r.rolsuper as superuser,r.rolcreatedb as createdb,r.rolcreaterole as createrole,
  r.rolreplication as replication,r.rolbypassrls as bypassrls,
  m.inherit_option as runtime_inherit,m.set_option as runtime_set,m.admin_option as runtime_admin,
  (select count(*)::integer from pg_catalog.pg_auth_members am where am.member=r.oid) as membership_count,
  (select count(*)::integer from pg_catalog.pg_roles other where other.oid not in (r.oid,rt.oid)
    and pg_catalog.pg_has_role(r.oid,other.oid,'MEMBER')) as unexpected_memberships,
  pg_catalog.pg_has_role(r.oid,rt.oid,'USAGE') as expected_runtime,
  exists(select 1 from pg_catalog.pg_namespace n
    where n.nspname in ('public','customer','customer_private','customer_auth')
      and pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')) as schema_create,
  (exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('customer','customer_private','customer_auth')
        and pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE'))
    or exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('customer','customer_private','customer_auth')
        and pg_catalog.pg_has_role(r.oid,p.proowner,'USAGE'))
    or exists(select 1 from pg_catalog.pg_namespace n
      where n.nspname in ('customer','customer_private','customer_auth')
        and pg_catalog.pg_has_role(r.oid,n.nspowner,'USAGE'))) as owns_customer_objects,
  pg_catalog.has_any_column_privilege(r.oid,(select c.oid from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and c.relname='sessions'),
    'SELECT') as provider_table_read,
  pg_catalog.to_regprocedure('customer_auth.provider_session_exists(uuid,uuid)') is null as helper_absent,
  (select me.rolsuper or (me.rolcreaterole and exists(select 1 from pg_catalog.pg_auth_members am
     where am.roleid=r.oid and am.member=me.oid and am.admin_option))
   from pg_catalog.pg_roles me where me.rolname=current_user) as can_manage
  from pg_catalog.pg_roles r
  join pg_catalog.pg_roles rt on rt.rolname=case r.rolname
    when 'customer_app_login' then 'customer_app' else 'customer_auth_runtime' end
  left join pg_catalog.pg_auth_members m on m.member=r.oid and m.roleid=rt.oid
  left join pg_catalog.pg_stat_ssl s on s.pid=pg_catalog.pg_backend_pid()
  where r.rolname in ('customer_app_login','customer_auth_login') order by r.rolname`;

type SetupOptions = { path: string; signal?: AbortSignal;
  createClient?: (config: ClientConfig) => ResetClient;
  onProgress?: (stage: 'admin_connect' | 'password_reset' | 'local_save') => void;
};
export function runAdminDbSetup(options: {
  input: Input; output: Output; path: string; signal?: AbortSignal;
  createClient?: (config: ClientConfig) => ResetClient;
}): Promise<void> { return runSetupCore({ ...options, source: 'tty' }); }

export function runAdminDbSetupWithPassword(options: SetupOptions & { password: string }): Promise<void> {
  return runSetupCore({ ...options, source: 'password' });
}

async function runSetupCore(options: SetupOptions & ({ source: 'tty'; input: Input; output: Output }
  | { source: 'password'; password: string })): Promise<void> {
  const { path, signal } = options;
  const input = options.source === 'tty' ? options.input : undefined;
  const output = options.source === 'tty' ? options.output : undefined;
  let stage: Stage = 'local_preflight', fileSaved = false, transaction = false, interrupted = false;
  let detail: PreflightDetail | undefined;
  let db: ResetClient | undefined;
  let failure: AutoDbSetupError | undefined, closing: Promise<void> | undefined;
  let abortPending: (() => void) | undefined, restored = false, userCancelled = false;
  let admin = '', service = { app: '', auth: '' };
  const previousRaw = input?.isRaw === true;
  const close = () => {
    if (!closing && db) {
      try { closing = Promise.resolve(db.end()); } catch { closing = Promise.reject(invalid()); }
      // 취소 경로가 먼저 시작한 정리 Promise도 unhandled rejection을 만들지 않는다.
      void closing.catch(() => {});
    }
    return closing ?? Promise.resolve();
  };
  const stop = () => { interrupted = true; abortPending?.(); };
  const discard = (chunk: Buffer | string) => {
    if (String(chunk).includes('\x03') || String(chunk).includes('\x04')) { userCancelled = true; stop(); }
  };
  const check = () => { if (interrupted || signal?.aborted) throw invalid(); };
  const restore = () => {
    if (restored) return;
    restored = true;
    input?.pause(); input?.removeListener('data', discard); input?.removeListener('error', stop);
    input?.removeListener('end', stop); input?.removeListener('close', stop);
    signal?.removeEventListener('abort', stop);
    try { if (input?.isTTY === true && typeof input.setRawMode === 'function') input.setRawMode(previousRaw); }
    catch { failure ??= new AutoDbSetupError('close', fileSaved); }
  };
  function bounded<T>(work: () => Promise<T>, milliseconds: number, cancellable = true): Promise<T> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown, value?: T) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (abortPending === cancel) abortPending = undefined;
        if (error !== undefined) reject(error); else resolve(value as T);
      };
      const cancel = () => { restore(); void close(); finish(invalid()); };
      const timer = setTimeout(cancel, milliseconds);
      if (cancellable) {
        abortPending = cancel;
        if (interrupted || signal?.aborted) { cancel(); return; }
      }
      Promise.resolve().then(() => finished ? undefined : work())
        .then(value => finish(undefined, value as T), error => finish(error));
    });
  }
  const query = (sql: string, timeout = 20000) => bounded(() => db!.query(sql), timeout);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (options.source === 'tty' && (input?.isTTY !== true || output?.isTTY !== true || typeof input.setRawMode !== 'function')) throw invalid();
    const before = checkedSnapshot(path);
    check();
    stage = 'input';
    if (options.source === 'tty') {
      options.input.setRawMode!(true);
      admin = await readHiddenPassword(options.input, options.output, '신규 개발 DB 관리자 비밀번호: ', signal);
      options.input.on('data', discard); options.input.once('error', stop);
      options.input.once('end', stop); options.input.once('close', stop); options.input.resume();
    } else {
      admin = options.password;
    }
    check();
    if (checkedSnapshot(path) !== before) throw invalid();
    service = generateServicePasswords();
    const config = readDbTestConfig(parseEnv(buildDbSetupEnv({ admin, ...service })));
    const clientConfig = { ...connectionConfig(config.adminUrl, 'admin'), query_timeout: 20000 };
    stage = 'admin_connect'; output?.write('1/3 공식 인증서로 관리자 연결 확인 중입니다.\n');
    options.onProgress?.('admin_connect');
    if (options.createClient) db = options.createClient(clientConfig);
    else {
      const client = new pg.Client(clientConfig);
      client.on('error', stop);
      db = client;
    }
    try { await bounded(() => db!.connect(), 6000); } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '28P01') stage = 'admin_auth';
      throw invalid();
    }
    check();
    stage = 'role_preflight';
    detail = 'client_transport';
    const transport = inspectClientTransport(db, new URL(clientConfig.connectionString!).hostname);
    detail = 'begin';
    await query('begin'); transaction = true;
    detail = 'settings';
    await query("set local lock_timeout='5s'");
    await query("set local statement_timeout='15s'");
    detail = 'lock';
    const lock = await query('select pg_catalog.pg_try_advisory_xact_lock(764237186201::bigint) as locked');
    if (lock.rows.length !== 1 || lock.rows[0]?.locked !== true) throw invalid();
    detail = 'inspection_query';
    const inspected = await query(inspectionSql);
    detail = 'role_guard';
    validateResetRoles(inspected.rows, transport);
    check();
    stage = 'password_reset'; output?.write('2/3 두 서비스 계정의 새 비밀번호를 자동 설정 중입니다.\n');
    options.onProgress?.('password_reset');
    for (const [role, password] of [['customer_app_login', service.app], ['customer_auth_login', service.auth]] as const) {
      check();
      // 외부 식별자·원문 비밀번호를 SQL에 넣지 않는다. verifier는 고정 Base64 형식만 생성한다.
      await query(`alter role ${role} password '${scramVerifier(password)}'`);
    }
    check();
    stage = 'local_save'; output?.write('3/3 연결 파일을 로컬에 안전하게 저장 중입니다.\n');
    options.onProgress?.('local_save');
    saveDbSetupEnv(path, { admin, ...service }, before); fileSaved = true;
    check();
    stage = 'commit'; await query('commit'); transaction = false;
    stage = 'postcheck'; validateResetRoles((await query(inspectionSql)).rows, transport); check();
    // LOGIN은 메인이 저장 결과·권한을 재확인한 뒤 활성화한다. 이 도우미는 접속을 열지 않는다.
  } catch {
    failure = new AutoDbSetupError(stage, fileSaved, detail, userCancelled || signal?.aborted === true);
    // 네트워크 정리 응답보다 터미널 복원을 먼저 수행한다.
    restore();
    if (db && transaction && !closing) {
      try { await query('rollback', 5000); } catch { /* 불확실한 커밋·rollback은 성공으로 기록하지 않는다. */ }
    }
  } finally {
    admin = ''; service.app = ''; service.auth = '';
    restore();
    try { await bounded(close, 5000, false); } catch { failure ??= new AutoDbSetupError('close', fileSaved); }
  }
  if (failure) throw failure;
}
