/**
 * 인메모리 로그 버퍼(최근 N개 유지). 콘솔에도 함께 출력한다.
 * 레벨: info | warn | error
 */
const MAX = 1000;
const buffer = [];
let seq = 0;

export function addLog(level, message, meta = null) {
  const entry = {
    id: ++seq,
    ts: new Date().toISOString(),
    level,
    message: String(message),
    meta: meta ?? null,
  };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();

  const line = `[${entry.ts}] ${level.toUpperCase()} ${entry.message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  return entry;
}

export const logger = {
  debug: (m, meta) => addLog("debug", m, meta),
  info: (m, meta) => addLog("info", m, meta),
  warn: (m, meta) => addLog("warn", m, meta),
  error: (m, meta) => addLog("error", m, meta),
};

/**
 * 로그 조회.
 * @param {{ level?: string, limit?: number, sinceId?: number }} opts
 */
export function getLogs({ level = "all", limit = 300, sinceId = 0 } = {}) {
  let items = buffer;
  if (level && level !== "all") items = items.filter((e) => e.level === level);
  if (sinceId) items = items.filter((e) => e.id > sinceId);
  if (limit && items.length > limit) items = items.slice(items.length - limit);
  return items;
}
