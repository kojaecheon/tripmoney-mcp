import assert from 'node:assert/strict';
import test from 'node:test';

const modulePath = '../../web/ledger/expense-intake.mjs';
const trip = {startDate: '2026-11-04', endDate: '2026-11-07'};

test('suggests expense fields from one Korean card purchase and omits the card details and cumulative total', async () => {
  const {parseCardExpense} = await import(modulePath);
  assert.deepEqual(parseCardExpense('[Web발신]\n[체험카드 1234] 승인 24,500원\n11/05 14:20 해운대 커피 일시불\n누적 이용금액 275,000원', trip), {
    fields: {title: '해운대 커피', occurredLocal: '2026-11-05T14:20', currency: 'KRW', amount: '24500'},
    dateStatus: 'complete',
  });
});

test('suggests a supported baht purchase and recognizes a Korean date without a time', async () => {
  const {parseCardExpense} = await import(modulePath);
  assert.deepEqual(parseCardExpense('해외승인 THB 153.47\n2026년 11월 6일\n가맹점: 방콕 베이커리', trip), {
    fields: {title: '방콕 베이커리', occurredLocal: '2026-11-06T12:00', currency: 'THB', amount: '153.47'},
    dateStatus: 'default-time',
  });
});

test('requires direct input when the purchase, currency or amount is ambiguous or unsupported', async () => {
  const {parseCardExpense} = await import(modulePath);
  const fixtures = [
    '11/05 15:30 승인 24,500원\n11/05 15:50 승인 24,500원',
    '11/05 15:30 승인 24,500원\n누적 이용금액 40,000원\n11/06 15:30 승인 5,000원',
    '11/05 승인 24,500원 (2,000원 추가)',
    '11/05 15:30 승인 취소 24,500원',
    '11/05 15:30 부분환불 24,500원',
    '11/05 15:30 REFUND 24,500원',
    '11/05 15:30 승인 -24,500원',
    '11/05 15:30 승인 24,50원',
    '11/05 15:30 승인 KRW 1,000,001',
    '11/05 15:30 승인 KRW 24.50',
    '11/05 15:30 승인 THB 24.501',
    '11/05 15:30 승인 USD 25 (35,000원 환산)',
    '11/05 15:30 누적 이용금액 40,000원',
  ];
  for (const text of fixtures) assert.equal(parseCardExpense(text, trip), null, text);
});

test('preserves a Korean afternoon time and omits a weekday label from the merchant', async () => {
  const {parseCardExpense} = await import(modulePath);
  assert.deepEqual(parseCardExpense('체험카드 5,000원\n11/05(목) 오후 2:20 바다 카페', trip), {
    fields: {title: '바다 카페', occurredLocal: '2026-11-05T14:20', currency: 'KRW', amount: '5000'},
    dateStatus: 'complete',
  });
});

test('keeps the date unset when it falls outside the trip or contains an invalid hour', async () => {
  const {parseCardExpense} = await import(modulePath);
  for (const date of ['2025-11-05 15:30', '11/31 15:30', '11/06 25:30', '11/01 15:30']) {
    assert.deepEqual(parseCardExpense(`승인 ₩5,000\n${date} 여행 카페`, trip), {
      fields: {title: '여행 카페', occurredLocal: '', currency: 'KRW', amount: '5000'},
      dateStatus: 'missing',
    });
  }
});

test('ignores dates and fractional currency in a statement summary', async () => {
  const {parseCardExpense} = await import(modulePath);
  assert.deepEqual(parseCardExpense('승인 THB 15.47\n11/05 15:30 바다 카페\n누적 이용금액 THB 35.50', trip), {
    fields: {title: '바다 카페', occurredLocal: '2026-11-05T15:30', currency: 'THB', amount: '15.47'},
    dateStatus: 'complete',
  });
  assert.equal(parseCardExpense('승인 520원\n잔액 기준일 11/05', trip)?.dateStatus, 'missing');
});

test('uses only a merchant from an identified field or date line and clears it if it contains private identifiers', async () => {
  const {parseCardExpense} = await import(modulePath);
  assert.deepEqual(parseCardExpense('김카드 5312 승인 2.5만원\n010-5555-5555', trip), {
    fields: {title: '', occurredLocal: '', currency: 'KRW', amount: '25000'}, dateStatus: 'missing',
  });
  assert.equal(parseCardExpense('11월 5일 바다 시장 12,000원', trip)?.fields.title, '바다 시장');
  assert.equal(parseCardExpense('11/05 12:42 바다 시장 010-5555-5555\n12,000원', trip)?.fields.title, '');
});

