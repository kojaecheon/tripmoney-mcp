export const STORAGE_KEY = 'tripmoney.experience.v1';
export const REASONS = Object.freeze({ amount: '금액을 다시 확인해 주세요', split: '분담 대상을 확인해 주세요', payer: '결제자를 확인해 주세요' });
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));

function cents(value) {
  const text = String(value).trim();
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(text)) fail('금액은 양수이며 소수 둘째 자리까지만 입력해 주세요.');
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (result < 1 || result > 100_000_000) fail('샘플 금액은 0보다 크고 1,000,000 이하여야 합니다.');
  return result;
}

export function baseAmount(expense) {
  return Math.floor((expense.amountCents * expense.rateMilli + 50_000) / 100_000);
}

function emptyDecisions(members) {
  return Object.fromEntries(members.filter(m => m.role !== 'organizer').map(m => [m.id, { status: 'not_responded', reason: null, at: null }]));
}

export function createState(seed) {
  const members = seed.members.map(({ id, alias, role }) => ({ id, alias, role }));
  return {
    schema: 1, dataClass: 'demo', sampleId: seed.trip.id,
    trip: { name: seed.trip.name, organizerId: seed.trip.organizer_id }, members,
    expenses: seed.expenses.map(e => ({ id: e.id, title: e.title, currency: e.currency,
      amountCents: cents(e.amount), rateMilli: Math.round(e.rate * 1000), payerId: e.payer_id, splitIds: [...e.split_ids] })),
    version: 1, organizerApprovedAt: null, decisions: emptyDecisions(members),
    reviewClosedAt: null, qaAt: null, lockedAt: null, shareRevoked: false, history: [],
  };
}

export function calculate(state) {
  const paid = Object.fromEntries(state.members.map(m => [m.id, 0]));
  const owed = { ...paid };
  let total = 0;
  for (const e of state.expenses) {
    const amount = baseAmount(e);
    total += amount;
    paid[e.payerId] += amount;
    const splitIds = state.members.filter(m => e.splitIds.includes(m.id)).map(m => m.id);
    if (!splitIds.length || splitIds.length !== e.splitIds.length) fail('분담 대상이 올바르지 않습니다. 샘플을 초기화해 주세요.');
    const share = Math.floor(amount / splitIds.length);
    const remainder = amount % splitIds.length;
    splitIds.forEach((id, i) => { owed[id] += share + (i < remainder ? 1 : 0); });
  }
  const members = state.members.map(m => ({ ...m, paid: paid[m.id], owed: owed[m.id], net: paid[m.id] - owed[m.id] }));
  const debtors = members.filter(m => m.net < 0).map(m => ({ id: m.id, alias: m.alias, amount: -m.net })).sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id));
  const creditors = members.filter(m => m.net > 0).map(m => ({ id: m.id, alias: m.alias, amount: m.net })).sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id));
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    transfers.push({ from_id: debtors[i].id, from: debtors[i].alias, to_id: creditors[j].id, to: creditors[j].alias, amount });
    debtors[i].amount -= amount; creditors[j].amount -= amount;
    if (!debtors[i].amount) i++;
    if (!creditors[j].amount) j++;
  }
  if (!Number.isSafeInteger(total) || members.reduce((sum, m) => sum + m.net, 0) !== 0) fail('정산 합계 검증에 실패했습니다. 샘플을 초기화해 주세요.');
  return { total, members, transfers };
}

function checkVersion(state, version) {
  if (state.version !== version) fail('정산 버전이 변경되었습니다. 최신 화면에서 다시 시도해 주세요.');
}
function editable(state, version) {
  checkVersion(state, version);
  if (state.lockedAt) fail('잠금 완료된 샘플은 수정할 수 없습니다. 초기화 후 다시 체험해 주세요.');
}
function record(state, action, at, target = null) {
  if (!iso(at)) fail('처리 시각이 올바르지 않습니다.');
  state.history = [...state.history, { action, at, version: state.version, target }].slice(-30);
  return state;
}

