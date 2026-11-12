import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import type { LedgerDTO } from '../../core/ledger/contracts.js';
import type { TripDTO } from '../../server/identity/contracts.js';
import type { LedgerApi } from '../../web/api.mjs';
import { ApiError, createApi } from '../../web/api.mjs';

const tripId = '10000000-0000-4000-8000-000000000001';
const otherTrip = '10000000-0000-4000-8000-000000000002';
const account = '20000000-0000-4000-8000-000000000001';
const otherAccount = '20000000-0000-4000-8000-000000000002';
const memberId = '30000000-0000-4000-8000-000000000001';
const itemId = '40000000-0000-4000-8000-000000000001';
const operationId = '50000000-0000-4000-8000-000000000001';
const at = '2026-11-05T00:00:00.000Z';
const trip: TripDTO = {
  id: tripId, name: '방콕 여행', destination: '방콕', startDate: '2026-11-05', endDate: '2026-11-07',
  timeZone: 'Asia/Bangkok', budgetKrw: 100_000, settlementMode: 'end_of_trip', dailyTime: '20:00',
  revision: 4, status: 'active', createdAt: at, ownerMemberId: memberId, role: 'owner', memberCount: 1,
};
const item: LedgerDTO['items'][number] = {
  id: itemId, tripId, date: trip.startDate, startTime: '', endTime: '', title: '시장', place: '', budgetKrw: 60_000,
  status: 'active', order: 0, createdAt: at, updatedAt: at, updatedByMemberId: memberId,
};
const expense: LedgerDTO['expenses'][number] = {
  id: '60000000-0000-4000-8000-000000000001', tripId, itineraryId: itemId, title: '시장 식사',
  currency: 'KRW', amountCents: 4_500_000, amountKrw: 45_000, rateMilli: 1000, rateSource: 'unit',
  occurredAt: '2026-11-05T05:00:00.000Z', occurredLocal: '2026-11-05T12:00', localDate: trip.startDate,
  timeZone: trip.timeZone, payerId: memberId, splitIds: [memberId], shares: [{memberId, amountKrw: 45_000}],
  status: 'active', createdAt: at, updatedAt: at, updatedByMemberId: memberId,
};
const legacyResult = {spentKrw: 55_000, balances: [{memberId, paidKrw: 55_000, owedKrw: 55_000, netKrw: 0}], transfers: []};
const ledger: LedgerDTO = {
  tripId, revision: 4, role: 'owner', startDate: trip.startDate, endDate: trip.endDate, timeZone: trip.timeZone,
  budgetKrw: 100_000, fx: {rateMilli: 38600, source: 'demo'},
  members: [{id: memberId, tripId, alias: '지수', role: 'owner', active: true, isMe: true}],
  items: [item], expenses: [expense, {...expense, id: '60000000-0000-4000-8000-000000000002', title: '택시',
    itineraryId: null, amountCents: 1_000_000, amountKrw: 10_000, shares: [{memberId, amountKrw: 10_000}]}], history: [],
  summary: {allocatedKrw: 60_000, spentKrw: 55_000, remainingKrw: 45_000, unassignedKrw: 10_000,
    byItem: [{itineraryId: itemId, budgetKrw: 60_000, spentKrw: 45_000, remainingKrw: 15_000}],
    byDate: [{date: trip.startDate, spentKrw: 55_000}], byMember: [{memberId, paidKrw: 55_000, owedKrw: 55_000, netKrw: 0}]},
  settlement: {mode: 'end_of_trip', today: trip.startDate, dailyTime: '20:00', due: false,
    days: [{date: trip.startDate, spentKrw: 55_000, current: legacyResult}], final: legacyResult, snapshots: [], payments: []},
};
const change = {value: {targetId: itemId}, tripRevision: 5, replayed: false};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});
const me = (userId = account) => ({me: {userId, email: 'fixture@example.invalid', expiresAt: at}});
const fake = (options: Partial<LedgerApi> = {}): LedgerApi => ({
  me: async () => me(), getLedger: async () => ledger, executeLedger: async () => change, ...options,
});
const controllerPath = '../../web/ledger/controller.mjs';
async function setup(t: TestContext, api = fake(), options = {}) {
  const {createLedgerController}: typeof import('../../web/ledger/controller.mjs') = await import(controllerPath);
  const c = createLedgerController(api, options);
  t.after(() => c.destroy());
  return c;
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('Google selection retains user place memo and stores the reference without copying provider text',async t=>{
 const c=await setup(t);await c.setContext(account,trip);c.editSchedule(itemId);
 c.setScheduleField('place','내가 작성한 메모');
 const candidate={ref:{provider:'google',placeId:'ChIJfixture'},name:'GOOGLE_PROVIDER_NAME',address:'GOOGLE_PROVIDER_ADDRESS',lat:13,lng:100,source:'google'} as const;
 assert.equal(c.applyPlace(candidate),true);
 assert.equal(c.state.scheduleDraft.place,'내가 작성한 메모');
 assert.deepEqual(c.state.scheduleDraft.placeRef,{provider:'google',placeId:'ChIJfixture'});
 assert.ok(!JSON.stringify(c.state.scheduleDraft).includes('GOOGLE_PROVIDER'));
});

test('ledger client sends the expected account and exact command, projects nested public data and rejects unsafe totals', async () => {
  let last: [string, RequestInit] | undefined;
  let body: unknown = {ledger: {...ledger, members: [{...ledger.members[0], email: 'private'}],
    expenses: [{...expense, shares: [{...expense.shares[0], userId: 'private'}]}, ledger.expenses[1]], token: 'private'}};
  const client = createApi(async (url, init) => { last = [url, init]; return json(body); });
  assert.equal(typeof client.getLedger, 'function');
  const projected = await client.getLedger(tripId, account);
  assert.deepEqual(projected, ledger);
  assert.equal(last?.[0], `/api/customer/trips/${tripId}/ledger`);
  assert.equal(new Headers(last?.[1].headers).get('X-TripMoney-Expected-Account'), account);
  body = change;
  const command = {type: 'schedule.cancel' as const, id: itemId};
  assert.deepEqual(await client.executeLedger(tripId, command, 4, operationId, account), change);
  assert.equal(last?.[0], `/api/customer/trips/${tripId}/ledger/commands`);
  assert.equal(new Headers(last?.[1].headers).get('X-TripMoney-Expected-Account'), account);
  assert.deepEqual(JSON.parse(String(last?.[1].body)), {command, expectedRevision: 4, operationId});
  body = {ledger: {...ledger, summary: {...ledger.summary, remainingKrw: Number.MAX_SAFE_INTEGER + 1}}};
  await assert.rejects(client.getLedger(tripId, account), {code: 'invalid_response'});
});

test('poll refreshes a clean form but cannot rebase a dirty form; explicit conflict reapply uses a new operation', async t => {
  let current = ledger;
  const sent: Parameters<LedgerApi['executeLedger']>[] = [];
  const c = await setup(t, fake({
    getLedger: async () => current,
    executeLedger: async (...args) => {
      sent.push(args);
      if (args[2] !== current.revision) throw new ApiError(409, 'conflict');
      return change;
    },
  }));
  await c.setContext(account, trip);
  c.editSchedule(itemId);
  current = {...ledger, revision: 5, items: [{...item, title: '새 시장'}]};
  await c.refresh();
  assert.equal(c.state.scheduleDraft.title, '새 시장');
  c.setScheduleField('title', '내 일정');
  current = {...ledger, revision: 6, items: [{...item, title: '공동 일정'}]};
  await c.refresh();
  await c.saveSchedule();
  assert.equal(c.state.scheduleDraft.title, '내 일정');
  assert.equal(c.state.error?.code, 'conflict');
  assert.equal(sent[0]?.[2], 5);
  assert.equal(await c.reapply(), false);
  await c.refreshConflict();
  assert.deepEqual(c.state.conflict?.differences.find(d => d.label === '일정 이름'),
    {label: '일정 이름', latest: '공동 일정', proposed: '내 일정'});
  assert.equal(sent.length, 1);
  await c.reapply();
  assert.equal(sent[1]?.[2], 6);
  assert.notEqual(sent[0]?.[3], sent[1]?.[3]);
});

test('uncertain writes are scoped by trip and target; only dedicated retry repeats the original body', async t => {
  const sent: Parameters<LedgerApi['executeLedger']>[] = [];
  const c = await setup(t, fake({
    getLedger: async id => id === tripId ? ledger : {...ledger, tripId: id, items: [], expenses: [], members: []},
    executeLedger: async (...args) => {sent.push(args); throw new ApiError(0, 'network');},
  }));
  await c.setContext(account, trip);
  c.setScheduleField('title', '원본');
  await c.saveSchedule();
  c.setScheduleField('title', '수정본');
  await c.saveSchedule();
  c.confirmCancel('schedule', itemId);
  await c.cancelConfirmed();
  assert.equal(sent.length, 1);
  await c.setContext(account, {...trip, id: otherTrip});
  assert.equal(c.state.scheduleDraft.title, '');
  assert.equal(await c.retryPending(), false);
  await c.setContext(account, trip);
  assert.equal(c.state.scheduleDraft.title, '수정본');
  await c.retryPending();
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(sent[0]?.[4], account);
  await c.setContext(otherAccount, trip);
  assert.equal(c.state.scheduleDraft.title, '');
  assert.equal(await c.retryPending(), false);
  await c.setContext(account, trip);
  assert.equal(c.state.scheduleDraft.title, '');
});

test('a stale account preflight cannot write or restore a draft', async t => {
  let unauthorized = 0;
  const c = await setup(t, fake({me: async () => me(otherAccount), executeLedger: async () => assert.fail('stale account wrote')}), {
    onUnauthorized: () => {unauthorized++;},
  });
  await c.setContext(account, trip);
  c.setScheduleField('title', '이전 계정');
  await c.saveSchedule();
  assert.equal(c.state.ledger, null);
  assert.equal(c.state.scheduleDraft.title, '');
  assert.equal(unauthorized, 1);
  await c.setContext(account, trip);
  assert.equal(c.state.scheduleDraft.title, '');
});

test('403 checks current role, 404 clears retained drafts and a stale response cannot replace another trip', async t => {
  let phase: 'owner' | 'viewer' | 'missing' | 'late' = 'owner';
  let unavailable = 0;
  let release: (value: LedgerDTO) => void = () => assert.fail('no pending response');
  const c = await setup(t, fake({
    getLedger: async id => {
      if (id === otherTrip) return {...ledger, tripId: id};
      if (phase === 'missing') throw new ApiError(404, 'not_found');
      if (phase === 'late') return new Promise(resolve => {release = resolve;});
      return {...ledger, role: phase};
    },
    executeLedger: async () => {phase = 'viewer'; throw new ApiError(403, 'forbidden');},
  }), {onUnavailable: () => {unavailable++;}});
  await c.setContext(account, trip);
  c.setScheduleField('title', '권한 확인 전');
  await c.saveSchedule();
  assert.equal(c.state.canEdit, false);
  assert.equal(c.state.scheduleDraft.title, '');
  phase = 'missing';
  await c.refresh();
  assert.equal(c.state.ledger, null);
  assert.equal(unavailable, 1);
  phase = 'late';
  const old = c.refresh();
  await turn();
  await c.setContext(account, {...trip, id: otherTrip});
  release(ledger);
  await old;
  assert.equal((c.state.ledger as LedgerDTO | null)?.tripId, otherTrip);
  c.destroy();
  assert.equal(c.state.ledger, null);
});

test('poll skips hidden and in-flight requests and destroy clears its timer', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  let visible = false;
  let requests = 0;
  let release: (value: LedgerDTO) => void = () => assert.fail('no pending response');
  const c = await setup(t, fake({
    getLedger: async () => ++requests === 1 ? ledger : new Promise(resolve => {release = resolve;}),
  }), {isVisible: () => visible});
  await c.setContext(account, trip);
  t.mock.timers.tick(5000);
  assert.equal(requests, 1);
  visible = true;
  t.mock.timers.tick(5000);
  assert.equal(requests, 2);
  t.mock.timers.tick(5000);
  assert.equal(requests, 2);
  release(ledger);
  await turn();
  c.destroy();
  t.mock.timers.tick(10000);
  assert.equal(requests, 2);
});

