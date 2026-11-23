import assert from 'node:assert/strict';
import test from 'node:test';
import type { SettlementResult, SettlementSnapshot } from '../../core/ledger/contracts.js';

const shareModule = '../../web/ledger/settlement-share.mjs';
const tripId = '10000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000002';
const senderId = '30000000-0000-4000-8000-000000000003';
const recipientId = '40000000-0000-4000-8000-000000000004';
const snapshot: SettlementSnapshot & {rawMessage: string; receiptUrl: string} = {
  id: '50000000-0000-4000-8000-000000000005', date: '2026-11-24', sourceRevision: 5, expenseRevision: 3,
  confirmedPaymentRevision: 4, createdAt: '2026-11-24T11:00:00.000Z', createdByMemberId: senderId,
  reopenedAt: null, reopenedByMemberId: null,
  rawMessage: 'private@example.invalid 010-123-456789 카드 승인', receiptUrl: 'https://private.example.invalid/receipt.jpg',
  result: {
    spentKrw: 50_000,
    balances: [
      {memberId: senderId, paidKrw: 0, owedKrw: 20_000, netKrw: -20_000},
      {memberId: recipientId, paidKrw: 50_000, owedKrw: 30_000, netKrw: 20_000},
    ],
    transfers: [{fromMemberId: senderId, toMemberId: recipientId, amountKrw: 20_000}],
  },
};
const currentResult: SettlementResult = {
  spentKrw: 50_000,
  balances: [
    {memberId: senderId, paidKrw: 0, owedKrw: 20_000, netKrw: -8_000},
    {memberId: recipientId, paidKrw: 50_000, owedKrw: 30_000, netKrw: 8_000},
  ],
  transfers: [{fromMemberId: senderId, toMemberId: recipientId, amountKrw: 8_000}],
};

type ShareNavigator = {
  share?: (data: {text: string}) => Promise<void>;
  clipboard?: {writeText: (text: string) => Promise<void>};
};

async function setup(navigator: ShareNavigator = {}) {
  const {mountSettlementShare} = await import(shareModule);
  const document = {
    activeElement: null as Node | null,
    defaultView: {location: {origin: 'https://trips.example.invalid', href: 'https://trips.example.invalid/invite#t=private'}, navigator},
    createElement: (tag: string) => new Node(tag),
  };
  type Handler = (event: {currentTarget: Node}) => void | Promise<void>;
  class Node {
    children: Node[] = [];
    listeners = new Map<string, Handler>();
    attributes = new Map<string, string>();
    id = '';
    textContent = '';
    value = '';
    hidden = false;
    disabled = false;
    readOnly = false;
    selected = false;
    constructor(readonly tag: string) {}
    append(...nodes: Node[]) {this.children.push(...nodes);}
    contains(node: Node) {return this === node || this.children.some((child): boolean => child.contains(node));}
    setAttribute(key: string, value: string) {this.attributes.set(key, value);}
    focus() {document.activeElement = this;}
    select() {this.selected = true;}
    click() {return this.listeners.get('click')?.({currentTarget: this});}
  }
  const parent = new Node('div');
  parent.id = 'daily-share';
  const fallback = new Node('h5');
  const update = mountSettlementShare(document, {container: parent, fallbackFocus: fallback,
    on: (node: Node, event: string, handler: Handler) => node.listeners.set(event, handler)});
  const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
  const get = (predicate: (node: Node) => boolean) => {
    const match = nodes(parent).find(predicate);
    assert.ok(match, '정산 공유 화면 요소');
    return match;
  };
  const trigger = get(node => node.tag === 'button' && node.attributes.has('aria-expanded'));
  const preview = get(node => node.tag === 'textarea');
  const status = get(node => node.attributes.get('role') === 'status');
  const control = (value: RegExp) => get(node => node.tag === 'button' && value.test(node.textContent));
  return {document, parent, trigger, preview, update, status, control, fallback};
}

