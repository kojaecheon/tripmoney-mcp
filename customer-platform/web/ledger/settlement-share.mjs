import { dayLabel, element, seoulTime, won, writeText } from './forms.mjs';

const tripIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const scopeLabel = date => date === null ? '여행 최종 정산' : '일일 정산';

function shareText(snapshot, result, closed, tripId, origin) {
  if (!origin || origin === 'null' || typeof tripId !== 'string' || tripId.length !== 36 || !tripIdPattern.test(tripId)) return '';
  const link = new URL('/', origin);
  link.hash = `trip=${tripId.toLowerCase()}`;
  const daily = snapshot.date !== null;
  const scope = scopeLabel(snapshot.date);
  const period = daily ? `${scope} (${dayLabel(snapshot.date)})` : scope;
  const finished = !daily && closed;
  const spentLabel = daily ? '누적 실지출' : '전체 실지출';
  const unpaid = finished ? [] : result.transfers;
  const unpaidKrw = unpaid.reduce((total, row) => total + row.amountKrw, 0);
  const lines = [
    `TripMoney ${period} · ${finished ? '마감' : '확정'}`,
    `확정 시각 ${seoulTime(snapshot.createdAt)} (한국 시간)`,
    `확정 당시 ${spentLabel} ${won(snapshot.result.spentKrw)}`,
  ];
  if (snapshot.result.spentKrw !== result.spentKrw) lines.push(`현재 ${spentLabel} ${won(result.spentKrw)}`);
  lines.push(`현재 남은 지급 ${unpaid.length}건 · 합계 ${won(unpaidKrw)}`, '', `여행 장부 (참여 중인 동행자 전용)\n${link.href}`);
  return lines.join('\n');
}

export function mountSettlementShare(doc, {container, on, fallbackFocus}) {
  const trigger = element(doc, 'button', 'secondary', '정산 공유 미리보기');
  const panel = element(doc, 'div', 'notice-panel');
  panel.id = `${container.id}-preview`;
  panel.hidden = true;
  container.hidden = true;
  trigger.setAttribute('aria-controls', panel.id);
  trigger.setAttribute('aria-expanded', 'false');

  const field = element(doc, 'div', 'field');
  const label = element(doc, 'label', '', '공유 문구');
  const preview = element(doc, 'textarea');
  preview.id = `${container.id}-text`;
  preview.readOnly = true;
  preview.rows = 7;
  label.htmlFor = preview.id;
  field.append(label, preview);

  const help = element(doc, 'p', 'help', '여행에 참여 중인 동행자만 링크에서 장부를 열 수 있습니다.');
  const status = element(doc, 'p', 'help');
  status.setAttribute('role', 'status');
  const controls = element(doc, 'div', 'button-row');
  const share = element(doc, 'button', 'primary', '앱에서 공유');
  const copy = element(doc, 'button', 'secondary', '문구 복사');
  const close = element(doc, 'button', 'secondary', '미리보기 닫기');
  const browser = doc.defaultView;
  const navigator = browser?.navigator;
  share.hidden = typeof navigator?.share !== 'function';
  for (const button of [trigger, share, copy, close]) button.type = 'button';
  controls.append(share, copy, close);
  panel.append(field, help, controls, status);
  container.append(trigger, panel);

  let message = '', selection = null, generation = 0, busy = false;
  function setBusy(value) {
    busy = value;
    for (const button of [share, copy]) button.setAttribute('aria-disabled', String(value));
  }
  function closePreview() {
    generation += 1;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    preview.value = '';
    writeText(status, '');
    setBusy(false);
  }
  function dismiss() {
    closePreview();
    trigger.focus();
  }
  on(trigger, 'click', () => {
    if (!message) return;
    if (!panel.hidden) {
      dismiss();
      return;
    }
    preview.value = message;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    preview.focus();
  });
  on(close, 'click', dismiss);
  on(panel, 'keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  });
  on(share, 'click', async () => {
    if (panel.hidden || share.hidden || busy) return;
    const attempt = generation;
    setBusy(true);
    writeText(status, '');
    try {
      await navigator.share({text: message});
    } catch (error) {
      if (attempt === generation && error?.name !== 'AbortError') {
        writeText(status, '이 기기의 공유 창을 열지 못했습니다. 문구를 복사해 보낼 수 있습니다.');
      }
    } finally {
      if (attempt === generation) setBusy(false);
    }
  });
  on(copy, 'click', async () => {
    if (panel.hidden || busy) return;
    const attempt = generation;
    setBusy(true);
    writeText(status, '');
    try {
      if (!navigator?.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(message);
      if (attempt === generation) writeText(status, '공유 문구를 복사했습니다.');
    } catch {
      if (attempt === generation) {
        preview.focus();
        preview.select();
        writeText(status, '위에 선택한 문구를 직접 복사해 주세요.');
      }
    } finally {
      if (attempt === generation) setBusy(false);
    }
  });

  return function update({snapshot, result = snapshot?.result, tripId, closed = false, accountId} = {}) {
    const next = accountId && snapshot?.reopenedAt === null && result
      ? shareText(snapshot, result, closed, tripId, browser?.location.origin) : '';
    const nextSelection = next ? `${accountId}/${snapshot.id}` : null;
    if (next === message && nextSelection === selection) return;
    const restoreFocus = doc.activeElement && container.contains(doc.activeElement);
    message = next;
    selection = nextSelection;
    closePreview();
    if (next) writeText(trigger, `${scopeLabel(snapshot.date)} 공유 미리보기`);
    container.hidden = !next;
    if (restoreFocus) (next ? trigger : fallbackFocus)?.focus();
  };
}
