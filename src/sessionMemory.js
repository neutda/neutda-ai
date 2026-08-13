/**
 * 단기(작업)기억 — S_ID 스코프.
 * 초기 구현: 인메모리 Map + 슬라이딩 TTL + 최근 N턴 cap.
 * 나중 Redis 교체 지점: get / append / clear 인터페이스만 유지.
 */

import { config } from "./config.js";

const DEFAULT_TTL_MS = config.sessionMemory.ttlMs; // 기본 2시간
const DEFAULT_MAX_TURNS = config.sessionMemory.maxTurns;
const DEFAULT_SWEEP_MS = config.sessionMemory.sweepMs; // 기본 5분

/** @type {Map<string, { turns: { role: string, content: string }[], expiresAt: number }>} */
const store = new Map();

let ttlMs = DEFAULT_TTL_MS;
let maxTurns = DEFAULT_MAX_TURNS;
let sweepMs = DEFAULT_SWEEP_MS;
/** @type {ReturnType<typeof setInterval> | null} */
let sweepTimer = null;

/** 테스트/설정용 */
export function configureSessionMemory(opts = {}) {
  if (Number.isFinite(opts.ttlMs) && opts.ttlMs > 0) ttlMs = opts.ttlMs;
  if (Number.isFinite(opts.maxTurns) && opts.maxTurns > 0) {
    maxTurns = Math.floor(opts.maxTurns);
  }
  if (Number.isFinite(opts.sweepMs) && opts.sweepMs >= 0) {
    sweepMs = opts.sweepMs;
    startSweep();
  }
}

function touch(entry) {
  entry.expiresAt = Date.now() + ttlMs;
}

function isExpired(entry) {
  return !entry || Date.now() > entry.expiresAt;
}

/**
 * 만료 세션 일괄 제거. 반환 = 삭제 건수.
 */
export function sweepExpired() {
  const now = Date.now();
  let n = 0;
  for (const [key, entry] of store) {
    if (!entry || now > entry.expiresAt) {
      store.delete(key);
      n++;
    }
  }
  return n;
}

export function startSweep(intervalMs = sweepMs) {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (!intervalMs || intervalMs <= 0) return;
  sweepMs = intervalMs;
  sweepTimer = setInterval(() => {
    sweepExpired();
  }, sweepMs);
  // Node 종료를 막지 않음
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

export function stopSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/**
 * @param {string} sid
 * @returns {{ role: string, content: string }[]}
 */
export function get(sid) {
  const key = String(sid || "").trim();
  if (!key) return [];
  const entry = store.get(key);
  if (!entry || isExpired(entry)) {
    if (entry) store.delete(key);
    return [];
  }
  touch(entry);
  return entry.turns.map((t) => ({ role: t.role, content: t.content }));
}

/**
 * @param {string} sid
 * @param {{ role: string, content: string }} turn
 */
export function append(sid, turn) {
  const key = String(sid || "").trim();
  if (!key) return;
  const role = turn?.role === "assistant" ? "assistant" : "user";
  const content = String(turn?.content ?? "");
  if (!content) return;

  let entry = store.get(key);
  if (!entry || isExpired(entry)) {
    entry = { turns: [], expiresAt: 0 };
    store.set(key, entry);
  }
  entry.turns.push({ role, content });
  if (entry.turns.length > maxTurns) {
    entry.turns = entry.turns.slice(-maxTurns);
  }
  touch(entry);
}

/**
 * @param {string} sid
 */
export function clear(sid) {
  const key = String(sid || "").trim();
  if (!key) return;
  store.delete(key);
}

/** 테스트/운영용 — 전체 비우기 */
export function clearAll() {
  store.clear();
}

/** Map 크기 (디버그) */
export function size() {
  return store.size;
}

// 모듈 로드 시 주기 sweep 시작
startSweep();