test('a successful exact retry preserves input edited while the original result was unknown', async t => {
  let sent = 0;
  const c = await setup(t, fake({
    executeLedger: async (_id, command) => {
      assert.equal(command.type, 'schedule.create');
      if (command.type === 'schedule.create') assert.equal(command.input.title, '처음 저장한 입력');
      if (++sent === 1) throw new ApiError(0, 'network');
      return {...change, replayed: true};
    },
  }));
  await c.setContext(account, trip);
  c.setScheduleField('title', '처음 저장한 입력');
  await c.saveSchedule();
  c.setScheduleField('title', '나중에 편집한 입력');
  assert.equal(await c.retryPending(), true);
  assert.equal(c.state.pendingKind, null);
  assert.equal(c.state.scheduleDraft.title, '나중에 편집한 입력');
});

test('a failed parent refresh can recover on a later ledger read at the same revision', async t => {
  let parentAttempts = 0;
  let c: Awaited<ReturnType<typeof setup>>;
  c = await setup(t, fake({getLedger: async () => ({...ledger, revision: 5})}), {
    onChanged: (_account: string, _tripId: string, revision: number) => {
      if (++parentAttempts === 2) void c.setContext(account, {...trip, revision});
    },
  });
  await c.setContext(account, trip);
  await turn();
  assert.equal(parentAttempts, 1, 'failure should not immediately retry the parent');
  await c.resume();
  assert.equal(parentAttempts, 2, 'the next ledger read should offer parent recovery');
  await c.refresh();
  assert.equal(parentAttempts, 2, 'a synced parent needs no further requests');
});

