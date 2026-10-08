import * as M from './model.mjs';
import { renderView } from './view.mjs';

const seed = globalThis.TM_DATA;
let storage;
try { storage = globalThis.localStorage; } catch { storage = null; }
const store = M.createStore(seed, storage);
let state = store.load();
const params = new URLSearchParams(location.search);
let role = ['operator', 'organizer', 'participant'].includes(params.get('view')) ? params.get('view') : 'operator';
let memberId = state.members.some(m => m.id === params.get('member') && m.role !== 'organizer') ? params.get('member') : 'm_jieun';
let selectedId = state.expenses[0].id;
let expenseDraftChanged = false;
const main = document.querySelector('#main');
const feedback = document.querySelector('#feedback');

function message(text, error = false) {
  feedback.textContent = text;
  feedback.classList.toggle('error', error);
  feedback.setAttribute('role', error ? 'alert' : 'status');
}

function render(focusId) {
  expenseDraftChanged = false;
  main.innerHTML = renderView(state, role, memberId, selectedId);
  document.querySelectorAll('[data-role]').forEach(button => {
    if (button.dataset.role === role) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  const status = store.status();
  document.querySelector('#save-status').textContent = status.persistent ? '브라우저에 샘플 저장' : '메모리 모드 · 새로고침 시 초기화';
  if (focusId) document.getElementById(focusId)?.focus();
}

function navigate(nextRole) {
  role = nextRole;
  const url = new URL(location.href);
  url.searchParams.set('view', role);
  if (role === 'participant') url.searchParams.set('member', memberId); else url.searchParams.delete('member');
  history.replaceState(null, '', url);
  state = store.load();
  message(''); render('view-title');
}

function apply(action, text, version = state.version) {
  const latest = store.load();
  const next = action(latest, version, new Date().toISOString());
  const feedbackText = typeof text === 'function' ? text(next, latest) : text;
  const saved = store.save(next);
  state = next; render('view-title');
  message(saved ? feedbackText : feedbackText + ' 현재 화면에서만 유지됩니다. 브라우저 저장을 사용할 수 없습니다.');
}

async function copyLink() {
  const url = new URL(location.href);
  url.searchParams.set('view', 'participant'); url.searchParams.set('member', memberId);
  try {
    if (!navigator.clipboard) throw new Error('clipboard_unavailable');
    await navigator.clipboard.writeText(url.href);
    message('체험 링크를 복사했습니다. 같은 브라우저에서 열어 주세요.');
  } catch {
    document.querySelector('#copy-link-value').value = url.href;
    document.querySelector('#copy-dialog').showModal();
    document.querySelector('#copy-link-value').select();
  }
}

document.addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.dataset.role) { navigate(target.dataset.role); return; }
  try {
    const version = state.version;
    switch (target.dataset.action) {
      case 'select-expense': state = store.load(); selectedId = target.dataset.id; message('최신 샘플 지출을 불러왔습니다.'); render('expense-select'); break;
      case 'mark-qa': apply(M.markQa, '현재 버전의 샘플 검수를 확인했습니다.', version); break;
      case 'approve-organizer': apply(M.approveOrganizer, '총무 승인 완료. 참여자 검토가 열렸습니다.', version); break;
      case 'close-review': apply(M.closeReview, '검토창 종료. 무응답 기록은 그대로 유지됩니다.', version); break;
      case 'finalize': apply(M.finalize, '현재 버전을 잠갔습니다. 지출과 응답은 더 이상 변경할 수 없습니다.', version); break;
      case 'revoke-share': apply((s, _v, at) => M.revokeShare(s, at), '공유 시연을 종료했습니다.', version); break;
      case 'approve-participant': apply((s, v, at) => M.decideParticipant(s, memberId, 'approved', null, v, at), '이 버전에 승인 의견을 기록했습니다.', version); break;
      case 'object-participant': {
        const reason = document.querySelector('#objection-reason').value;
        apply((s, v, at) => M.decideParticipant(s, memberId, 'objection', reason, v, at), '이의를 기록했습니다. 총무 화면에도 반영됩니다.', version); break;
      }
      case 'withdraw-objection': apply((s, v, at) => M.withdrawObjection(s, memberId, v, at), '이의를 철회했습니다. 승인 여부는 별도로 선택해 주세요.', version); break;
      case 'open-participant': navigate('participant'); break;
      case 'copy-link': await copyLink(); break;
      case 'reset': document.querySelector('#reset-dialog').showModal(); break;
      case 'confirm-reset': state = store.reset(); selectedId = state.expenses[0].id; document.querySelector('#reset-dialog').close(); navigate('operator'); message('합성 샘플을 처음 상태로 초기화했습니다.'); break;
    }
  } catch (error) {
    state = store.load(); render(); message(error.message, true);
  }
});

document.addEventListener('input', event => {
  if (event.target.closest('#expense-form')) expenseDraftChanged = true;
});

document.addEventListener('change', event => {
  if (event.target.id === 'expense-select') { state = store.load(); selectedId = event.target.value; message(''); render('expense-select'); }
  else if (event.target.closest('#expense-form')) expenseDraftChanged = true;
  if (event.target.id === 'participant-member') {
    memberId = event.target.value; navigate('participant'); document.querySelector('#participant-member')?.focus();
  }
});

document.addEventListener('submit', event => {
  if (event.target.id !== 'expense-form') return;
  event.preventDefault();
  const form = event.target, fields = new FormData(form);
  try {
    const patch = { amount: fields.get('amount'), payerId: fields.get('payerId'), splitIds: fields.getAll('splitId') };
    apply((s, version, at) => M.updateExpense(s, fields.get('expenseId'), patch, version, at),
      (next, latest) => next.version === latest.version ? '변경된 항목이 없습니다. 기존 승인과 버전은 유지됩니다.' : '지출을 재계산했습니다. 변경된 버전을 다시 승인해 주세요.', Number(form.dataset.version));
  } catch (error) {
    form.querySelector('#expense-amount').setAttribute('aria-invalid', 'true');
    message(error.message, true);
  }
});

window.addEventListener('storage', event => {
  if (event.key !== M.STORAGE_KEY) return;
  if (role === 'operator' && expenseDraftChanged) {
    message('다른 화면에서 샘플 상태가 변경되었습니다. 입력 내용은 유지했습니다. 버전이 바뀌었다면 저장 전에 지출 목록에서 항목을 다시 선택해 최신 상태를 확인해 주세요.');
    return;
  }
  state = store.load(); render(); message('다른 화면에서 변경한 샘플 상태를 불러왔습니다.');
});

render();
const initialStatus = store.status(), initialMessages = [];
if (initialStatus.recovered) initialMessages.push('저장된 샘플이 손상되었거나 형식이 달라 초기 상태로 복구했습니다.');
if (!initialStatus.persistent) initialMessages.push('브라우저 저장을 사용할 수 없습니다. 현재 화면에서만 유지됩니다.');
if (initialMessages.length) message(initialMessages.join(' '), true);
