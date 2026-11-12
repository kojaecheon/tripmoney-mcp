import { focusAfterAction } from '../travel/view.mjs';
import {
  actionLabels, activeSnapshot, button, dayLabel, element, field, issueFor, memberName, paymentAction, paymentLabels,
  paymentRecipients, reconcile, renderField, renderOptions, seoulTime, settlementAction, won, writeText, writesLocked,
} from './forms.mjs';

function periodMarkup(kind, title, dateField = '') {
  const id = `ledger-${kind}-settlement`;
  return `<section id="${id}" class="ledger-settlement-panel" aria-labelledby="${id}-title">
    <h5 id="${id}-title" tabindex="-1">${title}</h5>
    ${dateField}
    <p id="${id}-status" class="help"></p>
    ${kind === 'daily' ? '<p id="ledger-daily-settlement-day-spent" class="ledger-amount-line"></p>' : ''}
    <p id="${id}-spent" class="ledger-amount-line"></p>
    <h6>현재 잔액</h6>
    <ul id="${id}-balances" class="ledger-list"></ul>
    <h6>지급 제안</h6>
    <p id="${id}-empty" class="help" hidden>추가 지급 제안이 없습니다.</p>
    <ul id="${id}-transfers" class="ledger-list"></ul>
    <button id="${id}-action" type="button" class="secondary" aria-controls="ledger-settlement-review"
      aria-describedby="${id}-status ledger-write-help" aria-expanded="false" hidden></button>
  </section>`;
}
const dateField = `<div class="field ledger-settlement-date">
  <label for="ledger-settlement-date">정산 날짜</label><select id="ledger-settlement-date"></select>
</div><p id="ledger-settlement-local-time" class="help"></p>`;
export const settlementMarkup = `
<section id="ledger-settlement" class="ledger-section" aria-labelledby="ledger-settlement-title" hidden>
  <h4 id="ledger-settlement-title" tabindex="-1">여행 정산</h4>
  <p class="help">현재 잔액과 지급 제안에는 받은 사람이 확인한 지급이 반영됩니다.</p>
  <p id="ledger-settlement-due" class="role-notice" role="status" hidden></p>
  <section id="ledger-settlement-review" class="notice-panel" aria-labelledby="ledger-settlement-review-title" hidden>
    <h5 id="ledger-settlement-review-title" tabindex="-1"></h5>
    <p id="ledger-settlement-review-help" class="help" role="status"></p>
    <div class="button-row">
      <button id="ledger-settlement-confirm-yes" type="button" class="primary" aria-describedby="ledger-settlement-review-help"></button>
      <button id="ledger-settlement-confirm-no" type="button" class="secondary">돌아가기</button>
    </div>
  </section>
  ${periodMarkup('daily', '일일 정산', dateField)}
  ${periodMarkup('final', '여행 최종 정산')}
  <details id="ledger-settlement-history" class="ledger-history">
    <summary>정산 확정 이력</summary>
    <p class="help">각 기록은 확정 당시의 경비와 잔액을 보여 줍니다.</p>
    <p id="ledger-settlement-history-empty" class="help" hidden>아직 확정한 정산이 없습니다.</p>
    <ul id="ledger-settlement-snapshots" class="ledger-list"></ul>
  </details>
  <section class="ledger-settlement-panel" aria-labelledby="ledger-payments-title">
    <h5 id="ledger-payments-title" tabindex="-1">지급 기록</h5>
    <p class="help" id="ledger-payment-help">별도로 보낸 돈을 기록합니다. 받은 동행자가 확인하면 잔액에 반영됩니다. 지급 기록은 건당 최대 1조 원입니다.</p>
    <p id="ledger-payment-no-recipients" class="help" hidden>지급 기록을 확인할 수 있는 참여 중인 소유자 또는 편집자가 필요합니다.</p>
    <form id="ledger-payment-form" class="ledger-editor" novalidate>
      <div class="ledger-fields">
        ${field('payment', 'toMemberId', paymentLabels.toMemberId, '<select @field required></select>')}
        ${field('payment', 'amountKrw', paymentLabels.amountKrw, '<input @field type="text" inputmode="numeric" required>', '1원 단위로 입력해 주세요.')}
      </div>
      <button id="ledger-save-payment" class="primary" type="submit" aria-describedby="ledger-write-help">지급 기록 저장</button>
    </form>
    <h6 id="ledger-payments-pending-title" tabindex="-1">확인 대기</h6>
    <p id="ledger-payments-pending-empty" class="help" hidden>확인을 기다리는 지급이 없습니다.</p>
    <ul id="ledger-payments-pending" class="ledger-list" aria-labelledby="ledger-payments-pending-title"></ul>
    <h6 id="ledger-payments-history-title" tabindex="-1">확인 및 취소 내역</h6>
    <p id="ledger-payments-history-empty" class="help" hidden>확인하거나 취소한 지급이 없습니다.</p>
    <ul id="ledger-payments-history" class="ledger-list" aria-labelledby="ledger-payments-history-title"></ul>
  </section>
</section>`;

