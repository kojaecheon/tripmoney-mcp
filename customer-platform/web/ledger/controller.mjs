import { ApiError, parsePlaceReference } from '../api.mjs';
import {
  blankExpense, blankPayment, blankSchedule, dayItems, draftCommand, expenseFields, expenseLabels,
  fxFields, fxLabels, fxName, itemName, memberName, paymentAction, scheduleFields, scheduleLabels,
  scopeOf, settlementAction, tripDates, validation,
} from './forms.mjs';

const scopes = ['schedule', 'expense', 'fx', 'payment'];
const makeForm = (fields, id = null) => ({fields, id, base: null});
function emptySession() {
  return {
    forms: {schedule: makeForm(blankSchedule()), expense: makeForm(blankExpense()), fx: makeForm(fxFields()),
      payment: makeForm(blankPayment())},
    day: '', settlementDate: '', settlementReview: null, filters: {date: '', itineraryId: '', payerId: ''},
    pending: null, conflict: null, confirm: null,
  };
}
const permitted = (role, scope) => role === 'owner' || (role === 'editor' && scope !== 'fx' && scope !== 'settlement');
const canWriteType = (role, type) => permitted(role, scopeOf(type));
const needsFreshAction = scope => scope === 'settlement' || scope === 'payment';
const safeError = (error, scope) => {
  const safe = error instanceof ApiError ? error : new ApiError(503, 'unavailable');
  const messages = {
    unavailable: '장부를 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요.',
    forbidden: '장부를 변경할 권한을 확인해 주세요.',
    not_found: '이 여행의 장부를 조회할 수 없습니다.',
  };
  const fieldMessages = {
    settlementLocked: '소유자가 정산을 재개한 뒤 경비를 변경할 수 있습니다.',
    toMemberId: '받는 동행자를 다시 확인해 주세요.',
    amountKrw: '보낸 금액을 1원부터 1조 원까지 원 단위로 입력해 주세요.',
  };
  const message = safe.code === 'conflict' && needsFreshAction(scope)
    ? '다른 변경이 먼저 저장되었습니다. 최신 장부를 확인한 뒤 정산 또는 지급 작업을 다시 시작해 주세요.'
    : fieldMessages[safe.field] ?? messages[safe.code] ?? safe.message;
  return {scope, code: safe.code, field: safe.field, message};
};
const same = (a, b) => Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every(value => b.includes(value))
  : a === b;
function formFromLedger(scope, ledger, day, id) {
  if (scope === 'fx') return makeForm(fxFields(ledger.fx));
  if (scope === 'payment') return makeForm(blankPayment());
  const rows = scope === 'schedule' ? ledger.items : ledger.expenses;
  const row = rows.find(row => row.id === id && row.status === 'active');
  if (row) return makeForm(scope === 'schedule' ? scheduleFields(row) : expenseFields(row), id);
  const member = ledger.members.find(row => row.isMe && row.active);
  return makeForm(scope === 'schedule' ? blankSchedule(day) : blankExpense(day, member?.id));
}
function conflictValue(key, value, ledger) {
  if (key === 'itineraryId') return itemName(ledger, value);
  if (key === 'payerId') return value ? memberName(ledger, value) : '선택 안 함';
  if (key === 'splitIds') return value.map(id => memberName(ledger, id)).join(', ') || '선택 안 함';
  if (key === 'source') return fxName(value);
  if (typeof value === 'boolean') return value ? '적용' : '유지';
  return value === '' ? '입력 없음' : String(value);
}
function compare(op, form, ledger) {
  const {command} = op;
  const scope = scopeOf(command.type);
  if (op.form) {
    const current = formFromLedger(scope, ledger, form.fields.date || ledger.startDate, form.id);
    if (form.id && current.id !== form.id) return [{label: '기록', latest: '취소되었거나 조회할 수 없음', proposed: '수정'}];
    const labels = {schedule: scheduleLabels, expense: expenseLabels, fx: fxLabels}[scope];
    return Object.entries(labels).filter(([key]) => !same(current.fields[key], form.fields[key])).map(([key, label]) => ({
      label, latest: form.id || scope === 'fx' ? conflictValue(key, current.fields[key], ledger) : '새 기록',
      proposed: conflictValue(key, form.fields[key], ledger),
    }));
  }
  if (command.type === 'schedule.reorder') {
    const latest = dayItems(ledger, command.date).map(row => row.id);
    const titles = ids => ids.map(id => itemName(ledger, id)).join(', ') || '일정 없음';
    return [{label: '일정 순서', latest: titles(latest), proposed: titles(command.ids)}];
  }
  const row = (scope === 'schedule' ? ledger.items : ledger.expenses).find(row => row.id === command.id);
  return [{label: '기록 상태', latest: row ? row.title + (row.status === 'active' ? ' (진행 중)' : ' (취소됨)') : '조회할 수 없음', proposed: '취소'}];
}

