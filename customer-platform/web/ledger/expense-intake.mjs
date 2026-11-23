import {tripDates, writesLocked, writeText} from './forms.mjs';

const textLimit = 2_000;
const maxAmount = 1_000_000;
const summaryMarker = /누적|합계|잔액|한도|이용\s*가능|사용\s*가능/;
const refundOrDenial = /취소|환불|환급|반품|거절|실패|미승인|\b(?:refund(?:ed)?|cancel(?:led|ed|lation)?|declined|reversal)\b/i;
const otherCurrency = /[$€¥£]|\b(?:USD|JPY|EUR|CNY|HKD|TWD|GBP|AUD|SGD|VND|CAD|MYR|IDR|PHP)\b|\d\s*(?:달러|엔|유로|위안|동|페소)/i;

const datePattern = /(?<![\d./-])(?:(?<year>\d{4})(?:[ \t]*년[ \t]*|[./-]))?(?<month>\d{1,2})(?:[ \t]*월[ \t]*|[./-])(?<day>\d{1,2})(?:[ \t]*일(?![가-힣]))?(?![\d./-])/g;
const weekdayPattern = /^[ \t]*\([월화수목금토일](?:요일)?\)/;
const timePattern = /^[ \tT]*(?:(?<meridiem>오전|오후)[ \t]*)?(?<hour>\d{1,2}):(?<minute>\d{2})(?::\d{2})?(?![\d:])/;
const amountPattern = /(?<![\w.,+−-])(?:(?<prefix>KRW\b|THB\b|[₩฿])[ \t]*)?(?<amount>[+−-]?\d[\d,]*(?:\.\d+)?)(?:[ \t]*(?<suffix>만[ \t]*원|원|바트|KRW\b|THB\b))?/gi;

function currencyOf(unit = '') {
  if (/^(?:฿|THB|바트)$/i.test(unit)) return 'THB';
  return unit ? 'KRW' : null;
}

function readAmount(match) {
  const {amount, prefix, suffix} = match.groups;
  const leading = currencyOf(prefix), trailing = currencyOf(suffix);
  if (leading && trailing && leading !== trailing) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(amount)) return null;
  const currency = leading ?? trailing;
  const digits = amount.replaceAll(',', '');
  const inTenThousands = suffix?.startsWith('만');
  const fraction = digits.split('.')[1]?.length ?? 0;
  if (fraction > (inTenThousands ? 4 : currency === 'THB' ? 2 : 0)) return null;
  const value = Number(digits) * (inTenThousands ? 10_000 : 1);
  if (value <= 0 || value > maxAmount) return null;
  // Rounding removes floating point artifacts when converting 만원 to whole won.
  return {currency, amount: String(currency === 'KRW' ? Math.round(value) : value)};
}

function readMerchant(text, afterDate, amount) {
  const merchantField = text.match(/(?:가맹점|상호)\s*(?:명)?[ \t]*[:：][ \t]*([^\n]+)/)?.[1];
  const dateLine = afterDate.split('\n')[0];
  const candidate = (merchantField ?? dateLine).replace(amount[0], ' ').trim()
    .replace(/^(?:(?:일시불|\d{1,2}개월\s*할부|할부|승인)[ \t]+)+/, '')
    .replace(/[ \t]+(?:일시불|\d{1,2}개월\s*할부|할부|승인)(?:\s.*)?$/, '');
  const privateDetails = /[\p{Cc}\[\]*@]|https?:|\d{4}|\d{2,4}[- ]\d{2,4}|승인번호|회원번호|연락처|전화번호|고객님|카드번호/u;
  return /\p{L}/u.test(candidate) && [...candidate].length <= 100 && !privateDetails.test(candidate) ? candidate : '';
}

