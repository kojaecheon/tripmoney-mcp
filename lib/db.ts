// Supabase Postgres 연결 (custom schema `tripmoney` 직접 접근)
// 서버리스 환경: 전역 Pool 재사용, Transaction Pooler 연결 권장
import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL 환경변수가 설정되지 않았습니다.");
    }
    pool = new Pool({
      connectionString,
      max: 3,
      ssl: { rejectUnauthorized: false },
      // 모든 쿼리의 기본 스키마를 tripmoney 로
      options: "-c search_path=tripmoney,public",
    });
  }
  return pool;
}

export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const client = await getPool().connect();
  try {
    const res = await client.query(text, params);
    return res.rows as T[];
  } finally {
    client.release();
  }
}

export async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export type DbRunner = {
  q<T = any>(text: string, params?: any[]): Promise<T[]>;
  one<T = any>(text: string, params?: any[]): Promise<T | null>;
};

export async function tx<T>(fn: (db: DbRunner) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const db: DbRunner = {
    async q<T = any>(text: string, params: any[] = []): Promise<T[]> {
      const res = await client.query(text, params);
      return res.rows as T[];
    },
    async one<T = any>(text: string, params: any[] = []): Promise<T | null> {
      const rows = await db.q<T>(text, params);
      return rows[0] ?? null;
    },
  };

  try {
    await client.query("begin");
    const result = await fn(db);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
