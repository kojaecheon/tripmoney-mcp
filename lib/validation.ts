export type ExpenseTripRefs = {
  payer_member_id?: string | null;
  schedule_id?: string | null;
  split_member_ids?: string[] | null;
  custom_shares?: { member_id: string; amount: number }[] | null;
};

export function validateExpenseTripRefs(
  refs: ExpenseTripRefs,
  allowed: { memberIds: Set<string>; scheduleIds: Set<string> }
): void {
  if (refs.payer_member_id && !allowed.memberIds.has(refs.payer_member_id)) {
    throw new Error("payer_member_id 가 이 여행방의 멤버가 아닙니다.");
  }

  if (refs.schedule_id && !allowed.scheduleIds.has(refs.schedule_id)) {
    throw new Error("schedule_id 가 이 여행방의 일정이 아닙니다.");
  }

  for (const memberId of refs.split_member_ids ?? []) {
    if (!allowed.memberIds.has(memberId)) {
      throw new Error(`split_member_ids 에 이 여행방 멤버가 아닌 id 가 포함되어 있습니다: ${memberId}`);
    }
  }

  for (const share of refs.custom_shares ?? []) {
    if (!allowed.memberIds.has(share.member_id)) {
      throw new Error(`custom_shares 에 이 여행방 멤버가 아닌 id 가 포함되어 있습니다: ${share.member_id}`);
    }
  }
}

export function validateCustomShareTotal(
  customShares: { member_id: string; amount: number }[] | undefined | null,
  amountBase: number
): void {
  if (!customShares || customShares.length === 0) {
    throw new Error("custom 모드에는 custom_shares 가 1개 이상 필요합니다.");
  }
  const total = customShares.reduce((sum, share) => sum + share.amount, 0);
  if (Math.abs(total - amountBase) > 0.01) {
    throw new Error(
      `custom_shares 합계(${Math.round(total * 100) / 100})가 비용 기준금액(${amountBase})과 일치하지 않습니다.`
    );
  }
}
