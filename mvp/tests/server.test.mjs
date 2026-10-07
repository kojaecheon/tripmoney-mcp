import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
let createMvpServer;
try { ({ createMvpServer } = await import('../server.mjs')); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('test_timeout')));
    req.on('error', reject); req.end();
  });
}

test('MVP는 전용 화면만 제공하며 API, env, 경로 우회를 차단한다', async () => {
  assert.equal(typeof createMvpServer, 'function', '의존성 없는 합성 MVP 서버 필요');
  const server = createMvpServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const page = await request(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /체험형 MVP/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.headers['content-security-policy'], /connect-src 'none'/);
    for (const path of ['/app.mjs', '/model.mjs', '/view.mjs', '/style.css', '/assets/tokens.css', '/assets/data.js', '/assets/components.js']) {
      assert.equal((await request(port, path)).status, 200, path);
    }
    for (const path of ['/api/mcp', '/api/beta', '/api/web', '/mcp', '/.env', '/package.json', '/../package.json', '/%2e%2e/package.json', '/assets/../../.env', '/assets/%2e%2e/.env', '/docs/design/mockups/operator.html', '/?url=/api/beta']) {
      const result = await request(port, path);
      assert.equal(result.status, path.startsWith('/?') ? 200 : 404, path);
      assert.doesNotMatch(result.body, /DATABASE_URL|CLOVA_OCR_SECRET/);
    }
    assert.equal((await request(port, '/', 'POST')).status, 405);
    const head = await request(port, '/', 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body, '');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
