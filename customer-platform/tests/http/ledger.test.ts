import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { IdentityError, type TripInput } from '../../core/contracts.js';
import type { LedgerChange, LedgerDTO } from '../../core/ledger/contracts.js';
import { readHttpConfig } from '../../server/http/config.js';
import { createCustomerAuthServer } from '../../server/http/server.js';
import type { MemberDTO, TripDTO } from '../../server/identity/contracts.js';
import type { LedgerService } from '../../server/ledger/contracts.js';
import { createLocalRuntime } from '../../server/local/runtime.js';

const origin = 'http://127.0.0.1:8125';
const sessionCookie = 'tripmoney_session_dev';
const challengeCookie = 'tripmoney_challenge_dev';
const nil = '00000000-0000-0000-0000-000000000000';
const settings = {
  name: '공동 여행', destination: '방콕', startDate: '2026-11-02', endDate: '2026-11-04',
  timeZone: 'Asia/Bangkok', budgetKrw: 100_000, settlementMode: 'end_of_trip', dailyTime: '20:00',
};
const schedule = {
  type: 'schedule.create',
  input: { date: '2026-11-02', startTime: '10:00', endTime: '11:30', title: '시장', place: '', budgetKrw: 2_000 },
} as const;
const envelope = (command: unknown, expectedRevision = 1, operationId = randomUUID()) => ({ command, expectedRevision, operationId });
const tripPath = (id: string) => '/api/customer/trips/' + id;
const ledgerPath = (id: string) => tripPath(id) + '/ledger';
const commandPath = (id: string) => ledgerPath(id) + '/commands';

type Jar = Map<string, string>;
type Headers = Record<string, string | string[]>;
type Response = { status: number; headers: IncomingHttpHeaders; raw: string; json<T>(): T };

async function fixture(t: TestContext, options: {
  withoutLedger?: boolean;
  withoutIdentity?: boolean;
  now?: () => number;
  webRoot?: string;
  ledger?: (service: LedgerService) => LedgerService;
} = {}) {
  const runtime = createLocalRuntime({ now: options.now });
  const server = createCustomerAuthServer({
    config: readHttpConfig({ publicOrigin: origin, clientKey: randomBytes(32) }),
    authService: runtime.authService,
    identityService: options.withoutIdentity ? undefined : runtime.identityService,
    ledgerService: options.withoutLedger ? undefined : options.ledger?.(runtime.ledgerService) ?? runtime.ledgerService,
    webRoot: options.webRoot,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  t.after(async () => {
    try {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    } finally {
      runtime.close();
    }
  });

  function send(path: string, data?: unknown, jar?: Jar, extra: Headers = {}, method = data === undefined ? 'GET' : 'POST'): Promise<Response> {
    const cookie = jar && [...jar.values()].join('; ');
    const payload = data === undefined || typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
    const headers = {
      Host: '127.0.0.1:8125', Origin: origin, 'X-TripMoney-Request': '1', 'Content-Type': 'application/json',
      ...(payload === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(payload)) }),
      ...(cookie ? { Cookie: cookie } : {}), ...extra,
    };
    const rawHeaders = Object.entries(headers).flatMap(([name, values]) =>
      (Array.isArray(values) ? values : [values]).flatMap(value => [name, value]),
    );
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: rawHeaders }, res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          for (const value of res.headers['set-cookie'] ?? []) {
            const pair = value.split(';')[0]!;
            const name = pair.split('=')[0]!;
            if (value.includes('Max-Age=0')) jar?.delete(name);
            else jar?.set(name, pair);
          }
          resolve({ status: res.statusCode!, headers: res.headers, raw, json: () => JSON.parse(raw) });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  async function login(email: string) {
    const jar: Jar = new Map();
    ok(await send('/api/customer/auth/request-code', { email }, jar));
    const response = await send('/api/customer/auth/verify-code', { code: '123456' }, jar);
    const { userId } = ok<{ me: { userId: string } }>(response).me;
    assert.ok(jar.has(sessionCookie));
    return { jar, userId, email };
  }

  async function create(jar: Jar, overrides: Partial<TripInput> = {}) {
    return ok<{ value: { trip: TripDTO; ownerMember: MemberDTO } }>(
      await send('/api/customer/trips', { ...settings, alias: '소유자', ...overrides, operationId: randomUUID() }, jar),
    ).value;
  }

  async function invite(tripId: string, owner: Jar, guest: Jar) {
    const issued = await send(tripPath(tripId) + '/invites', { role: 'editor', expectedRevision: 1, operationId: randomUUID() }, owner);
    const { url } = ok<{ value: { url: string } }>(issued).value;
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get('t');
    assert.ok(token);
    const accepted = await send('/api/customer/invites/accept', { token, alias: '동행자', operationId: randomUUID() }, guest);
    const { tripRevision } = ok<{ tripRevision: number }>(accepted);
    return { tripRevision, token };
  }

  return { send, login, create, invite, runtime };
}

