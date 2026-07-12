// 방 접근/권한 가드 + 여행방 참조 검증 + 분담 생성 공통 모듈
// MCP 표면(lib/server.ts)과 웹 표면(lib/mcpEngine.ts)이 동일 규칙을 공유하는 단일 소스.
// 인증 규칙을 고칠 때는 반드시 이 파일만 수정한다 (표면별 복제 금지 — 드리프트 방지).
import { q, one, type DbRunner } from "./db.js";
import { splitEqually } from "./settlement.js";
import { validateExpenseTripRefs, type ExpenseTripRefs } from "./validation.js";

export async function tripBaseCurrency(tripId: string): Promise<string> {
  const t = await one<{ base_currency: string }>(
    "select base_currency from tripmoney.trips where id = $1",
    [tripId]
  );
  if (!t) throw new Error("존재하지 않는 trip_id 입니다.");
  return t.base_currency;
}

/** 여행방에 api_key 가 설정돼 있으면 trip_key 일치 요구 (방 단위 접근 보호, 쓰기/전체 권한) */
export async function requireTripKey(tripId: string, providedKey?: string | null): Promise<void> {
  const t = await one<{ api_key: string | null }>(
    "select api_key from tripmoney.trips where id = $1",
    [tripId]
  );
  if (!t) throw new Error("존재하지 않는 trip_id 입니다.");
  if (t.api_key && t.api_key !== providedKey) {
    throw new Error("권한 없음: 이 여행방은 보호되어 있습니다. 올바른 trip_key 가 필요합니다.");
  }
}

/**
 * 읽기 접근 검증: trip_key(전체) 또는 share_token(읽기 전용) 중 하나가 일치하면 허용.
 * 조회 도구(getBudgetSummary/calculateSettlement)에서 사용한다.
 */
export async function requireReadAccess(tripId: string, providedKey?: string | null): Promise<void> {
  const t = await one<{ api_key: string | null; share_token: string | null }>(
    "select api_key, share_token from tripmoney.trips where id = $1",
    [tripId]
  );
  if (!t) throw new Error("존재하지 않는 trip_id 입니다.");
  if (!t.api_key) return; // 비보호(레거시) 방
  if (providedKey && (providedKey === t.api_key || (t.share_token && providedKey === t.share_token))) {
    return;
  }
  throw new Error("권한 없음: 올바른 trip_key 또는 share_token 이 필요합니다.");
}

/** actor_member_id 가 주어지면 (1) 해당 trip 의 멤버인지 + (2) viewer 가 아닌지 검증 */
export async function requireWriteRole(actorId: string | null | undefined, tripId: string): Promise<void> {
  if (!actorId) return;
  // trip_id 까지 일치를 강제 → 다른 여행방 멤버 id 를 빌려와 통과하는 우회 차단
  const m = await one<{ role: string }>(
    "select role from tripmoney.members where id = $1 and trip_id = $2",
    [actorId, tripId]
  );
  if (!m) throw new Error("actor_member_id 가 이 여행방의 멤버가 아닙니다.");
  if (m.role === "viewer") throw new Error("권한 없음: viewer 는 수정할 수 없습니다.");
}

export async function tripMemberIds(tripId: string, db?: DbRunner): Promise<string[]> {
  const runQ = db?.q ?? q;
  const rows = await runQ<{ id: string }>(
    "select id from tripmoney.members where trip_id = $1 order by created_at",
    [tripId]
  );
  return rows.map((r) => r.id);
}

export async function tripScheduleIds(tripId: string, db?: DbRunner): Promise<string[]> {
  const runQ = db?.q ?? q;
  const rows = await runQ<{ id: string }>(
    "select id from tripmoney.schedules where trip_id = $1",
    [tripId]
  );
  return rows.map((r) => r.id);
}

export async function requireExpenseTripRefs(tripId: string, refs: ExpenseTripRefs): Promise<void> {
  const [memberIds, scheduleIds] = await Promise.all([
    tripMemberIds(tripId),
    tripScheduleIds(tripId),
  ]);
  validateExpenseTripRefs(refs, {
    memberIds: new Set(memberIds),
    scheduleIds: new Set(scheduleIds),
  });
}

/** 비용 분담(expense_shares) 생성 */
export async function createShares(
  db: DbRunner,
  tripId: string,
  expenseId: string,
  amountBase: number,
  splitMode: "equal" | "custom" | "payer",
  splitMemberIds?: string[],
  customShares?: { member_id: string; amount: number }[]
) {
  if (splitMode === "payer") return; // 결제자 전액 부담 → 분담 없음
  if (splitMode === "custom") {
    for (const s of customShares ?? []) {
      await db.q(
        "insert into tripmoney.expense_shares(expense_id, member_id, share_base) values ($1,$2,$3) on conflict (expense_id,member_id) do update set share_base = excluded.share_base",
        [expenseId, s.member_id, s.amount]
      );
    }
    return;
  }
  // equal
  const participants =
    splitMemberIds && splitMemberIds.length > 0
      ? splitMemberIds
      : await tripMemberIds(tripId, db);
  if (participants.length === 0) return;
  const parts = splitEqually(amountBase, participants.length); // 잔차 손실 없는 N빵
  for (let i = 0; i < participants.length; i++) {
    await db.q(
      "insert into tripmoney.expense_shares(expense_id, member_id, share_base) values ($1,$2,$3) on conflict (expense_id,member_id) do update set share_base = excluded.share_base",
      [expenseId, participants[i], parts[i]]
    );
  }
}
