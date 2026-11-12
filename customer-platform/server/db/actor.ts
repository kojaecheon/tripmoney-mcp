import type { Pool, PoolClient } from 'pg';
import { IdentityError, type Actor } from '../../core/contracts.js';

export function identityDbError(error: unknown): IdentityError {
  if (error instanceof IdentityError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  switch (code) {
    case 'P0401': return new IdentityError('unauthenticated', '다시 로그인해 주세요.');
    case 'P0403': return new IdentityError('forbidden', '이 작업을 할 권한이 없습니다.');
    case 'P0404': return new IdentityError('not_found', '여행을 찾을 수 없습니다.');
    case 'P0409': return new IdentityError('conflict', '최신 내용을 확인해 주세요.');
    case 'P0410': return new IdentityError('invite_unavailable', '사용할 수 없는 초대입니다.');
    case 'P0422': return new IdentityError('validation', '입력 내용을 확인해 주세요.');
    default: return new IdentityError('unavailable', '잠시 후 다시 시도해 주세요.');
  }
}

export async function withActor<T>(pool: Pool, actor: Actor, work: (db: PoolClient) => Promise<T>): Promise<T> {
  if (!actor || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(actor.userId)
    || !/^[0-9a-f]{64}$/.test(actor.sessionHash)) {
    throw new IdentityError('unauthenticated', '다시 로그인해 주세요.');
  }
  let db: PoolClient;
  try { db = await pool.connect(); } catch (error) { throw identityDbError(error); }
  let discard: Error | undefined;
  try {
    await db.query('begin');
    await db.query("select set_config('customer.actor_id',$1,true)", [actor.userId]);
    await db.query("select set_config('customer.session_hash',$1,true)", [actor.sessionHash]);
    await db.query('select customer_private.assert_actor()');
    const value = await work(db);
    await db.query('commit');
    return value;
  } catch (error) {
    try { await db.query('rollback'); }
    catch { discard = new Error('transaction_cleanup_failed'); }
    throw identityDbError(error);
  } finally {
    db.release(discard);
  }
}