test('daily and final settlement share the ledger and apply only recipient-confirmed payments', async t => {
  // HTTP cookie expiry uses real time; anchor the synthetic Bangkok clock on the next UTC date.
  const midnight = (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000;
  const date = (offset: number) => new Date(midnight + offset * 86_400_000).toISOString().slice(0, 10);
  const first = date(0), secondDay = date(1);
  let now = midnight + 13 * 3_600_000;
  const f = await fixture(t, { now: () => now });
  const owner = await f.login('settlement-owner@example.invalid');
  const guest = await f.login('settlement-guest@example.invalid');
  const { trip, ownerMember } = await f.create(owner.jar, { settlementMode: 'daily', startDate: first, endDate: date(2) });
  const path = ledgerPath(trip.id), commands = commandPath(trip.id);
  await f.invite(trip.id, owner.jar, guest.jar);
  async function read(jar = owner.jar) {
    return ok<{ ledger: LedgerDTO }>(await f.send(path, undefined, jar)).ledger;
  }
  let current = await read();
  const guestId = current.members.find(member => !member.isMe)!.id;
  async function write(command: unknown, jar = owner.jar) {
    const value = ok<LedgerChange>(await f.send(commands, envelope(command, current.revision), jar));
    current = await read();
    return value;
  }
  function paymentCommand(type: string, id: string) {
    return { type, id, expectedPaymentRevision: current.settlement.payments.find(payment => payment.id === id)!.revision };
  }
  const input = {
    itineraryId: null, title: '저녁 식비', occurredLocal: first + 'T23:58', currency: 'KRW',
    amount: '1000', payerId: ownerMember.id, splitIds: [ownerMember.id, guestId], refreshRate: false,
  };
  const create = { type: 'expense.create', input };
  const expenseId = (await write(create)).value.targetId!;
  const final = { type: 'settlement.finalize', date: null };
  const daily = { type: 'settlement.finalize', date: first };
  const owing = (amountKrw: number) => [{ fromMemberId: guestId, toMemberId: ownerMember.id, amountKrw }];
  assert.ok(current.settlement, '장부 응답에 정산 데이터가 있어야 합니다.');
  assert.equal(current.settlement.today, first);
  assert.equal(current.settlement.due, true);
  fixed(await f.send(commands, envelope(daily, current.revision), guest.jar), 403, 'forbidden');
  const dailyId = (await write(daily)).value.targetId;
  assert.equal(current.settlement.due, false);

  const nextDay = { ...input, title: '이튿날 교통비', amount: '600', occurredLocal: secondDay + 'T00:01', splitIds: [ownerMember.id] };
  await write({ type: 'expense.create', input: nextDay });
  const expenseRevision = current.revision;
  assert.deepEqual(current.settlement.days.slice(0, 2).map(day => [day.spentKrw, day.current.spentKrw]), [[1000, 1000], [600, 1600]]);
  fixed(await f.send(commands, envelope({ type: 'expense.update', id: expenseId, input: nextDay }, current.revision), owner.jar), 422, 'validation', 'settlementLocked');

  const report = envelope({ type: 'payment.report', toMemberId: ownerMember.id, amountKrw: 200 }, current.revision);
  const paymentId = ok<LedgerChange>(await f.send(commands, report, guest.jar)).value.targetId!;
  assert.equal(ok<LedgerChange>(await f.send(commands, report, guest.jar)).replayed, true);
  current = await read(guest.jar);
  assert.deepEqual(current.settlement.final.transfers, owing(500));
  assert.equal(current.settlement.payments.length, 1);
  const confirm = paymentCommand('payment.confirm', paymentId);
  fixed(await f.send(commands, envelope(confirm, current.revision), guest.jar), 403, 'forbidden');
  fixed(await f.send(commands, envelope({ ...confirm, expectedPaymentRevision: confirm.expectedPaymentRevision - 1 }, current.revision), owner.jar), 409, 'conflict');
  await write(confirm);
  const confirmedPaymentRevision = current.revision;
  const finalId = (await write(final)).value.targetId;
  assert.deepEqual(current.settlement.final.transfers, owing(300));
  fixed(await f.send(commands, envelope({ type: 'expense.create', input: nextDay }, current.revision), guest.jar), 422, 'validation', 'settlementLocked');

  now = midnight + 17 * 3_600_000 + 60_000;
  const second = (await write({ type: 'payment.report', toMemberId: ownerMember.id, amountKrw: 300 }, guest.jar)).value.targetId!;
  await write(paymentCommand('payment.confirm', second));
  assert.equal(current.settlement.today, secondDay);
  assert.deepEqual(current.settlement.days[0]!.current.transfers, owing(300));
  assert.deepEqual(current.settlement.final.transfers, []);
  assert.deepEqual(current.settlement.snapshots.find(row => row.id === dailyId)?.result.transfers, owing(500));
  const frozenFinal = current.settlement.snapshots.find(row => row.id === finalId);
  assert.deepEqual(frozenFinal?.result.transfers, owing(300));
  assert.equal(frozenFinal?.expenseRevision, expenseRevision);
  assert.equal(frozenFinal?.confirmedPaymentRevision, confirmedPaymentRevision);
  await write(paymentCommand('payment.requestVoid', paymentId), guest.jar);
  assert.deepEqual(current.settlement.final.transfers, []);
  const confirmVoid = paymentCommand('payment.confirmVoid', paymentId);
  fixed(await f.send(commands, envelope(confirmVoid, current.revision), guest.jar), 403, 'forbidden');
  await write(confirmVoid);
  assert.deepEqual(current.settlement.final.transfers, owing(200));
  await write({ type: 'settlement.reopen', date: null });
  await write({ type: 'settlement.reopen', date: first });
  await write({ type: 'expense.update', id: expenseId, input: { ...input, amount: '1200' } });
  const newer = (await write(daily)).value.targetId;
  assert.notEqual(newer, dailyId);
  assert.deepEqual(current.settlement.snapshots.find(row => row.id === newer)?.result.transfers, owing(600));
  assert.deepEqual(current.settlement.snapshots.find(row => row.id === dailyId)?.result.transfers, owing(500));
});

function ok<T>(result: Response): T {
  assert.equal(result.status, 200, result.raw);
  return result.json<T>();
}

function fixed(result: Response, status: number, code: string, field?: string) {
  assert.equal(result.status, status, result.raw);
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.match(String(result.headers['content-security-policy']), /frame-ancestors 'none'/);
  const body = result.json<{ error: { code: string; message: string; field?: string }; requestId: string }>();
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId']);
  assert.deepEqual(Object.keys(body.error).sort(), field ? ['code', 'field', 'message'] : ['code', 'message']);
  assert.equal(body.error.code, code);
  assert.equal(body.error.field, field);
  assert.match(body.requestId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  return body.error.message;
}

test('invited editor shares the ledger revision and totals, and a viewer cannot replay a write', async t => {
  const f = await fixture(t);
  const owner = await f.login('owner@example.invalid');
  const guest = await f.login('guest@example.invalid');
  const { trip, ownerMember } = await f.create(owner.jar);
  const path = ledgerPath(trip.id);
  const commands = commandPath(trip.id);
  const read = async (jar: Jar) => ok<{ ledger: LedgerDTO }>(await f.send(path, undefined, jar)).ledger;

  fixed(await f.send(path, undefined, guest.jar), 404, 'not_found');
  fixed(await f.send(commands, envelope(schedule), guest.jar), 404, 'not_found');
  const { tripRevision, token } = await f.invite(trip.id, owner.jar, guest.jar);
  assert.equal(tripRevision, 3);
  const initial = await read(guest.jar);
  assert.equal(initial.role, 'editor');
  const guestMember = initial.members.find(member => member.isMe)!;

  const createItem = envelope(schedule, tripRevision);
  const created = ok<LedgerChange>(await f.send(commands, createItem, guest.jar));
  const itineraryId = created.value.targetId;
  assert.ok(itineraryId);
  assert.deepEqual(created, { value: { targetId: itineraryId }, tripRevision: 4, replayed: false });
  assert.deepEqual(ok<LedgerChange>(await f.send(commands, createItem, guest.jar)), { ...created, replayed: true });
  fixed(await f.send(commands, envelope({ ...schedule, input: { ...schedule.input, title: '다른 입력' } }, tripRevision, createItem.operationId), guest.jar), 409, 'conflict');
  fixed(await f.send(commands, envelope({ type: 'fx.update', source: 'manual', rateMilli: 39000 }, 4), guest.jar), 403, 'forbidden');
  fixed(await f.send(tripPath(trip.id), { ...settings, expectedRevision: tripRevision, operationId: randomUUID() }, owner.jar, {}, 'PATCH'), 409, 'conflict');

  const expense = {
    type: 'expense.create',
    input: { itineraryId, title: '간식 원문', occurredLocal: '2026-11-02T11:00', currency: 'THB', amount: '10.00',
      payerId: ownerMember.id, splitIds: [ownerMember.id, guestMember.id], refreshRate: false },
  };
  const results = await Promise.all([
    f.send(commands, envelope(expense, 4), owner.jar),
    f.send(commands, envelope(expense, 4), guest.jar),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const stale = results.find(result => result.status === 409)!;
  fixed(stale, 409, 'conflict');
  assert.ok(!stale.raw.includes(expense.input.title));

  const response = await f.send(path, undefined, owner.jar);
  const body = ok<{ ledger: LedgerDTO }>(response);
  const { ledger } = body;
  assert.deepEqual(Object.keys(body), ['ledger']);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(ledger.revision, 5);
  assert.equal(ledger.expenses.length, 1);
  assert.deepEqual(ledger.summary.byItem, [{ itineraryId, budgetKrw: 2000, spentKrw: 386, remainingKrw: 1614 }]);
  assert.equal(ledger.summary.spentKrw, 386);
  assert.equal(ledger.summary.remainingKrw, 99614);
  assert.deepEqual(ledger.expenses[0]!.shares.map(share => share.amountKrw), [193, 193]);
  assert.deepEqual(Object.keys(ledger.members[0]!).sort(), ['active', 'alias', 'id', 'isMe', 'role', 'tripId']);
  assert.deepEqual(Object.keys(ledger.history[0]!).sort(), ['action', 'at', 'memberId', 'revision', 'targetId']);
  assert.ok(!JSON.stringify(ledger.history).includes(expense.input.title));
  for (const privateValue of [owner.email, guest.email, owner.userId, guest.userId, token, createItem.operationId]) {
    assert.ok(!response.raw.includes(privateValue));
  }

  ok(await f.send(tripPath(trip.id) + '/members/' + guestMember.id,
    { role: 'viewer', active: true, expectedRevision: 5, operationId: randomUUID() }, owner.jar, {}, 'PATCH'));
  assert.equal((await read(guest.jar)).role, 'viewer');
  fixed(await f.send(commands, envelope(schedule, 6), guest.jar), 403, 'forbidden');
  fixed(await f.send(commands, createItem, guest.jar), 403, 'forbidden');
  assert.equal((await read(owner.jar)).revision, 6);
});

test('foreign itinerary, payer and split member references leave the ledger unchanged', async t => {
  const f = await fixture(t);
  const owner = await f.login('owner@example.invalid');
  const outsider = await f.login('outsider@example.invalid');
  const local = await f.create(owner.jar);
  const foreign = await f.create(outsider.jar);
  const itineraryId = ok<LedgerChange>(await f.send(commandPath(foreign.trip.id), envelope(schedule), outsider.jar)).value.targetId;
  assert.ok(itineraryId);
  const input = {
    itineraryId: null, title: '점심', occurredLocal: '2026-11-02T12:00', currency: 'KRW', amount: '500',
    payerId: local.ownerMember.id, splitIds: [local.ownerMember.id], refreshRate: false,
  };
  for (const [field, value] of [
    ['itineraryId', itineraryId], ['payerId', foreign.ownerMember.id], ['splitIds', [foreign.ownerMember.id]],
  ] as const) {
    const result = await f.send(commandPath(local.trip.id), envelope({ type: 'expense.create', input: { ...input, [field]: value } }), owner.jar);
    fixed(result, 422, 'validation', field);
    assert.ok(!result.raw.includes(foreign.ownerMember.id));
    assert.ok(!result.raw.includes(itineraryId));
  }
  const { ledger } = ok<{ ledger: LedgerDTO }>(await f.send(ledgerPath(local.trip.id), undefined, owner.jar));
  assert.equal(ledger.revision, 1);
  assert.deepEqual(ledger.expenses, []);
});

test('account mismatch preserves the current cookie, while missing or revoked sessions clear only that cookie', async t => {
  const f = await fixture(t);
  const previous = await f.login('previous@example.invalid');
  const current = await f.login('current@example.invalid');
  const { trip } = await f.create(current.jar);
  const path = ledgerPath(trip.id);
  const commands = commandPath(trip.id);
  const expected = { 'X-TripMoney-Expected-Account': previous.userId };
  const before = new Map(current.jar);
  for (const result of [await f.send(path, undefined, current.jar, expected), await f.send(commands, '{', current.jar, expected)]) {
    fixed(result, 412, 'account_changed');
    assert.equal(result.headers['set-cookie'], undefined);
    assert.deepEqual(current.jar, before);
  }
  const matching = { 'X-TripMoney-Expected-Account': current.userId };
  assert.equal(ok<{ ledger: LedgerDTO }>(await f.send(path, undefined, current.jar, matching)).ledger.revision, 1);
  ok(await f.send(commands, envelope(schedule), current.jar, matching));

  const revoked = new Map(current.jar);
  assert.equal((await f.send('/api/customer/auth/logout', {}, current.jar)).status, 204);
  const challenge = [challengeCookie, challengeCookie + '=synthetic'] as const;
  const unknown = new Map([[sessionCookie, sessionCookie + '=' + randomBytes(32).toString('base64url')], challenge]);
  for (const [target, payload, jar] of [
    [path, undefined, new Map<string, string>([challenge])], [path, undefined, unknown], [commands, envelope(schedule), revoked],
  ] as const) {
    const result = await f.send(target, payload, jar, expected);
    fixed(result, 401, 'unauthenticated');
    assert.equal(result.headers['set-cookie']?.length, 1);
    assert.match(result.headers['set-cookie']![0]!, /^tripmoney_session_dev=; Max-Age=0/);
    assert.equal(jar.has(sessionCookie), false);
  }
  assert.equal(unknown.get(challengeCookie), challenge[1]);
});

test('strict write headers reject requests before any ledger mutation', async t => {
  const f = await fixture(t);
  const owner = await f.login('owner@example.invalid');
  const { trip } = await f.create(owner.jar);
  const commands = commandPath(trip.id);
  const invalidHeaders: Headers[] = [
    { Host: 'localhost:8125' }, { Host: ['127.0.0.1:8125', '127.0.0.1:8125'] }, { Origin: 'https://example.invalid' },
    { 'Content-Type': 'application/json; charset=utf-8' }, { 'X-TripMoney-Request': '0' },
    { Origin: [] }, { 'Content-Type': [] }, { 'X-TripMoney-Request': [] },
    { Origin: [origin, origin] }, { 'Content-Type': ['application/json', 'application/json'] },
    { 'X-TripMoney-Request': ['1', '1'] },
  ];
  for (const headers of invalidHeaders) fixed(await f.send(commands, envelope(schedule), owner.jar, headers), 403, 'forbidden');
  fixed(await f.send(ledgerPath(trip.id), undefined, owner.jar, { Host: 'localhost:8125' }), 403, 'forbidden');
  assert.equal(ok<{ ledger: LedgerDTO }>(await f.send(ledgerPath(trip.id), undefined, owner.jar, {
    Origin: [], 'Content-Type': [], 'X-TripMoney-Request': [],
  })).ledger.revision, 1);
});

test('validates exact command shapes, nonnil UUIDs, field types and the UTF-8 byte limit before calling the service', async t => {
  let writes = 0;
  const f = await fixture(t, { ledger: service => ({
    ...service,
    execute: (...args) => { writes++; return service.execute(...args); },
  }) });
  const owner = await f.login('owner@example.invalid');
  const { trip, ownerMember } = await f.create(owner.jar);
  const commands = commandPath(trip.id);
  const expense = {
    type: 'expense.create',
    input: { itineraryId: null, title: '간식', occurredLocal: '2026-11-02T10:00', currency: 'KRW', amount: '500',
      payerId: ownerMember.id, splitIds: [ownerMember.id], refreshRate: false },
  };
  const cases: [unknown, string?][] = [
    [null], [[]], ['{'], [Buffer.from([0xc3, 0x28])],
    [{ ...envelope(schedule), actor: { userId: owner.userId } }],
    [{ ...envelope(schedule), role: 'owner' }],
    [{ command: schedule, expectedRevision: 1 }],
    [{ ...envelope(schedule), expectedRevision: '1' }, 'expectedRevision'],
    [envelope(schedule, 0), 'expectedRevision'],
    [envelope(schedule, Number.MAX_SAFE_INTEGER + 1), 'expectedRevision'],
    [envelope(schedule, 1, nil), 'operationId'],
    [envelope({ ...schedule, type: 'unknown' })],
    [envelope({ ...schedule, id: randomUUID() })],
    [envelope({ ...schedule, input: { ...schedule.input, email: owner.email } })],
    [envelope({ ...schedule, input: { ...schedule.input, title: 1 } }), 'title'],
    [envelope({ ...schedule, input: { ...schedule.input, date: '2026-02-30' } }), 'date'],
    [envelope({ ...schedule, input: { ...schedule.input, startTime: '25:00' } }), 'startTime'],
    [envelope({ ...schedule, input: { ...schedule.input, endTime: '09:00' } }), 'endTime'],
    [envelope({ ...schedule, input: { ...schedule.input, place: '\u0000' } }), 'place'],
    [envelope({ ...expense, input: { ...expense.input, amount: 500 } }), 'amount'],
    [envelope({ ...expense, input: { ...expense.input, currency: 'USD' } }), 'currency'],
    [envelope({ ...expense, input: { ...expense.input, occurredLocal: '2026-11-02 10:00' } }), 'occurredLocal'],
    [envelope({ ...expense, input: { ...expense.input, itineraryId: 'bad' } }), 'itineraryId'],
    [envelope({ ...expense, input: { ...expense.input, payerId: nil } }), 'payerId'],
    [envelope({ ...expense, input: { ...expense.input, splitIds: [ownerMember.id, ownerMember.id] } }), 'splitIds'],
    [envelope({ ...expense, input: { ...expense.input, refreshRate: 'false' } }), 'refreshRate'],
    [envelope({ type: 'schedule.reorder', date: schedule.input.date, ids: ['bad'] }), 'ids'],
    [envelope({ type: 'schedule.cancel', id: 'bad' })],
    [envelope({ type: 'fx.update', rateMilli: '38600', source: 'demo' }), 'rateMilli'],
    [envelope({ type: 'fx.update', rateMilli: 38600, source: 'live' }), 'source'],
  ];
  for (const [data, field] of cases) fixed(await f.send(commands, data, owner.jar), 422, 'validation', field);
  fixed(await f.send(ledgerPath(nil), undefined, owner.jar), 422, 'validation', 'tripId');
  fixed(await f.send(commandPath('bad'), envelope(schedule), owner.jar), 422, 'validation', 'tripId');
  const json = JSON.stringify(envelope(schedule));
  const boundary = json + ' '.repeat(8192 - Buffer.byteLength(json));
  fixed(await f.send(commands, boundary + ' ', owner.jar), 422, 'validation');
  assert.equal(writes, 0);
  assert.equal(ok<LedgerChange>(await f.send(commands, boundary, owner.jar)).tripRevision, 2);
  assert.equal(writes, 1);
});

test('ledger service failure returns only fixed public errors', async t => {
  let failure: unknown;
  const f = await fixture(t, { ledger: service => ({
    ...service,
    async get(...args) {
      if (failure) throw failure;
      return service.get(...args);
    },
  }) });
  const owner = await f.login('owner@example.invalid');
  const { trip } = await f.create(owner.jar);
  const path = ledgerPath(trip.id);
  failure = new Error('internal error details');
  const unavailable = await f.send(path, undefined, owner.jar);
  assert.equal(fixed(unavailable, 503, 'unavailable'), '인증 확인을 잠시 사용할 수 없습니다.');
  assert.ok(!unavailable.raw.includes('internal error details'));
  failure = new IdentityError('validation', 'internal error details', 'sessionHash');
  const invalid = await f.send(path, undefined, owner.jar);
  assert.equal(fixed(invalid, 422, 'validation'), '입력 형식을 확인해 주세요.');
  assert.ok(!invalid.raw.includes('internal error details'));
  assert.ok(!invalid.raw.includes('sessionHash'));
  failure = undefined;
  f.runtime.close();
  const closed = await f.send(path, undefined, owner.jar);
  assert.equal(fixed(closed, 503, 'unavailable'), '인증 확인을 잠시 사용할 수 없습니다.');
  assert.equal(closed.headers['set-cookie'], undefined);
});

test('routes only the two ledger endpoints and keeps an explicit static allowlist', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tripmoney-ledger-http-'));
  t.after(() => rm(root, { recursive: true }));
  await mkdir(join(root, 'ledger'));
  const f = await fixture(t, { webRoot: root });
  const identityOnly = await fixture(t, { withoutLedger: true });
  const authOnly = await fixture(t, { withoutLedger: true, withoutIdentity: true });
  const id = randomUUID();
  const path = ledgerPath(id);
  const commands = commandPath(id);
  for (const fixture of [identityOnly, authOnly]) {
    fixed(await fixture.send(path), 404, 'not_found');
    fixed(await fixture.send(commands, envelope(schedule)), 404, 'not_found');
  }
  for (const [target, method] of [
    [path, 'POST'], [path, 'HEAD'], [commands, 'GET'], [commands, 'PATCH'],
    [path + '/', 'GET'], [path + '?x=1', 'GET'], [commands + '/extra', 'POST'],
    [tripPath(id) + '/%6cedger', 'GET'], [tripPath(id) + '/extra/../ledger', 'GET'],
  ] as const) {
    const response = await f.send(target, undefined, undefined, {}, method);
    if (method === 'HEAD') assert.equal(response.status, 404);
    else fixed(response, 404, 'not_found');
  }
  for (const name of ['controller.mjs', 'view.mjs', 'forms.mjs', 'itinerary-view.mjs', 'expenses-view.mjs', 'settlement-view.mjs']) {
    await writeFile(join(root, 'ledger', name), 'export {};');
    const response = await f.send('/ledger/' + name);
    assert.equal(response.status, 200);
    assert.equal(response.raw, 'export {};');
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  for (const path of ['ledger/controller.d.mts', 'ledger/private.mjs', 'core/ledger/contracts.ts', 'server/http/ledger-routes.ts', 'tests/http/ledger.test.ts']) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), 'private');
    fixed(await f.send('/' + path), 404, 'not_found');
  }
  await rm(join(root, 'ledger', 'view.mjs'));
  await symlink(join(root, 'ledger', 'private.mjs'), join(root, 'ledger', 'view.mjs'));
  fixed(await f.send('/ledger/view.mjs'), 404, 'not_found');
});
