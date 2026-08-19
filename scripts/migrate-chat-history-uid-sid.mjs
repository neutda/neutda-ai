/**
 * chat_history 에 uid/sid varchar(32) 컬럼 + 인덱스 추가 (멱등).
 * 요청 당시의 U_ID/S_ID 를 남겨 나중에 외부 시스템과 대조·검증하기 위함.
 *
 * 사용:  node scripts/migrate-chat-history-uid-sid.mjs
 * (.env 의 DATABASE_URL 사용. STORAGE_BACKEND=postgres 환경 전용)
 */
import "dotenv/config";
import { query, ping, closePool } from "../src/storage/pg.js";

const STMTS = [
  `ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS uid varchar(32)`,
  `ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS sid varchar(32)`,
  `CREATE INDEX IF NOT EXISTS chat_history_uid_idx ON chat_history (uid) WHERE uid IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS chat_history_sid_idx ON chat_history (sid) WHERE sid IS NOT NULL`,
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL 이 필요합니다 (.env).");
    process.exit(1);
  }
  await ping();
  for (const sql of STMTS) {
    await query(sql);
    console.log("OK:", sql);
  }
  const cols = await query(
    `SELECT column_name, data_type, character_maximum_length AS maxlen
       FROM information_schema.columns
      WHERE table_name = 'chat_history' AND column_name IN ('uid','sid')
      ORDER BY column_name`,
  );
  console.log("\nchat_history 컬럼 확인:");
  console.table(cols.rows);
  await closePool();
}

main().catch(async (e) => {
  console.error("migration 실패:", e.message);
  await closePool().catch(() => {});
  process.exit(1);
});