function intakeControls() {
  class Control extends EventTarget {
    disabled = false;
    hidden = false;
    textContent = '';
    value = '';
    src = '';
    files: Blob[] = [];
    setAttribute() {}
    removeAttribute(name: string) {if (name === 'src') this.src = '';}
  }
  const controls = new Map<string, Control>();
  function control(id: string) {
    if (!controls.has(id)) controls.set(id, new Control());
    return controls.get(id)!;
  }
  const fields: Record<string, string> = {};
  const refs = new Proxy({}, {get: (_, id: string) => control(id)});
  const actions = {setExpenseField(name: string, value: string) {fields[name] = value;}};
  let focused: string | undefined;
  const helpers = {
    on(node: Control, event: string, listener: EventListener) {node.addEventListener(event, listener);},
    focus(id: string) {focused = id;},
  };
  function fire(id: string, event = 'click') {control(id).dispatchEvent(new Event(event));}
  return {control, fire, fields, refs, actions, helpers, focus: () => focused};
}

const available = {accountId: 'account', tripId: 'trip', ledger: trip, canEdit: true};

test('the SMS review writes only expense fields and clears the original text before the user saves', async () => {
  const {mountExpenseIntake} = await import(modulePath);
  const ui = intakeControls();
  const intake = mountExpenseIntake(ui.refs, ui.actions, ui.helpers);
  intake.render(available);
  ui.fire('ledger-expense-sms-method');
  const input = ui.control('ledger-expense-sms-text');
  input.value = '[체험 카드 1234] 승인 24,500원\n11/05 14:20 바다 카페';
  ui.fire('ledger-expense-sms-review');
  assert.deepEqual(ui.fields, {title: '바다 카페', occurredLocal: '2026-11-05T14:20', currency: 'KRW', amount: '24500'});
  assert.equal(input.value, '');
  assert.equal(ui.focus(), 'ledger-expense-title');
});

test('a refund leaves the existing form fields intact and takes the user to manual entry', async () => {
  const {mountExpenseIntake} = await import(modulePath);
  const ui = intakeControls();
  const intake = mountExpenseIntake(ui.refs, ui.actions, ui.helpers);
  intake.render(available);
  ui.fire('ledger-expense-sms-method');
  const input = ui.control('ledger-expense-sms-text');
  input.value = '11/05 14:20 승인 취소 24,500원';
  ui.fire('ledger-expense-sms-review');
  assert.deepEqual(ui.fields, {});
  assert.equal(input.value, '');
  assert.equal(ui.focus(), 'ledger-expense-title');
});

test('revokes local image previews on close, trip change, edit permission loss and teardown', async () => {
  const {mountExpenseIntake} = await import(modulePath);
  const ui = intakeControls();
  const intake = mountExpenseIntake(ui.refs, ui.actions, ui.helpers);
  const picker = ui.control('ledger-expense-receipt-file');
  const preview = ui.control('ledger-expense-receipt-image');
  for (const close of [
    () => ui.fire('ledger-expense-receipt-close'),
    () => intake.render({...available, tripId: 'other trip'}),
    () => intake.render({...available, canEdit: false}),
    () => intake.render({...available, ledger: {...trip, settlement: {closure: {snapshotId: 'final'}}}}),
    () => intake.close(),
  ]) {
    intake.render(available);
    ui.fire('ledger-expense-receipt-method');
    picker.files = [new Blob(['receipt'], {type: 'image/png'})];
    picker.value = 'receipt.png';
    ui.fire('ledger-expense-receipt-file', 'change');
    const url = preview.src;
    assert.ok(url.startsWith('blob:'));
    assert.equal(await (await fetch(url)).text(), 'receipt');
    close();
    assert.equal(preview.src, '');
    assert.equal(picker.value, '');
    await assert.rejects(fetch(url));
  }
  assert.deepEqual(ui.fields, {});
});

test('blocks review while writes are locked and clears a pending paste when the account changes', async () => {
  const {mountExpenseIntake} = await import(modulePath);
  const ui = intakeControls();
  const intake = mountExpenseIntake(ui.refs, ui.actions, ui.helpers);
  intake.render(available);
  ui.fire('ledger-expense-sms-method');
  const input = ui.control('ledger-expense-sms-text');
  input.value = '11/05 14:20 바다 카페 24,500원';
  intake.render({...available, pendingKind: 'expense.create'});
  assert.equal(ui.control('ledger-expense-sms-review').disabled, true);
  ui.fire('ledger-expense-sms-review');
  assert.deepEqual(ui.fields, {});
  intake.render({...available, accountId: 'another account'});
  assert.equal(input.value, '');
});
