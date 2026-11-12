import { focusAfterAction } from '../travel/view.mjs';

export const scheduleLabels = {
  date: '일정 날짜', startTime: '시작 시각', endTime: '종료 시각',
  title: '일정 이름', place: '장소 메모', budgetKrw: '일정 예산 (원)',
};
export const expenseLabels = {
  title: '경비 이름', occurredLocal: '지출 일시 (여행지 시간)', itineraryId: '연결할 일정',
  currency: '통화', amount: '원통화 금액', payerId: '결제자', splitIds: '분담자', refreshRate: '현재 환율 적용',
};
export const fxLabels = {source: '환율 출처', rateMilli: '1 THB당 원화 (원)'};
export const paymentLabels = {toMemberId: '받는 동행자', amountKrw: '보낸 금액 (원)'};
export const actionLabels = {
  'schedule.create': '일정 추가', 'schedule.update': '일정 수정', 'schedule.cancel': '일정 취소',
  'schedule.adopt': '추천 일정 선택 저장',
  'schedule.reorder': '일정 순서 변경', 'expense.create': '경비 등록', 'expense.update': '경비 수정',
  'expense.cancel': '경비 취소', 'fx.update': '환율 변경',
  'settlement.finalize': '정산 확정', 'settlement.reopen': '정산 재개',
  'payment.report': '지급 기록', 'payment.confirm': '받은 지급 확인',
  'payment.requestVoid': '지급 취소 요청', 'payment.confirmVoid': '지급 취소 확인',
  create: '여행 생성', update: '여행 설정 변경', manage: '동행자 변경',
  issue: '초대 발급', accept: '여행 참여', revoke: '초대 폐기',
};
export const scopeOf = type => type.split('.')[0];
export const blankSchedule = (date = '') => ({date, startTime: '', endTime: '', title: '', place: '', budgetKrw: '0'});
export const blankExpense = (date = '', me = '') => ({
  title: '', itineraryId: null, occurredLocal: date ? date + 'T12:00' : '', currency: 'KRW', amount: '',
  payerId: me, splitIds: me ? [me] : [], refreshRate: false,
});
export const fxFields = (fx = {source: 'demo', rateMilli: 38600}) => ({
  source: fx.source, rateMilli: String(fx.rateMilli / 1000),
});
export const blankPayment = () => ({toMemberId: '', amountKrw: ''});
export const activeSnapshot = (settlement, date) =>
  settlement.snapshots.find(row => row.date === date && row.reopenedAt === null);
export function settlementAction(settlement, date) {
  if (!settlement || (date !== null && (settlement.mode !== 'daily' || date > settlement.today ||
    !settlement.days.some(row => row.date === date) || activeSnapshot(settlement, null)))) return null;
  return activeSnapshot(settlement, date) ? 'settlement.reopen' : 'settlement.finalize';
}
const activeMe = ledger => ledger.members.find(row => row.active && row.isMe)?.id;
export const paymentRecipients = ledger => ledger.members.filter(row => row.active && !row.isMe && row.role !== 'viewer');
export function paymentAction(ledger, payment) {
  const me = activeMe(ledger);
  if (!payment || (me !== payment.fromMemberId && me !== payment.toMemberId)) return null;
  if (payment.status === 'reported') return me === payment.fromMemberId ? 'payment.requestVoid' : 'payment.confirm';
  if (payment.status === 'confirmed') return 'payment.requestVoid';
  if (payment.status === 'void_requested' && payment.voidRequestedByMemberId !== me) return 'payment.confirmVoid';
  return null;
}
export const scheduleFields = row => ({
  date: row.date, startTime: row.startTime, endTime: row.endTime, title: row.title, place: row.place, budgetKrw: String(row.budgetKrw),
  ...(Object.hasOwn(row, 'placeRef') ? {placeRef: row.placeRef ? {...row.placeRef} : null} : {}),
});
export const expenseFields = row => ({
  title: row.title, occurredLocal: row.occurredLocal, itineraryId: row.itineraryId, currency: row.currency,
  amount: String(row.amountCents / 100), payerId: row.payerId, splitIds: [...row.splitIds], refreshRate: false,
});
export const dayItems = (ledger, date) => ledger.items.filter(item => item.date === date && item.status === 'active')
  .sort((a, b) => a.order - b.order);
export function tripDates(ledger) {
  const end = Date.parse(ledger.endDate + 'T00:00:00Z');
  const dates = [];
  for (let ms = Date.parse(ledger.startDate + 'T00:00:00Z'); ms <= end && dates.length < 14; ms += 86400000) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}
