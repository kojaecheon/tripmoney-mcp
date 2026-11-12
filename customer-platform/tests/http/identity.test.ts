import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCustomerAuthServer } from '../../server/http/server.js';
import { readHttpConfig } from '../../server/http/config.js';
import { createLocalRuntime } from '../../server/local/runtime.js';
import type { IdentityService } from '../../server/identity/contracts.js';
import type { AuthService } from '../../server/auth/service.js';
import { IdentityError } from '../../core/contracts.js';

const origin = 'http://127.0.0.1:8125';
const key = randomBytes(32);
const settings = { name: '로컬 여행', destination: '서울', startDate: '2026-11-02', endDate: '2026-11-04', timeZone: 'Asia/Seoul', budgetKrw: 100000, settlementMode: 'end_of_trip', dailyTime: '20:00' };
type Result = { status: number; body: any; raw: string; headers: IncomingHttpHeaders };
type Jar = Map<string, string>;
type Headers = Record<string, string | string[]>;
type Options = { authOnly?: boolean; webRoot?: string; identity?: (service: IdentityService) => IdentityService; auth?: (service: AuthService) => AuthService };
async function fixture(options: Options = {}) {
  const runtime = createLocalRuntime();
  const server = createCustomerAuthServer({ config: readHttpConfig({ publicOrigin: origin, clientKey: key }),
    authService: options.auth?.(runtime.authService) ?? runtime.authService,
    identityService: options.authOnly ? undefined : options.identity?.(runtime.identityService) ?? runtime.identityService,
    webRoot: options.webRoot });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  const send = (path: string, data?: unknown, jar?: Jar, extra: Headers = {}, method = data === undefined ? 'GET' : 'POST'): Promise<Result> => new Promise((resolve, reject) => {
    const cookie = jar && [...jar.values()].join('; ');
    const payload = data === undefined ? undefined : Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data);
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: '127.0.0.1:8125', Origin: origin, 'X-TripMoney-Request': '1', 'Content-Type': 'application/json', ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload).toString() }), ...(cookie ? { Cookie: cookie } : {}), ...extra } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        for (const value of res.headers['set-cookie'] ?? []) {
          const pair = value.split(';')[0]!; const name = pair.split('=')[0]!;
          if (value.includes('Max-Age=0')) jar?.delete(name); else jar?.set(name, pair);
        }
        resolve({ status: res.statusCode!, body: raw && res.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw) : null, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
  const login = async (email: string) => {
    const jar: Jar = new Map();
    assert.equal((await send('/api/customer/auth/request-code', { email }, jar)).status, 200);
    const verified = await send('/api/customer/auth/verify-code', { code: '123456' }, jar);
    assert.equal(verified.status, 200); assert.equal(jar.size, 1);
    assert.ok(!verified.raw.includes(jar.get('tripmoney_session_dev')!.split('=')[1]!));
    return jar;
  };
  return { send, login, runtime, close: async () => { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); runtime.close(); } };
}
function fixed(result: Result, status: number, code: string, field?: string) {
  assert.equal(result.status, status); assert.equal(result.body.error.code, code);
  assert.deepEqual(Object.keys(result.body).sort(), ['error', 'requestId']);
  assert.deepEqual(Object.keys(result.body.error).sort(), field ? ['code', 'field', 'message'] : ['code', 'message']);
  if (field) assert.equal(result.body.error.field, field);
  assert.match(result.body.requestId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.match(String(result.headers['content-security-policy']), /frame-ancestors 'none'/);
}
const create = (f: Awaited<ReturnType<typeof fixture>>, jar: Jar) => f.send('/api/customer/trips', { ...settings, alias: '소유자', operationId: randomUUID() }, jar);

test('two cookie jars create, inspect and join the same trip with public DTOs and owner management', async () => {
  const f = await fixture(); try {
    const a = await f.login('owner@example.invalid'); const b = await f.login('guest@example.invalid');
    assert.deepEqual((await f.send('/api/customer/trips', undefined, a)).body, { trips: [] });
    const created = await create(f, a); assert.equal(created.status, 200);
    const { trip, ownerMember } = created.body.value; const path = `/api/customer/trips/${trip.id}`;
    assert.deepEqual(Object.keys(trip).sort(), ['budgetKrw', 'createdAt', 'dailyTime', 'destination', 'endDate', 'id', 'memberCount', 'name', 'ownerMemberId', 'revision', 'role', 'settlementMode', 'startDate', 'status', 'timeZone']);
    assert.deepEqual(Object.keys(ownerMember).sort(), ['active', 'alias', 'id', 'isMe', 'role', 'tripId']);
    assert.equal(trip.role, 'owner'); assert.equal(trip.memberCount, 1);
    fixed(await f.send(path, undefined, b), 404, 'not_found');
    const operationId = randomUUID();
    const issued = await f.send(`${path}/invites`, { role: 'viewer', expectedRevision: 1, operationId }, a);
    assert.equal(issued.status, 200); assert.equal(issued.body.tripRevision, 2);
    assert.deepEqual(Object.keys(issued.body.value.invite).sort(), ['expiresAt', 'id', 'role', 'status']);
    const link = issued.body.value.url as string;
    assert.ok(link.startsWith(`${origin}/invite#t=`)); const token = link.split('#t=')[1]!;
    assert.deepEqual((await f.send(`${path}/invites/${operationId}/link`, {}, a)).body, issued.body.value);
    const invites = await f.send(`${path}/invites`, undefined, a); assert.equal(invites.body.invites.length, 1); assert.ok(!invites.raw.includes(token));
    const inspected = await f.send('/api/customer/invites/inspect', { token }, b);
    assert.equal(inspected.status, 200); assert.deepEqual(Object.keys(inspected.body).sort(), ['expiresAt', 'role', 'state', 'tripName']); assert.equal(inspected.body.state, 'pending');
    const accepted = await f.send('/api/customer/invites/accept', { token, alias: '동행자', operationId: randomUUID() }, b);
    assert.equal(accepted.status, 200); assert.equal(accepted.body.tripRevision, 3); assert.equal(accepted.body.value.trip.role, 'viewer'); assert.ok(!accepted.raw.includes(token));
    const memberId = accepted.body.value.member.id;
    assert.deepEqual((await f.send('/api/customer/invites/inspect', { token }, b)).body, { state: 'joined', tripId: trip.id });
    assert.equal((await f.send(path, undefined, b)).body.trip.memberCount, 2);
    assert.equal((await f.send('/api/customer/trips', undefined, b)).body.trips[0].id, trip.id);
    const members = (await f.send(`${path}/members`, undefined, b)).body.members;
    assert.equal(members.length, 2); assert.deepEqual(members.map((m: any) => m.isMe), [false, true]);
    const updated = await f.send(path, { ...settings, name: '바뀐 여행', expectedRevision: 3, operationId: randomUUID() }, a, {}, 'PATCH'); assert.equal(updated.status, 200); assert.equal(updated.body.tripRevision, 4);
    fixed(await f.send(path, { ...settings, expectedRevision: 4, operationId: randomUUID() }, b, {}, 'PATCH'), 403, 'forbidden');
    fixed(await f.send(`${path}/invites`, undefined, b), 403, 'forbidden');
    const changed = await f.send(`${path}/members/${memberId}`, { role: 'editor', active: true, expectedRevision: 4, operationId: randomUUID() }, a, {}, 'PATCH'); assert.equal(changed.status, 200); assert.equal(changed.body.value.role, 'editor');
    const removed = await f.send(`${path}/members/${memberId}`, { role: 'viewer', active: false, expectedRevision: 5, operationId: randomUUID() }, a, {}, 'PATCH'); assert.equal(removed.status, 200);
    fixed(await f.send(path, undefined, b), 404, 'not_found');
    const pendingId = randomUUID(); assert.equal((await f.send(`${path}/invites`, { role: 'viewer', expectedRevision: 6, operationId: pendingId }, a)).status, 200);
    const revoked = await f.send(`${path}/invites/${pendingId}`, { expectedRevision: 7, operationId: randomUUID() }, a, {}, 'DELETE'); assert.equal(revoked.status, 200); assert.equal(revoked.body.value.status, 'revoked');
  } finally { await f.close(); }
});

test('identity authentication rejects missing, unknown and revoked actors and clears only session cookies', async () => {
  const f = await fixture(); try {
    for (const [path, data] of [['/api/customer/trips', undefined], ['/api/customer/invites/inspect', { token: 'invalid' }], ['/api/customer/invites/accept', { token: 'invalid', alias: 'a', operationId: randomUUID() }]] as const) {
      const r = await f.send(path, data); fixed(r, 401, 'unauthenticated'); assert.match(r.headers['set-cookie']![0]!, /^tripmoney_session_dev=; Max-Age=0/);
    }
    const unknown = new Map([['tripmoney_session_dev', `tripmoney_session_dev=${randomBytes(32).toString('base64url')}`]]);
    fixed(await f.send('/api/customer/trips', undefined, unknown), 401, 'unauthenticated');
    const a = await f.login('owner@example.invalid'); const stale = new Map(a);
    assert.equal((await f.send('/api/customer/auth/logout', {}, a)).status, 204);
    fixed(await f.send('/api/customer/trips', undefined, stale), 401, 'unauthenticated');
  } finally { await f.close(); }
  const forged = await fixture({ auth: service => ({ ...service, authenticate: async () => ({ actor: { userId: randomUUID(), sessionHash: '0'.repeat(64) }, email: 'unknown@example.invalid', expiresAt: new Date(Date.now() + 60000).toISOString() }) }) });
  try { fixed(await forged.send('/api/customer/trips', undefined, new Map([['tripmoney_session_dev', `tripmoney_session_dev=${randomBytes(32).toString('base64url')}`]])), 401, 'unauthenticated'); } finally { await forged.close(); }
});

test('identity requires exact bodies and UUIDs before any command call', async () => {
  let commands = 0;
  const f = await fixture({ identity: service => new Proxy(service, { get(target, prop, receiver) { const value = Reflect.get(target, prop, receiver); return typeof value === 'function' ? (...args: unknown[]) => { commands++; return value(...args); } : value; } }) });
  try {
    const a = await f.login('owner@example.invalid'); const tripId = randomUUID(); const memberId = randomUUID(); const inviteId = randomUUID();
    const validCreate = { ...settings, alias: 'A', operationId: randomUUID() };
    const invalidCreates: [unknown, string?][] = [
      [{ ...validCreate, actor: { userId: tripId } }], [{ ...validCreate, ownerUserId: tripId }],
      [{ ...validCreate, userId: tripId }], [{ ...validCreate, role: 'owner' }],
      [{ ...validCreate, operationId: '00000000-0000-0000-0000-000000000000' }, 'operationId'],
      [{ ...validCreate, operationId: 'bad' }, 'operationId'], [{ ...validCreate, name: 1 }, 'name'],
      [{ ...validCreate, budgetKrw: '1' }, 'budgetKrw'], [{ ...validCreate, budgetKrw: -1 }, 'budgetKrw'],
      [{ ...validCreate, budgetKrw: 0.5 }, 'budgetKrw'], [{ ...validCreate, dailyTime: undefined }, 'dailyTime'],
      [{ ...validCreate, settlementMode: 'invalid' }, 'settlementMode'],
      [[]], [null], ['{'], [Buffer.from([0xc3, 0x28])], [{ ...validCreate, name: 'a'.repeat(8200) }],
    ];
    for (const [data, field] of invalidCreates) fixed(await f.send('/api/customer/trips', data, a), 422, 'validation', field);
    const trip = `/api/customer/trips/${tripId}`;
    const cases: [string, unknown, string][] = [
      [trip, { ...settings, alias: 'forged', expectedRevision: 1, operationId: randomUUID() }, 'PATCH'],
      [trip, { ...settings, expectedRevision: '1', operationId: randomUUID() }, 'PATCH'],
      [`${trip}/members/${memberId}`, { role: 'owner', active: true, expectedRevision: 1, operationId: randomUUID() }, 'PATCH'],
      [`${trip}/members/${memberId}`, { role: 'editor', active: 'false', expectedRevision: 1, operationId: randomUUID() }, 'PATCH'],
      [`${trip}/invites`, { role: 'editor', expectedRevision: 0, operationId: randomUUID() }, 'POST'],
      [`${trip}/invites/${inviteId}/link`, { token: 'caller' }, 'POST'],
      [`${trip}/invites/${inviteId}`, { expectedRevision: 1, operationId: 'bad' }, 'DELETE'],
      ['/api/customer/invites/inspect', { token: 1 }, 'POST'],
      ['/api/customer/invites/inspect', { token: 'invalid', clientHash: 'caller' }, 'POST'],
      ['/api/customer/invites/accept', { token: 'invalid', alias: 1, operationId: randomUUID() }, 'POST'],
    ];
    for (const [path, data, method] of cases) assert.equal((await f.send(path, data, a, {}, method)).status, 422);
    for (const path of ['/api/customer/trips/bad', `/api/customer/trips/${tripId}/members/bad`, `/api/customer/trips/${tripId}/invites/bad/link`]) {
      const method = path.includes('/members/') ? 'PATCH' : path.endsWith('/link') ? 'POST' : 'GET';
      assert.equal((await f.send(path, method === 'GET' ? undefined : {}, a, {}, method)).status, 422);
    }
    assert.equal(commands, 0);
  } finally { await f.close(); }
});

test('PATCH and DELETE enforce the same exact Host, Origin, JSON and request header boundary', async () => {
  const f = await fixture(); try {
    const a = await f.login('owner@example.invalid'); const created = await create(f, a); const path = `/api/customer/trips/${created.body.value.trip.id}`;
    for (const method of ['PATCH', 'DELETE']) {
      const target = method === 'PATCH' ? path : `${path}/invites/${randomUUID()}`;
      const invalidHeaders: Headers[] = [{ Origin: 'https://evil.invalid' }, { Host: 'localhost:8125' }, { 'Content-Type': 'text/plain' }, { 'X-TripMoney-Request': '0' }, { Origin: [] }, { 'Content-Type': [] }, { 'X-TripMoney-Request': [] }, { Origin: [origin, origin] }, { 'X-TripMoney-Request': ['1', '1'] }];
      for (const headers of invalidHeaders) fixed(await f.send(target, {}, a, headers, method), 403, 'forbidden');
    }
    assert.equal((await f.send(path, undefined, a)).body.trip.revision, 1);
  } finally { await f.close(); }
});

test('conflicts and unusable invites return fixed errors without consuming invites on GET', async () => {
  const f = await fixture(); try {
    const a = await f.login('owner@example.invalid'); const b = await f.login('guest@example.invalid'); const created = await create(f, a); const path = `/api/customer/trips/${created.body.value.trip.id}`;
    const op = randomUUID(); const issueBody = { role: 'viewer', expectedRevision: 1, operationId: op };
    const issue = await f.send(`${path}/invites`, issueBody, a); const token = issue.body.value.url.split('#t=')[1]!;
    fixed(await f.send(`${path}/invites`, { ...issueBody, role: 'editor' }, a), 409, 'conflict');
    fixed(await f.send(path, { ...settings, expectedRevision: 1, operationId: randomUUID() }, a, {}, 'PATCH'), 409, 'conflict');
    for (const target of ['/api/customer/invites/inspect', '/api/customer/invites/accept']) assert.equal((await f.send(target, undefined, b)).status, 404);
    assert.equal((await f.send('/invite', undefined, b)).status, 200);
    assert.equal((await f.send('/api/customer/invites/inspect', { token }, b)).body.state, 'pending');
    assert.equal((await f.send(`${path}/invites`, undefined, a)).body.invites[0].status, 'pending');
    assert.equal((await f.send(`${path}/invites/${op}`, { expectedRevision: 2, operationId: randomUUID() }, a, {}, 'DELETE')).status, 200);
    const gone = await f.send('/api/customer/invites/inspect', { token }, b); fixed(gone, 410, 'invite_unavailable'); assert.equal(gone.body.error.message, '사용할 수 없는 초대입니다.'); assert.ok(!gone.raw.includes(token));
    fixed(await f.send(`${path}/invites/${op}/link`, {}, a), 410, 'invite_unavailable');
    fixed(await f.send('/api/customer/invites/accept', { token, alias: 'B', operationId: randomUUID() }, b), 410, 'invite_unavailable');
  } finally { await f.close(); }
});

test('identity rate limit uses server HMAC and closed runtime returns a fixed 503', async () => {
  const hashes: string[] = [];
  const f = await fixture({ identity: service => ({ ...service, inspectInvite: async (actor, token, clientHash) => { hashes.push(clientHash); return service.inspectInvite(actor, token, clientHash); } }) });
  try {
    const a = await f.login('owner@example.invalid');
    for (let i = 0; i < 30; i++) fixed(await f.send('/api/customer/invites/inspect', { token: 'invalid' }, a, { 'X-Forwarded-For': `192.0.2.${i + 1}` }), 410, 'invite_unavailable');
    fixed(await f.send('/api/customer/invites/inspect', { token: 'invalid' }, a), 429, 'rate_limited');
    assert.equal(new Set(hashes).size, 1); assert.equal(hashes[0], createHmac('sha256', key).update('identity-client:127.0.0.1').digest('hex'));
    f.runtime.close(); fixed(await f.send('/api/customer/trips', undefined, a), 503, 'unavailable');
  } finally { await f.close(); }
});

test('unknown service failures and unsafe error fields never expose exception data', async () => {
  let failure: unknown = new Error('SECRET SQL token email stack');
  const f = await fixture({ identity: service => ({ ...service, listTrips: async () => { throw failure; } }) });
  try {
    const a = await f.login('owner@example.invalid');
    const r = await f.send('/api/customer/trips', undefined, a); fixed(r, 503, 'unavailable'); assert.ok(!r.raw.includes('SECRET')); assert.equal(r.headers['set-cookie'], undefined);
    failure = new IdentityError('validation', 'SECRET', 'sessionHash'); fixed(await f.send('/api/customer/trips', undefined, a), 422, 'validation');
    for (const field of ['trip', 'name', 'destination', 'startDate', 'endDate', 'timeZone', 'budgetKrw', 'alias', 'settlementMode', 'dailyTime', 'operationId', 'expectedRevision', 'tripId', 'memberId', 'inviteId', 'role', 'active', 'token']) {
      failure = new IdentityError('validation', 'SECRET', field); fixed(await f.send('/api/customer/trips', undefined, a), 422, 'validation', field);
    }
  } finally { await f.close(); }
});

test('identity route matching and static allowlist stay strict with optional injection', async () => {
  const f = await fixture(); const authOnly = await fixture({ authOnly: true });
  try {
    const a = await f.login('owner@example.invalid');
    for (const path of ['/api/customer/trips/', '/api/customer/trips?x=1', '/api/customer/%74rips', '/api/customer/trips/x/extra', '/api/customer/invites/inspect?token=redacted', '/travel/controller.d.mts', '/api.d.mts', '/server/identity/service.ts']) fixed(await f.send(path, undefined, a), 404, 'not_found');
    for (const method of ['PUT', 'HEAD', 'DELETE']) { const r = await f.send('/api/customer/trips', {}, a, {}, method); assert.equal(r.status, 404); }
    for (const method of ['GET', 'POST']) fixed(await authOnly.send('/api/customer/trips', method === 'GET' ? undefined : {}, undefined, {}, method), 404, 'not_found');
  } finally { await f.close(); await authOnly.close(); }
  const root = await mkdtemp(join(tmpdir(), 'tripmoney-identity-http-'));
  await mkdir(join(root, 'travel')); await mkdir(join(root, 'invites')); await writeFile(join(root, 'index.html'), 'invite page'); await writeFile(join(root, 'travel', 'view.mjs'), 'export {};');
  const files = await fixture({ webRoot: root }); try {
    assert.equal((await files.send('/invite')).raw, 'invite page'); assert.equal((await files.send('/travel/view.mjs')).status, 200);
    for (const path of ['/travel/controller.mjs', '/travel/forms.mjs', '/invites/view.mjs', '/travel/view.d.mts']) fixed(await files.send(path), 404, 'not_found');
    for (const path of ['travel/controller.mjs', 'travel/forms.mjs', 'invites/view.mjs']) {
      await writeFile(join(root, path), 'export {};');
      const served = await files.send(`/${path}`); assert.equal(served.status, 200); assert.equal(served.raw, 'export {};');
      assert.equal(served.headers['content-type'], 'text/javascript; charset=utf-8');
    }
    await rm(join(root, 'travel', 'controller.mjs'));
    await symlink(join(root, 'index.html'), join(root, 'travel', 'controller.mjs'));
    fixed(await files.send('/travel/controller.mjs'), 404, 'not_found');
  } finally { await files.close(); await rm(root, { recursive: true }); }
});

test('cookie change between me and create fails the expected-account precondition before the command', async () => {
 let commands = 0;
 const f = await fixture({ identity: s => ({ ...s, createTrip: (...args) => { commands++; return s.createTrip(...args); } }) });
 try {
  const a = await f.login('first@example.invalid'), b = await f.login('second@example.invalid');
  const previous = (await f.send('/api/customer/me', undefined, a)).body.me.userId;
  const current = (await f.send('/api/customer/me', undefined, b)).body.me.userId;
  const payload = { ...settings, alias: '이전 계정 초안', operationId: randomUUID() };
  fixed(await f.send('/api/customer/trips', payload, b, { 'X-TripMoney-Expected-Account': previous }), 412, 'account_changed');
  assert.equal(commands, 0);
  fixed(await f.send('/api/customer/trips', undefined, b, { 'X-TripMoney-Expected-Account': previous }), 412, 'account_changed');
  assert.deepEqual((await f.send('/api/customer/trips', undefined, b)).body.trips, []);
  assert.deepEqual((await f.send('/api/customer/trips', undefined, a)).body.trips, []);
  assert.equal((await f.send('/api/customer/trips', payload, b, { 'X-TripMoney-Expected-Account': current })).status, 200);
  assert.equal(commands, 1);
 } finally { await f.close(); }
});

test('only valid authenticated accept reveals fixed alias or capacity reasons, with no partial joins', async () => {
 const f = await fixture();
 try {
  const a = await f.login('owner@example.invalid');
  const created = await create(f,a), path = '/api/customer/trips/' + created.body.value.trip.id;
  let rev = 1;
  for (let i = 1; i <= 8; i++) {
   const b = await f.login('guest' + i + '@example.invalid');
   const link = await f.send(path + '/invites', { role: 'viewer', expectedRevision: rev, operationId: randomUUID() }, a);
   assert.equal(link.status, 200); rev = link.body.tripRevision;
   const token = new URLSearchParams(new URL(link.body.value.url).hash.substring(1)).get('t');
   const accept = (jar: Jar|undefined, alias: string) => f.send('/api/customer/invites/accept', {token,alias,operationId:randomUUID()}, jar);
   if (i === 1) {
    fixed(await accept(undefined,'소유자'), 401,'unauthenticated');
    const duplicate = await accept(b,'소유자'); assert.equal(duplicate.status,409);
    assert.equal(duplicate.body.error.code,'conflict'); assert.equal(duplicate.body.error.reason,'alias_taken');
   }
   const result = await accept(b,'동행' + i);
   if (i < 8) { assert.equal(result.status,200); rev = result.body.tripRevision; }
   else { assert.equal(result.status,409); assert.equal(result.body.error.code,'conflict'); assert.equal(result.body.error.reason,'member_limit'); }
  }
  const latest = (await f.send(path, undefined, a)).body.trip;
  assert.equal(latest.memberCount,8); assert.equal(latest.revision,rev);
  fixed(await f.send('/api/customer/invites/accept',{token:'invalid',alias:'소유자',operationId:randomUUID()},a),410,'invite_unavailable');
 } finally { await f.close(); }
});
