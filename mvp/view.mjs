import { calculate, baseAmount, participantResult, REASONS } from './model.mjs';

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = value => '₩' + value.toLocaleString('ko-KR');
const alias = (state, id) => state.members.find(m => m.id === id)?.alias ?? '';
const disabled = value => value ? ' disabled' : '';
const button = (action, text, isDisabled = false, secondary = true) => `<button type="button" class="btn${secondary ? ' btn-secondary' : ''}" data-action="${action}"${disabled(isDisabled)}>${text}</button>`;
const pill = (text, tone = '') => `<span class="pill ${tone}">${esc(text)}</span>`;
const time = value => value ? new Date(value).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const stamp = (label, value, kind) => value ? `<span class="stamp ${kind}" role="img" aria-label="${esc(label + ' ' + time(value))}"><span>${esc(label)}</span><span class="date">${esc(time(value))}</span></span>` : '';
const titles = { operator: '지출을 확인하고, 숫자를 맞춥니다.', organizer: '내가 승인한 버전이 기준이 됩니다.', participant: '내 몫을 확인하고, 의견을 남깁니다.' };

function stats(items) {
  return `<div class="mvp-stats">${items.map(([label, value, detail, format]) => `<div><span class="caption">${label}</span><strong class="num">${format === 'count' ? value.toLocaleString('ko-KR') : won(value)}</strong>${detail ? `<span class="caption">${detail}</span>` : ''}</div>`).join('')}</div>`;
}

function transfers(list) {
  if (!list.length) return '<p class="empty-state">추가 송금이 필요하지 않습니다.</p>';
  return `<div class="transfer-list">${list.map(t => `<div class="transfer-ticket"><div><span class="caption">보내는 사람 / 받는 사람</span><strong>${esc(t.from)} / ${esc(t.to)}</strong></div><span class="num">${won(t.amount)}</span></div>`).join('')}</div>`;
}

function history(state) {
  const names = { expense_updated: '지출 수정, 이전 승인 초기화', organizer_approved: '총무 승인', participant_approved: '참여자 승인', participant_objected: '참여자 이의', objection_withdrawn: '이의 철회', qa_confirmed: '내부 검수 확인', review_closed: '검토창 종료', finalized: '정산 잠금', share_revoked: '공유 시연 종료' };
  return `<details class="card mvp-history"><summary>샘플 처리 이력 <span class="num">${state.history.length}</span></summary>${state.history.length ? `<ol>${[...state.history].reverse().map(h => `<li><span>v${h.version} · ${names[h.action]}</span><time>${esc(time(h.at))}</time></li>`).join('')}</ol>` : '<p class="meta">아직 처리한 작업이 없습니다.</p>'}</details>`;
}

