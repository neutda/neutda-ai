/**
 * 저장소 추상화 진입점.
 *
 * 목적: 지금은 프로토타입이라 파일(JSON/JSONL)로 저장하지만, 실제 운영에서는
 * DB 로 관리할 예정이다. 도메인 모듈이 fs 를 직접 호출하지 않고 아래 팩토리만
 * 쓰면, DB 이행이 이 폴더 안(파일 백엔드 → DB 백엔드 추가 + 분기 한 줄)으로
 * 국소화된다.
 *
 * 저장소 종류(= 백엔드가 반드시 구현해야 하는 계약):
 *   docStore(name)        단일 문서   read() / readSync() / save(obj) / flush()
 *   collectionStore(name) 레코드 컬렉션 all() / get(id) / upsert(rec) / remove(id)
 *                                     / replaceAll(arr) / loadSync() / flush()
 *   appendLog(name)       append 로그  append(rec) / readAll() / overwrite(recs) / clear()
 *
 * DB 이행 절차:
 *   1) src/storage/<db>Backend.js 에 위 세 팩토리를 같은 시그니처로 구현
 *      (collectionStore.upsert → SQL upsert, remove → DELETE, docStore → 단일 행/KV,
 *       appendLog → append 전용 테이블 등)
 *   2) 아래 BACKEND 분기에 케이스 추가
 *   3) data/*.json → DB 로 옮기는 1회성 임포터 작성
 *   name 은 논리 이름(파일명)일 뿐이므로 DB 백엔드에선 테이블명 매핑으로 해석하면 된다.
 */
import "dotenv/config"; // STORAGE_BACKEND/DATABASE_URL 를 읽기 전에 .env 로드 보장(idempotent)
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileDocStore,
  fileCollectionStore,
  fileAppendLog,
  fileKeyedDocStore,
} from "./fileBackend.js";
import {
  pgDocStore,
  pgCollectionStore,
  pgAppendLog,
  pgKeyedDocStore,
  initPg,
  flushPg,
  shutdownPg,
} from "./pgBackend.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** 모든 파일 저장소의 기준 디렉터리 (기본 <repo>/data, DATA_DIR 로 재정의). */
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));

/** 선택된 백엔드. 파일 외 값은 아직 미구현(부팅 시 명확히 실패). */
export const STORAGE_BACKEND = (process.env.STORAGE_BACKEND || "file")
  .trim()
  .toLowerCase();

function resolveFile(name) {
  return path.join(DATA_DIR, name);
}

function unsupported(kind) {
  throw new Error(
    `STORAGE_BACKEND="${STORAGE_BACKEND}" 은 아직 ${kind} 를 지원하지 않습니다. ` +
      `현재는 file 백엔드만 구현되어 있습니다 (src/storage/README.md 참고).`,
  );
}

/** 단일 JSON 문서 저장소. */
export function docStore(name, opts = {}) {
  if (STORAGE_BACKEND === "file") return fileDocStore(resolveFile(name), opts);
  if (STORAGE_BACKEND === "postgres") return pgDocStore(name, opts);
  return unsupported("docStore");
}

/** 레코드 컬렉션 저장소. */
export function collectionStore(name, opts = {}) {
  if (STORAGE_BACKEND === "file")
    return fileCollectionStore(resolveFile(name), opts);
  if (STORAGE_BACKEND === "postgres") return pgCollectionStore(name, opts);
  return unsupported("collectionStore");
}

/** append 로그 저장소(JSONL). */
export function appendLog(name, opts = {}) {
  if (STORAGE_BACKEND === "file") return fileAppendLog(resolveFile(name), opts);
  if (STORAGE_BACKEND === "postgres") return pgAppendLog(name, opts);
  return unsupported("appendLog");
}

/** id 로 키된 다중 문서 저장소 (name = 디렉터리). */
export function keyedDocStore(name, opts = {}) {
  if (STORAGE_BACKEND === "file")
    return fileKeyedDocStore(resolveFile(name), opts);
  if (STORAGE_BACKEND === "postgres") return pgKeyedDocStore(name, opts);
  return unsupported("keyedDocStore");
}

/**
 * 저장소 계층 초기화. postgres 백엔드면 연결 확인 + 캐시형 저장소 하이드레이션.
 * 서버는 요청을 받기 전(app.listen 전)에 반드시 await 해야 한다. file 백엔드는 no-op.
 */
export async function init() {
  if (STORAGE_BACKEND === "postgres") await initPg();
}

/** 대기 중인 write-through 를 모두 반영(연결은 유지). file 백엔드는 no-op. */
export async function flush() {
  if (STORAGE_BACKEND === "postgres") await flushPg();
}

/** 종료 시: 대기 중인 쓰기 반영 + 연결 종료 (file 백엔드는 no-op). */
export async function shutdown() {
  if (STORAGE_BACKEND === "postgres") await shutdownPg();
}
