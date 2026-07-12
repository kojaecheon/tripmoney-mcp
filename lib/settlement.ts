// 정산 핵심 로직 (순수 함수 - DB/네트워크 의존 없음, 테스트 용이)

export type Member = { id: string; name: string };

export type ExpenseForCalc = {
  id: string;
  payer_member_id: string | null;
  amount_base: number; // base 통화(보통 KRW) 환산 금액
  shares: { member_id: string; share_base: number }[];
};

export type SettleMode = "equal" | "shares" | "individual";

export type Transfer = { from: string; to: string; amount: number };

export type SettlementResult = {
  mode: SettleMode;
  base_currency: string;
  total: number;
  per_member: {
    member_id: string;
    name: string;
    paid: number; // 실제 지불액
    owed: number; // 부담해야 할 금액
    net: number; // paid - owed (양수면 받을 돈, 음수면 줄 돈)
  }[];
  transfers: Transfer[]; // 송금 횟수를 줄이는 제안 (그리디 휴리스틱, 누가 누구에게 얼마)
  excluded: { count: number; total: number }; // payer 미상(멤버 삭제 등) 지출 — 정산에서 제외된 금액
};

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * 균등 분배(N빵)를 잔차 손실 없이 나눈다 (largest-remainder).
 * total 을 n 명에게 센트(0.01) 단위로 나누되, 합이 정확히 total 과 일치하도록
 * 나머지 센트를 앞쪽 멤버부터 1센트씩 배분한다.
 * 예) 100을 3명 → [33.34, 33.33, 33.33] (합 100.00, 기존 33.33×3=99.99 결함 해소)
 */
export function splitEqually(total: number, n: number): number[] {
  if (n <= 0) return [];
  const cents = Math.round(total * 100);
  const base = Math.trunc(cents / n);
  const remainder = cents - base * n; // 0..n-1 (total 부호와 무관하게 분배)
  const sign = remainder >= 0 ? 1 : -1;
  let left = Math.abs(remainder);
  return Array.from({ length: n }, (_, i) => {
    const extra = i < left ? sign : 0;
    return (base + extra) / 100;
  });
}

/**
 * 비용 금액이 바뀔 때 기존 분담(share)을 새 총액에 맞춰 비례 재배분한다.
 * - 기존 분담 비율(equal/custom 모두)을 보존하고, 센트 잔차는 큰 share 부터 보정해 합 = newTotal.
 * - 기존 분담이 없거나 합이 0이면 균등(N빵)으로 재분배.
 */
export function rescaleShares(
  old: { member_id: string; share_base: number }[],
  newTotal: number
): { member_id: string; share_base: number }[] {
  if (old.length === 0) return [];
  const oldTotal = old.reduce((s, x) => s + x.share_base, 0);
  if (oldTotal <= 0) {
    const parts = splitEqually(newTotal, old.length);
    return old.map((s, i) => ({ member_id: s.member_id, share_base: parts[i] }));
  }
  const scaled = old.map((s) => ({
    member_id: s.member_id,
    cents: Math.round((s.share_base / oldTotal) * newTotal * 100),
  }));
  let diff = Math.round(newTotal * 100) - scaled.reduce((a, b) => a + b.cents, 0);
  const order = [...scaled].sort((a, b) => b.cents - a.cents);
  for (let i = 0; diff !== 0 && i < order.length; i++) {
    const d = diff > 0 ? 1 : -1;
    order[i].cents += d;
    diff -= d;
  }
  return scaled.map((s) => ({ member_id: s.member_id, share_base: s.cents / 100 }));
}

/**
 * 정산 계산
 * - equal      : 총액 N빵 (전원 균등 부담)
 * - shares     : 비용별 기록된 참여자 분담(share_base) 기준
 * - individual : 각자 지출 각자 부담 (송금 없음, 결산만)
 */
export function calculateSettlement(
  members: Member[],
  expenses: ExpenseForCalc[],
  mode: SettleMode,
  baseCurrency = "KRW"
): SettlementResult {
  const ids = members.map((m) => m.id);
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const paid = new Map<string, number>(ids.map((id) => [id, 0]));
  const owed = new Map<string, number>(ids.map((id) => [id, 0]));

  // payer 를 특정할 수 없는 지출(멤버 삭제로 payer_member_id=null 등)은 정산에서 제외한다.
  // 포함하면 어떤 멤버의 paid 에도 잡히지 않아 sum(net)=0 불변식이 깨진다(줄 사람만 있고 받을 사람 없음).
  const idSet = new Set(ids);
  const settleable: ExpenseForCalc[] = [];
  let excludedCount = 0;
  let excludedTotal = 0;
  for (const e of expenses) {
    if (e.payer_member_id && idSet.has(e.payer_member_id)) {
      settleable.push(e);
    } else {
      excludedCount++;
      excludedTotal += e.amount_base;
    }
  }

  let total = 0;
  for (const e of settleable) {
    total += e.amount_base;
    paid.set(e.payer_member_id!, paid.get(e.payer_member_id!)! + e.amount_base);
  }
  total = round(total);

  if (mode === "equal") {
    const n = ids.length || 1;
    const parts = splitEqually(total, n); // 잔차 손실 없는 N빵
    ids.forEach((id, i) => owed.set(id, parts[i] ?? 0));
  } else if (mode === "shares") {
    for (const e of settleable) {
      if (e.shares && e.shares.length > 0) {
        for (const s of e.shares) {
          if (owed.has(s.member_id))
            owed.set(s.member_id, owed.get(s.member_id)! + s.share_base);
        }
      } else if (e.payer_member_id && owed.has(e.payer_member_id)) {
        // 분담 정보가 없으면 결제자가 전액 부담으로 간주
        owed.set(e.payer_member_id, owed.get(e.payer_member_id)! + e.amount_base);
      }
    }
  } else {
    // individual: 각자 지출 각자 부담 → owed = paid
    ids.forEach((id) => owed.set(id, paid.get(id)!));
  }

  const per_member = ids.map((id) => {
    const p = round(paid.get(id)!);
    const o = round(owed.get(id)!);
    return { member_id: id, name: nameOf.get(id) ?? id, paid: p, owed: o, net: round(p - o) };
  });

  const transfers = minimizeTransfers(per_member);

  return {
    mode,
    base_currency: baseCurrency,
    total,
    per_member,
    transfers,
    excluded: { count: excludedCount, total: round(excludedTotal) },
  };
}

/**
 * 송금 횟수 축소 그리디 휴리스틱: 받을 사람(net>0)과 줄 사람(net<0)을
 * 금액 큰 순으로 매칭. 최소 송금 횟수(NP-hard)의 보장된 최적해는 아니나
 * 실무 규모(소수 인원)에서는 충분히 적은 횟수를 만든다.
 */
function minimizeTransfers(
  rows: { member_id: string; net: number }[]
): Transfer[] {
  const creditors = rows
    .filter((r) => r.net > 0.009)
    .map((r) => ({ id: r.member_id, amt: r.net }))
    .sort((a, b) => b.amt - a.amt);
  const debtors = rows
    .filter((r) => r.net < -0.009)
    .map((r) => ({ id: r.member_id, amt: -r.net }))
    .sort((a, b) => b.amt - a.amt);

  const transfers: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if (pay > 0.009) {
      transfers.push({ from: debtors[i].id, to: creditors[j].id, amount: round(pay) });
    }
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt < 0.01) i++;
    if (creditors[j].amt < 0.01) j++;
  }
  return transfers;
}