const transferLabel = (ledger, row) =>
  `${memberName(ledger, row.fromMemberId)} 님이 ${memberName(ledger, row.toMemberId)} 님에게 ${won(row.amountKrw)}`;
const balanceLabel = (ledger, row) => {
  const net = row.netKrw === 0 ? '남은 잔액 없음'
    : row.netKrw > 0 ? `받을 금액 ${won(row.netKrw)}` : `보낼 금액 ${won(-row.netKrw)}`;
  return `${memberName(ledger, row.memberId)} · 결제 ${won(row.paidKrw)} · 부담 ${won(row.owedKrw)} · ${net}`;
};
const scopeLabel = date => date === null ? '여행 최종 정산' : `${dayLabel(date)} 정산`;
const paymentStatus = {
  reported: '받는 동행자의 확인 대기', confirmed: '지급 확인됨', void_requested: '취소 확인 대기 · 잔액에 반영 중',
  voided: '지급 기록 취소됨',
};
function paymentButtonLabel(action, status) {
  if (action === 'payment.requestVoid') return status === 'reported' ? '확인 전 기록 철회' : '지급 취소 요청';
  return actionLabels[action];
}

export function mountSettlement(r, actions, {on, focus, run}) {
  const doc = r['ledger-settlement'].ownerDocument;
  const balances = {daily: new Map(), final: new Map()}, transfers = {daily: new Map(), final: new Map()};
  const snapshots = new Map(), pending = new Map(), history = new Map();
  const paymentKeys = Object.keys(paymentLabels);
  let reviewOrigin = null;
  let lastContext = null;

  on(r['ledger-settlement-date'], 'change', event => actions.selectSettlementDate(event.target.value));
  for (const kind of ['daily', 'final']) {
    const trigger = r[`ledger-${kind}-settlement-action`];
    on(trigger, 'click', () => {
      const state = actions.state;
      const date = kind === 'daily' ? state.settlementDate : null;
      const type = settlementAction(state.ledger?.settlement, date);
      if (!type) return;
      reviewOrigin = trigger;
      actions.reviewSettlement(type, date);
      if (actions.state.settlementReview) focus('ledger-settlement-review-title');
    });
  }
  on(r['ledger-settlement-confirm-yes'], 'click', event => {
    const kind = actions.state.settlementReview?.date === null ? 'final' : 'daily';
    void run(event.currentTarget, actions.confirmSettlement, `ledger-${kind}-settlement-title`);
  });
  function closeReview(origin) {
    actions.closeSettlementReview();
    focusAfterAction(doc, origin, [reviewOrigin, r['ledger-settlement-title']]);
    reviewOrigin = null;
  }
  on(r['ledger-settlement-confirm-no'], 'click', event => closeReview(event.currentTarget));
  on(r['ledger-settlement-review'], 'keydown', event => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    event.preventDefault();
    closeReview(doc.activeElement);
  });
  for (const key of paymentKeys) {
    const input = r[`ledger-payment-${key}`];
    on(input, key === 'toMemberId' ? 'change' : 'input', () => actions.setPaymentField(key, input.value));
  }
  on(r['ledger-payment-form'], 'submit', event => {
    event.preventDefault();
    void run(event.submitter, actions.savePayment, 'ledger-payments-title');
  });

  function renderPeriod(state, kind, date, result) {
    const {ledger} = state, {settlement} = ledger;
    const id = `ledger-${kind}-settlement`;
    const snapshot = activeSnapshot(settlement, date);
    const finalLock = date !== null && activeSnapshot(settlement, null);
    const type = settlementAction(settlement, date);
    const context = snapshot ? '확정됨 · 확정 당시 금액은 정산 확정 이력에서 확인할 수 있습니다.'
      : date !== null && date > settlement.today ? '예정된 날짜 · 여행지 날짜가 되면 확정할 수 있습니다.' : '미확정';
    writeText(r[`${id}-status`], `${context}${finalLock ? ' · 여행 최종 정산을 재개해야 일일 정산을 변경할 수 있습니다.' : ''}`);
    writeText(r[`${id}-spent`], `${kind === 'daily' ? '선택일까지 누적 실지출' : '그룹 전체 실지출'} ${won(result?.spentKrw ?? 0)}`);
    const trigger = r[`${id}-action`];
    trigger.hidden = !state.canSettle || !type;
    trigger.disabled = writesLocked(state);
    trigger.setAttribute('aria-expanded', String(state.settlementReview?.date === date));
    writeText(trigger, type ? `${kind === 'daily' ? '일일' : '최종'} ${actionLabels[type]}` : '');
    reconcile(r[`${id}-balances`], balances[kind], (result?.balances ?? []).map(row => ({...row, id: row.memberId})),
      () => element(doc, 'li'), (li, row) => writeText(li, balanceLabel(ledger, row)));
    reconcile(r[`${id}-transfers`], transfers[kind],
      (result?.transfers ?? []).map(row => ({...row, id: `${row.fromMemberId}-${row.toMemberId}`})),
      () => element(doc, 'li'), (li, row) => writeText(li, transferLabel(ledger, row)));
    r[`${id}-empty`].hidden = Boolean(result?.transfers.length);
  }
  function makeSnapshot() {
    const li = element(doc, 'li', 'ledger-row');
    const details = element(doc, 'details');
    li.titleNode = element(doc, 'summary');
    li.meta = element(doc, 'p', 'help');
    li.result = element(doc, 'p', 'ledger-amount-line');
    li.balances = element(doc, 'ul', 'ledger-list');
    li.transfers = element(doc, 'ul', 'ledger-list');
    li.balances.setAttribute('aria-label', '확정 당시 잔액');
    li.transfers.setAttribute('aria-label', '확정 당시 지급 제안');
    li.noTransfer = element(doc, 'p', 'help', '확정 당시 지급 제안이 없습니다.');
    li.balanceNodes = new Map();
    li.transferNodes = new Map();
    details.append(li.titleNode, li.meta, li.result, li.balances, li.transfers, li.noTransfer);
    li.append(details);
    return li;
  }
  function updateSnapshot(li, row, ledger) {
    writeText(li.titleNode, `${scopeLabel(row.date)} · 갱신 ${row.sourceRevision} · ${row.reopenedAt ? '재개됨' : '확정됨'}`);
    const created = `확정 ${memberName(ledger, row.createdByMemberId)} · ${seoulTime(row.createdAt)}`;
    const reopened = row.reopenedAt ? ` / 재개 ${memberName(ledger, row.reopenedByMemberId)} · ${seoulTime(row.reopenedAt)}` : '';
    writeText(li.meta, `${created}${reopened} (한국 시간)`);
    writeText(li.result, `확정 당시 그룹 전체 실지출 ${won(row.result.spentKrw)}`);
    reconcile(li.balances, li.balanceNodes, row.result.balances.map(row => ({...row, id: row.memberId})),
      () => element(doc, 'li'), (li, balance) => writeText(li, balanceLabel(ledger, balance)));
    reconcile(li.transfers, li.transferNodes, row.result.transfers.map(row => ({...row, id: `${row.fromMemberId}-${row.toMemberId}`})),
      () => element(doc, 'li'), (li, transfer) => writeText(li, transferLabel(ledger, transfer)));
    li.noTransfer.hidden = row.result.transfers.length > 0;
  }
  function makePayment(row) {
    const li = element(doc, 'li', 'ledger-row');
    li.dataset.paymentId = row.id;
    li.titleNode = element(doc, 'p', 'ledger-amount-line');
    li.titleNode.tabIndex = -1;
    li.meta = element(doc, 'p', 'help');
    li.control = button(doc, '', 'payment', event => {
      const action = event.currentTarget.dataset.ledgerAction;
      void run(event.currentTarget, () => actions.changePayment(action, row.id, li.paymentRevision), 'ledger-payments-title');
    });
    li.append(li.titleNode, li.meta, li.control);
    return li;
  }
  function updatePayment(li, row, state) {
    const {ledger} = state;
    const title = transferLabel(ledger, row);
    writeText(li.titleNode, title);
    const times = [`기록 ${seoulTime(row.reportedAt)}`];
    if (row.confirmedAt) times.push(`확인 ${seoulTime(row.confirmedAt)}`);
    if (row.voidRequestedAt) times.push(`취소 요청 ${memberName(ledger, row.voidRequestedByMemberId)} · ${seoulTime(row.voidRequestedAt)}`);
    if (row.voidedAt) times.push(`취소 ${seoulTime(row.voidedAt)}`);
    writeText(li.meta, `${paymentStatus[row.status]} · ${times.join(' / ')} (한국 시간)`);
    const action = state.canEdit ? paymentAction(ledger, row) : null;
    li.control.hidden = !action;
    li.control.disabled = writesLocked(state);
    li.control.dataset.ledgerAction = action ?? 'payment';
    li.paymentRevision = row.revision;
    const label = action ? paymentButtonLabel(action, row.status) : '';
    writeText(li.control, label);
    if (action) li.control.setAttribute('aria-label', `${label}, ${title}`);
  }

  return function render(state) {
    const {ledger, paymentDraft, settlementDate, settlementReview} = state;
    const settlement = ledger?.settlement;
    const context = `${state.accountId}/${state.tripId}`;
    const moved = lastContext !== context;
    if (moved) {
      reviewOrigin = null;
      r['ledger-settlement-history'].open = false;
      lastContext = context;
    }
    r['ledger-settlement'].hidden = !settlement;
    if (!settlement) {
      renderOptions(r['ledger-settlement-date'], [], '');
      renderOptions(r['ledger-payment-toMemberId'], [], '');
      r['ledger-payment-amountKrw'].value = '';
      for (const [id, nodes] of [
        ['ledger-settlement-snapshots', snapshots], ['ledger-payments-pending', pending], ['ledger-payments-history', history],
        ['ledger-daily-settlement-balances', balances.daily], ['ledger-final-settlement-balances', balances.final],
        ['ledger-daily-settlement-transfers', transfers.daily], ['ledger-final-settlement-transfers', transfers.final],
      ]) reconcile(r[id], nodes, [], () => {}, () => {});
      for (const id of ['ledger-daily-settlement-day-spent', 'ledger-daily-settlement-spent', 'ledger-final-settlement-spent', 'ledger-settlement-review-title',
        'ledger-settlement-review-help', 'ledger-settlement-due']) writeText(r[id], '');
      return;
    }
    const daily = settlement.mode === 'daily';
    const locked = writesLocked(state);
    const focused = moved ? null : doc.activeElement;
    const focusedPaymentId = focused?.closest('[data-payment-id]')?.dataset.paymentId;
    r['ledger-daily-settlement'].hidden = !daily;
    writeText(r['ledger-settlement-local-time'], `정산 안내 시각은 여행지 기준 매일 ${settlement.dailyTime}입니다.`);
    r['ledger-settlement-due'].hidden = !settlement.due;
    writeText(r['ledger-settlement-due'], settlement.due
      ? `여행지 기준 ${settlement.dailyTime} 일일 정산 시각이 지났습니다. 오늘 경비와 지급 내역을 확인해 주세요.` : '');
    renderOptions(r['ledger-settlement-date'], settlement.days.map(row => ({id: row.date, label: dayLabel(row.date)})), settlementDate);
    const day = settlement.days.find(row => row.date === settlementDate);
    writeText(r['ledger-daily-settlement-day-spent'], `당일 실지출 ${won(day?.spentKrw ?? 0)}`);
    renderPeriod(state, 'daily', settlementDate, day?.current);
    renderPeriod(state, 'final', null, settlement.final);

    r['ledger-settlement-review'].hidden = !settlementReview;
    if (settlementReview) {
      const {date, type, stale} = settlementReview;
      const finalize = type === 'settlement.finalize';
      const target = date === null ? '여행 전체' : dayLabel(date);
      const result = date === null ? settlement.final : settlement.days.find(row => row.date === date)?.current;
      writeText(r['ledger-settlement-review-title'], `${target} 정산을 ${finalize ? '확정' : '재개'}할까요?`);
      writeText(r['ledger-settlement-review-help'], stale
        ? '정산 정보가 바뀌었습니다. 돌아간 뒤 현재 금액과 지급 제안을 다시 확인해 주세요.'
        : finalize ? `현재 실지출 ${won(result?.spentKrw ?? 0)}과 지급 제안을 확정 이력에 남깁니다. 확정 범위의 경비를 변경하려면 정산을 재개해야 합니다.`
          : '기존 확정 이력은 보존됩니다. 정산을 재개하면 해당 경비를 변경할 수 있습니다.');
      writeText(r['ledger-settlement-confirm-yes'], actionLabels[type]);
      r['ledger-settlement-confirm-yes'].disabled = locked || stale;
    }

    r['ledger-settlement-history-empty'].hidden = settlement.snapshots.length > 0;
    reconcile(r['ledger-settlement-snapshots'], snapshots, [...settlement.snapshots].reverse(), makeSnapshot,
      (li, row) => updateSnapshot(li, row, ledger));
    const recipients = paymentRecipients(ledger);
    r['ledger-payment-no-recipients'].hidden = !state.canEdit || recipients.length > 0;
    r['ledger-payment-form'].hidden = !state.canEdit || recipients.length === 0;
    renderOptions(r['ledger-payment-toMemberId'], [{id: '', label: '받는 동행자 선택'},
      ...recipients.map(row => ({id: row.id, label: memberName(ledger, row.id)}))], paymentDraft.toMemberId);
    r['ledger-save-payment'].disabled = locked;
    r['ledger-payment-toMemberId'].disabled = state.busy === 'write';
    r['ledger-payment-amountKrw'].readOnly = state.busy === 'write';
    for (const key of paymentKeys) renderField(r[`ledger-payment-${key}`], issueFor(state, 'payment', key),
      r[`ledger-payment-${key}-error`], paymentDraft[key]);
    const newestFirst = [...settlement.payments].reverse();
    const awaiting = newestFirst.filter(row => row.status === 'reported');
    const completed = newestFirst.filter(row => row.status !== 'reported');
    for (const [kind, nodes, rows] of [['pending', pending, awaiting], ['history', history, completed]]) {
      r[`ledger-payments-${kind}-empty`].hidden = rows.length > 0;
      reconcile(r[`ledger-payments-${kind}`], nodes, rows, makePayment, (li, row) => updatePayment(li, row, state));
    }
    if (focusedPaymentId && !state.busy) {
      const row = pending.get(focusedPaymentId) ?? history.get(focusedPaymentId);
      focusAfterAction(doc, focused, [row?.control, row?.titleNode, r['ledger-payments-title']].filter(Boolean));
    }
  };
}
