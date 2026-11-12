import type { ExpenseDTO, PaymentDTO, SettlementBalance, SettlementResult } from './contracts.js';
import { invalid, safeSum } from './money.js';

// Match the maximum converted value of one expense. The row limits keep all balances safe integers.
export const MAX_PAYMENT_KRW = 1_000_000_000_000;

export function emptyBalances(memberIds: string[]) {
  return new Map(memberIds.map(memberId => [memberId,{memberId,paidKrw:0,owedKrw:0,netKrw:0}]));
}

export function addExpenseBalance(balances: Map<string,SettlementBalance>, expense: ExpenseDTO) {
  const payer = balances.get(expense.payerId);
  if (!payer) return invalid('payerId');
  payer.paidKrw = safeSum(payer.paidKrw,expense.amountKrw);
  if (safeSum(...expense.shares.map(share => share.amountKrw)) !== expense.amountKrw) return invalid('splitIds');
  for (const {memberId,amountKrw} of expense.shares) {
    const member = balances.get(memberId);
    if (!member) return invalid('splitIds');
    member.owedKrw = safeSum(member.owedKrw,amountKrw);
  }
  return;
}

export function calculateSettlement(spentKrw: number, expenseBalances: Iterable<SettlementBalance>,
                                    payments: PaymentDTO[], through: string | null): SettlementResult {
  const balances = [...expenseBalances].map(b => ({...b,netKrw:safeSum(b.paidKrw,-b.owedKrw)}));
  const members = new Map(balances.map(b => [b.memberId,b]));
  for (const payment of payments) {
    if ((payment.status !== 'confirmed' && payment.status !== 'void_requested') ||
        (through !== null && (payment.confirmedDate === null || payment.confirmedDate > through))) continue;
    const sender = members.get(payment.fromMemberId), recipient = members.get(payment.toMemberId);
    if (!sender || !recipient) return invalid('toMemberId');
    sender.netKrw = safeSum(sender.netKrw,payment.amountKrw);
    recipient.netKrw = safeSum(recipient.netKrw,-payment.amountKrw);
  }
  if (safeSum(...balances.map(b => b.netKrw)) !== 0) return invalid('amountKrw');

  const ranked = (sign: number) => balances.filter(b => sign*b.netKrw > 0)
    .map(b => ({memberId:b.memberId,amountKrw:sign*b.netKrw}))
    .sort((a,b) => b.amountKrw-a.amountKrw || a.memberId.localeCompare(b.memberId));
  const debtors = ranked(-1), creditors = ranked(1);
  const transfers: SettlementResult['transfers'] = [];
  let debtorIndex = 0, creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex]!, creditor = creditors[creditorIndex]!;
    const amountKrw = Math.min(debtor.amountKrw,creditor.amountKrw);
    transfers.push({fromMemberId:debtor.memberId,toMemberId:creditor.memberId,amountKrw});
    debtor.amountKrw -= amountKrw;
    creditor.amountKrw -= amountKrw;
    if (!debtor.amountKrw) debtorIndex++;
    if (!creditor.amountKrw) creditorIndex++;
  }
  return {spentKrw,balances,transfers};
}