test('a repeated ledger 404 offers parent recovery at the next polling interval', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  let parentAttempts = 0;
  const c = await setup(t, fake({getLedger: async () => {throw new ApiError(404, 'not_found');}}), {
    onUnavailable: () => {parentAttempts++;},
  });
  await c.setContext(account, trip);
  await turn();
  assert.equal(parentAttempts, 1);
  t.mock.timers.tick(5000);
  await turn();
  assert.equal(parentAttempts, 2);
  await c.refresh();
  assert.equal(parentAttempts, 3);
  assert.equal(c.state.ledger, null);
});

test('reconciling a remotely reordered row restores a moved button or its heading if the button is disabled', async () => {
  const formsPath = '../../web/ledger/forms.mjs';
  const {reconcile} = await import(formsPath);
  for (const disabledAfterMove of [false, true]) {
    const body = {};
    const doc: {body: object; activeElement: object} = {body, activeElement: body};
    function control() {
      return {isConnected: true, disabled: false, closest: () => null, focus() {doc.activeElement = this;}};
    }
    const button = control(), heading = control();
    const first = {id: 'first'}, second = {id: 'second'};
    const focusedRow = disabledAfterMove ? first : second;
    const parent = {
      ownerDocument: doc, children: [first, second],
      contains: (node: object) => node === button,
      insertBefore(row: typeof first, before: typeof first) {
        this.children.splice(this.children.indexOf(row), 1);
        this.children.splice(this.children.indexOf(before), 0, row);
        if (row === focusedRow) doc.activeElement = body;
      },
    };
    doc.activeElement = button;
    reconcile(parent, new Map([[first.id, first], [second.id, second]]), [second, first],
      () => assert.fail('existing row was replaced'), (row: typeof first) => {
        if (row === focusedRow) button.disabled = disabledAfterMove;
      }, () => heading);
    assert.deepEqual(parent.children, [second, first]);
    assert.equal(doc.activeElement, disabledAfterMove ? heading : button);
  }
});

