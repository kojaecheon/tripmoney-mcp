import type { Pool, PoolClient } from 'pg';
import { IdentityError, type Actor, type Member, type Role, type Trip } from '../../core/contracts.js';
import { withActor } from './actor.js';

// 서버 내부용 계약이다. HTTP 공개 DTO는 Task5에서 Auth 사용자 식별값을 제외해 별도 매핑한다.
export type ReadTrip = Trip & { ownerMemberId: string; role: Role };
const tripSelect = `select t.id,t.owner_user_id,t.name,t.destination,
  t.start_date::text as start_date,t.end_date::text as end_date,t.time_zone,
  t.budget_krw,t.settlement_mode,t.daily_time,t.revision,t.status,t.created_at,
  owner.id as owner_member_id,me.role as my_role
  from customer.trips t
  join customer.memberships owner on owner.trip_id=t.id and owner.role='owner' and owner.active
  join customer.memberships me on me.trip_id=t.id
    and me.user_id=customer_private.actor_id() and me.active`;

function corrupt(): never { throw new IdentityError('unavailable', '저장된 내용을 확인할 수 없습니다.'); }
function text(value: unknown): string { return typeof value === 'string' ? value : corrupt(); }
function integer(value: unknown, min: number): number {
  if ((typeof value !== 'string' || !/^[0-9]+$/.test(value)) && typeof value !== 'number') return corrupt();
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : corrupt();
}
function role(value: unknown): Role {
  return value === 'owner' || value === 'editor' || value === 'viewer' ? value : corrupt();
}
function trip(row: Record<string, unknown>): ReadTrip {
  const mode = row.settlement_mode;
  if ((mode !== 'daily' && mode !== 'end_of_trip') || row.status !== 'active') return corrupt();
  const created = row.created_at instanceof Date ? row.created_at : new Date(text(row.created_at));
  if (!Number.isFinite(created.getTime())) return corrupt();
  return { id: text(row.id), ownerUserId: text(row.owner_user_id), name: text(row.name),
    destination: text(row.destination), startDate: text(row.start_date), endDate: text(row.end_date),
    timeZone: text(row.time_zone), budgetKrw: integer(row.budget_krw, 0),
    settlementMode: mode, dailyTime: text(row.daily_time), revision: integer(row.revision, 1),
    status: 'active', createdAt: created.toISOString(), ownerMemberId: text(row.owner_member_id), role: role(row.my_role) };
}
async function readTrip(db: PoolClient, id: string): Promise<ReadTrip> {
  const result = await db.query(`${tripSelect} where t.id=$1 order by t.created_at desc,t.id asc`, [id]);
  if (!result.rows[0]) throw new IdentityError('not_found', '여행을 찾을 수 없습니다.');
  return trip(result.rows[0] as Record<string, unknown>);
}

export class IdentityRepository {
  constructor(private readonly app: Pool) {}
  listTrips(actor: Actor): Promise<ReadTrip[]> {
    return withActor(this.app, actor, async (db) => {
      const result = await db.query(`${tripSelect} order by t.created_at desc,t.id asc`, []);
      return result.rows.map((row: Record<string, unknown>) => trip(row));
    });
  }
  getTrip(actor: Actor, tripId: string): Promise<ReadTrip> {
    return withActor(this.app, actor, (db) => readTrip(db, tripId));
  }
  listMembers(actor: Actor, tripId: string): Promise<Member[]> {
    return withActor(this.app, actor, async (db) => {
      await readTrip(db, tripId);
      const result = await db.query(`select m.id,m.trip_id,m.user_id,m.alias,m.role,m.active
        from customer.memberships m where m.trip_id=$1 order by m.created_at asc,m.id asc`, [tripId]);
      return result.rows.map((row: Record<string, unknown>): Member => {
        if (typeof row.active !== 'boolean') return corrupt();
        return { id: text(row.id), tripId: text(row.trip_id), userId: text(row.user_id),
          alias: text(row.alias), role: role(row.role), active: row.active };
      });
    });
  }
}