test('정산 공유 미리보기는 확정 당시 실지출과 현재 남은 지급 합계만 공유한다', async () => {
  const {update, trigger, preview} = await setup();
  update({snapshot, result: currentResult, tripId, accountId});
  assert.match(trigger.textContent, /^일일 정산/);
  assert.equal(preview.value, '');
  trigger.click();

  assert.equal(preview.readOnly, true);
  assert.match(preview.value, /일일 정산.*11월 24일.*확정/);
  assert.match(preview.value, /확정 당시 누적 실지출 50,000원/);
  assert.match(preview.value, /현재 남은 지급 1건.*8,000원/);
  assert.match(preview.value, /https:\/\/trips\.example\.invalid\/#trip=10000000-0000-4000-8000-000000000001/);
  assert.doesNotMatch(preview.value, /20,000원|@|010-123-456789|\.jpg|카드 승인|invite|token|#t=/);
  assert.ok(!preview.value.includes(senderId));
  assert.ok(!preview.value.includes(snapshot.id));
});

test('여행 최종 정산이 마감되면 마감 상태와 남은 지급 0원을 공유한다', async () => {
  const {update, trigger, preview} = await setup();
  update({snapshot: {...snapshot, date: null}, closed: true, tripId, accountId});
  assert.match(trigger.textContent, /^여행 최종 정산/);
  trigger.click();

  assert.match(preview.value, /여행 최종 정산.*마감/);
  assert.match(preview.value, /현재 남은 지급 0건.*0원/);
});

test('정산 재개 또는 로그아웃 후 이전에 열린 공유 내용을 지운다', async () => {
  const {update, trigger, preview, parent, fallback, document} = await setup();
  update({snapshot, tripId, accountId});
  trigger.click();
  preview.focus();

  update({snapshot: {...snapshot, reopenedAt: '2026-11-24T12:00:00.000Z'}, tripId, accountId});
  assert.equal(parent.hidden, true);
  assert.equal(preview.value, '');
  assert.equal(document.activeElement, fallback);

  update({snapshot, tripId, accountId});
  trigger.click();
  update();
  assert.equal(trigger.attributes.get('aria-expanded'), 'false');
  assert.equal(preview.value, '');
});

test('지원되는 기기에서 선택창과 클립보드가 사용자가 검토한 같은 문구를 받는다', async () => {
  const shared: string[] = [], copied: string[] = [];
  const {update, trigger, preview, control} = await setup({
    async share(data) {shared.push(data.text);}, clipboard: {async writeText(text) {copied.push(text);}},
  });
  update({snapshot, tripId, accountId});
  assert.deepEqual(shared, []);
  assert.deepEqual(copied, []);
  trigger.click();

  await control(/앱에서 공유/).click();
  await control(/문구 복사/).click();
  assert.deepEqual(shared, [preview.value]);
  assert.deepEqual(copied, [preview.value]);
});

test('클립보드 접근이 거부되면 선택 가능한 문구와 복사 방법을 표시한다', async () => {
  const {document, update, trigger, preview, status, control} = await setup({
    clipboard: {async writeText() {throw new Error('denied');}},
  });
  update({snapshot, tripId, accountId});
  trigger.click();

  assert.equal(control(/앱에서 공유/).hidden, true);
  await control(/문구 복사/).click();
  assert.ok(preview.value);
  assert.equal(document.activeElement, preview);
  assert.equal(preview.selected, true);
  assert.match(status.textContent, /직접 복사/);
});

test('공유 선택창에서 취소하면 자동 복사하지 않는다', async () => {
  let copied = false;
  const {update, trigger, control, status} = await setup({
    async share() {throw new DOMException('cancelled', 'AbortError');}, clipboard: {async writeText() {copied = true;}},
  });
  update({snapshot, tripId, accountId});
  trigger.click();
  await control(/앱에서 공유/).click();

  assert.equal(copied, false);
  assert.equal(status.textContent, '');
  assert.equal(trigger.attributes.get('aria-expanded'), 'true');
});

test('미리보기에서 최신 지급 합계가 바뀌면 갱신한 문구를 다시 확인할 수 있다', async () => {
  let finishCopy: () => void = () => {};
  const {update, trigger, preview, status, control} = await setup({
    clipboard: {writeText: () => new Promise<void>(resolve => {finishCopy = resolve;})},
  });
  update({snapshot, tripId, accountId});
  trigger.click();
  const pending = control(/문구 복사/).click();
  update({snapshot, result: currentResult, tripId, accountId});
  assert.equal(trigger.attributes.get('aria-expanded'), 'false');
  assert.equal(preview.value, '');
  trigger.click();
  finishCopy();
  await pending;

  assert.match(preview.value, /현재 남은 지급 1건.*8,000원/);
  assert.equal(status.textContent, '');
});