export function updateExpense(state, id, patch, version, at) {
  editable(state, version);
  const next = clone(state), expense = next.expenses.find(e => e.id === id);
  if (!expense) fail('샘플 지출을 찾을 수 없습니다.');
  const memberIds = new Set(next.members.map(m => m.id));
  if (!memberIds.has(patch.payerId)) fail('샘플 멤버 중 결제자를 선택해 주세요.');
  if (!Array.isArray(patch.splitIds) || !patch.splitIds.length || new Set(patch.splitIds).size !== patch.splitIds.length || patch.splitIds.some(id => !memberIds.has(id))) fail('분담 대상은 중복 없이 한 명 이상 선택해 주세요.');
  expense.amountCents = cents(patch.amount);
  if (!baseAmount(expense)) fail('원화 환산액이 1원 이상이어야 합니다.');
  expense.payerId = patch.payerId;
  expense.splitIds = next.members.filter(m => patch.splitIds.includes(m.id)).map(m => m.id);
  const original = state.expenses.find(e => e.id === id);
  if (expense.amountCents === original.amountCents && expense.payerId === original.payerId && expense.splitIds.length === original.splitIds.length && expense.splitIds.every(memberId => original.splitIds.includes(memberId))) return clone(state);
  next.version++;
  next.organizerApprovedAt = next.reviewClosedAt = next.qaAt = next.lockedAt = null;
  next.decisions = emptyDecisions(next.members);
  next.shareRevoked = false;
  calculate(next);
  return record(next, 'expense_updated', at, id);
}

export function approveOrganizer(state, version, at) {
  editable(state, version);
  if (state.organizerApprovedAt) return clone(state);
  calculate(state);
  const next = clone(state);
  next.organizerApprovedAt = at;
  return record(next, 'organizer_approved', at);
}

function participantOpen(state, id, version) {
  checkVersion(state, version);
  if (!state.organizerApprovedAt) fail('총무 승인 후 참여자 검토를 시작할 수 있습니다.');
  if (state.reviewClosedAt || state.lockedAt) fail('참여자 검토가 종료되었습니다.');
  if (state.shareRevoked) fail('공유 시연이 종료되었습니다.');
  if (!Object.hasOwn(state.decisions, id)) fail('샘플 참여자를 선택해 주세요.');
}

export function decideParticipant(state, id, status, reason, version, at) {
  participantOpen(state, id, version);
  if (!['approved', 'objection'].includes(status)) fail('승인 또는 이의를 선택해 주세요.');
  if (status === 'objection' && !Object.hasOwn(REASONS, reason)) fail('샘플 이의 사유를 선택해 주세요.');
  const next = clone(state);
  next.decisions[id] = { status, reason: status === 'objection' ? reason : null, at };
  return record(next, status === 'approved' ? 'participant_approved' : 'participant_objected', at, id);
}

export function withdrawObjection(state, id, version, at) {
  participantOpen(state, id, version);
  if (state.decisions[id].status !== 'objection') fail('철회할 이의가 없습니다.');
  const next = clone(state);
  next.decisions[id] = { status: 'not_responded', reason: null, at: null };
  return record(next, 'objection_withdrawn', at, id);
}

export function markQa(state, version, at) {
  editable(state, version);
  if (state.qaAt) return clone(state);
  calculate(state);
  const next = clone(state); next.qaAt = at;
  return record(next, 'qa_confirmed', at);
}

export function closeReview(state, version, at) {
  editable(state, version);
  if (!state.organizerApprovedAt) fail('총무 승인 후 검토창을 종료할 수 있습니다.');
  if (Object.values(state.decisions).some(d => d.status === 'objection')) fail('미해결 이의를 철회하거나 새 버전으로 수정한 뒤 종료해 주세요.');
  if (state.reviewClosedAt) return clone(state);
  const next = clone(state); next.reviewClosedAt = at;
  return record(next, 'review_closed', at);
}

export function finalize(state, version, at) {
  editable(state, version);
  if (!state.organizerApprovedAt || !state.reviewClosedAt || !state.qaAt || Object.values(state.decisions).some(d => d.status === 'objection')) fail('총무 승인, 검토창 종료, 이의 해결, 내부 검수를 먼저 완료해 주세요.');
  calculate(state);
  const next = clone(state); next.lockedAt = at;
  return record(next, 'finalized', at);
}

export function revokeShare(state, at) {
  const next = clone(state); next.shareRevoked = true;
  return record(next, 'share_revoked', at);
}

export function participantResult(state, id) {
  if (state.shareRevoked || !state.organizerApprovedAt) return null;
  if (!Object.hasOwn(state.decisions, id)) fail('샘플 참여자를 선택해 주세요.');
  const result = calculate(state);
  return { member: result.members.find(m => m.id === id), transfers: result.transfers.filter(t => t.from_id === id || t.to_id === id), decision: clone(state.decisions[id]) };
}

function sameKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...expected].sort().join('|');
}

function validStored(state, baseline) {
  if (!sameKeys(state, Object.keys(baseline)) || state.schema !== 1 || state.dataClass !== 'demo' || state.sampleId !== baseline.sampleId || JSON.stringify(state.trip) !== JSON.stringify(baseline.trip) || JSON.stringify(state.members) !== JSON.stringify(baseline.members) || !Number.isSafeInteger(state.version) || state.version < 1 || typeof state.shareRevoked !== 'boolean') return false;
  if (!Array.isArray(state.expenses) || state.expenses.length !== baseline.expenses.length) return false;
  const ids = new Set(state.members.map(m => m.id));
  for (let i = 0; i < baseline.expenses.length; i++) {
    const e = state.expenses[i], original = baseline.expenses[i];
    if (!sameKeys(e, Object.keys(original)) || ['id', 'title', 'currency', 'rateMilli'].some(k => e[k] !== original[k]) || !Number.isInteger(e.amountCents) || e.amountCents < 1 || e.amountCents > 100_000_000 || !baseAmount(e) || !ids.has(e.payerId) || !Array.isArray(e.splitIds) || !e.splitIds.length || new Set(e.splitIds).size !== e.splitIds.length || e.splitIds.some(id => !ids.has(id))) return false;
  }
  for (const key of ['organizerApprovedAt', 'reviewClosedAt', 'qaAt', 'lockedAt']) if (state[key] !== null && !iso(state[key])) return false;
  if (!sameKeys(state.decisions, Object.keys(baseline.decisions))) return false;
  for (const d of Object.values(state.decisions)) {
    if (!sameKeys(d, ['status', 'reason', 'at']) || !['not_responded', 'approved', 'objection'].includes(d.status)) return false;
    if (d.status === 'not_responded' ? d.reason !== null || d.at !== null : !iso(d.at)) return false;
    if (d.status === 'objection' ? !Object.hasOwn(REASONS, d.reason) : d.reason !== null) return false;
  }
  if (!state.organizerApprovedAt && (state.reviewClosedAt || state.lockedAt || Object.values(state.decisions).some(d => d.status !== 'not_responded'))) return false;
  if ((state.reviewClosedAt || state.lockedAt) && Object.values(state.decisions).some(d => d.status === 'objection')) return false;
  if (state.lockedAt && (!state.reviewClosedAt || !state.qaAt)) return false;
  const actions = ['expense_updated', 'organizer_approved', 'participant_approved', 'participant_objected', 'objection_withdrawn', 'qa_confirmed', 'review_closed', 'finalized', 'share_revoked'];
  if (!Array.isArray(state.history) || state.history.length > 30 || state.history.some(h => !sameKeys(h, ['action', 'at', 'version', 'target']) || !actions.includes(h.action) || !iso(h.at) || !Number.isSafeInteger(h.version) || h.version < 1 || h.version > state.version || (h.target !== null && !ids.has(h.target) && !baseline.expenses.some(e => e.id === h.target)))) return false;
  try { calculate(state); return true; } catch { return false; }
}

export function createStore(seed, storage) {
  const baseline = createState(seed);
  let memory = clone(baseline), persistent = Boolean(storage), recovered = false;
  return {
    load() {
      if (persistent) {
        try {
          const raw = storage.getItem(STORAGE_KEY);
          if (raw !== null) {
            const parsed = JSON.parse(raw);
            if (!validStored(parsed, baseline)) throw new Error('invalid_demo_state');
            memory = parsed;
          }
        } catch (error) {
          if (error instanceof SyntaxError || error.message === 'invalid_demo_state') {
            recovered = true; memory = clone(baseline);
            try { storage.removeItem(STORAGE_KEY); } catch { persistent = false; }
          } else persistent = false;
        }
      }
      return clone(memory);
    },
    save(state) {
      if (!validStored(state, baseline)) fail('올바른 합성 샘플 상태만 저장할 수 있습니다.');
      memory = clone(state);
      if (persistent) {
        try { storage.setItem(STORAGE_KEY, JSON.stringify(memory)); return true; } catch { persistent = false; }
      }
      return false;
    },
    reset() {
      memory = clone(baseline); recovered = false;
      if (persistent) try { storage.setItem(STORAGE_KEY, JSON.stringify(memory)); } catch { persistent = false; }
      return clone(memory);
    },
    status() { return { persistent, recovered }; },
  };
}
