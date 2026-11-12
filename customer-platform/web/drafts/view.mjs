import { createDraftController } from './controller.mjs';
import { scheduleLabels, expenseLabels } from '../ledger/forms.mjs';

export function mountDrafts(root, options) {
  const c = createDraftController(options);
  root.innerHTML = `<section class="drafts-panel notice-panel" aria-labelledby="draft-heading">
    <h3 id="draft-heading" tabindex="-1">메시지로 초안 만들기</h3>
    <p class="help" id="draft-help">합성 데이터 체험입니다. 아래 3개 예문만 처리하며 실제 Claude·카카오에 연결하지 않습니다. 결제자·분담자와 누락 항목은 폼에서 직접 확인해 주세요.</p>
    <p class="help" id="draft-examples">지원 예문: 내일 오전 10시 왕궁 방문 / 점심 300바트 / 택시 15000원. 내일은 여행지 시간대 기준이며 여행 기간 안의 날짜만 적용합니다.</p>
    <form id="draft-form"><div class="field"><label for="draft-message">일정 또는 경비 메시지</label>
      <textarea id="draft-message" rows="3" maxlength="2000" aria-describedby="draft-help draft-examples draft-count" placeholder="점심 300바트"></textarea>
      <p id="draft-count" class="help"></p></div>
      <button id="draft-generate" type="submit" class="secondary">초안 생성</button>
    </form>
    <p id="draft-role" class="help" hidden>편집 권한이 있어야 초안을 만들고 적용할 수 있습니다.</p>
    <p id="draft-status" class="status" role="status" aria-live="polite" hidden></p>
    <p id="draft-error" class="error" role="alert" tabindex="-1" hidden></p>
    <section id="draft-result" class="drafts-result" aria-labelledby="draft-result-heading" hidden>
      <h4 id="draft-result-heading" tabindex="-1">생성한 초안</h4>
      <p id="draft-preview" class="drafts-preview"></p><p id="draft-missing" class="help"></p><p id="draft-warnings" class="help"></p>
      <button id="draft-apply" type="button" class="secondary">빈 폼에 적용</button>
    </section>
  </section>`;
  const refs = Object.fromEntries([...root.querySelectorAll('[id]')].map(node => [node.id,node]));
  const removers = [];
  function on(node, event, fn) {node.addEventListener(event,fn);removers.push(() => node.removeEventListener(event,fn));}
  const message = refs['draft-message'];
  on(message,'input',() => c.setMessage(message.value));
  on(refs['draft-form'],'submit',async event => {event.preventDefault();await c.generate();});
  on(refs['draft-apply'],'click',() => {
    if (c.apply()) refs['draft-heading'].focus();
  });
  const labels = {...scheduleLabels,...expenseLabels};
  const unsubscribe = c.subscribe(state => {
    if (message.value !== state.message) message.value = state.message;
    message.disabled = !state.canEdit;
    refs['draft-generate'].disabled = !state.canEdit || state.busy || !state.message.trim();
    refs['draft-generate'].textContent = state.busy ? '생성 중' : '초안 생성';
    refs['draft-role'].hidden = state.canEdit;
    refs['draft-count'].textContent = `${[...state.message].length}/2,000자`;
    refs['draft-form'].setAttribute('aria-busy',String(state.busy));
    refs['draft-status'].textContent = state.busy ? '초안을 만들고 있습니다.' : state.status;
    refs['draft-status'].hidden = !state.busy && !state.status;
    refs['draft-error'].textContent = state.error; refs['draft-error'].hidden = !state.error;
    refs['draft-result'].hidden = !state.draft;
    refs['draft-apply'].disabled = !state.canEdit || state.busy || !state.draft;
    const draft = state.draft;
    refs['draft-result-heading'].textContent = draft?.kind === 'expense' ? '경비 초안' : '일정 초안';
    refs['draft-preview'].textContent = draft ? Object.entries(draft.fields).map(([key,value]) => `${labels[key] ?? key}: ${Array.isArray(value) ? value.join(', ') : value ?? '미지정'}`).join('\n') : '';
    refs['draft-missing'].textContent = draft?.missing.length ? '직접 확인할 항목: ' + draft.missing.map(key => labels[key] ?? key).join(', ') : '';
    refs['draft-warnings'].textContent = draft?.warnings.join(' ') ?? '';
  });
  return {updateContext: context => c.updateContext(context), destroy() {unsubscribe();c.destroy();for (const remove of removers) remove();root.replaceChildren();}};
}