function operator(state, selectedId) {
  const result = calculate(state), e = state.expenses.find(e => e.id === selectedId) ?? state.expenses[0];
  const locked = Boolean(state.lockedAt);
  return `${stats([['전체 지출', result.total, '원화 환산 합계'], ['지출 건수', state.expenses.length, '합성 지출 12건', 'count'], ['현재 버전', state.version, '수정하면 승인 초기화', 'count']])}
    <div class="mvp-columns">
      <section class="card edit-card" aria-labelledby="expense-heading"><div class="section-head"><span class="eyebrow">01 / 샘플 지출</span>${pill('고정 환율', 'info')}</div><h2 id="expense-heading">숫자를 바꿔 보세요</h2>
      <form id="expense-form" class="stack" data-version="${state.version}">
        <label class="field" for="expense-select">수정할 지출<select class="input" id="expense-select" name="expenseId"${disabled(locked)}>${state.expenses.map(item => `<option value="${item.id}"${item.id === e.id ? ' selected' : ''}>${esc(item.title)}</option>`).join('')}</select></label>
        <div class="grid-2 field-grid"><label class="field" for="expense-amount">금액 (${esc(e.currency)})<input class="input num" id="expense-amount" name="amount" inputmode="decimal" value="${e.amountCents / 100}" required aria-describedby="amount-help"${disabled(locked)}></label>
        <label class="field" for="expense-payer">결제자<select class="input" id="expense-payer" name="payerId"${disabled(locked)}>${state.members.map(m => `<option value="${m.id}"${m.id === e.payerId ? ' selected' : ''}>${esc(m.alias)}</option>`).join('')}</select></label></div>
        <p class="caption" id="amount-help">샘플 금액은 1,000,000 이하, 소수 둘째 자리까지입니다. 환율은 ${e.rateMilli / 1000}으로 고정되어 있습니다.</p>
        <fieldset class="split-fieldset"${disabled(locked)}><legend>분담 대상 (한 명 이상)</legend><div class="split-options">${state.members.map(m => `<label class="check"><input type="checkbox" name="splitId" value="${m.id}"${e.splitIds.includes(m.id) ? ' checked' : ''}>${esc(m.alias)}</label>`).join('')}</div></fieldset>
        <p class="conversion"><span>현재 원화 환산</span><strong class="num">${won(baseAmount(e))}</strong></p>
        <button class="btn" type="submit"${disabled(locked)}>지출 수정 · 재계산</button>
        <p class="meta">${locked ? '잠금 완료된 샘플입니다. 초기화 후 다시 체험할 수 있습니다.' : '금액·결제자·분담을 바꾸면 새 버전이 생기고 총무·참여자 승인도 초기화됩니다.'}</p>
      </form></section>
      <section class="card" aria-labelledby="expense-list-heading"><div class="section-head"><span class="eyebrow">02 / 수정 결과</span>${pill('샘플 전용')}</div><h2 id="expense-list-heading">지출과 근거</h2><div class="mvp-table-scroll"><table class="table expense-table"><caption class="sr-only">샘플 지출과 환산액, 결제자</caption><thead><tr><th scope="col">지출</th><th scope="col">원화 환산</th><th scope="col">결제자</th></tr></thead><tbody>${state.expenses.map(item => `<tr data-expense-id="${item.id}" class="${item.id === e.id ? 'selected-expense' : ''}"><th scope="row"><button type="button" class="expense-link" data-action="select-expense" data-id="${item.id}">${esc(item.title)}</button><span class="caption">${(item.amountCents / 100).toLocaleString('ko-KR')} ${esc(item.currency)} · ${item.splitIds.length}명 분담</span></th><td class="num">${won(baseAmount(item))}</td><td>${esc(alias(state, item.payerId))}</td></tr>`).join('')}</tbody></table></div></section>
    </div>
    <section class="card qa-card"><div><span class="eyebrow">03 / 내부 검수</span><h2>합계를 확인합니다</h2><p class="meta">분담 합계, 멤버 순액 합계 0, 송금 제안을 계산했습니다. 실제 영수증 검수가 아닌 샘플 검수입니다.</p></div><div class="qa-action">${stamp('내부 검수', state.qaAt, 'qa')}${button('mark-qa', '현재 버전 검수 확인', locked || Boolean(state.qaAt), false)}</div></section>${history(state)}`;
}

function decisions(state) {
  const values = Object.values(state.decisions);
  const count = status => values.filter(d => d.status === status).length;
  const labels = { approved: ['승인', 'ok'], objection: ['이의', 'bad'], not_responded: ['무응답', 'wait'] };
  return `<div class="decision-counts">${pill('승인 ' + count('approved'), 'ok')}${pill('이의 ' + count('objection'), 'bad')}${pill('무응답 ' + count('not_responded'), 'wait')}</div><div class="decision-list">${state.members.filter(m => m.role !== 'organizer').map(m => {
    const d = state.decisions[m.id], [label, tone] = labels[d.status];
    return `<div class="decision"><div><strong>${esc(m.alias)}</strong>${d.reason ? `<p class="reason">${REASONS[d.reason]}</p>` : ''}</div>${pill(label, tone)}</div>`;
  }).join('')}</div>`;
}

