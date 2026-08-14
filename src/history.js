import { appendFile, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.jsonl");

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

function channelOf(entry) {
  const c = entry && typeof entry.channel === "string" ? entry.channel.trim() : "";
  return c || "console";
}

/** 대화 1건을 history.jsonl 에 한 줄(JSON)로 추가 */
export async function appendHistory(entry) {
  await ensureDir();
  const row =
    entry && typeof entry === "object"
      ? { ...entry, channel: channelOf(entry) }
      : entry;
  await appendFile(HISTORY_FILE, JSON.stringify(row) + "\n", "utf8");
}

async function readAll() {
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
    return items;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/** 저장된 대화 내역. channel 을 주면 그 채널만 (console | ask:<keyId>). */
export async function readHistory(limit, channel) {
  let items = await readAll();
  if (channel) {
    items = items.filter((it) => channelOf(it) === channel);
  }
  return limit && limit > 0 ? items.slice(-limit) : items;
}

/** 대화 내역 삭제. channel 생략 시 전체, 있으면 해당 채널만. */
export async function clearHistory(channel) {
  if (!channel) {
    await rm(HISTORY_FILE, { force: true });
    return;
  }
  const kept = (await readAll()).filter((it) => channelOf(it) !== channel);
  if (!kept.length) {
    await rm(HISTORY_FILE, { force: true });
    return;
  }
  await ensureDir();
  await writeFile(
    HISTORY_FILE,
    kept.map((it) => JSON.stringify(it) + "\n").join(""),
    "utf8",
  );
}