test('parent refresh after returning to the same trip can start while the old context is still stalled', async () => {
  const {createTravelRefreshQueue} = await import(controllerPath);
  assert.equal(typeof createTravelRefreshQueue, 'function');
  const unresolved: ((ok: boolean) => void)[] = [];
  const state = {accountId: account as string | null, selectedTripId: tripId as string | null, busy: null as string | null};
  const queue = createTravelRefreshQueue({
    state, refresh: () => new Promise<boolean>(resolve => {unresolved.push(resolve);}),
  });
  queue.request(account, tripId);
  await turn();
  assert.equal(unresolved.length, 1);
  state.accountId = state.selectedTripId = null;
  queue.sync();
  state.accountId = account;
  state.selectedTripId = tripId;
  queue.sync();
  queue.request(account, tripId);
  await turn();
  assert.equal(unresolved.length, 2);
  unresolved[0]!(false);
  await turn();
  queue.request(account, tripId);
  await turn();
  assert.equal(unresolved.length, 2, 'the old completion must leave the current refresh coalesced');
  unresolved[1]!(false);
  await turn();
  assert.equal(unresolved.length, 2, 'failure should wait for another ledger observation');
  state.busy = 'refresh';
  queue.request(account, tripId);
  state.accountId = state.selectedTripId = null;
  queue.sync();
  state.accountId = account;
  state.selectedTripId = tripId;
  state.busy = null;
  queue.sync();
  await turn();
  assert.equal(unresolved.length, 2, 'work queued by a previous context must be dropped');
  queue.destroy();
});

