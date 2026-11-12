import {
  balance, button, changeLabel, dayItems, dayLabel, element, field, issueFor, reconcile,
  renderField, renderOptions, scheduleLabels, tripDates, won, writeText, writesLocked,
} from './forms.mjs';

export const itineraryMarkup = `
<section class="ledger-section" aria-labelledby="ledger-itinerary-title">
  <h4 id="ledger-itinerary-title" tabindex="-1">날짜별 일정</h4>
  <div class="ledger-day-bar">
    <div class="field"><label for="ledger-day">일정 조회 날짜</label><select id="ledger-day"></select></div>
    <p id="ledger-day-spent" class="help"></p>
  </div>
  <p id="ledger-schedule-empty" class="help" hidden>이 날짜에 표시할 일정이 없습니다.</p>
  <ul id="ledger-schedule-list" class="ledger-list"></ul>
  <details id="ledger-cancelled-schedules" class="ledger-history" hidden>
    <summary>여행 전체의 취소된 일정</summary><ul id="ledger-schedule-cancelled-list" class="ledger-list"></ul>
  </details>
  <form id="ledger-schedule-form" class="ledger-editor" novalidate>
    <h5 id="ledger-schedule-form-title">일정 추가</h5>
    <div class="ledger-fields">
      ${field('schedule','date',scheduleLabels.date,'<input @field type="date" required>')}
      ${field('schedule','title',scheduleLabels.title,'<input @field type="text" required>')}
      ${field('schedule','startTime',scheduleLabels.startTime,'<input @field type="time">')}
      ${field('schedule','endTime',scheduleLabels.endTime,'<input @field type="time">')}
      ${field('schedule','place',scheduleLabels.place,'<input @field type="text">')}
      ${field('schedule','budgetKrw',scheduleLabels.budgetKrw,'<input @field type="text" inputmode="numeric" required>','그룹 전체 예산을 입력해 주세요.')}
    </div>
    <p class="help">시간을 정하지 않았다면 시작과 종료 시각을 모두 비워 두세요.</p>
    <div class="button-row"><button id="ledger-save-schedule" class="primary" type="submit" aria-describedby="ledger-write-help">일정 저장</button>
      <button id="ledger-new-schedule" class="secondary" type="button">일정 입력 초기화</button></div>
  </form>
</section>`;

