import { q, type DbRunner } from "./db.js";

export type AuditAction =
  | "member.add"
  | "schedule.add"
  | "schedule.update"
  | "expense.add"
  | "expense.update"
  | "expense.delete"
  | "itinerary.recommend.save"
  | "share_token.create"
  | "share_token.revoke";

export type AuditEventInput = {
  trip_id: string | null;
  actor_member_id?: string | null;
  action: AuditAction;
  target_type: "member" | "schedule" | "expense" | "trip";
  target_id?: string | null;
  payload?: Record<string, unknown>;
};

export async function recordAuditEvent(input: AuditEventInput, db?: DbRunner): Promise<void> {
  const runQ = db?.q ?? q;
  await runQ(
    `insert into tripmoney.audit_events(trip_id, actor_member_id, action, target_type, target_id, payload)
     values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      input.trip_id,
      input.actor_member_id ?? null,
      input.action,
      input.target_type,
      input.target_id ?? null,
      JSON.stringify(input.payload ?? {}),
    ]
  );
}