export function parseCardExpense(raw, ledger) {
  if (!raw || raw.length > textLimit) return null;
  const text = raw.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  if (refundOrDenial.test(text) || [...text.matchAll(/승인(?!\s*번호)/g)].length > 1) return null;

  // Ignore statement totals and balances without dropping a second payment on another line.
  const transaction = text.split('\n').map(line => line.split(summaryMarker, 1)[0]).join('\n');
  const amounts = [...transaction.matchAll(amountPattern)].filter(({groups}) => groups.prefix || groups.suffix);
  const dates = [...transaction.matchAll(datePattern)].filter(date => !amounts.some(amount =>
    date.index >= amount.index && date.index + date[0].length <= amount.index + amount[0].length));
  if (amounts.length !== 1 || dates.length > 1 || otherCurrency.test(transaction)) return null;
  const amount = readAmount(amounts[0]);
  if (!amount) return null;

  let occurredLocal = '', dateStatus = 'missing', afterDate = '';
  if (dates.length) {
    const [{groups: {year, month, day}}] = dates;
    const date = tripDates(ledger).find(value => (!year || value.slice(0, 4) === year) &&
      Number(value.slice(5, 7)) === Number(month) && Number(value.slice(8)) === Number(day));
    afterDate = transaction.slice(dates[0].index + dates[0][0].length).replace(weekdayPattern, '');
    const time = afterDate.match(timePattern);
    if (time) afterDate = afterDate.slice(time[0].length);
    const {hour, minute, meridiem} = time?.groups ?? {};
    const hourValue = Number(hour);
    const validHour = meridiem ? hourValue >= 1 && hourValue <= 12 : hourValue < 24;
    if (date && (!time || (validHour && Number(minute) < 60))) {
      const hour24 = meridiem ? hourValue % 12 + (meridiem === '오후' ? 12 : 0) : hourValue;
      const clock = time ? `${String(hour24).padStart(2, '0')}:${minute}` : '12:00';
      occurredLocal = `${date}T${clock}`;
      dateStatus = time ? 'complete' : 'default-time';
    }
  }
  const title = readMerchant(transaction, afterDate, amounts[0]);
  return {fields: {title, occurredLocal, ...amount}, dateStatus};
}

const receiptTypes = ['image/jpeg', 'image/png', 'image/webp'];
const receiptMaxBytes = 10 * 1024 * 1024;
const methods = {direct: '직접 입력', receipt: '영수증 이미지', sms: '카드 문자·텍스트'};

export const expenseIntakeMarkup = `
<div id="ledger-expense-intake" class="ledger-editor" hidden>
  <div class="button-row" role="group" aria-label="경비 입력 방법">
    ${Object.entries(methods).map(([id, label]) => `<button id="ledger-expense-${id}-method" class="secondary" type="button"${
      id === 'direct' ? '' : ` aria-controls="ledger-expense-${id}-panel" aria-expanded="false"`
    }>${label}</button>`).join('')}
  </div>
  <div id="ledger-expense-receipt-panel" hidden>
    <div class="field">
      <label for="ledger-expense-receipt-file">영수증 사진 선택</label>
      <p id="ledger-expense-receipt-help" class="help">JPG, PNG, WebP 파일을 최대 10MB까지 이 브라우저에서 미리 보고 경비를 입력할 수 있습니다.</p>
      <input id="ledger-expense-receipt-file" type="file" accept="${receiptTypes.join(',')}" aria-describedby="ledger-expense-receipt-help ledger-expense-receipt-error">
      <p id="ledger-expense-receipt-error" class="field-error" role="alert"></p>
      <img id="ledger-expense-receipt-image" class="ledger-expense-preview" alt="선택한 영수증" hidden>
    </div>
    <button id="ledger-expense-receipt-close" class="secondary" type="button">영수증 닫기</button>
  </div>
  <div id="ledger-expense-sms-panel" hidden>
    <div class="field">
      <label for="ledger-expense-sms-text">카드 결제 문자</label>
      <p id="ledger-expense-sms-help" class="help">결제 한 건의 금액, 사용 날짜, 가맹점이 나온 부분을 붙여넣으세요. 원문은 이 브라우저에서만 사용합니다.</p>
      <textarea id="ledger-expense-sms-text" rows="3" autocomplete="off" autocorrect="off" spellcheck="false" aria-describedby="ledger-expense-sms-help ledger-expense-intake-status"></textarea>
    </div>
    <div class="button-row">
      <button id="ledger-expense-sms-review" class="primary" type="button">초안 확인</button>
      <button id="ledger-expense-sms-close" class="secondary" type="button">문자 입력 닫기</button>
    </div>
  </div>
  <p id="ledger-expense-intake-status" class="help" role="status"></p>
</div>`;