function webLedgerDom() {
  // Model the focus loss that occurs when an already-mounted row is reinserted.
  const doc = {
    body: {} as object,
    activeElement: null as object | null,
    createElement: (tag: string) => new Node(tag),
  };
  class Node {
    ownerDocument = doc;
    children: Node[] = [];
    dataset: Record<string, string> = {};
    parent: Node | null = null;
    isConnected = true;
    disabled = false;
    hidden = false;
    textContent = '';
    value = '';
    constructor(readonly tagName: string) {}
    get firstElementChild() {return this.children[0];}
    get lastElementChild() {return this.children.at(-1);}
    setAttribute() {}
    append(...nodes: Node[]) {for (const node of nodes) this.insertBefore(node, null);}
    contains(node: object): boolean {return node === this || this.children.some(child => child.contains(node));}
    closest(selector: string): Node | null {
      if (selector === '[data-expense-id]' && this.dataset.expenseId) return this;
      if (selector === '[data-payment-id]' && this.dataset.paymentId) return this;
      if (selector === '[hidden]' && this.hidden) return this;
      return this.parent?.closest(selector) ?? null;
    }
    focus() {doc.activeElement = this;}
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    insertBefore(node: Node, before: Node | null) {
      if (node.parent && doc.activeElement && node.contains(doc.activeElement)) doc.activeElement = doc.body;
      node.remove();
      this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
      node.parent = this;
    }
    addEventListener() {}
  }
  const controls = new Map<string, Node>();
  const refs = new Proxy({}, {get: (_, key: string) => {
    if (!controls.has(key)) controls.set(key, new Node(''));
    return controls.get(key);
  }});
  return {controls, doc, refs};
}

