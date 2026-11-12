export function createDraftController({api, onApply, onUnauthorized = () => {}}) {
  let context = null, generation = 0, destroyed = false;
  const listeners = new Set();
  const state = {message: '', draft: null, busy: false, canEdit: false, error: '', status: ''};
  const emit = () => {for (const fn of listeners) fn(state);};
  const invalidate = () => {generation++; state.busy = false; state.draft = null; state.error = ''; state.status = '';};
  function updateContext(next) {
    if (destroyed) return;
    const changedIdentity = next.accountId !== context?.accountId || next.tripId !== context?.tripId;
    const changedRevision = next.ledger?.revision !== context?.ledger?.revision;
    const changedRole = next.ledger?.role !== context?.ledger?.role;
    if (changedIdentity || changedRevision || changedRole || !next.ledger) invalidate();
    if (changedIdentity) state.message = '';
    // Snapshot context values so a caller mutating a ledger object cannot silently
    // change the revision associated with an in-flight generation.
    context = {...next, ledger: next.ledger ? {...next.ledger} : null};
    state.canEdit = Boolean(next.accountId && next.tripId && next.ledger?.tripId === next.tripId && ['owner','editor'].includes(next.ledger?.role));
    emit();
  }
  function setMessage(value) {
    if (destroyed) return;
    invalidate(); state.message = String(value); emit();
  }
  async function generate() {
    if (destroyed || state.busy || !state.canEdit || !state.message.trim()) return false;
    if ([...state.message].length > 2000) {state.error = '메시지는 2,000자까지 입력해 주세요.'; emit(); return false;}
    const own = ++generation, request = context;
    state.busy = true; state.draft = null; state.error = ''; state.status = ''; emit();
    try {
      const draft = await api.generateDraft(request.tripId, state.message, request.ledger.revision, request.accountId);
      if (destroyed || own !== generation) return false;
      if (!draft || draft.tripId !== request.tripId || draft.baseRevision !== request.ledger.revision || !['schedule','expense'].includes(draft.kind)) {
        state.error = '현재 여행에 적용할 수 없는 초안입니다. 다시 생성해 주세요.'; return false;
      }
      state.draft = draft; state.status = '초안 내용을 확인한 뒤 빈 폼에 적용해 주세요.'; return true;
    } catch (error) {
      if (destroyed || own !== generation) return false;
      state.error = error?.code === 'validation' ? '지원 예문과 여행 기간을 확인해 주세요. 원문은 보존했습니다.'
        : error?.code === 'conflict' ? '장부가 갱신되었습니다. 최신 내용을 확인한 뒤 다시 생성해 주세요.'
        : '초안을 만들지 못했습니다. 원문을 확인한 뒤 다시 시도해 주세요.';
      if ([401,403,404,412].includes(error?.status) || ['unauthenticated','forbidden','not_found','account_changed'].includes(error?.code)) onUnauthorized(error);
      return false;
    } finally {
      if (!destroyed && own === generation) {state.busy = false; emit();}
    }
  }
  function apply() {
    if (destroyed || !state.canEdit || state.busy || !state.draft || state.draft.tripId !== context.tripId || state.draft.baseRevision !== context.ledger.revision) return false;
    if (onApply(state.draft) !== true) {
      state.error = '기존 폼에 미저장 입력이 있어 적용하지 않았습니다. 입력을 먼저 확인해 주세요.'; emit(); return false;
    }
    state.draft = null; state.error = ''; state.status = '빈 폼에 초안을 적용했습니다. 누락 항목을 확인하고 기존 저장 버튼으로 저장해 주세요.'; emit(); return true;
  }
  return {state, updateContext, setMessage, generate, apply,
    subscribe(fn) {listeners.add(fn); fn(state); return () => listeners.delete(fn);},
    destroy() {destroyed = true; invalidate(); state.message = ''; state.canEdit = false; context = null; listeners.clear();},
  };
}