export function mountExpenseIntake(r, actions, {on, focus}) {
  const picker = r['ledger-expense-receipt-file'], preview = r['ledger-expense-receipt-image'];
  const receiptError = r['ledger-expense-receipt-error'], sms = r['ledger-expense-sms-text'];
  const review = r['ledger-expense-sms-review'], status = r['ledger-expense-intake-status'];
  let state, method = 'direct', previewUrl = '';

  function receiptFeedback(message) {
    writeText(receiptError, message);
    picker.setAttribute('aria-invalid', String(Boolean(message)));
  }
  function clearReceipt() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = '';
      preview.removeAttribute('src');
    }
    preview.hidden = true;
    picker.value = '';
    receiptFeedback('');
  }
  function selectMethod(next) {
    method = next;
    for (const key of ['receipt', 'sms']) {
      r[`ledger-expense-${key}-panel`].hidden = method !== key;
      r[`ledger-expense-${key}-method`].setAttribute('aria-expanded', String(method === key));
    }
  }
  function close() {
    clearReceipt();
    sms.value = '';
    writeText(status, '');
    selectMethod('direct');
  }
  function enabled() {
    return Boolean(state?.ledger && !state.ledger.settlement?.closure && state.canEdit && !state.expenseId && !writesLocked(state));
  }

  on(r['ledger-expense-direct-method'], 'click', () => {
    if (!enabled()) return;
    close();
    focus('ledger-expense-title');
  });
  for (const key of ['receipt', 'sms']) {
    on(r[`ledger-expense-${key}-method`], 'click', () => {
      if (!enabled()) return;
      if (method === key) return close();
      close();
      selectMethod(key);
      focus(key === 'receipt' ? 'ledger-expense-receipt-file' : 'ledger-expense-sms-text');
    });
    on(r[`ledger-expense-${key}-close`], 'click', () => {
      close();
      focus(`ledger-expense-${key}-method`);
    });
  }
  on(picker, 'change', () => {
    const file = picker.files?.[0];
    if (!file) return;
    if (method !== 'receipt' || !enabled()) {
      picker.value = '';
      return;
    }
    clearReceipt();
    if (!receiptTypes.includes(file.type) || file.size === 0 || file.size > receiptMaxBytes) {
      receiptFeedback('10MB 이하의 JPG, PNG 또는 WebP 사진을 선택해 주세요.');
      return;
    }
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    preview.hidden = false;
  });
  on(preview, 'error', () => {
    if (!previewUrl) return;
    clearReceipt();
    receiptFeedback('선택한 사진을 열 수 없습니다. 다른 이미지를 선택해 주세요.');
  });
  on(sms, 'input', () => writeText(status, ''));
  on(review, 'click', () => {
    if (method !== 'sms' || !enabled()) return;
    if (!sms.value.trim() || sms.value.length > textLimit) {
      writeText(status, '2,000자 이내로 결제 문자 한 건을 붙여넣어 주세요.');
      focus('ledger-expense-sms-text');
      return;
    }
    const draft = parseCardExpense(sms.value, state.ledger);
    close();
    if (draft) {
      for (const [field, value] of Object.entries(draft.fields)) actions.setExpenseField(field, value);
    }
    focus('ledger-expense-title');
    const messages = {
      complete: '초안을 입력했습니다. 금액, 지출 일시, 결제자와 분담자를 확인한 뒤 저장해 주세요.',
      'default-time': '문자에 시각이 없어 낮 12시를 넣었습니다. 실제 지출 시각과 다른 항목을 확인한 뒤 저장해 주세요.',
      missing: '여행 기간 안의 지출 일시를 확인하지 못했습니다. 일시를 직접 입력해 주세요.',
    };
    if (draft) {
      const missingTitle = draft.fields.title ? '' : ' 경비 이름을 입력해 주세요.';
      writeText(status, messages[draft.dateStatus] + missingTitle);
    } else {
      writeText(status, '카드 문자에서 결제 한 건을 확인하지 못했습니다. 경비를 직접 입력해 주세요.');
    }
  });

  return {close, render(next) {
    const visible = Boolean(next.ledger && !next.ledger.settlement?.closure && next.canEdit && !next.expenseId);
    if (!visible || (state && (state.accountId !== next.accountId || state.tripId !== next.tripId))) close();
    state = next;
    r['ledger-expense-intake'].hidden = !visible;
    const disabled = !enabled();
    for (const key of Object.keys(methods)) r[`ledger-expense-${key}-method`].disabled = disabled;
    picker.disabled = sms.disabled = review.disabled = disabled;
  }};
}
