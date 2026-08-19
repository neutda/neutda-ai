/**
 * PostgreSQL 연결 풀 (pgBackend 전용).
 * DATABASE_URL 로 접속. STORAGE_BACKEND=postgres 일 때만 실제 연결한다.
 */
import pg from "pg";

let pool = null;

export function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "STORAGE_BACKEND=postgres 인데 DATABASE_URL 이 없습니다. " +
        ".env 에 DATABASE_URL=postgres://user:pass@host:5432/dbname 을 설정하세요.",
    );
  }
  pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS) || 30000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 5000,
  });
  // 유휴 클라이언트 오류로 프로세스가 죽지 않게 (풀이 재연결 처리)
  pool.on("error", () => {});
  return pool;
}

/** 단발 쿼리 헬퍼. */
export function query(text, params) {
  return getPool().query(text, params);
}

/** 트랜잭션 실행 헬퍼. fn(client) 안에서 client.query 사용. */
export async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // 롤백 실패는 무시(연결 반납이 우선)
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 연결 확인 (init 시 fail-fast 용). */
export async function ping() {
  await query("SELECT 1");
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
