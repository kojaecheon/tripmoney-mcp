import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/view.mjs': ['view.mjs', 'text/javascript; charset=utf-8'],
  '/model.mjs': ['model.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/assets/tokens.css': ['../docs/design/mockups/tokens.css', 'text/css; charset=utf-8'],
  '/assets/data.js': ['../docs/design/mockups/data.js', 'text/javascript; charset=utf-8'],
  '/assets/components.js': ['../docs/design/mockups/components.js', 'text/javascript; charset=utf-8'],
};
const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
};

export function createMvpServer() {
  return http.createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    const file = Object.hasOwn(files, pathname) ? files[pathname] : null;
    if (!file) { res.writeHead(404, headers); res.end(req.method === 'HEAD' ? '' : 'not found'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { ...headers, allow: 'GET, HEAD' }); res.end('method not allowed'); return; }
    try {
      const body = await readFile(new URL(file[0], import.meta.url));
      res.writeHead(200, { ...headers, 'content-type': file[1] });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(503, headers); res.end('unavailable'); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8123);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('유효한 포트를 지정해 주세요.');
  const server = createMvpServer();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '포트가 사용 중입니다. 다른 포트를 지정해 주세요.' : 'MVP 서버를 시작하지 못했습니다.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`TripMoney 체험형 MVP: http://127.0.0.1:${port}/`));
}
