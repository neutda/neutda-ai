import { appendLog } from "./storage/index.js";

// 영속: append 로그(JSONL) 저장소 (파일→DB 이행은 storage 계층에서 처리)
const log = appendLog("history.jsonl");

function channelOf(entry) {
  const c = entry && typeof entry.channel === "string" ? entry.channel.trim() : "";
  return c || "console";
}

/** 대화 1건을 history.jsonl 에 한 줄(JSON)로 추가 */
export async function appendHistory(entry) {
  const row =
    entry && typeof entry === "object"
      ? { ...entry, channel: channelOf(entry) }
      : entry;
  await log.append(row);
}

/** 저장된 대화 내역. channel 을 주면 그 채널만 (console | ask:<keyId>). */
export async function readHistory(limit, channel) {
  let items = await log.readAll();
  if (channel) {
    items = items.filter((it) => channelOf(it) === channel);
  }
  return limit && limit > 0 ? items.slice(-limit) : items;
}

/** 대화 내역 삭제. channel 생략 시 전체, 있으면 해당 채널만. */
export async function clearHistory(channel) {
  if (!channel) {
    await log.clear();
    return;
  }
  const kept = (await log.readAll()).filter((it) => channelOf(it) !== channel);
  if (!kept.length) {
    await log.clear();
    return;
  }
  await log.overwrite(kept);
}
