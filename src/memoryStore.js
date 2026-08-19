/**
 * 장기(회상)기억 — U_ID 스코프 개인 RAG.
 * 저장: data/memory/<safeUid>.json
 * 검색: BM25 + (임베딩 있으면) 코사인. 문서 RAG(index.json)와 분리.
 *
 * 품질/성장 가드:
 * - recall 점수 하한(임계값) — 미달이면 주입 안 함
 * - 엔트리 최근 N개 cap — remember 시 오래된 것 폐기
 */
import { config } from "./config.js";
import { keyedDocStore } from "./storage/index.js";

// uid 당 개인기억 {entries} 영속 — file: data/memory/<uid>.json / postgres: memory_entry.
const store = keyedDocStore("memory");

/** @type {null | ((texts: string[]) => Promise<number[][]|null>)} */
let embedBatch = null;

/** uid → 로드된 엔트리 캐시 */
const cache = new Map();

/** 설정 (환경/테스트에서 configure 로 조정) */
let maxEntries = Math.max(
  20,
  Number(process.env.MEMORY_MAX_ENTRIES) || 200,
);
/** 코사인 유사도 하한 — 최고점이 이하면 회상 생략 */
let minScoreEmbedding = Number(process.env.MEMORY_MIN_SCORE_EMBED) || 0.32;
/**
 * BM25 점수 하한 (한글 bigram 스케일).
 * 관련 질의 예: ~0.6+, 단일어 매칭 ~1.0+. 무관 질의는 보통 0건.
 */
let minScoreBm25 = Number(process.env.MEMORY_MIN_SCORE_BM25) || 0.5;

export function setEmbedder(fn) {
  embedBatch = typeof fn === "function" ? fn : null;
}

export function configureMemoryStore(opts = {}) {
  if (Number.isFinite(opts.maxEntries) && opts.maxEntries > 0) {
    maxEntries = Math.floor(opts.maxEntries);
  }
  if (Number.isFinite(opts.minScoreEmbedding)) {
    minScoreEmbedding = opts.minScoreEmbedding;
  }
  if (Number.isFinite(opts.minScoreBm25)) {
    minScoreBm25 = opts.minScoreBm25;
  }
}

export function memoryStoreConfig() {
  return { maxEntries, minScoreEmbedding, minScoreBm25 };
}

function safeUid(uid) {
  return String(uid || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}


function tokenize(text) {
  const out = [];
  const lower = String(text).toLowerCase();
  const re = /[a-z0-9]+|[\uac00-\ud7a3]+/g;
  let m;
  while ((m = re.exec(lower)) !== null) {
    const tok = m[0];
    if (/[a-z0-9]/.test(tok[0])) {
      out.push(tok);
    } else if (tok.length === 1) {
      out.push(tok);
    } else {
      for (let i = 0; i < tok.length - 1; i++) {
        out.push(tok.slice(i, i + 2));
      }
    }
  }
  return out;
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 구버전 Q:/A: 통째 저장 → 사용자 발화만 추출.
 * 이미 사용자 원문이면 그대로.
 */
export function extractUserMemoryText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const m = raw.match(/^Q:\s*([\s\S]*?)\nA:\s*[\s\S]*$/i);
  if (m) return String(m[1] || "").trim();
  // 줄바꿈 없는 변형
  const m2 = raw.match(/^Q:\s*(.+?)\s+A:\s+/i);
  if (m2) return String(m2[1] || "").trim();
  return raw;
}

function hydrateEntry(e) {
  const text = extractUserMemoryText(e?.text);
  const entry = {
    ...e,
    text,
    embedding: Array.isArray(e.embedding) ? e.embedding : undefined,
  };
  entry.tokens = termFreq(tokenize(text || ""));
  entry.len = 0;
  for (const v of entry.tokens.values()) entry.len += v;
  return entry;
}

/**
 * @returns {Promise<{ entries: object[] }>}
 */
async function loadUser(uid) {
  const key = safeUid(uid);
  if (!key) return { entries: [] };
  if (cache.has(key)) return cache.get(key);

  const data = await store.get(key);
  let entries = Array.isArray(data?.entries) ? data.entries : [];

  let migrated = false;
  const cleaned = [];
  for (const e of entries) {
    const before = String(e?.text || "");
    const entry = hydrateEntry(e);
    if (!entry.text) continue;
    if (entry.text !== before.trim()) migrated = true;
    // 동일 문장 연속 중복 제거
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.text === entry.text) {
      migrated = true;
      continue;
    }
    cleaned.push(entry);
  }

  const state = { entries: cleaned };
  cache.set(key, state);
  // 구 Q/A 엔트리는 디스크에도 사용자 발화만 남기도록 지연 마이그레이션
  if (migrated) {
    persistUser(key, state).catch(() => {});
  }
  return state;
}

async function persistUser(uid, state) {
  const key = safeUid(uid);
  if (!key) return;
  const data = {
    entries: state.entries.map((e) => ({
      id: e.id,
      text: e.text,
      createdAt: e.createdAt,
      meta: e.meta || undefined,
      embedding: Array.isArray(e.embedding) ? e.embedding : undefined,
    })),
  };
  await store.put(key, data);
  cache.set(key, state);
}