function organizer(state) {
  const result = calculate(state), objection = Object.values(state.decisions).some(d => d.status === 'objection');
  const locked = Boolean(state.lockedAt);
  const canFinalize = state.organizerApprovedAt && state.reviewClosedAt && state.qaAt && !objection && !locked;
  return `${stats([['전체 지출', result.total, '분담 합계와 일치'], ['총무가 낸 금액', result.members.find(m => m.id === state.trip.organizerId).paid, '샘플 결제 기록'], ['총무 순액', result.members.find(m => m.id === state.trip.organizerId).net, '양수는 받을 금액']])}
    <div class="mvp-columns"><section class="card"><div class="section-head"><span class="eyebrow">01 / 정산 결과</span>${pill('v' + state.version, 'info')}</div><h2>누가 얼마를 부담하나요</h2><div class="mvp-table-scroll"><table class="table"><caption class="sr-only">샘플 멤버별 정산 결과</caption><thead><tr><th scope="col">멤버</th><th scope="col">낸 금액</th><th scope="col">부담액</th><th scope="col">순액</th></tr></thead><tbody>${result.members.map(m => `<tr><th scope="row">${esc(m.alias)}</th><td class="num">${won(m.paid)}</td><td class="num">${won(m.owed)}</td><td class="num ${m.net > 0 ? 'positive' : ''}">${won(m.net)}</td></tr>`).join('')}</tbody></table></div><h3 class="subhead">송금 제안</h3>${transfers(result.transfers)}<p class="caption">송금을 실행하지 않습니다. 계좌·은행 정보는 사용하지 않습니다.</p></section>
    <div class="stack"><section class="card"><span class="eyebrow">02 / 버전 승인</span><h2>총무 승인</h2>${state.organizerApprovedAt ? `<div class="stamp-inline">${stamp('총무 승인 v' + state.version, state.organizerApprovedAt, 'organizer')}</div><p class="meta">이 버전으로 참여자 검토가 열렸습니다.</p>` : `<p class="meta">결과를 확인한 뒤 승인하면 참여자가 본인 몫을 검토할 수 있습니다.</p>${button('approve-organizer', '이 버전 승인', false, false)}`}
      <div class="btn-row share-buttons">${button('open-participant', '참여자 화면 보기', !state.organizerApprovedAt || state.shareRevoked)}${button('copy-link', '체험 링크 복사', !state.organizerApprovedAt || state.shareRevoked)}</div><p class="caption">같은 브라우저에서만 상태가 공유됩니다. 외부 사용자에게 데이터를 전달하는 링크가 아닙니다.</p></section>
      <section class="card"><span class="eyebrow">03 / 검토 현황</span><h2>참여자 응답</h2>${decisions(state)}<p class="meta">무응답은 승인이 아닙니다. 이의가 있으면 수정하거나 철회해야 합니다.</p></section></div></div>
    <section class="card lock-card"><div><span class="eyebrow">04 / 마감</span><h2>정산을 잠급니다</h2><ul class="lock-checks"><li>${pill(state.organizerApprovedAt ? '충족' : '대기', state.organizerApprovedAt ? 'ok' : 'wait')} 총무 승인</li><li>${pill(state.qaAt ? '충족' : '대기', state.qaAt ? 'ok' : 'wait')} 내부 검수</li><li>${pill(state.reviewClosedAt ? '충족' : '대기', state.reviewClosedAt ? 'ok' : 'wait')} 검토창 종료</li><li>${pill(objection ? '차단' : '충족', objection ? 'bad' : 'ok')} 미해결 이의 ${Object.values(state.decisions).filter(d => d.status === 'objection').length}건</li></ul></div><div class="stack lock-actions">${stamp('정산 잠금 v' + state.version, state.lockedAt, 'locked')}${button('close-review', '검토창 종료 시연', !state.organizerApprovedAt || Boolean(state.reviewClosedAt) || objection || locked)}${button('finalize', '현재 버전 잠금', !canFinalize, false)}${button('revoke-share', '공유 시연 종료', !state.organizerApprovedAt || state.shareRevoked)}<p class="caption">종료 시각은 체험 버튼으로 진행합니다. 실제 검토 기한·접근권한 기능은 아닙니다.</p></div></section>${history(state)}`;
}