test('an expense card reordered by a remote occurrence-time change retains focus on its edit button', async t => {
  const expensesPath = '../../web/ledger/expenses-view.mjs';
  const {mountExpenses} = await import(expensesPath);
  const c = await setup(t);
  await c.setContext(account, trip);
  const {controls, doc, refs} = webLedgerDom();
  const render = mountExpenses(refs, c, {on() {}});
  render(c.state);
  const list = controls.get('ledger-expense-list')!;
  const second = list.children[1]!;
  const edit = second.lastElementChild!.children[0]!;
  edit.focus();
  const moved = {...ledger.expenses[1]!, occurredAt: '2026-11-05T11:30:00.000Z', occurredLocal: '2026-11-05T18:30'};
  render({...c.state, ledger: {...ledger, revision: 5, expenses: [expense, moved]}});
  assert.equal(list.children[0], second);
  assert.equal(doc.activeElement, edit);
  render({...c.state, canEdit: false});
  assert.equal(doc.activeElement, second.firstElementChild);
});

const recipientId = '30000000-0000-4000-8000-000000000002';
const settlementResult = {
  spentKrw: 55_000,
  balances: [
    {memberId, paidKrw: 0, owedKrw: 25_000, netKrw: -25_000},
    {memberId: recipientId, paidKrw: 55_000, owedKrw: 30_000, netKrw: 25_000},
  ],
  transfers: [{fromMemberId: memberId, toMemberId: recipientId, amountKrw: 25_000}],
};
const paymentId = '60000000-0000-4000-8000-000000000003';
const settlement = {
  mode: 'daily' as const, today: '2026-11-06', dailyTime: '20:00', due: true,
  days: [
    {date: '2026-11-05', spentKrw: 55_000, current: settlementResult},
    {date: '2026-11-06', spentKrw: 0, current: {spentKrw: 0, balances: [], transfers: []}},
    {date: '2026-11-07', spentKrw: 0, current: {spentKrw: 0, balances: [], transfers: []}},
  ],
  final: settlementResult,
  snapshots: [{id: itemId, date: '2026-11-05', sourceRevision: 3, expenseRevision: 2, confirmedPaymentRevision: 0, createdAt: at,
    createdByMemberId: memberId, result: settlementResult, reopenedAt: null, reopenedByMemberId: null}],
  payments: [{id: paymentId, fromMemberId: memberId, toMemberId: recipientId, amountKrw: 5000, revision: 4,
    status: 'reported' as const, reportedAt: at, confirmedAt: null, confirmedDate: null,
    voidRequestedByMemberId: null, voidRequestedAt: null, voidedAt: null, voidedByMemberId: null}],
};
const settlementLedger: LedgerDTO = {...ledger, settlement, members: [...ledger.members, {
  id: recipientId, tripId, alias: '현우', role: 'editor' as const, active: true, isMe: false,
}]};

test('the ledger client projects public settlement data and rejects malformed nested settlement rows', async () => {
  let value: unknown = {...settlement, privateToken: 'private',
    final: {...settlement.final, transfers: [{...settlement.final.transfers[0], userId: 'private'}]}};
  const client = createApi(async () => json({ledger: {...settlementLedger, settlement: value}}));
  assert.deepEqual((await client.getLedger(tripId, account)).settlement, settlement);
  value = {...settlement, payments: [{...settlement.payments[0], amountKrw: -1}]};
  await assert.rejects(client.getLedger(tripId, account), {code: 'invalid_response'});
  value = {...settlement, payments: [{...settlement.payments[0], revision: 0}]};
  await assert.rejects(client.getLedger(tripId, account), {code: 'invalid_response'});
});

test('settlement conflicts require re-reading and starting the action again', async t => {
  let current = settlementLedger;
  const sent: Parameters<LedgerApi['executeLedger']>[] = [];
  const c = await setup(t, fake({
    getLedger: async () => current,
    executeLedger: async (...args) => {
      sent.push(args);
      if (args[2] !== current.revision) throw new ApiError(409, 'conflict');
      return change;
    },
  }));
  await c.setContext(account, trip);
  assert.equal(c.state.settlementDate, '2026-11-06');
  c.selectSettlementDate('2026-11-07');
  assert.equal(await c.changeSettlement('settlement.finalize', c.state.settlementDate), false);
  assert.equal(sent.length, 0);
  current = {...settlementLedger, revision: 5};
  assert.equal(await c.changeSettlement('settlement.finalize', null), false);
  assert.equal(c.state.conflict?.type, 'settlement.finalize');
  assert.equal(await c.reapply(), false);
  assert.equal(await c.refreshConflict(), true);
  assert.equal(await c.reapply(), false);
  assert.equal(sent.length, 1);
  assert.equal(await c.changeSettlement('settlement.finalize', null), true);
  assert.deepEqual(sent.map(args => [args[1], args[2]]), [
    [{type: 'settlement.finalize', date: null}, 4], [{type: 'settlement.finalize', date: null}, 5],
  ]);
  assert.notEqual(sent[0]?.[3], sent[1]?.[3]);
});