export function createLedgerController(api, {
  onUnauthorized = () => {}, onChanged = () => {}, onUnavailable = () => {},
  pollMs = 5000, isVisible = () => !globalThis.document?.hidden,
} = {}) {
  const listeners = new Set();
  const retained = new Map();
  let accountId = null, trip = null, ledger = null, session = emptySession();
  let epoch = 0, timer = null, destroyed = false, request = null, catchUp = false;
  let missing = false, blocked = false, error = null, status = '';
  let state;

  function role() {
    if (!ledger || blocked) return null;
    return trip.revision > ledger.revision ? trip.role : ledger.role;
  }
  function publish() {
    const conflict = session.conflict;
    const settlement = ledger?.settlement;
    const review = session.settlementReview;
    const freshAction = conflict && needsFreshAction(scopeOf(conflict.command.type));
    const settlementDate = settlement && (session.settlementDate ||
      (settlement.today < ledger.startDate ? ledger.startDate : settlement.today > ledger.endDate ? ledger.endDate : settlement.today));
    state = {
      accountId, tripId: trip?.id ?? null, ledger, day: session.day, filters: {...session.filters},
      canEdit: permitted(role(), 'schedule'), canSetFx: permitted(role(), 'fx'),
      canSettle: Boolean(settlement && permitted(role(), 'settlement')),
      settlementDate: settlementDate || '',
      settlementReview: settlement && review ? {...review, stale: review.revision !== ledger.revision ||
        review.type !== settlementAction(settlement, review.date)} : null,
      busy: request === 'poll' ? null : request, error, status, confirmation: session.confirm,
      scheduleDraft: session.forms.schedule.fields, scheduleId: session.forms.schedule.id,
      expenseDraft: session.forms.expense.fields, expenseId: session.forms.expense.id, fxDraft: session.forms.fx.fields,
      paymentDraft: settlement ? session.forms.payment.fields : blankPayment(),
      pendingKind: ledger ? session.pending?.command.type ?? null : null,
      conflict: ledger && conflict ? {type: conflict.command.type, revision: conflict.revision, latestChecked: conflict.revision !== null,
        freshAction: Boolean(freshAction),
        differences: conflict.revision === null || freshAction ? [] : compare(conflict, session.forms[scopeOf(conflict.command.type)], ledger)} : null,
    };
    if (!ledger) {
      state.scheduleDraft = blankSchedule();
      state.expenseDraft = blankExpense();
      state.fxDraft = fxFields();
      state.scheduleId = state.expenseId = state.confirmation = null;
      state.day = '';
      state.filters = {date: '', itineraryId: '', payerId: ''};
    }
    for (const listen of listeners) listen(state);
  }
  function stopPoll() { if (timer !== null) clearInterval(timer); timer = null; }
  function startPoll() {
    if (timer === null && pollMs > 0) timer = setInterval(() => {
      if (isVisible()) void refresh('poll');
    }, pollMs);
  }
  function current(e) { return !destroyed && epoch === e; }
  function resetContext() {
    ++epoch;
    stopPoll();
    trip = ledger = request = error = null;
    session = emptySession();
    catchUp = missing = blocked = false;
    status = '';
  }
  function clearAccount() {
    retained.clear();
    accountId = null;
    resetContext();
  }
  function restrict(toRole) {
    for (const scope of scopes) {
      if (!permitted(toRole, scope)) session.forms[scope] = emptySession().forms[scope];
    }
    if (session.pending && !canWriteType(toRole, session.pending.command.type)) session.pending = null;
    if (session.conflict && !canWriteType(toRole, session.conflict.command.type)) session.conflict = null;
    if (!permitted(toRole, 'schedule')) session.confirm = null;
    if (!permitted(toRole, 'settlement')) session.settlementReview = null;
  }
  function applyLedger(next) {
    ledger = next;
    blocked = missing = false;
    retained.set(trip.id, session);
    const dates = tripDates(next);
    if (!dates.includes(session.day)) session.day = next.startDate;
    if (!next.settlement?.days.some(row => row.date === session.settlementDate)) session.settlementDate = '';
    if (!dates.includes(session.filters.date) && !next.expenses.some(row => row.localDate === session.filters.date)) session.filters.date = '';
    if (!next.items.some(row => row.id === session.filters.itineraryId) && session.filters.itineraryId !== 'unassigned') session.filters.itineraryId = '';
    if (!next.members.some(row => row.id === session.filters.payerId)) session.filters.payerId = '';
    restrict(role());
    for (const scope of scopes) {
      const form = session.forms[scope];
      if (permitted(role(), scope) && form.base === null) session.forms[scope] = formFromLedger(scope, next, session.day, form.id);
    }
    if (session.conflict?.revision !== next.revision && session.conflict) session.conflict = {...session.conflict, revision: null};
    startPoll();
  }
  async function read(e) {
    const next = await api.getLedger(trip.id, accountId);
    if (!current(e)) return false;
    if (next.tripId !== trip.id) throw new ApiError(0, 'invalid_response');
    if (next.revision < (ledger?.revision ?? 0)) return false;
    applyLedger(next);
    if (next.revision > trip.revision || next.role !== trip.role) onChanged(accountId, trip.id, next.revision);
    return true;
  }
  function failure(thrown, e, scope) {
    if (!current(e)) return;
    const http = thrown instanceof ApiError ? thrown.status : 0;
    const info = safeError(thrown, scope);
    if (http === 401 || http === 412) {
      clearAccount();
      publish();
      onUnauthorized();
      return;
    }
    if (http === 404) {
      retained.delete(trip.id);
      session = emptySession();
      ledger = null;
      missing = true;
      onUnavailable(accountId, trip.id);
    }
    if (http === 403) blocked = true;
    if (scope !== 'poll' || !error || error.scope === 'poll' || http === 403 || http === 404) error = info;
  }
  function finish(e) {
    if (!current(e)) return;
    request = null;
    publish();
    if (catchUp) {
      catchUp = false;
      if (!missing && !error) void refresh('poll');
    }
  }
  async function refresh(kind = 'refresh') {
    if (!accountId || !trip || request || destroyed) return false;
    const e = epoch;
    const op = kind === 'conflict' ? session.conflict : null;
    request = kind;
    if (kind !== 'poll' && error?.code !== 'conflict') error = null;
    if (kind !== 'poll') publish();
    try {
      const loaded = await read(e);
      if (!loaded) return false;
      if (op && session.conflict && canWriteType(role(), op.command.type)) {
        if (needsFreshAction(scopeOf(op.command.type))) {
          session.conflict = null;
          error = null;
          status = '최신 장부를 불러왔습니다. 정산과 지급 내역을 확인한 뒤 필요한 작업을 선택해 주세요.';
          if (op.command.type === 'payment.report') session.forms.payment.base = ledger.revision;
        } else {
          session.conflict = {...op, revision: ledger.revision};
        }
      }
      if (kind === 'refresh') status = '최신 장부를 불러왔습니다.';
      if (kind === 'poll' && error?.scope === 'poll') error = null;
      return true;
    } catch (err) {
      failure(err, e, kind);
      return false;
    } finally { finish(e); }
  }
  function allowed(scope) {
    return Boolean(ledger && (!needsFreshAction(scope) || ledger.settlement) && permitted(role(), scope) &&
      request !== 'write' && !destroyed);
  }
  function edit(scope, id = null, itineraryId) {
    if (!allowed(scope) || session.pending || session.conflict) return;
    const form = formFromLedger(scope, ledger, session.day, id);
    if (id && form.id !== id) return;
    if (itineraryId) {
      const item = ledger.items.find(row => row.id === itineraryId && row.status === 'active');
      if (!item) return;
      form.fields = {...form.fields, itineraryId, occurredLocal: item.date + 'T12:00'};
      form.base = ledger.revision;
    }
    session.forms[scope] = form;
    if (error?.scope === scope) error = null;
    publish();
  }
  function setField(scope, field, value) {
    if (!allowed(scope)) return;
    const form = session.forms[scope];
    if (!Object.hasOwn(form.fields, field) || same(form.fields[field], value)) return;
    session.forms[scope] = {
      ...form, base: form.base ?? ledger.revision,
      fields: {...form.fields, [field]: Array.isArray(value) ? [...value] : value},
    };
    if (scope === 'schedule' && field === 'place' && Object.hasOwn(form.fields, 'placeRef')) {
      session.forms[scope].fields.placeRef = null;
    }
    if (error?.scope === scope && error.code === 'validation') error = null;
    publish();
  }
  async function send(op) {
    if (request || !allowed(scopeOf(op.command.type))) return false;
    const e = epoch;
    const scope = scopeOf(op.command.type);
    request = 'write';
    error = null;
    status = '';
    let submitted = false;
    publish();
    try {
      const {me} = await api.me();
      if (!current(e)) return false;
      if (me.userId !== accountId) throw new ApiError(412, 'account_changed');
      if (!canWriteType(role(), op.command.type)) return false;
      session.conflict = null;
      session.pending = op;
      submitted = true;
      const result = await api.executeLedger(trip.id, op.command, op.expectedRevision, op.operationId, accountId);
      if (!current(e)) return false;
      session.pending = session.conflict = session.confirm = session.settlementReview = null;
      const draft = session.forms[scope];
      if (op.form && draft.id === op.form.id && Object.keys(draft.fields).every(key => same(draft.fields[key], op.form.fields[key]))) {
        session.forms[scope] = formFromLedger(scope, ledger, session.day);
      }
      status = result.replayed ? '이전 요청이 저장된 것을 확인했습니다.' : '변경 사항을 저장했습니다.';
      try {
        await read(e);
      } catch (err) {
        failure(err, e, 'refresh');
        if (current(e) && !missing) onChanged(accountId, trip.id, result.tripRevision);
      }
      return current(e);
    } catch (err) {
      if (!current(e)) return false;
      const http = err instanceof ApiError ? err.status : 0;
      if (submitted) {
        const info = safeError(err, scope);
        if (http === 409) {
          session.conflict = {...op, revision: null};
          session.pending = null;
          session.settlementReview = null;
        } else if (http !== 503 && !['network', 'invalid_response', 'unavailable'].includes(info.code)) {
          session.pending = null;
        }
      }
      failure(err, e, scope);
      if (http === 403) {
        publish();
        try { await read(e); } catch (requery) { failure(requery, e, 'refresh'); }
      }
      return false;
    } finally { finish(e); }
  }
  function write(command, expectedRevision, form = null) {
    return send({command: structuredClone(command), expectedRevision, form, operationId: globalThis.crypto.randomUUID()});
  }
  function interruptPoll() {
    if (request !== 'poll') return;
    // An old background snapshot must not update the screen during a user action.
    ++epoch;
    request = null;
  }
  function save(scope) {
    interruptPoll();
    if (request || !allowed(scope) || session.pending || session.conflict) return Promise.resolve(false);
    const form = session.forms[scope];
    const result = draftCommand(scope, form, ledger);
    if (result.error) {
      error = result.error;
      publish();
      return Promise.resolve(false);
    }
    return write(result.command, form.base ?? ledger.revision, form);
  }
  function changeSettlement(type, date, revision = ledger?.revision) {
    interruptPoll();
    if (request || !allowed('settlement') || session.pending || session.conflict || revision !== ledger.revision ||
      type !== settlementAction(ledger.settlement, date)) return Promise.resolve(false);
    session.settlementReview = null;
    return write({type, date}, revision);
  }

  const controller = {
    get state() { return state; },
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    setContext(nextAccount, nextTrip) {
      if (destroyed) return Promise.resolve(false);
      if (nextAccount !== accountId) clearAccount();
      accountId = nextAccount;
      if (nextAccount && nextTrip && nextTrip.id === trip?.id) {
        const changed = nextTrip.revision > trip.revision || nextTrip.role !== trip.role;
        trip = nextTrip;
        if (!changed || missing || (ledger && ledger.revision >= trip.revision && ledger.role === trip.role)) return Promise.resolve(false);
        if (ledger) restrict(role());
        publish();
        if (request) { catchUp = true; return Promise.resolve(false); }
        return refresh('poll');
      }
      if (!trip && (!nextAccount || !nextTrip)) { publish(); return Promise.resolve(false); }
      resetContext();
      if (nextAccount && nextTrip) {
        trip = nextTrip;
        session = retained.get(trip.id) ?? emptySession();
        retained.set(trip.id, session);
        startPoll();
        return refresh('load');
      }
      publish();
      return Promise.resolve(false);
    },
    refresh() { interruptPoll(); return refresh(); },
    refreshConflict() {
      if (!session.conflict) return Promise.resolve(false);
      interruptPoll();
      return refresh('conflict');
    },
    resume: () => isVisible() ? refresh('poll') : Promise.resolve(false),
    selectDay(date) {
      if (!ledger || !tripDates(ledger).includes(date) || session.day === date) return;
      session.day = date;
      for (const scope of ['schedule', 'expense']) {
        const form = session.forms[scope];
        if (!form.id && form.base === null) session.forms[scope] = formFromLedger(scope, ledger, date);
      }
      publish();
    },
    selectSettlementDate(date) {
      if (!ledger?.settlement?.days.some(row => row.date === date) || state.settlementDate === date) return;
      session.settlementDate = date;
      session.settlementReview = null;
      publish();
    },
    setFilter(field, value) {
      if (!ledger || !Object.hasOwn(session.filters, field)) return;
      session.filters[field] = value;
      publish();
    },
    editSchedule: id => edit('schedule', id),
    applyPlace(candidate) {
      if (!allowed('schedule') || request || session.pending || session.conflict || !candidate ||
          typeof candidate.name !== 'string' || !candidate.name.trim() || [...candidate.name].length > 200) return false;
      let ref;
      try { ref = parsePlaceReference(candidate.ref); } catch { return false; }
      if (!ref) return false;
      const form = session.forms.schedule;
      session.forms.schedule = {...form, base: form.base ?? ledger.revision,
        fields: {...form.fields, place: ref.provider==='google'?form.fields.place:candidate.name, placeRef: ref}};
      error = null;
      status = '선택한 장소를 일정 입력에 적용했습니다. 저장 버튼으로 확인해 주세요.';
      publish();
      return true;
    },
    applyDraft(draft) {
      const scope = draft?.kind;
      if (!['schedule', 'expense'].includes(scope) || !allowed(scope) || request || session.pending || session.conflict ||
          draft.tripId !== trip.id || draft.baseRevision !== ledger.revision || !draft.fields ||
          typeof draft.fields !== 'object' || Array.isArray(draft.fields)) return false;
      const form = session.forms[scope];
      if (form.id || form.base !== null) return false;
      const fields = structuredClone(form.fields);
      const keys = scope === 'schedule'
        ? ['date','startTime','endTime','title','place','budgetKrw','placeRef']
        : ['title','itineraryId','occurredLocal','currency','amount','payerId','splitIds','refreshRate'];
      for (const key of keys) {
        if (!Object.hasOwn(draft.fields,key)) continue;
        const value = draft.fields[key];
        if (key === 'placeRef') {
          try { fields[key] = parsePlaceReference(value); } catch { return false; }
        } else if (key === 'splitIds') {
          if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) return false;
          fields[key] = [...value];
        } else if (key === 'budgetKrw') {
          if (!Number.isSafeInteger(value) || value < 0) return false;
          fields[key] = String(value);
        } else if (key === 'refreshRate') {
          if (typeof value !== 'boolean') return false;
          fields[key] = value;
        } else {
          if (typeof value !== 'string' && !(key === 'itineraryId' && value === null)) return false;
          fields[key] = value;
        }
      }
      // Missing payment/split information must remain visibly unselected.
      if (scope === 'expense') {
        if (!Object.hasOwn(draft.fields,'occurredLocal')) fields.occurredLocal = '';
        if (!Object.hasOwn(draft.fields,'amount')) fields.amount = '';
        if (!Object.hasOwn(draft.fields,'currency')) fields.currency = '';
        if (!Object.hasOwn(draft.fields,'payerId')) fields.payerId = '';
        if (!Object.hasOwn(draft.fields,'splitIds')) fields.splitIds = [];
      } else {
        if (!Object.hasOwn(draft.fields,'date')) fields.date = '';
        if (!Object.hasOwn(draft.fields,'budgetKrw')) fields.budgetKrw = '';
      }
      session.forms[scope] = {...form, fields, base: ledger.revision};
      error = null;
      status = '메시지 초안을 입력란에 적용했습니다. 누락한 내용을 확인한 뒤 저장해 주세요.';
      publish();
      return true;
    },
    editExpense: id => edit('expense', id),
    addExpenseFor: id => edit('expense', null, id),
    setScheduleField: (field, value) => setField('schedule', field, value),
    setExpenseField: (field, value) => setField('expense', field, value),
    setFxField: (field, value) => setField('fx', field, value),
    setPaymentField: (field, value) => setField('payment', field, value),
    saveSchedule: () => save('schedule'),
    saveExpense: () => save('expense'),
    saveFx: () => save('fx'),
    savePayment: () => save('payment'),
    changeSettlement,
    reviewSettlement(type, date) {
      if (!allowed('settlement') || session.pending || session.conflict || type !== settlementAction(ledger.settlement, date)) return;
      session.settlementReview = {type, date, revision: ledger.revision};
      publish();
    },
    closeSettlementReview() {
      session.settlementReview = null;
      publish();
    },
    confirmSettlement() {
      const review = state.settlementReview;
      return review && !review.stale ? changeSettlement(review.type, review.date, review.revision) : Promise.resolve(false);
    },
    changePayment(type, id, expectedPaymentRevision) {
      interruptPoll();
      if (request || !allowed('payment') || session.pending || session.conflict) return Promise.resolve(false);
      const row = ledger.settlement.payments.find(row => row.id === id);
      if (!row || row.revision !== expectedPaymentRevision || type !== paymentAction(ledger, row)) return Promise.resolve(false);
      return write({type, id, expectedPaymentRevision}, ledger.revision);
    },
    moveSchedule(id, offset) {
      interruptPoll();
      if (request || !allowed('schedule') || session.pending || session.conflict || ![-1, 1].includes(offset)) return Promise.resolve(false);
      const ids = dayItems(ledger, session.day).map(row => row.id);
      const index = ids.indexOf(id);
      const to = index + offset;
      if (index < 0 || to < 0 || to >= ids.length) return Promise.resolve(false);
      [ids[index], ids[to]] = [ids[to], ids[index]];
      return write({type: 'schedule.reorder', date: session.day, ids}, ledger.revision);
    },
    confirmCancel(scope, id) {
      if (id === null) {session.confirm = null; publish(); return;}
      if (!['schedule', 'expense'].includes(scope) || !allowed(scope) || session.pending || session.conflict) return;
      const row = (scope === 'schedule' ? ledger.items : ledger.expenses).find(row => row.id === id);
      if (row?.status !== 'active') return;
      session.confirm = {scope, id, title: row.title, revision: ledger.revision};
      publish();
    },
    cancelConfirmed() {
      interruptPoll();
      if (request || !session.confirm || session.pending || session.conflict) return Promise.resolve(false);
      const {scope, id, revision} = session.confirm;
      return write({type: scope + '.cancel', id}, revision);
    },
    retryPending() {
      interruptPoll();
      return session.pending ? send(session.pending) : Promise.resolve(false);
    },
    discardPending() {
      if (request === 'write') return;
      session.pending = session.conflict = session.confirm = session.settlementReview = null;
      error = null;
      status = '보존한 요청을 닫았습니다. 편집 중인 입력은 그대로 남아 있습니다.';
      publish();
    },
    reapply() {
      interruptPoll();
      const op = session.conflict;
      if (request || !op || op.revision === null || needsFreshAction(scopeOf(op.command.type)) ||
        !canWriteType(role(), op.command.type)) return Promise.resolve(false);
      const scope = scopeOf(op.command.type);
      let command = op.command;
      if (op.form) {
        const result = draftCommand(scope, session.forms[scope], ledger);
        if (result.error) { error = result.error; publish(); return Promise.resolve(false); }
        command = result.command;
      } else if (command.type === 'schedule.reorder' && !same(command.ids, dayItems(ledger, command.date).map(row => row.id))) {
        error = validation(scope, undefined, '일정 목록이 바뀌었습니다. 이 요청을 닫고 현재 목록에서 순서를 바꿔 주세요.');
        publish();
        return Promise.resolve(false);
      } else if (command.type.endsWith('.cancel') && !(scope === 'schedule' ? ledger.items : ledger.expenses)
        .some(row => row.id === command.id && row.status === 'active')) {
        error = validation(scope, undefined, '이미 취소되었거나 조회할 수 없는 기록입니다.');
        publish();
        return Promise.resolve(false);
      }
      return write(command, op.revision, op.form ? session.forms[scope] : null);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      clearAccount();
      publish();
    },
  };
  publish();
  return controller;
}

