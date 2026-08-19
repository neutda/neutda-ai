/**
 * chat_history → request_log 테이블/인덱스 rename (멱등).
 * 외부 API 요청 기록은 "채팅"이 아니므로 중립적 이름(request_log)으로 변경.
 * 콘솔 테스트 대화도 같은 테이블에 channel 로 구분되어 함께 들어간다.
 *
 * 사용:  node scripts/rename-chat-history-to-request-log.mjs
 */
import "dotenv/config";
import { query, ping, closePool } from "../src/storage/pg.js";

const STMTS = [
  // 테이블 rename (이미 바뀌었으면 skip)
  `DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'chat_history')
        AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'request_log') THEN
       ALTER TABLE chat_history RENAME TO request_log;
     END IF;
   END $$;`,
  // 인덱스 rename (IF EXISTS 로 재실행 안전)
  `ALTER INDEX IF EXISTS chat_history_channel_idx RENAME TO request_log_channel_idx`,
  `ALTER INDEX IF EXISTS chat_history_uid_idx     RENAME TO request_log_uid_idx`,
  `ALTER INDEX IF EXISTS chat_history_sid_idx     RENAME TO request_log_sid_idx`,
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL 이 필요합니다 (.env).");
    process.exit(1);
  }
  await ping();
  for (const sql of STMTS) {
    await query(sql);
    console.log("OK:", sql.replace(/\s+/g, " ").slice(0, 80));
  }
  const t = await query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('chat_history','request_log') ORDER BY table_name`,
  );
  const idx = await query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'request_log' ORDER BY indexname`,
  );
  console.log("\n테이블:", t.rows.map((r) => r.table_name));
  console.log("request_log 인덱스:", idx.rows.map((r) => r.indexname));
  await closePool();
}

main().catch(async (e) => {
  console.error("rename 실패:", e.message);
  await closePool().catch(() => {});
  process.exit(1);
});
