/**
 * data/*.json / *.jsonl → PostgreSQL 1회성 임포터.
 *
 * 사용:  DATABASE_URL=postgres://... node scripts/import-json-to-db.mjs
 *   (STORAGE_BACKEND 는 신경 안 씀 — 매퍼로 직접 기록. upsert 라 재실행 안전.)
 *
 * 대상: 이미 storage 계층으로 이행된 8개 저장소. rag/memory(벡터)는 별도.
 * FK 때문에 rule·knowledge_collection 을 apiKeys 보다 먼저 넣는다.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importStore, shutdownPg } from "../src/storage/pgBackend.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");

async function readJson(rel) {
  try {
    return JSON.parse(await readFile(path.join(DATA, rel), "utf-8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function readJsonl(rel) {
  let text;
  try {
    text = await readFile(path.join(DATA, rel), "utf-8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 손상 줄 skip */
    }
  }
  return out;
}

function log(name, n) {
  console.log(`  ✓ ${name}: ${n}건`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL 이 필요합니다.");
    process.exit(1);
  }
  console.log("[import] data/ → PostgreSQL\n");

  // 1) FK 선행: rule, knowledge_collection
  const rules = await readJson("rules.json");
  const ruleArr = Array.isArray(rules?.rules) ? rules.rules : [];
  await importStore("collection", "rules.json", ruleArr);
  log("rule", ruleArr.length);

  const know = await readJson("knowledge.json");
  const knowArr = Array.isArray(know?.collections) ? know.collections : [];
  await importStore("collection", "knowledge.json", knowArr);
  log("knowledge_collection", knowArr.length);

  // 2) apiKeys (+ 바인딩)
  const keys = await readJson("apiKeys.json");
  const keyArr = Array.isArray(keys?.keys) ? keys.keys : [];
  await importStore("collection", "apiKeys.json", keyArr);
  log("api_key", keyArr.length);

  // 3) 단일 문서 저장소
  const stats = await readJson("stats.json");
  if (stats) {
    await importStore("doc", "stats.json", stats);
    log("tier_stats/app_meta", Object.keys(stats.byTier || {}).length);
  }
  const keyStats = await readJson("keyStats.json");
  if (keyStats) {
    await importStore("doc", "keyStats.json", keyStats);
    log("key_stats", Object.keys(keyStats.keys || {}).length);
  }
  const serverStatus = await readJson("server-status.json");
  if (serverStatus) {
    await importStore("doc", "server-status.json", serverStatus);
    log("server_status", Object.keys(serverStatus).length);
  }

  // 4) append 로그
  const history = await readJsonl("history.jsonl");
  await importStore("appendlog", "history.jsonl", history);
  log("request_log", history.length);

  // 5) 키 문서: loadsessions/*.json
  let sessFiles = [];
  try {
    sessFiles = (await readdir(path.join(DATA, "loadsessions"))).filter((f) =>
      f.endsWith(".json"),
    );
  } catch {
    /* 폴더 없음 */
  }
  const sessions = [];
  for (const f of sessFiles) {
    try {
      const obj = JSON.parse(
        await readFile(path.join(DATA, "loadsessions", f), "utf-8"),
      );
      if (obj?.id) sessions.push({ id: obj.id, obj });
    } catch {
      /* skip */
    }
  }
  await importStore("keyed", "loadsessions", sessions);
  log("load_session", sessions.length);

  // 6) rag 인덱스 (docs+chunks+임베딩). 이미지 바이너리는 파일 유지.
  const ragIdx = await readJson("rag/index.json");
  if (ragIdx) {
    await importStore("doc", "rag/index.json", ragIdx);
    log(
      "rag_document/chunk",
      `${(ragIdx.docs || []).length} docs / ${(ragIdx.chunks || []).length} chunks`,
    );
  }

  // 7) 개인 장기기억 (uid 당 파일 → memory_entry)
  let memFiles = [];
  try {
    memFiles = (await readdir(path.join(DATA, "memory"))).filter((f) =>
      f.endsWith(".json"),
    );
  } catch {
    /* 폴더 없음 */
  }
  let memEntries = 0;
  for (const f of memFiles) {
    const uid = f.replace(/\.json$/, "");
    const obj = await readJson(path.join("memory", f));
    const entries = Array.isArray(obj?.entries) ? obj.entries : [];
    await importStore("keyed", "memory", [{ id: uid, obj: { entries } }]);
    memEntries += entries.length;
  }
  log("memory_entry", `${memFiles.length} uid / ${memEntries} entries`);

  console.log("\n✅ 임포트 완료");
  await shutdownPg();
}

main().catch(async (e) => {
  console.error("\n❌ 임포트 실패:", e.message);
  try {
    await shutdownPg();
  } catch {
    /* noop */
  }
  process.exit(1);
});