function rebuildDf(entries) {
  const df = new Map();
  let total = 0;
  for (const e of entries) {
    if (!e.tokens) {
      e.tokens = termFreq(tokenize(e.text || ""));
      e.len = 0;
      for (const v of e.tokens.values()) e.len += v;
    }
    total += e.len;
    for (const term of e.tokens.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const avgdl = entries.length ? total / entries.length : 0;
  return { df, avgdl };
}

/**
 * Phase 3 임계값 가드: 최고점이 하한 미달이면 전부 버리고,
 * 통과해도 하한 미만 hit 은 제거.
 */
function applyScoreGuard(hits, mode) {
  if (!hits?.length) return [];
  const min =
    mode === "embedding" ? minScoreEmbedding : minScoreBm25;
  if (hits[0].score < min) return [];
  return hits.filter((h) => h.score >= min);
}

function bm25Retrieve(entries, query, k) {
  if (!entries.length) return [];
  const { df, avgdl } = rebuildDf(entries);
  const k1 = config.bm25.k1;
  const b = config.bm25.b;
  const N = entries.length;
  const qTokens = [...new Set(tokenize(query))];

  const scored = entries.map((e) => {
    let score = 0;
    for (const term of qTokens) {
      const tf = e.tokens.get(term);
      if (!tf) continue;
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = tf + k1 * (1 - b + (b * e.len) / (avgdl || 1));
      score += idf * ((tf * (k1 + 1)) / denom);
    }
    return { e, score };
  });

  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => ({
      id: s.e.id,
      text: s.e.text,
      score: Number(s.score.toFixed(4)),
      createdAt: s.e.createdAt,
      mode: "bm25",
    }));
  return applyScoreGuard(hits, "bm25");
}

/**
 * @param {string} uid
 * @param {string} text
 * @param {object} [meta]
 */
export async function remember(uid, text, meta) {
  const key = safeUid(uid);
  if (!key) return null;
  const body = extractUserMemoryText(text);
  if (!body) return null;

  const state = await loadUser(key);

  // 직전 엔트리와 동일하면 skip (중복 성장 방지)
  const last = state.entries[state.entries.length - 1];
  if (last && String(last.text || "").trim() === body) {
    return { id: last.id, createdAt: last.createdAt, skipped: true };
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const entry = {
    id,
    text: body,
    createdAt: new Date().toISOString(),
    meta: meta && typeof meta === "object" ? meta : undefined,
    tokens: termFreq(tokenize(body)),
    len: 0,
  };
  for (const v of entry.tokens.values()) entry.len += v;

  if (embedBatch) {
    try {
      const vectors = await embedBatch([body]);
      if (Array.isArray(vectors?.[0])) entry.embedding = vectors[0];
    } catch {
      /* BM25만으로도 동작 */
    }
  }

  state.entries.push(entry);
  if (state.entries.length > maxEntries) {
    state.entries = state.entries.slice(-maxEntries);
  }
  await persistUser(key, state);
  return { id, createdAt: entry.createdAt };
}

/**
 * @param {string} uid
 * @param {string} query
 * @param {number} [k]
 */
export async function recall(uid, query, k = config.rag.topK) {
  const key = safeUid(uid);
  if (!key) return [];
  const qFull = String(query || "").trim();
  if (!qFull) return [];
  // llama 임베딩 n_batch(512) 를 넘는 긴 질의는 앞부분만 쓴다.
  const q = qFull.length > 360 ? qFull.slice(0, 360) : qFull;
  const topK = Math.max(
    1,
    Math.min(config.rag.topKMax, Number(k) || config.rag.topK),
  );

  const state = await loadUser(key);
  const entries = state.entries;
  if (!entries.length) return [];

  const embedded = entries.filter((e) => Array.isArray(e.embedding));
  const coverage = entries.length ? embedded.length / entries.length : 0;

  if (embedBatch && coverage >= config.rag.vectorCoverageMin && embedded.length) {
    try {
      const qVecs = await embedBatch([q]);
      const qv = qVecs?.[0];
      if (Array.isArray(qv)) {
        const scored = embedded
          .map((e) => ({ e, score: cosine(qv, e.embedding) }))
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK)
          .map((s) => ({
            id: s.e.id,
            text: s.e.text,
            score: Number(s.score.toFixed(4)),
            createdAt: s.e.createdAt,
            mode: "embedding",
          }));
        const guarded = applyScoreGuard(scored, "embedding");
        if (guarded.length) return guarded;
        // 임베딩 최고점이 하한 미달이면 BM25 로 폴백하지 않음 —
        // 약한 회상으로 오도하는 것이 더 나쁨.
        if (scored.length) return [];
      }
    } catch {
      /* BM25 폴백 */
    }
  }

  return bm25Retrieve(entries, q, topK);
}

const MEMORY_HIT_CHARS = 400;
const MEMORY_CONTEXT_CHARS = 1200;

/** 프롬프트 주입용 블록 */
export function formatMemoryContext(hits) {
  if (!hits?.length) return "";
  const parts = [];
  let used = 0;
  for (let i = 0; i < hits.length; i++) {
    const raw = String(hits[i].text || "").trim();
    if (!raw) continue;
    const clipped =
      raw.length > MEMORY_HIT_CHARS ? raw.slice(0, MEMORY_HIT_CHARS) + "…" : raw;
    const block = `[기억 ${i + 1}] ${clipped}`;
    if (used + block.length > MEMORY_CONTEXT_CHARS) break;
    parts.push(block);
    used += block.length;
  }
  if (!parts.length) return "";
  return `### 개인 기억\n${parts.join("\n\n")}`;
}

/**
 * U_ID 장기기억 삭제 (파일 + 캐시).
 * @returns {Promise<{ ok: boolean, removed: boolean }>}
 */
export async function forget(uid) {
  const key = safeUid(uid);
  if (!key) return { ok: false, removed: false };
  cache.delete(key);
  const removed = await store.remove(key);
  return { ok: true, removed };
}

/** 테스트용 캐시 비우기 */
export function clearCache() {
  cache.clear();
}