function participant(state, memberId) {
  if (state.shareRevoked) return '<section class="card empty-state"><h2>공유 시연이 종료되었습니다</h2><p>초기화하면 합성 샘플로 다시 체험할 수 있습니다.</p></section>';
  if (!state.organizerApprovedAt) return '<section class="card empty-state"><h2>총무 승인을 기다리고 있습니다</h2><p>총무 화면에서 현재 버전을 승인한 뒤 참여자 검토를 체험해 주세요.</p></section>';
  const result = participantResult(state, memberId), d = result.decision;
  const closed = Boolean(state.reviewClosedAt || state.lockedAt);
  return `<section class="participant-intro"><label class="field" for="participant-member">샘플 참여자 선택<select class="input" id="participant-member">${state.members.filter(m => m.role !== 'organizer').map(m => `<option value="${m.id}"${m.id === memberId ? ' selected' : ''}>${esc(m.alias)}</option>`).join('')}</select></label><p class="caption">역할 전환은 체험용입니다. 실제 로그인이나 사용자 권한 분리가 아닙니다.</p></section>
    <h2 class="participant-heading">${esc(result.member.alias)}님의 결과</h2>${stats([['내가 낸 금액', result.member.paid], ['내 부담액', result.member.owed], [result.member.net >= 0 ? '받을 금액' : '보낼 금액', Math.abs(result.member.net)]])}
    <div class="mvp-columns"><section class="card"><span class="eyebrow">01 / 내 송금 제안</span><h2>내가 관련된 송금만</h2>${transfers(result.transfers)}<p class="caption">고정 샘플 환율로 원화 환산 후 1원 단위로 분담합니다. 계좌나 송금 실행 기능은 없습니다.</p></section>
    <section class="card participant-decision"><span class="eyebrow">02 / 내 의견</span><h2>${closed ? '검토가 종료되었습니다' : '이 버전을 확인해 주세요'}</h2><div class="decision-counts">${pill('v' + state.version, 'info')}${pill(d.status === 'approved' ? '승인' : d.status === 'objection' ? '이의' : '무응답', d.status === 'approved' ? 'ok' : d.status === 'objection' ? 'bad' : 'wait')}</div>${d.at ? `<p class="meta">처리 시각 ${esc(time(d.at))}</p>` : ''}${d.reason ? `<p class="reason">${REASONS[d.reason]}</p>` : ''}
    ${closed ? '<p class="meta">기록된 응답은 그대로 남습니다. 무응답을 승인으로 바꾸지 않습니다.</p>' : `<label class="field" for="objection-reason">샘플 이의 사유<select class="input" id="objection-reason">${Object.entries(REASONS).map(([key, value]) => `<option value="${key}"${d.reason === key ? ' selected' : ''}>${value}</option>`).join('')}</select></label><div class="btn-row decision-actions">${button('approve-participant', '이 버전 승인', false, false)}${button('object-participant', '이의 제기')}${d.status === 'objection' ? button('withdraw-objection', '이의 철회') : ''}</div><p class="meta">이의를 철회해도 자동 승인되지 않습니다. 개인정보 입력을 막기 위해 고정 사유만 제공합니다.</p>`}</section></div>`;
}

export function renderView(state, role, memberId, selectedId) {
  const body = role === 'organizer' ? organizer(state) : role === 'participant' ? participant(state, memberId) : operator(state, selectedId);
  return `<div class="view-heading"><div><span class="eyebrow">${role === 'operator' ? '운영자 시연' : role === 'organizer' ? '총무 시연' : '참여자 시연'} · 합성 데이터</span><h1 id="view-title" tabindex="-1">${titles[role] ?? titles.operator}</h1><p class="meta">${role === 'participant' && (!state.organizerApprovedAt || state.shareRevoked) ? '샘플 검토 상태 안내' : esc(state.trip.name) + ' · 샘플 멤버 ' + state.members.length + '명 · v' + state.version}</p></div>${pill(state.lockedAt ? '잠금 완료' : state.organizerApprovedAt ? '참여자 검토' : '총무 승인 대기', state.lockedAt ? 'ok' : 'info')}</div>${body}`;
}
