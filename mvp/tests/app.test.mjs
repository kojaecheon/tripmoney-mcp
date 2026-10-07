import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as M from '../model.mjs';
import { renderView } from '../view.mjs';
const data = createRequire(import.meta.url)('../../docs/design/mockups/data.js');
const at = '2026-10-08T00:00:00.000Z';

function appHarness() {
  const values = new Map(), events = new Map(), windowEvents = new Map();
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  let html = '', renders = 0;
  const main = { get innerHTML() { return html; }, set innerHTML(value) { html = value; renders++; } };
  const feedback = { textContent: '', classList: { toggle() {} }, setAttribute() {} };
  const status = { textContent: '' };
  const document = {
    querySelector: selector => ({ '#main': main, '#feedback': feedback, '#save-status': status })[selector],
    querySelectorAll: () => [], getElementById: () => null,
    addEventListener: (name, handler) => events.set(name, handler),
  };
  class FormDataStub { constructor(form) { this.fields = form.fields; } get(key) { return this.fields[key]; } getAll(key) { return this.fields[key]; } }
  const source = readFileSync(new URL('../app.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  runInNewContext(source, { M, renderView, document, localStorage: storage, TM_DATA: data,
    window: { addEventListener: (name, handler) => windowEvents.set(name, handler) },
    location: { href: 'http://127.0.0.1:8123/', search: '' }, history: { replaceState() {} },
    URL, URLSearchParams, FormData: FormDataStub, Date,
  });
  return { events, windowEvents, storage, main, feedback, get renders() { return renders; } };
}

test('다른 탭의 같은 버전 승인은 작성 중 지출 입력을 덮지 않는다', () => {
  const app = appHarness();
  app.events.get('input')?.({ target: { closest: () => ({ id: 'expense-form' }) } });
  const other = M.createStore(data, app.storage);
  other.save(M.approveOrganizer(other.load(), 1, at));
  app.windowEvents.get('storage')({ key: M.STORAGE_KEY });
  assert.equal(app.renders, 1, '초안 작성 중에는 main을 교체하지 않아야 한다');
  assert.match(app.feedback.textContent, /입력.*유지/);
});

test('다른 탭에서 지출 버전이 바뀌면 이전 초안 저장을 거부하고 재선택으로 갱신한다', async () => {
  const app = appHarness();
  app.events.get('input')?.({ target: { closest: () => ({ id: 'expense-form' }) } });
  const other = M.createStore(data, app.storage), expense = other.load().expenses[0];
  other.save(M.updateExpense(other.load(), expense.id, { amount: '600', payerId: expense.payerId, splitIds: expense.splitIds }, 1, at));
  app.windowEvents.get('storage')({ key: M.STORAGE_KEY });
  assert.equal(app.renders, 1);
  const form = { id: 'expense-form', dataset: { version: '1' }, fields: { expenseId: expense.id, amount: '500', payerId: expense.payerId, splitId: expense.splitIds }, querySelector: () => ({ setAttribute() {} }) };
  app.events.get('submit')({ target: form, preventDefault() {} });
  assert.match(app.feedback.textContent, /버전/);
  assert.equal(other.load().expenses[0].amountCents, 60000);
  await app.events.get('click')({ target: { closest: () => ({ dataset: { action: 'select-expense', id: expense.id }, disabled: false }) } });
  assert.match(app.main.innerHTML, /data-version="2"/);
  assert.match(app.main.innerHTML, /value="600"/);
});

test('작성 중인 초안이 없으면 다른 탭의 상태를 즉시 표시한다', () => {
  const app = appHarness(), other = M.createStore(data, app.storage);
  other.save(M.approveOrganizer(other.load(), 1, at));
  app.windowEvents.get('storage')({ key: M.STORAGE_KEY });
  assert.equal(app.renders, 2);
  assert.match(app.main.innerHTML, /참여자 검토/);
});

test('변경 없는 지출 저장은 재승인을 요구하지 않고 기존 승인을 보존한다', () => {
  const app = appHarness(), other = M.createStore(data, app.storage);
  other.save(M.approveOrganizer(other.load(), 1, at));
  app.windowEvents.get('storage')({ key: M.STORAGE_KEY });
  const expense = other.load().expenses[0];
  const form = { id: 'expense-form', dataset: { version: '1' }, fields: { expenseId: expense.id, amount: String(expense.amountCents / 100), payerId: expense.payerId, splitId: expense.splitIds } };
  app.events.get('submit')({ target: form, preventDefault() {} });
  assert.match(app.feedback.textContent, /변경된 항목이 없습니다/);
  assert.equal(other.load().version, 1);
  assert.equal(other.load().organizerApprovedAt, at);
});
