// 정산 라스트마일: 송금 딥링크 + 카톡 공유용 메시지

export type PayeeAccount = { bank_name?: string | null; account_no?: string | null };

/** 토스 송금 딥링크 (수취 계좌 정보가 있을 때 프리필). 앱에서 열림. */
export function tossSendLink(amount: number, acc?: PayeeAccount): string | null {
  if (!acc?.bank_name || !acc?.account_no) return null;
  const p = new URLSearchParams({
    bank: acc.bank_name,
    accountNo: String(acc.account_no).replace(/[^0-9]/g, ""),
    amount: String(Math.round(amount)),
  });
  return `supertoss://send?${p.toString()}`;
}

/** 카카오페이 송금(앱 열기). 계좌 프리필 공개 스킴이 없어 앱 진입 링크로 안내. */
export function kakaoPayLink(): string {
  return "kakaotalk://kakaopay/money/to";
}

export type SettleTransferView = {
  from: string;
  to: string;
  amount: number;
  toss_link: string | null;
  kakaopay_link: string;
  payee_account: string | null;
};

/** 카톡 등에 붙여넣을 정산 요약 텍스트 */
export function settlementMessage(
  tripName: string,
  baseCurrency: string,
  total: number,
  transfers: SettleTransferView[]
): string {
  const head = `💰 [${tripName}] 정산 결과 (총 ${total.toLocaleString()} ${baseCurrency})`;
  if (transfers.length === 0) return `${head}\n정산 완료 — 추가 송금 없음 🎉`;
  const lines = transfers.map((t) => {
    const acc = t.payee_account ? ` (${t.payee_account})` : "";
    return `• ${t.from} → ${t.to} : ${t.amount.toLocaleString()} ${baseCurrency}${acc}`;
  });
  return [head, ...lines, "", "※ 토스 링크를 누르면 송금 화면이 열립니다."].join("\n");
}
