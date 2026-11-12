import {
  button, changeLabel, dayLabel, element, expenseLabels, field, fxName, issueFor, itemName, memberName, reconcile,
  renderField, renderOptions, tripDates, won, writeText, writesLocked,
} from './forms.mjs';

export const expensesMarkup = `
<section class="ledger-section" aria-labelledby="ledger-expenses-title">
  <h4 id="ledger-expenses-title" tabindex="-1">경비 내역</h4>
  <p id="ledger-expenses-unassigned" class="ledger-amount-line"></p>
  <div class="ledger-fields ledger-filters">
    <div class="field"><label for="ledger-filter-date">지출 날짜 필터</label><select id="ledger-filter-date"></select></div>
    <div class="field"><label for="ledger-filter-itineraryId">연결 일정 필터</label><select id="ledger-filter-itineraryId"></select></div>
    <div class="field"><label for="ledger-filter-payerId">결제자 필터</label><select id="ledger-filter-payerId"></select></div>
  </div>
  <p id="ledger-expenses-empty" class="help" hidden>선택한 조건에 해당하는 경비가 없습니다.</p>
  <ul id="ledger-expense-list" class="ledger-list"></ul>
  <form id="ledger-expense-form" class="ledger-editor" novalidate>
    <h5 id="ledger-expense-form-title">경비 등록</h5>
    <div class="ledger-fields">
      ${field('expense','title',expenseLabels.title,'<input @field type="text" required>')}
      ${field('expense','occurredLocal',expenseLabels.occurredLocal,'<input @field type="datetime-local" required>','여행지 시간으로 입력해 주세요. 서머타임 전환으로 존재하지 않는 시각은 저장할 수 없습니다. 같은 시각이 두 번 나타나면 첫 번째 시각으로 저장합니다.')}
      ${field('expense','itineraryId',expenseLabels.itineraryId,'<select @field></select>')}
      ${field('expense','payerId',expenseLabels.payerId,'<select @field required></select>')}
      ${field('expense','currency',expenseLabels.currency,'<select @field><option value="KRW">KRW (원)</option><option value="THB">THB (바트)</option></select>')}
      ${field('expense','amount',expenseLabels.amount,'<input @field type="text" inputmode="decimal" required>','원화는 정수, 바트는 소수 둘째 자리까지 입력할 수 있습니다.')}
    </div>
    <fieldset id="ledger-expense-splitIds" class="ledger-splits" tabindex="-1" aria-describedby="ledger-expense-splitIds-help ledger-expense-splitIds-error">
      <legend>균등 분담자</legend><p class="help" id="ledger-expense-splitIds-help">분담할 사람을 1명부터 8명까지 선택해 주세요.</p>
      <div id="ledger-split-options" class="ledger-checklist"></div><p id="ledger-expense-splitIds-error" class="field-error" hidden></p>
    </fieldset>
    <div id="ledger-expense-refresh" class="ledger-rate-choice" hidden>
      <label class="ledger-check"><input id="ledger-expense-refreshRate" name="refreshRate" type="checkbox" aria-describedby="ledger-expense-refreshRate-help ledger-expense-refreshRate-error">현재 환율로 다시 계산</label>
      <p class="help" id="ledger-expense-refreshRate-help">같은 통화로 수정할 때는 등록 당시 환율을 사용합니다. 선택하면 현재 설정된 환율을 적용합니다. 통화를 바꾸면 새 통화의 현재 환율을 적용합니다.</p>
      <p class="field-error" id="ledger-expense-refreshRate-error" hidden></p>
    </div>
    <div class="button-row"><button id="ledger-save-expense" class="primary" type="submit" aria-describedby="ledger-write-help">경비 저장</button>
      <button id="ledger-new-expense" class="secondary" type="button">경비 입력 초기화</button></div>
  </form>
</section>`;

const currencyNumber = new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 2});
const rateNumber = new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 3});
function applyFilters(rows, {date, itineraryId, payerId}) {
  return rows.filter(row => (!date || row.localDate === date) && (!payerId || row.payerId === payerId) &&
    (!itineraryId || row.itineraryId === (itineraryId === 'unassigned' ? null : itineraryId)))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt));
}

