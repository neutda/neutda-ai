import { appendFile, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.jsonl");

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

/** 대화 1건을 history.jsonl 에 한 줄(JSON)로 추가 */
export async function appendHistory(entry) {
  await ensureDir();
  await appendFile(HISTORY_FILE, JSON.stringify(entry) + "\n", "utf8");
}

/** 저장된 대화 내역을 배열로 반환 (limit 지정 시 최근 limit 건) */
export async function readHistory(limit) {
  try {
    const text = await readFile(HISTORY_FILE, "utf8");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    const items = [];
    for (const line of lines) {
      try {
        items.push(JSON.parse(line));
      } catch {
        // 손상된 줄은 건너뜀
      }
    }
    return limit && limit > 0 ? items.slice(-limit) : items;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/** 대화 내역 전체 삭제 */
export async function clearHistory() {
  await rm(HISTORY_FILE, { force: true });
}