test('payment drafts survive a poll and exact retry while other accounts cannot access them', async t => {
  let current = settlementLedger;
  const sent: Parameters<LedgerApi['executeLedger']>[] = [];
  const c = await setup(t, fake({
    getLedger: async id => ({...current, tripId: id}),
    executeLedger: async (...args) => {
      sent.push(args);
      if (sent.length === 1) throw new ApiError(0, 'network');
      return {...change, replayed: true};
    },
  }));
  await c.setContext(account, trip);
  c.setPaymentField('toMemberId', recipientId);
  c.setPaymentField('amountKrw', '1000');
  current = {...settlementLedger, revision: 5};
  await c.resume();
  assert.equal(c.state.paymentDraft.amountKrw, '1000');
  await c.savePayment();
  assert.deepEqual(sent[0]?.[1], {type: 'payment.report', toMemberId: recipientId, amountKrw: 1000});
  assert.equal(sent[0]?.[2], 4);
  c.setPaymentField('amountKrw', '1500');
  await c.setContext(account, {...trip, id: otherTrip});
  assert.deepEqual(c.state.paymentDraft, {toMemberId: '', amountKrw: ''});
  assert.equal(await c.retryPending(), false);
  await c.setContext(account, trip);
  assert.equal(await c.retryPending(), true);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(c.state.paymentDraft.amountKrw, '1500');
  await c.setContext(otherAccount, trip);
  await c.setContext(account, trip);
  assert.deepEqual(c.state.paymentDraft, {toMemberId: '', amountKrw: ''});
});

test('a payment action is scoped to the correct party and current state', async t => {
  let current = settlementLedger;
  const sent: Parameters<LedgerApi['executeLedger']>[] = [];
  const c = await setup(t, fake({
    getLedger: async () => current,
    executeLedger: async (...args) => {sent.push(args); return change;},
  }));
  await c.setContext(account, trip);
  assert.equal(await c.changePayment('payment.confirm', paymentId, 4), false);
  assert.equal(await c.changePayment('payment.requestVoid', paymentId, 4), true);
  current = {...settlementLedger, revision: 5, role: 'editor', members: settlementLedger.members.map(row => ({
    ...row, isMe: row.id === recipientId,
  }))};
  await c.refresh();
  assert.equal(await c.changePayment('payment.confirm', paymentId, 4), true);
  assert.equal(await c.changeSettlement('settlement.finalize', null), false);
  assert.deepEqual(sent.map(args => args[1]), [
    {type: 'payment.requestVoid', id: paymentId, expectedPaymentRevision: 4},
    {type: 'payment.confirm', id: paymentId, expectedPaymentRevision: 4},
  ]);
});

test('a remote ledger change invalidates the open settlement review before confirmation', async t => {
  let current = settlementLedger;
  const c = await setup(t, fake({
    getLedger: async () => current,
    executeLedger: async () => assert.fail('a stale settlement review wrote to the ledger'),
  }));
  await c.setContext(account, trip);
  c.reviewSettlement('settlement.finalize', null);
  assert.equal(c.state.settlementReview?.stale, false);
  current = {...settlementLedger, revision: 5};
  await c.resume();
  assert.equal(c.state.settlementReview?.stale, true);
  assert.equal(await c.confirmSettlement(), false);
});