export function createTravelRefreshQueue(travel) {
  let queued = null, inFlight = null, scheduled = false, destroyed = false;
  function isCurrent(context) {
    return context.account === travel.state.accountId && context.tripId === travel.state.selectedTripId;
  }
  function sync() {
    if (destroyed) return;
    if (queued && !isCurrent(queued)) queued = null;
    if (inFlight && !isCurrent(inFlight)) inFlight = null;
    if (!queued || scheduled || travel.state.busy) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!queued) return;
      if (!isCurrent(queued)) { queued = null; return; }
      if (travel.state.busy) return;
      const pending = queued;
      queued = null;
      inFlight = pending;
      void travel.refresh().finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    });
  }
  return {
    request(account, tripId) {
      const context = {account, tripId};
      if (destroyed || !isCurrent(context) || (inFlight?.account === account && inFlight.tripId === tripId)) return;
      queued = context;
      sync();
    },
    sync,
    destroy() { destroyed = true; queued = inFlight = null; },
  };
}

// Signals only carry a revision. Existing refresh paths remain responsible for data and identity.
export function createTripChangesController(api, {
  onChanged = () => {}, onUnavailable = () => {},
  isVisible = () => !globalThis.document?.hidden,
  isOnline = () => globalThis.navigator?.onLine !== false,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
} = {}) {
  const validId = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) &&
    value !== '00000000-0000-0000-0000-000000000000';
  let enabled = false, destroyed = false, context = null, cursor = 0;
  let generation = 0, request = null, timer = null;
  const active = () => !destroyed && enabled && context !== null && isVisible() && isOnline();
  function cancel() {
    ++generation;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (request) {
      clearTimer(request.deadline);
      request.controller.abort();
      request = null;
    }
  }
  function schedule(ms) {
    if (!active() || timer !== null) return;
    timer = setTimer(() => {timer = null; resume();}, ms);
    timer?.unref?.();
  }
  function current(pending) {
    return active() && request === pending && generation === pending.generation;
  }
  function complete(pending, result, error) {
    if (!current(pending)) return;
    clearTimer(pending.deadline);
    request = null;
    if (error) {
      schedule(error.status === 429 ? 15000 : 5000);
      if ([401,403,404,412].includes(error.status)) onUnavailable(pending.accountId, pending.tripId);
      return;
    }
    // Defend against malformed adapters as well as malformed HTTP responses.
    if (!result || result.tripId !== pending.tripId || !Number.isSafeInteger(result.revision) || result.revision < pending.after) {
      schedule(5000);
      return;
    }
    const changed = result.revision > cursor;
    cursor = Math.max(cursor, result.revision);
    schedule(100);
    if (changed) onChanged(pending.accountId, pending.tripId, cursor);
  }
  function resume() {
    if (!active()) { cancel(); return; }
    if (request || timer !== null) return;
    const controller = new AbortController();
    const pending = {...context, after: cursor, generation, controller, deadline: null};
    request = pending;
    pending.deadline = setTimer(() => {
      if (!current(pending)) return;
      cancel();
      schedule(5000);
    }, 30000);
    pending.deadline?.unref?.();
    try {
      Promise.resolve(api.waitForChanges(pending.tripId, pending.after, pending.accountId, controller.signal))
        .then(result => complete(pending, result), error => complete(pending, null, error ?? new Error()));
    } catch (error) { complete(pending, null, error ?? new Error()); }
  }
  return {
    configure(value) {
      if (destroyed || enabled === (value === true)) return;
      cancel(); enabled = value === true; resume();
    },
    setContext(value) {
      if (destroyed) return;
      const valid = validId(value?.accountId) && validId(value?.tripId) && Number.isSafeInteger(value?.revision) && value.revision > 0;
      const next = valid ? {accountId: value.accountId, tripId: value.tripId} : null;
      if (context?.accountId === next?.accountId && context?.tripId === next?.tripId && (!next || value.revision <= cursor)) return;
      cancel(); context = next; cursor = next ? value.revision : 0; resume();
    },
    resume,
    destroy() { if (destroyed) return; destroyed = true; cancel(); context = null; },
  };
}
