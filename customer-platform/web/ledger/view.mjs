import { focusAfterAction } from '../travel/view.mjs';
import {
  actionLabels, balance, element, field, fxLabels, fxName, issueFor, itemName, memberName,
  reconcile, renderField, seoulTime, won, writeText, writesLocked,
} from './forms.mjs';
import { itineraryMarkup, mountItinerary } from './itinerary-view.mjs';
import { expensesMarkup, mountExpenses } from './expenses-view.mjs';
import { settlementMarkup, mountSettlement } from './settlement-view.mjs';

const views = new WeakMap();
const totals = {
  budgetKrw: '전체 목표 예산', allocatedKrw: '일정 배정 예산', spentKrw: '전체 실지출', remainingKrw: '여행 잔여 예산',
};

function mount(root, actions) {
  root.innerHTML = `
  <section class="ledger" aria-labelledby="ledger-title">
    <div class="ledger-heading">
      <div><h3 id="ledger-title" tabindex="-1">공동 일정·경비 장부</h3><p class="help">화면을 보는 동안 공동 변경을 주기적으로 확인합니다.</p></div>
      <button id="ledger-refresh" class="secondary" type="button">장부 다시 조회</button>
    </div>
    <p id="ledger-busy" class="help" role="status" hidden></p>
    <p id="ledger-status" class="status" role="status" hidden></p>
    <p id="ledger-error" class="error" role="alert" tabindex="-1" hidden></p>
    <div id="ledger-content" hidden>
      <section class="ledger-overview" aria-labelledby="ledger-totals-title">
        <h4 id="ledger-totals-title">그룹 전체 예산·경비</h4>
        <dl class="ledger-totals">${Object.entries(totals).map(([id,label]) => `<div><dt>${label}</dt><dd id="ledger-total-${id}"></dd></div>`).join('')}</dl>
        <p id="ledger-context" class="help"></p>
      </section>
      <p id="ledger-write-help" class="help" hidden></p>
      <section id="ledger-pending" class="notice-panel" aria-labelledby="ledger-pending-title" hidden>
        <h4 id="ledger-pending-title"></h4>
        <p>결과를 확인하지 못했습니다. 재시도는 처음 저장을 눌렀을 때의 입력을 사용합니다. 그 뒤 편집한 내용은 따로 남겨 둡니다.</p>
        <div class="button-row">
          <button id="ledger-retry-pending" type="button" class="secondary">같은 요청 재시도</button>
          <button id="ledger-discard-pending" type="button" class="secondary">보존한 요청 닫기</button>
        </div>
      </section>
      <section id="ledger-conflict" class="notice-panel" aria-labelledby="ledger-conflict-title" hidden>
        <h4 id="ledger-conflict-title">다른 변경이 먼저 저장되었습니다</h4>
        <p id="ledger-conflict-help"></p>
        <ul id="ledger-conflict-differences" class="ledger-list ledger-differences"></ul>
        <div class="button-row">
          <button id="ledger-refresh-conflict" type="button" class="secondary">최신 정보 확인</button>
          <button id="ledger-reapply" type="button" class="secondary" aria-describedby="ledger-conflict-help">내 입력 다시 적용</button>
          <button id="ledger-dismiss-conflict" type="button" class="secondary">이 요청 닫기</button>
        </div>
      </section>
      <section id="ledger-confirm" class="notice-panel" aria-labelledby="ledger-confirm-title" hidden>
        <h4 id="ledger-confirm-title" tabindex="-1"></h4>
        <p id="ledger-confirm-help"></p>
        <div class="button-row">
          <button id="ledger-confirm-yes" type="button" class="secondary">취소 확정</button>
          <button id="ledger-confirm-no" type="button" class="secondary">돌아가기</button>
        </div>
      </section>
      ${settlementMarkup}
      ${itineraryMarkup}
      ${expensesMarkup}
      <section class="ledger-section" aria-labelledby="ledger-fx-title">
        <h4 id="ledger-fx-title">환율</h4>
        <p id="ledger-fx-current" class="ledger-amount-line"></p>
        <p class="help">체험 환율은 예시 값입니다. 환율을 바꿔도 이미 등록한 경비는 그대로 유지됩니다.</p>
        <form id="ledger-fx-form" class="ledger-editor" novalidate>
          <div class="ledger-fields">
            ${field('fx', 'source', fxLabels.source, '<select @field><option value="demo">체험 환율</option><option value="manual">수동 환율</option></select>')}
            ${field('fx', 'rateMilli', fxLabels.rateMilli, '<input @field type="text" inputmode="decimal" required>','수동 환율은 소수 셋째 자리까지 입력할 수 있습니다.')}
          </div>
          <button id="ledger-save-fx" class="primary" type="submit" aria-describedby="ledger-write-help">환율 저장</button>
        </form>
      </section>
      <section class="ledger-section" aria-labelledby="ledger-members-title">
        <h4 id="ledger-members-title">동행자 부담 현황</h4>
        <p class="help">경비에 기록한 결제액과 균등 분담액입니다. 지급을 반영한 잔액은 여행 정산에서 확인할 수 있습니다.</p>
        <ul id="ledger-member-balances" class="ledger-list"></ul>
      </section>
      <details id="ledger-history" class="ledger-history">
        <summary>최근 변경 이력</summary>
        <p class="help">최근 30건까지 표시합니다. 변경 시각은 한국 시간입니다.</p>
        <ul id="ledger-history-list" class="ledger-list"></ul>
      </details>
    </div>
  </section>`;
  const r = Object.fromEntries([...root.querySelectorAll('[id]')].map(node => [node.id, node]));
  const doc = root.ownerDocument;
  const removers = [];
  const members = new Map(), history = new Map(), differences = new Map();
  let previous = null, confirmOrigin = null;
  function on(node, event, fn) {
    node.addEventListener(event, fn);
    removers.push(() => node.removeEventListener(event, fn));
  }
  function focus(id) {
    const node = r[id];
    if (node && !node.closest('[hidden]')) node.focus();
  }
  async function run(origin, action, fallback = 'ledger-title') {
    const before = previous?.error;
    try { await action(); }
    finally {
      const issue = previous?.error;
      if (origin && issue && issue !== before && (doc.activeElement === doc.body || doc.activeElement === origin)) {
        const input = r[`ledger-${issue.scope}-${issue.field}`];
        focus(input && !input.closest('[hidden]') ? input.id : 'ledger-error');
      } else if (previous?.ledger) {
        focusAfterAction(doc, origin, [typeof fallback === 'string' ? r[fallback] : fallback, r['ledger-title']]);
      }
    }
  }
  function confirm(scope, id, origin) {
    actions.confirmCancel(scope, id);
    if (actions.state.confirmation?.id !== id) return;
    confirmOrigin = origin;
    focus('ledger-confirm-title');
  }
  const helper = {on, focus, run, confirm};
  const renderItinerary = mountItinerary(r, actions, helper);
  const renderExpenses = mountExpenses(r, actions, helper);
  const renderSettlement = mountSettlement(r, actions, helper);
  for (const [id, action] of [
    ['ledger-refresh', actions.refresh], ['ledger-retry-pending', actions.retryPending], ['ledger-discard-pending', actions.discardPending],
    ['ledger-refresh-conflict', actions.refreshConflict], ['ledger-reapply', actions.reapply], ['ledger-dismiss-conflict', actions.discardPending],
  ]) on(r[id], 'click', event => {void run(event.currentTarget, action);});
  on(r['ledger-confirm-yes'], 'click', event => {
    const target = confirmOrigin?.closest('li')?.titleNode ?? r['ledger-title'];
    void run(event.currentTarget, actions.cancelConfirmed, target);
  });
  function closeConfirmation(origin) {
    const trigger = confirmOrigin;
    actions.confirmCancel(previous?.confirmation?.scope, null);
    confirmOrigin = null;
    focusAfterAction(doc, origin, [trigger, r['ledger-title']]);
  }
  on(r['ledger-confirm-no'], 'click', event => closeConfirmation(event.currentTarget));
  on(r['ledger-confirm'], 'keydown', event => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    event.preventDefault();
    closeConfirmation(doc.activeElement);
  });
  for (const [key, event] of [['source','change'],['rateMilli','input']]) {
    const input = r[`ledger-fx-${key}`];
    on(input, event, () => actions.setFxField(key, input.value));
  }
  on(r['ledger-fx-form'], 'submit', event => {
    event.preventDefault();
    void run(event.submitter, actions.saveFx, 'ledger-fx-title');
  });

  const rate = new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 3});
  function render(state) {
    const {ledger, busy, conflict, confirmation, pendingKind, error, status} = state;
    const active = doc.activeElement;
    const ownedFocus = root.contains(active);
    const moved = previous?.accountId !== state.accountId || previous?.tripId !== state.tripId;
    if (moved) {
      confirmOrigin = null;
      r['ledger-history'].open = false;
    }
    root.hidden = !state.tripId;
    r['ledger-content'].hidden = !ledger;
    r['ledger-content'].setAttribute('aria-busy', String(busy === 'write' || busy === 'load'));
    r['ledger-refresh'].disabled = Boolean(busy);
    r['ledger-busy'].hidden = !busy;
    writeText(r['ledger-busy'], busy === 'write' ? '변경 사항을 저장하고 있습니다.' : busy ? '장부를 조회하고 있습니다.' : '');
    r['ledger-status'].hidden = !status;
    writeText(r['ledger-status'], status);
    r['ledger-error'].hidden = !error;
    writeText(r['ledger-error'], error?.message ?? '');
    const locked = writesLocked(state);
    const pending = Boolean(pendingKind && !conflict);
    r['ledger-pending'].hidden = !pending;
    writeText(r['ledger-pending-title'], pending ? `${actionLabels[pendingKind]} 결과 확인` : '');
    const canRetry = pendingKind?.startsWith('settlement.') ? state.canSettle
      : pendingKind === 'fx.update' ? state.canSetFx : state.canEdit;
    r['ledger-retry-pending'].disabled = Boolean(busy) || !canRetry;
    r['ledger-discard-pending'].disabled = Boolean(busy);
    r['ledger-conflict'].hidden = !conflict;
    r['ledger-refresh-conflict'].disabled = Boolean(busy);
    r['ledger-reapply'].hidden = Boolean(conflict?.freshAction);
    r['ledger-dismiss-conflict'].hidden = Boolean(conflict?.freshAction);
    r['ledger-reapply'].disabled = Boolean(busy || !conflict?.latestChecked);
    r['ledger-dismiss-conflict'].disabled = Boolean(busy);
    writeText(r['ledger-conflict-help'], conflict?.freshAction
      ? '최신 장부를 확인한 뒤 현재 금액과 상태를 보고 필요한 작업을 다시 선택해 주세요.'
      : conflict?.latestChecked
      ? `갱신 ${conflict.revision}의 정보입니다. ${conflict.differences.length ? '최신 값과 내 입력을 확인한 뒤 다시 적용해 주세요.' : '표시할 입력 차이가 없습니다. 요청을 다시 적용할 수 있습니다.'}`
      : '내 입력을 보존했습니다. 최신 정보를 확인하면 현재 장부와 비교할 수 있습니다.');
    reconcile(r['ledger-conflict-differences'], differences, (conflict?.differences ?? []).map(row => ({...row, id: row.label})),
      () => element(doc, 'li'), (li, row) => writeText(li, `${row.label} · 최신 값 ${row.latest} · 내 입력 ${row.proposed}`));
    r['ledger-write-help'].hidden = !locked;
    writeText(r['ledger-write-help'], busy ? '처리가 끝나면 저장할 수 있습니다.' :
      locked ? '보존한 요청을 확인하거나 닫은 뒤 새 변경을 저장할 수 있습니다.' : '');
    r['ledger-confirm'].hidden = !confirmation || Boolean(conflict || pendingKind);
    r['ledger-confirm-yes'].disabled = Boolean(busy);
    r['ledger-confirm-no'].disabled = Boolean(busy);
    writeText(r['ledger-confirm-title'], confirmation ? `‘${confirmation.title}’ ${confirmation.scope === 'schedule' ? '일정을' : '경비를'} 취소할까요?` : '');
    writeText(r['ledger-confirm-help'], confirmation?.scope === 'schedule'
      ? '취소한 일정과 연결된 경비는 기록에 남습니다. 연결 경비는 실지출에 계속 포함됩니다.'
      : '취소한 경비는 기록에 남고 실지출과 분담 합계에서 제외됩니다.');

    for (const key of Object.keys(totals)) {
      const value = key === 'budgetKrw' ? ledger?.budgetKrw : ledger?.summary[key];
      writeText(r[`ledger-total-${key}`], key === 'remainingKrw' ? balance(value ?? 0) : won(value ?? 0));
    }
    writeText(r['ledger-context'], ledger ? `여행지 시간대 ${ledger.timeZone} · 갱신 ${ledger.revision}` : '');
    writeText(r['ledger-fx-current'], ledger ? `현재 ${fxName(ledger.fx.source)} · 1 THB당 ${rate.format(ledger.fx.rateMilli / 1000)}원` : '');
    r['ledger-fx-form'].hidden = !state.canSetFx;
    r['ledger-save-fx'].disabled = locked;
    r['ledger-fx-source'].disabled = busy === 'write';
    r['ledger-fx-rateMilli'].readOnly = busy === 'write' || state.fxDraft.source === 'demo';
    for (const key of Object.keys(fxLabels)) renderField(r[`ledger-fx-${key}`], issueFor(state, 'fx', key), r[`ledger-fx-${key}-error`],
      key === 'rateMilli' && state.fxDraft.source === 'demo' ? '38.6' : state.fxDraft[key]);

    renderItinerary(state);
    renderExpenses(state);
    renderSettlement(state);
    reconcile(r['ledger-member-balances'], members, ledger?.summary.byMember.map(row => ({...row, id: row.memberId})) ?? [],
      () => element(doc, 'li', 'ledger-row'), (li, row) => {
        const net = row.netKrw === 0 ? '차액 없음' : row.netKrw > 0 ? `${won(row.netKrw)} 더 결제` : `${won(-row.netKrw)} 추가 부담`;
        writeText(li, `${memberName(ledger, row.memberId)} · 결제 ${won(row.paidKrw)} · 부담 ${won(row.owedKrw)} · ${net}`);
      });
    reconcile(r['ledger-history-list'], history, ledger?.history.map((row, i) => ({...row, id: `${row.revision}-${i}`})) ?? [],
      () => element(doc, 'li', 'ledger-row'), (li, row) => {
        const expense = ledger.expenses.find(item => item.id === row.targetId);
        const target = expense?.title ?? (ledger.items.some(item => item.id === row.targetId) ? itemName(ledger, row.targetId) : '');
        const action = Object.hasOwn(actionLabels, row.action) ? actionLabels[row.action] : '변경';
        writeText(li, [`갱신 ${row.revision}`, action, target, memberName(ledger, row.memberId), seoulTime(row.at)].filter(Boolean).join(' · '));
      });
    if (!moved && ownedFocus) {
      if (error && error !== previous?.error && error.scope !== 'poll') {
        const input = r[`ledger-${error.scope}-${error.field}`];
        focus(input && !input.closest('[hidden]') ? input.id : 'ledger-error');
      } else if (!busy && ledger && active && !r['ledger-confirm'].contains(active) &&
        !r['ledger-settlement-review'].contains(active) && (!active.isConnected || active.closest('[hidden]'))) {
        focusAfterAction(doc, active, [r['ledger-title']]);
      }
    }
    previous = state;
  }

  return {
    render,
    destroy() {
      for (const remove of removers) remove();
      root.replaceChildren();
      views.delete(root);
    },
  };
}

export function renderLedger(root, state, actions) {
  let view = views.get(root);
  if (!view) { view = mount(root, actions); views.set(root, view); }
  view.render(state);
  return view;
}
