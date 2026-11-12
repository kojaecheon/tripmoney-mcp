import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AutoDbSetupError, runAdminDbSetupWithPassword } from './db-auto-setup.js';
import { DB_SETUP_SCRIPT, DB_SETUP_STYLE, renderDbSetupPage } from './db-browser-page.js';

export type DbBrowserSetupResult = {
  status: 'saved' | 'failed' | 'cancelled'; code?: string; fileSaved: boolean | null;
};
export type DbBrowserSetupOptions = {
  path: string;
  runSetup?: typeof runAdminDbSetupWithPassword;
  idleTimeoutMs?: number;
  testTimeouts?: { bodyTimeoutMs?: number; closeTimeoutMs?: number };
};
const failed = (code: string): DbBrowserSetupResult => ({ status: 'failed', code, fileSaved: false });
const cancelled = (): DbBrowserSetupResult => ({ status: 'cancelled', fileSaved: false });
const safeAutoCode = /^customer_db_auto_(?:(?:local_preflight|input|admin_connect|admin_auth|password_reset|local_save|commit|postcheck|close)_failed(?:_file_saved)?|role_preflight_failed(?:_file_saved)?(?:_(?:client_transport|begin|settings|lock|inspection_query|role_guard))?)$/;

function validPassword(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 1024
    || /[\u0000-\u001f\u007f]/u.test(value)
    || ['[YOUR-PASSWORD]', 'REPLACE_WITH_URL_ENCODED_PASSWORD'].includes(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}
function oneHeader(req: IncomingMessage, name: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() !== name) continue;
    if (value !== undefined) return undefined;
    value = req.rawHeaders[index + 1];
  }
  return value;
}
function send(res: ServerResponse, status: number, content: string, type = 'application/json; charset=utf-8') {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Connection': 'close',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(content);
}
function sendResult(res: ServerResponse, result: DbBrowserSetupResult, status = 200) {
  send(res, status, JSON.stringify(result));
}
function readBody(req: IncomingMessage, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [], size = 0, finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      req.removeListener('data', data); req.removeListener('end', end);
      req.removeListener('error', stop); req.removeListener('aborted', stop);
      const bytes = Buffer.concat(chunks); chunks = [];
      if (error) { bytes.fill(0); req.resume(); reject(error); return; }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed as Record<string, unknown>);
      } catch { reject(new Error('customer_db_browser_request_rejected')); }
      finally { bytes.fill(0); }
    };
    const stop = () => finish(new Error('customer_db_browser_request_rejected'));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) { stop(); return; }
      chunks.push(chunk);
    };
    const end = () => finish();
    const timer = setTimeout(stop, timeoutMs);
    req.on('data', data); req.once('end', end); req.once('error', stop); req.once('aborted', stop);
  });
}