export const dayLabel = date => new Intl.DateTimeFormat('ko-KR', {dateStyle: 'full', timeZone: 'UTC'})
  .format(new Date(date + 'T00:00:00Z'));
const seoulClock = new Intl.DateTimeFormat('ko-KR', {dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul'});
export const seoulTime = value => seoulClock.format(new Date(value));
export const memberName = (ledger, id) => {
  const member = ledger.members.find(row => row.id === id);
  return member ? member.alias + (member.active ? '' : ' (참여 해제)') : '동행자';
};
export const itemName = (ledger, id) => {
  if (!id) return '미지정 공통 경비';
  const item = ledger.items.find(row => row.id === id);
  return item ? item.title + (item.status === 'cancelled' ? ' (취소)' : '') : '이전 일정';
};
export const changeLabel = (ledger, row) =>
  `마지막 변경 · ${memberName(ledger, row.updatedByMemberId)} · ${seoulTime(row.updatedAt)} (한국 시간)`;
const number = new Intl.NumberFormat('ko-KR');
export const won = value => number.format(value) + '원';
export const balance = value => value < 0 ? won(-value) + ' 초과' : won(value);
export const fxName = source => ({unit: '원화 기준', manual: '수동 환율', demo: '체험 환율'})[source];

export function validation(scope, field, message) { return {code: 'validation', scope, field, message}; }
export function draftCommand(scope, form, ledger) {
  const {fields, id} = form;
  const err = (field, message) => ({error: validation(scope, field, message)});
  if (scope === 'payment') {
    if (!activeMe(ledger) || !paymentRecipients(ledger).some(row => row.id === fields.toMemberId)) {
      return err('toMemberId', '받는 동행자를 선택해 주세요.');
    }
    const amount = fields.amountKrw.trim();
    const amountKrw = Number(amount);
    if (!/^\d+$/.test(amount) || amountKrw < 1 || amountKrw > 1_000_000_000_000) {
      return err('amountKrw', '보낸 금액을 1원부터 1조 원까지 원 단위로 입력해 주세요.');
    }
    return {command: {type: 'payment.report', toMemberId: fields.toMemberId, amountKrw}};
  }
  if (scope === 'fx') {
    if (fields.source === 'demo') return {command: {type: 'fx.update', source: 'demo', rateMilli: 38600}};
    const rate = fields.rateMilli.trim();
    if (!/^\d+(\.\d{1,3})?$/.test(rate) || Number(rate) <= 0 || Number(rate) > 1_000_000) {
      return err('rateMilli', '환율은 0원 초과 1,000,000원 이하로 입력해 주세요. 소수 셋째 자리까지 입력할 수 있습니다.');
    }
    return {command: {type: 'fx.update', source: 'manual', rateMilli: Math.round(Number(rate) * 1000)}};
  }
  const rows = scope === 'schedule' ? ledger.items : ledger.expenses;
  const original = rows.find(row => row.id === id);
  if (id && original?.status !== 'active') return err(undefined, '이미 취소되었거나 조회할 수 없는 기록입니다.');
  const title = fields.title.trim();
  if (!title || [...title].length > 100 || /\p{Cc}/u.test(fields.title)) return err('title', '이름은 1자부터 100자까지 입력해 주세요.');
  const type = scope + (id ? '.update' : '.create');
  const target = id ? {id} : {};
  const dates = tripDates(ledger);
  if (scope === 'schedule') {
    if (!dates.includes(fields.date)) return err('date', '여행 기간 안에서 날짜를 선택해 주세요.');
    if (!fields.startTime && fields.endTime) return err('startTime', '시작 시각도 입력해 주세요.');
    if ((fields.startTime && !fields.endTime) || fields.endTime < fields.startTime) {
      return err('endTime', '종료 시각을 시작 시각과 같거나 이후로 입력해 주세요.');
    }
    const budgetKrw = Number(fields.budgetKrw);
    if (!/^\d+$/.test(fields.budgetKrw) || !Number.isSafeInteger(budgetKrw)) return err('budgetKrw', '예산은 0원 이상 정수로 입력해 주세요.');
    if ([...fields.place.trim()].length > 200 || /\p{Cc}/u.test(fields.place)) return err('place', '장소 메모는 200자까지 입력해 주세요.');
    return {command: {type, ...target, input: {...fields, title, place: fields.place.trim(), budgetKrw}}};
  }
  if (!/^\d{4}-\d\d-\d\dT([01]\d|2[0-3]):[0-5]\d$/.test(fields.occurredLocal) || !dates.includes(fields.occurredLocal.slice(0, 10))) {
    return err('occurredLocal', '여행 기간 안에서 지출 날짜와 시각을 입력해 주세요.');
  }
  const amount = fields.amount.trim();
  if (!['KRW','THB'].includes(fields.currency)) return err('currency', '통화를 선택해 주세요.');
  const amountPattern = fields.currency === 'KRW' ? /^\d+$/ : /^\d+(\.\d{1,2})?$/;
  if (!amountPattern.test(amount) || Number(amount) <= 0 || Number(amount) > 1_000_000) {
    return err('amount', `금액은 0 초과 1,000,000 이하로 입력해 주세요. ${fields.currency === 'KRW' ? '원화는 정수로 입력해 주세요.' : '소수 둘째 자리까지 입력할 수 있습니다.'}`);
  }
  const active = id => ledger.members.some(member => member.id === id && member.active);
  if (!active(fields.payerId) && fields.payerId !== original?.payerId) return err('payerId', '참여 중인 결제자를 선택해 주세요.');
  if (!fields.splitIds.length || fields.splitIds.length > 8 || fields.splitIds.some(id => !active(id) && !original?.splitIds.includes(id))) {
    return err('splitIds', '참여 중인 분담자를 1명부터 8명까지 선택해 주세요.');
  }
  if (fields.itineraryId && fields.itineraryId !== original?.itineraryId && !ledger.items.some(item => item.id === fields.itineraryId && item.status === 'active')) {
    return err('itineraryId', '진행 중인 일정이나 미지정 공통 경비를 선택해 주세요.');
  }
  return {command: {type, ...target, input: {...fields, title, amount}}};
}

export function field(prefix, key, label, control, help = '') {
  const id = `ledger-${prefix}-${key}`;
  const describedBy = `${id}-error${help ? ` ${id}-help` : ''}`;
  const attrs = `id="${id}" name="${key}" aria-describedby="${describedBy}"`;
  return `<div class="field"><label for="${id}">${label}</label>${control.replace('@field', attrs)}
    ${help ? `<p class="help" id="${id}-help">${help}</p>` : ''}
    <p class="field-error" id="${id}-error" hidden></p></div>`;
}
export function element(doc, tag, className = '', value = '') {
  const node = doc.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}
export function button(doc, value, action, onClick) {
  const node = element(doc, 'button', 'secondary', value);
  node.type = 'button';
  node.dataset.ledgerAction = action;
  node.setAttribute('aria-describedby', 'ledger-write-help');
  node.addEventListener('click', onClick);
  return node;
}
export function writeText(node, value) { if (node.textContent !== value) node.textContent = value; }
export function writeValue(node, value) { if (node.value !== String(value)) node.value = String(value); }
export function reconcile(parent, nodes, rows, make, update, focusFallback) {
  const doc = focusFallback && parent.ownerDocument;
  const active = doc?.activeElement;
  const focused = active && parent.contains(active) ? active : null;
  const fallback = focused && focusFallback(focused);
  const keys = new Set(rows.map(row => row.id));
  for (const [id, node] of nodes) {
    if (keys.has(id)) continue;
    node.remove();
    nodes.delete(id);
  }
  for (const [index, row] of rows.entries()) {
    let node = nodes.get(row.id);
    if (!node) { node = make(row); nodes.set(row.id, node); }
    update(node, row, index);
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
  }
  if (fallback?.isConnected) focusAfterAction(doc, focused, [fallback]);
}
export function renderOptions(select, rows, value) {
  if (!select.ledgerOptions) select.ledgerOptions = new Map();
  reconcile(select, select.ledgerOptions, rows, row => {
    const option = element(select.ownerDocument, 'option');
    option.value = row.id;
    return option;
  }, (option, row) => writeText(option, row.label));
  writeValue(select, value);
}
export function renderField(input, message, fieldError, value) {
  if (input.type === 'checkbox') input.checked = value;
  else if (value !== undefined) writeValue(input, value ?? '');
  input.setAttribute('aria-invalid', String(Boolean(message)));
  writeText(fieldError, message);
  fieldError.hidden = !message;
}
export const issueFor = (state, scope, field) => state.error?.scope === scope && state.error.field === field ? state.error.message : '';
export const writesLocked = state => Boolean(state.pendingKind || state.conflict || state.busy);
