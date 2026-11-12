import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { PreparedProviderResult } from './login.js';
import type { ProviderProbeReport } from './probe.js';
import { PROVIDER_SCRIPT, PROVIDER_STYLE, renderProviderPage } from './provider-page.js';

const codes = new Set(['customer_provider_prepare_configuration', 'customer_provider_prepare_login_p',
  'customer_provider_prepare_login_q', 'customer_provider_prepare_session_pair', 'customer_provider_prepare_probe',
  'customer_provider_prepare_cleanup', 'customer_provider_prepare_cancelled', 'customer_provider_prepare_cleanup_unknown',
  'customer_provider_prepare_transport']);
const reportKeys = ['normalP', 'normalQ', 'revokedP', 'tokenPStillUnexpired', 'otherQStillActive', 'cleanupP', 'cleanupQ'] as const;
const countKeys = ['anonymousRest', 'authenticatedRest', 'anonymousRpc', 'authenticatedRpc'] as const;
const unknownCleanup = (): PreparedProviderResult => ({ status: 'failed', code: 'customer_provider_prepare_cleanup_unknown',
  report: null, cleanupComplete: false, cleanupUncertain: true });
const cancelled = (): PreparedProviderResult => ({ status: 'cancelled', code: 'customer_provider_prepare_cancelled',
  report: null, cleanupComplete: true, cleanupUncertain: false });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// 외부 필드와 오류 원문을 버리고 계약의 boolean/count와 고정 code만 복사한다.
function sanitize(value: unknown): PreparedProviderResult {
  if (!record(value) || !['passed', 'failed', 'cancelled'].includes(String(value.status))
    || typeof value.cleanupComplete !== 'boolean' || typeof value.cleanupUncertain !== 'boolean'
    || (value.code !== undefined && (typeof value.code !== 'string' || !codes.has(value.code)))) return unknownCleanup();
  if ((value.status === 'passed' && value.code !== undefined)
    || (value.code === 'customer_provider_prepare_cleanup_unknown' && (value.cleanupComplete || !value.cleanupUncertain))) return unknownCleanup();
  let report: ProviderProbeReport | null = null;
  if (value.report !== null) {
    const raw = value.report;
    if (!record(raw) || !reportKeys.every(key => typeof raw[key] === 'boolean') || !record(raw.dataApi)) return unknownCleanup();
    const counts = raw.dataApi;
    if (!countKeys.every(key => typeof counts[key] === 'number' && Number.isInteger(counts[key])
      && Number(counts[key]) >= 0 && Number(counts[key]) <= 3)) return unknownCleanup();
    report = { normalP: raw.normalP as boolean, normalQ: raw.normalQ as boolean, revokedP: raw.revokedP as boolean,
      tokenPStillUnexpired: raw.tokenPStillUnexpired as boolean, otherQStillActive: raw.otherQStillActive as boolean,
      cleanupP: raw.cleanupP as boolean, cleanupQ: raw.cleanupQ as boolean,
      dataApi: { anonymousRest: counts.anonymousRest as number, authenticatedRest: counts.authenticatedRest as number,
        anonymousRpc: counts.anonymousRpc as number, authenticatedRpc: counts.authenticatedRpc as number } };
  }
  const status = value.status as PreparedProviderResult['status'];
  if (status === 'passed' && (!report || !reportKeys.every(key => report![key])
    || !countKeys.every(key => report!.dataApi[key] === 3) || !value.cleanupComplete || value.cleanupUncertain)) {
    return { status: 'failed', code: 'customer_provider_prepare_probe', report,
      cleanupComplete: value.cleanupComplete, cleanupUncertain: value.cleanupUncertain };
  }
  return { status, ...(value.code === undefined ? {} : { code: value.code as string }), report,
    cleanupComplete: value.cleanupComplete, cleanupUncertain: value.cleanupUncertain };
}

function hasDuplicateHeader(request: IncomingMessage): boolean {
  const names = new Set<string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!.toLowerCase(); if (names.has(name)) return true; names.add(name);
  }
  return false;
}
function readBody(request: IncomingMessage, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0; let chunks: Buffer[] = []; let finished = false;
    const finish = (error?: number) => {
      if (finished) return; finished = true; clearTimeout(timer);
      request.removeListener('data', onData); request.removeListener('end', onEnd);
      request.removeListener('aborted', onAbort); request.removeListener('error', onAbort);
      if (error) { chunks = []; request.resume(); reject(error); return; }
      try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); chunks = []; resolve(parsed); }
      catch { chunks = []; reject(400); }
    };
    const onData = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8192) finish(413); else chunks.push(chunk); };
    const onEnd = () => finish(); const onAbort = () => finish(400);
    const timer = setTimeout(() => finish(408), timeoutMs);
    request.on('data', onData); request.on('end', onEnd); request.on('aborted', onAbort); request.on('error', onAbort);
  });
}