export function mountExpenses(r, actions, helpers) {
  const {on, focus, run, confirm} = helpers;
  const doc = r['ledger-expense-list'].ownerDocument;
  const rows = new Map(), splits = new Map();
  const keys = Object.keys(expenseLabels).filter(key => key !== 'splitIds');
  for (const key of keys) {
    const input = r[`ledger-expense-${key}`];
    on(input, input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input', () => {
      const value = input.type === 'checkbox' ? input.checked : key === 'itineraryId' && !input.value ? null : input.value;
      actions.setExpenseField(key, value);
    });
  }
  for (const key of ['date','itineraryId','payerId']) on(r[`ledger-filter-${key}`], 'change', event => actions.setFilter(key, event.target.value));
  on(r['ledger-new-expense'], 'click', () => {actions.editExpense(); focus('ledger-expense-title');});
  on(r['ledger-expense-form'], 'submit', event => {
    event.preventDefault();
    void run(event.submitter, actions.saveExpense, 'ledger-expenses-title');
  });
  on(r['ledger-split-options'], 'change', () => actions.setExpenseField('splitIds',
    [...r['ledger-split-options'].querySelectorAll('input:checked')].map(node => node.value)));

  function makeRow(row) {
    const li = element(doc, 'li', 'ledger-row');
    li.dataset.expenseId = row.id;
    li.titleNode = element(doc, 'h5');
    li.titleNode.tabIndex = -1;
    li.meta = element(doc, 'p', 'help');
    li.amount = element(doc, 'p', 'ledger-amount-line');
    li.shares = element(doc, 'p', 'help');
    li.change = element(doc, 'p', 'help');
    li.controls = element(doc, 'div', 'button-row');
    li.edit = button(doc, '수정', 'edit-expense', () => {actions.editExpense(row.id); focus('ledger-expense-title');});
    li.cancel = button(doc, '취소', 'cancel-expense', event => confirm('expense', row.id, event.currentTarget));
    li.controls.append(li.edit, li.cancel);
    li.append(li.titleNode, li.meta, li.amount, li.shares, li.change, li.controls);
    return li;
  }
  function updateRow(li, row, state) {
    const {ledger} = state;
    writeText(li.titleNode, row.title);
    const when = `${dayLabel(row.localDate)} ${row.occurredLocal.slice(11)} (${row.timeZone})`;
    writeText(li.meta, `${when} · ${itemName(ledger, row.itineraryId)}${row.status === 'cancelled' ? ' · 취소됨' : ''}`);
    const amount = `${currencyNumber.format(row.amountCents / 100)} ${row.currency}`;
    const rate = row.currency === 'THB' ? ` · ${fxName(row.rateSource)} 1 THB당 ${rateNumber.format(row.rateMilli / 1000)}원` : '';
    writeText(li.amount, `${amount} · 그룹 전체 원화 환산 ${won(row.amountKrw)}${rate}`);
    const shares = row.shares.map(share => `${memberName(ledger, share.memberId)} ${won(share.amountKrw)}`).join(', ');
    writeText(li.shares, `결제자 ${memberName(ledger, row.payerId)} · 균등 분담 ${shares}`);
    writeText(li.change, changeLabel(ledger, row));
    li.controls.hidden = !state.canEdit || row.status !== 'active';
    li.edit.setAttribute('aria-label', `${row.title} 경비 수정`);
    li.cancel.setAttribute('aria-label', `${row.title} 경비 취소`);
    li.edit.disabled = li.cancel.disabled = writesLocked(state);
  }

  return function render(state) {
    const {ledger, expenseDraft: draft, filters} = state;
    const items = ledger?.items ?? [], members = ledger?.members ?? [];
    const original = ledger?.expenses.find(row => row.id === state.expenseId);
    const itemOption = row => ({id: row.id, label: `${row.date} · ${itemName(ledger, row.id)}`});
    const memberOption = row => ({id: row.id, label: memberName(ledger, row.id)});
    const unassigned = {id: 'unassigned', label: '미지정 공통 경비'};
    const dates = ledger ? [...new Set([...tripDates(ledger), ...ledger.expenses.map(row => row.localDate)])].sort() : [];
    renderOptions(r['ledger-filter-date'], [{id: '', label: '전체 날짜'},
      ...dates.map(date => ({id: date, label: dayLabel(date)}))], filters.date);
    renderOptions(r['ledger-filter-itineraryId'], [{id: '', label: '전체 일정'}, unassigned, ...items.map(itemOption)], filters.itineraryId);
    renderOptions(r['ledger-filter-payerId'], [{id: '', label: '전체 결제자'}, ...members.map(memberOption)], filters.payerId);
    renderOptions(r['ledger-expense-itineraryId'], [{...unassigned, id: ''},
      ...items.filter(item => item.status === 'active' || [original?.itineraryId, draft.itineraryId].includes(item.id)).map(itemOption)], draft.itineraryId ?? '');
    renderOptions(r['ledger-expense-payerId'], [{id: '', label: '결제자 선택'},
      ...members.filter(member => member.active || [original?.payerId, draft.payerId].includes(member.id)).map(memberOption)], draft.payerId);
    writeText(r['ledger-expenses-unassigned'], `여행 전체 미지정 공통 경비 ${won(ledger?.summary.unassignedKrw ?? 0)}`);
    const matches = applyFilters(ledger?.expenses ?? [], filters);
    r['ledger-expenses-empty'].hidden = matches.length > 0;
    reconcile(r['ledger-expense-list'], rows, matches, makeRow, (li, row) => updateRow(li, row, state),
      state.busy ? undefined : focused => focused.closest('[data-expense-id]')?.titleNode);

    const form = r['ledger-expense-form'], writing = state.busy === 'write';
    form.hidden = !state.canEdit;
    writeText(r['ledger-expense-form-title'], state.expenseId ? '경비 수정' : '경비 등록');
    writeText(r['ledger-save-expense'], state.expenseId ? '경비 수정 저장' : '경비 저장');
    r['ledger-save-expense'].disabled = writesLocked(state);
    r['ledger-new-expense'].disabled = writesLocked(state);
    r['ledger-expense-refresh'].hidden = !original || draft.currency !== 'THB' || original.currency !== draft.currency;
    r['ledger-expense-occurredLocal'].min = ledger ? `${ledger.startDate}T00:00` : '';
    r['ledger-expense-occurredLocal'].max = ledger ? `${ledger.endDate}T23:59` : '';
    for (const key of keys) {
      const input = r[`ledger-expense-${key}`];
      if (input.tagName === 'SELECT' || input.type === 'checkbox') input.disabled = writing;
      else input.readOnly = writing;
      renderField(input, issueFor(state,'expense',key), r[`ledger-expense-${key}-error`], draft[key]);
    }
    const splitIssue = issueFor(state, 'expense', 'splitIds');
    const splitError = r['ledger-expense-splitIds-error'];
    writeText(splitError, splitIssue);
    splitError.hidden = !splitIssue;
    const group = r['ledger-expense-splitIds'];
    group.setAttribute('aria-invalid', String(Boolean(splitIssue)));
    group.disabled = writing;
    const choices = members.filter(member => member.active || original?.splitIds.includes(member.id) || draft.splitIds.includes(member.id));
    reconcile(r['ledger-split-options'], splits, choices, member => {
      const label = element(doc, 'label', 'ledger-check');
      const input = element(doc, 'input');
      input.type = 'checkbox';
      input.name = 'splitIds';
      input.value = member.id;
      const title = element(doc, 'span');
      label.append(input, title);
      return label;
    }, (label, member) => {
      label.firstElementChild.checked = draft.splitIds.includes(member.id);
      writeText(label.lastElementChild, memberName(ledger, member.id));
    });
  };
}