export function mountItinerary(r, actions, helpers) {
  const {on, focus, run, confirm} = helpers;
  const doc = r['ledger-schedule-list'].ownerDocument;
  const rows = new Map(), cancelled = new Map();
  const inputs = Object.keys(scheduleLabels).map(key => [key, r[`ledger-schedule-${key}`]]);
  for (const [key, input] of inputs) on(input, 'input', () => actions.setScheduleField(key, input.value));
  on(r['ledger-day'], 'change', event => actions.selectDay(event.target.value));
  on(r['ledger-new-schedule'], 'click', () => {actions.editSchedule(); focus('ledger-schedule-title');});
  on(r['ledger-schedule-form'], 'submit', event => {
    event.preventDefault();
    void run(event.submitter, actions.saveSchedule, 'ledger-itinerary-title');
  });

  function makeRow(row, active) {
    const li = element(doc, 'li', 'ledger-row');
    li.dataset.scheduleId = row.id;
    li.titleNode = element(doc, 'h5');
    li.titleNode.tabIndex = -1;
    li.meta = element(doc, 'p', 'help');
    li.totals = element(doc, 'p', 'ledger-amount-line');
    li.change = element(doc, 'p', 'help');
    li.append(li.titleNode, li.meta, li.totals, li.change);
    if (active) {
      const controls = element(doc, 'div', 'button-row');
      li.edit = button(doc, '수정', 'edit-schedule', () => {actions.editSchedule(row.id); focus('ledger-schedule-title');});
      li.expense = button(doc, '경비 등록', 'add-expense-for', () => {actions.addExpenseFor(row.id); focus('ledger-expense-title');});
      li.up = button(doc, '위로', 'move-schedule-up', event => void run(event.currentTarget, () => actions.moveSchedule(row.id, -1), li.titleNode));
      li.down = button(doc, '아래로', 'move-schedule-down', event => void run(event.currentTarget, () => actions.moveSchedule(row.id, 1), li.titleNode));
      li.cancel = button(doc, '취소', 'cancel-schedule', event => confirm('schedule', row.id, event.currentTarget));
      controls.append(li.edit, li.expense, li.up, li.down, li.cancel);
      li.append(controls);
      li.controls = controls;
    }
    return li;
  }

  function updateRow(li, row, totals, state, index, count) {
    const {ledger} = state;
    const time = row.startTime ? `${row.startTime} ~ ${row.endTime}` : '시간 미정';
    writeText(li.titleNode, row.title);
    writeText(li.meta, [dayLabel(row.date), time, row.place, row.status === 'cancelled' ? '취소됨' : ''].filter(Boolean).join(' · '));
    writeText(li.totals, `그룹 전체 예산 ${won(row.budgetKrw)} · 실지출 ${won(totals?.spentKrw ?? 0)} · 차액 ${balance(totals?.remainingKrw ?? row.budgetKrw)}`);
    writeText(li.change, changeLabel(ledger, row));
    if (!li.controls) return;
    li.controls.hidden = !state.canEdit;
    const locked = writesLocked(state);
    for (const [control, name] of [[li.edit,'수정'],[li.expense,'경비 등록'],[li.up,'위로 이동'],[li.down,'아래로 이동'],[li.cancel,'취소']]) {
      control.setAttribute('aria-label', `${row.title} 일정 ${name}`);
      control.disabled = locked;
    }
    li.up.disabled = locked || index === 0;
    li.down.disabled = locked || index === count - 1;
  }

  return function render(state) {
    const {ledger} = state;
    const dateSelect = r['ledger-day'];
    const dates = ledger ? tripDates(ledger) : [];
    renderOptions(dateSelect, dates.map(date => ({id: date, label: dayLabel(date)})), state.day);
    r['ledger-schedule-form'].hidden = !state.canEdit;
    const writing = state.busy === 'write';
    const save = r['ledger-save-schedule'];
    save.disabled = writesLocked(state);
    writeText(save, state.scheduleId ? '일정 수정 저장' : '일정 저장');
    r['ledger-new-schedule'].disabled = writesLocked(state);
    writeText(r['ledger-schedule-form-title'], state.scheduleId ? '일정 수정' : '일정 추가');
    for (const [key, input] of inputs) {
      input.readOnly = writing;
      renderField(input, issueFor(state,'schedule',key), r[`ledger-schedule-${key}-error`], state.scheduleDraft[key]);
    }
    r['ledger-schedule-date'].min = ledger?.startDate ?? '';
    r['ledger-schedule-date'].max = ledger?.endDate ?? '';
    const active = ledger ? dayItems(ledger, state.day) : [];
    const old = ledger?.items.filter(row => row.status === 'cancelled') ?? [];
    if (!ledger) r['ledger-cancelled-schedules'].open = false;
    r['ledger-schedule-empty'].hidden = active.length !== 0;
    r['ledger-cancelled-schedules'].hidden = old.length === 0;
    const total = ledger?.summary.byDate.find(row => row.date === state.day);
    writeText(r['ledger-day-spent'], `이 날짜의 그룹 전체 실지출 ${won(total?.spentKrw ?? 0)}`);
    const byId = new Map(ledger?.summary.byItem.map(row => [row.itineraryId, row]));
    reconcile(r['ledger-schedule-list'], rows, active, row => makeRow(row, true),
      (li, row, i) => updateRow(li, row, byId.get(row.id), state, i, active.length),
      state.busy ? undefined : focused => focused.closest('[data-schedule-id]')?.titleNode);
    reconcile(r['ledger-schedule-cancelled-list'], cancelled, old, row => makeRow(row, false),
      (li, row) => updateRow(li, row, byId.get(row.id), state));
  };
}