test('only the other payment party can confirm a void request, using the version they saw', async t => {
  const payment = {...settlement.payments[0]!, status: 'void_requested' as const, revision: 5,
    confirmedAt: at, confirmedDate: trip.startDate, voidRequestedByMemberId: recipientId, voidRequestedAt: at};
  let current = {...settlementLedger, revision: 5, settlement: {...settlement, payments: [payment]}};
  const sent: Parameters<LedgerApi['executeLedger']>[] = [];
  const c = await setup(t, fake({
    getLedger: async () => current,
    executeLedger: async (...args) => {sent.push(args); return change;},
  }));
  await c.setContext(account, trip);
  assert.equal(await c.changePayment('payment.confirmVoid', paymentId, 4), false);
  assert.equal(await c.changePayment('payment.confirmVoid', paymentId, 5), true);
  current = {...current, members: current.members.map(row => ({...row, isMe: row.id === recipientId}))};
  await c.refresh();
  assert.equal(await c.changePayment('payment.confirmVoid', paymentId, 5), false);
  assert.deepEqual(sent.map(args => args[1]), [{type: 'payment.confirmVoid', id: paymentId, expectedPaymentRevision: 5}]);
});

test('the ledger client surfaces the expense lock reason and keeps the blocked input available', async t => {
  const client = createApi(async url => url.endsWith('/commands')
    ? json({error: {code: 'validation', field: 'settlementLocked'}, requestId: 'fixture'}, 422)
    : json({me: {userId: account, email: 'fixture@example.invalid', expiresAt: at}}));
  const c = await setup(t, fake({getLedger: async () => settlementLedger, me: client.me, executeLedger: client.executeLedger}));
  await c.setContext(account, trip);
  c.editExpense(expense.id);
  c.setExpenseField('title', '확정한 경비 이름');
  assert.equal(await c.saveExpense(), false);
  assert.match(c.state.error?.message ?? '', /소유자가 정산을 재개한 뒤 경비를 변경/);
  assert.equal(c.state.expenseDraft.title, '확정한 경비 이름');
  assert.equal(c.state.conflict, null);
});

test('daily settlement separates daily and cumulative spend and retains focus on a payment draft when polled', async t => {
  const settlementPath = '../../web/ledger/settlement-view.mjs';
  const {mountSettlement} = await import(settlementPath);
  const settled = {...settlementLedger, settlement: {...settlement, days: [
    settlement.days[0]!,
    {date: '2026-11-06', spentKrw: 5000, current: {...settlementResult, spentKrw: 60_000}},
    settlement.days[2]!,
  ]}};
  let current = settled;
  const c = await setup(t, fake({getLedger: async () => current}));
  await c.setContext(account, trip);
  const {controls, doc, refs} = webLedgerDom();
  const render = mountSettlement(refs, c, {on() {}});
  c.subscribe(render);
  assert.match(controls.get('ledger-daily-settlement-day-spent')!.textContent, /당일 실지출 5,000원/);
  assert.match(controls.get('ledger-daily-settlement-spent')!.textContent, /선택일까지 누적 실지출 60,000원/);
  const amount = controls.get('ledger-payment-amountKrw')!;
  amount.focus();
  c.setPaymentField('amountKrw', '1000');
  current = {...settled, revision: 5};
  await c.resume();
  assert.equal(amount.value, '1000');
  assert.equal(doc.activeElement, amount);
});

test('an active viewer is ineligible to receive a new payment record', async t => {
  const c = await setup(t, fake({
    getLedger: async () => ({...settlementLedger, members: settlementLedger.members.map(row =>
      row.id === recipientId ? {...row, role: 'viewer'} : row)}),
    executeLedger: async () => assert.fail('viewer received a payment record'),
  }));
  await c.setContext(account, trip);
  c.setPaymentField('toMemberId', recipientId);
  c.setPaymentField('amountKrw', '1000');
  assert.equal(await c.savePayment(), false);
  assert.equal(c.state.error?.field, 'toMemberId');
});