export async function startDbBrowserSetup(options: DbBrowserSetupOptions): Promise<{
  url: string; close(): Promise<void>; completed: Promise<DbBrowserSetupResult>;
}> {
  const idleTimeoutMs = options.idleTimeoutMs ?? 600000;
  const bodyTimeoutMs = options.testTimeouts?.bodyTimeoutMs ?? 5000;
  const closeTimeoutMs = options.testTimeouts?.closeTimeoutMs ?? 12000;
  for (const value of [idleTimeoutMs, bodyTimeoutMs, closeTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('customer_db_browser_configuration');
  }
  const token = randomBytes(32).toString('hex');
  const controller = new AbortController();
  let origin = '', host = '', consumed = false;
  let operation: Promise<DbBrowserSetupResult> | undefined;
  let result: DbBrowserSetupResult | undefined, closing: Promise<void> | undefined;
  let provideResult!: (value: DbBrowserSetupResult) => void;
  const finalResult = new Promise<DbBrowserSetupResult>(resolve => { provideResult = resolve; });
  const settleResult = (value: DbBrowserSetupResult) => { result ??= value; provideResult(result); return result; };
  let idle: ReturnType<typeof setTimeout> | undefined;
  let complete!: (value: DbBrowserSetupResult) => void;
  const completed = new Promise<DbBrowserSetupResult>(resolve => { complete = resolve; });
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    void handle(req, res).catch(() => sendResult(res, failed('customer_db_browser_request_rejected'), 400));
  });
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 1000;
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  const close = (): Promise<void> => {
    if (closing) return closing;
    consumed = true; clearTimeout(idle); controller.abort();
    closing = new Promise<void>(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        complete(settleResult({ status: 'failed', code: 'customer_db_browser_cleanup_incomplete', fileSaved: null })); resolve();
      };
      const timer = setTimeout(() => {
        settleResult({ status: 'failed', code: 'customer_db_browser_cleanup_incomplete', fileSaved: null });
        // 대기 중인 응답이 고정 결과를 기록한 후 남은 소켓을 종료한다.
        setImmediate(() => { server.closeAllConnections(); finish(); });
      }, closeTimeoutMs);
      const listenerClosed = new Promise<void>(resolveClosed => {
        server.close(() => resolveClosed()); server.closeIdleConnections();
      });
      // 실행 중 코어의 실제 fileSaved를 얻은 후 응답과 listener 종료를 마친다.
      void (async () => {
        settleResult(operation ? await operation : cancelled());
        await listenerClosed; finish();
      })();
    });
    return closing;
  };
  const finishResponse = (res: ServerResponse, value: DbBrowserSetupResult) => {
    sendResult(res, settleResult(value));
    setImmediate(() => { void close(); });
  };
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reject = (status = 400) => {
      req.resume(); sendResult(res, failed('customer_db_browser_request_rejected'), status);
    };
    if (oneHeader(req, 'host') !== host) { reject(); return; }
    if (req.method === 'GET') {
      if (req.url === '/') send(res, 200, renderDbSetupPage(token), 'text/html; charset=utf-8');
      else if (req.url === '/app.js') send(res, 200, DB_SETUP_SCRIPT, 'text/javascript; charset=utf-8');
      else if (req.url === '/style.css') send(res, 200, DB_SETUP_STYLE, 'text/css; charset=utf-8');
      else reject(404);
      return;
    }
    if (req.method !== 'POST' || !['/api/setup', '/api/cancel'].includes(req.url ?? '')) { reject(404); return; }
    const candidate = oneHeader(req, 'x-tripmoney-token');
    if (oneHeader(req, 'origin') !== origin
      || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(oneHeader(req, 'content-type') ?? '')
      || typeof candidate !== 'string' || candidate.length !== token.length
      || !timingSafeEqual(Buffer.from(candidate), Buffer.from(token))) { reject(403); return; }
    const body = await readBody(req, bodyTimeoutMs);
    if (req.url === '/api/cancel') {
      if (Object.keys(body).length !== 0) { reject(); return; }
      if (result) { reject(409); return; }
      consumed = true; clearTimeout(idle); void close();
      const outcome = await finalResult;
      finishResponse(res, outcome); return;
    }
    if (Object.keys(body).length !== 1 || !validPassword(body.password)) { body.password = ''; reject(); return; }
    if (consumed) { body.password = ''; reject(409); return; }
    consumed = true; clearTimeout(idle);
    const setupOptions = { password: body.password, path: options.path, signal: controller.signal };
    body.password = '';
    operation = (async (): Promise<DbBrowserSetupResult> => {
      try {
        await (options.runSetup ?? runAdminDbSetupWithPassword)(setupOptions);
        return { status: 'saved', fileSaved: true };
      } catch (error) {
        const fileSaved = error instanceof AutoDbSetupError && error.fileSaved === true;
        const code = error instanceof AutoDbSetupError && safeAutoCode.test(error.message)
          ? error.message : 'customer_db_browser_setup_failed';
        return { status: error instanceof AutoDbSetupError && error.cancelled ? 'cancelled' : 'failed', code, fileSaved };
      } finally { setupOptions.password = ''; }
    })();
    finishResponse(res, await Promise.race([operation, finalResult]));
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { await close(); throw new Error('customer_db_browser_configuration'); }
  host = `127.0.0.1:${address.port}`; origin = `http://${host}`;
  idle = setTimeout(() => { void close(); }, idleTimeoutMs);
  return { url: `${origin}/`, close, completed };
}