export async function startProviderBrowser(options: {
  email: string;
  run: (password: string, signal: AbortSignal) => Promise<PreparedProviderResult>;
  idleTimeoutMs?: number;
  testTimeouts?: { bodyTimeoutMs?: number; closeTimeoutMs?: number };
}): Promise<{ url: string; completed: Promise<PreparedProviderResult>; close(): Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  const bodyTimeoutMs = options.testTimeouts?.bodyTimeoutMs ?? 5000;
  const closeTimeoutMs = options.testTimeouts?.closeTimeoutMs ?? 20_000;
  const controller = new AbortController(); const sockets = new Set<Socket>();
  let host = ''; let origin = ''; let submitted = false; let settled = false; let stopping = false;
  let shutdownDeadline: number | undefined;
  let finalJson = '';
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveCompleted!: (result: PreparedProviderResult) => void;
  const completed = new Promise<PreparedProviderResult>(resolve => { resolveCompleted = resolve; });
  let resolveStopped!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
  const stop = () => {
    if (stopping) return; stopping = true;
    if (idleTimer) clearTimeout(idleTimer); if (closeTimer) clearTimeout(closeTimer);
    // 취소부터 socket 종료까지 하나의 상한을 적용한다.
    shutdownDeadline ??= Date.now() + closeTimeoutMs;
    forceTimer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, Math.max(1, shutdownDeadline - Date.now()));
    server.close(() => { if (forceTimer) clearTimeout(forceTimer); resolveStopped(); });
    server.closeIdleConnections();
  };
  const finish = (result: PreparedProviderResult) => {
    if (settled) return; settled = true;
    if (idleTimer) clearTimeout(idleTimer); if (closeTimer) clearTimeout(closeTimer);
    // runner나 completed 소비자의 객체 변경으로 HTTP 결과가 달라지지 않는다.
    const safe = sanitize(result);
    finalJson = JSON.stringify(safe);
    if (safe.report) { Object.freeze(safe.report.dataApi); Object.freeze(safe.report); }
    Object.freeze(safe);
    resolveCompleted(safe);
  };
  const requestClose = () => {
    shutdownDeadline ??= Date.now() + closeTimeoutMs;
    controller.abort();
    if (!submitted) finish(cancelled());
    else if (!settled && closeTimer === undefined) closeTimer = setTimeout(() => finish(unknownCleanup()), closeTimeoutMs);
  };
  const send = (response: ServerResponse, status: number, body: string, mime = 'application/json; charset=utf-8', terminal = false) => {
    if (response.destroyed || response.writableEnded) { if (terminal) stop(); return; }
    response.writeHead(status, { ...headers, 'Content-Type': mime, 'Connection': 'close' });
    if (terminal) response.once('finish', stop);
    response.end(body);
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (hasDuplicateHeader(request)) { request.resume(); send(response, 400, '{}'); return; }
    if (request.headers.host !== host) { request.resume(); send(response, 403, '{}'); return; }
    if (request.method === 'GET') {
      if (request.url === '/') send(response, 200, renderProviderPage(token, options.email), 'text/html; charset=utf-8');
      else if (request.url === '/app.js') send(response, 200, PROVIDER_SCRIPT, 'text/javascript; charset=utf-8');
      else if (request.url === '/style.css') send(response, 200, PROVIDER_STYLE, 'text/css; charset=utf-8');
      else send(response, 404, '{}');
      return;
    }
    if (request.method !== 'POST' || !['/api/run', '/api/cancel'].includes(request.url ?? '')) {
      request.resume(); send(response, 404, '{}'); return;
    }
    const supplied = request.headers['x-tripmoney-token'];
    if (request.headers.origin !== origin || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(token)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { request.resume(); send(response, 403, '{}'); return; }
    if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding'] !== undefined) {
      request.resume(); send(response, 415, '{}'); return;
    }
    let body: unknown;
    try { body = await readBody(request, bodyTimeoutMs); }
    catch (status) { send(response, typeof status === 'number' ? status : 400, '{}'); return; }
    if (!record(body)) { send(response, 400, '{}'); return; }
    if (request.url === '/api/run') {
      if (Object.keys(body).length !== 1 || typeof body.password !== 'string' || !body.password) { send(response, 400, '{}'); return; }
      if (submitted || settled || controller.signal.aborted) { body.password = ''; send(response, 409, '{}'); return; }
      submitted = true; if (idleTimer) clearTimeout(idleTimer);
      let password = body.password; body.password = ''; body = undefined;
      try {
        const result = options.run(password, controller.signal); password = '';
        void result.then(result => finish(sanitize(result)), () => finish(unknownCleanup()));
      } catch { password = ''; finish(unknownCleanup()); }
    } else {
      if (Object.keys(body).length !== 0) { send(response, 400, '{}'); return; }
      requestClose();
    }
    await completed;
    send(response, 200, finalJson, 'application/json; charset=utf-8', true);
  };
  const server = createServer((request, response) => { void handle(request, response).catch(() => send(response, 500, '{}')); });
  server.requestTimeout = 0; server.headersTimeout = 5000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('customer_provider_prepare_transport');
  host = `127.0.0.1:${address.port}`; origin = `http://${host}`;
  idleTimer = setTimeout(() => { requestClose(); void completed.then(stop); }, options.idleTimeoutMs ?? 10 * 60_000);
  return { url: `${origin}/`, completed,
    async close() { requestClose(); await completed; stop(); await stopped; } };
}
