/**
 * PostgreSQL 백엔드 — storage 추상화의 정규화 매핑 구현.
 *
 * 파일 백엔드와 동일한 팩토리 시그니처(docStore/collectionStore/appendLog/keyedDocStore)를
 * 제공하되, 각 저장소를 실제 정규화 테이블/컬럼에 매핑한다(docs/db-schema.md).
 *
 * 동기 접근 처리:
 *   도메인은 collectionStore.all()/get()/loadSync() 와 docStore.readSync() 를 "동기"로 쓴다.
 *   pg 드라이버는 비동기뿐이므로, 부팅 시 storage.init()→hydrate() 로 DB→인메모리 캐시를
 *   채운 뒤, 읽기는 캐시에서 동기로 서빙하고 쓰기는 캐시 갱신 + DB write-through 로 처리한다.
 *   (쓰기는 저장소별 프라미스 체인으로 직렬화. flush() 로 대기 가능.)
 *
 * keyStats·server-status 는 값이 "중첩 map/집계 블롭"이라 고정 컬럼으로 분해되지 않으므로
 * jsonb 페이로드(key_stats.data / server_status.data)에 저장한다(docs/db-schema.md 참고).
 */
import { query, withTx, ping, closePool } from "./pg.js";
import { logger } from "../logger.js";

/** init() 시 하이드레이션할 캐시형 저장소 목록 */
const hydratables = [];

function isoOrNull(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// ── pgvector 직렬화: 배열 ⇄ '[a,b,c]' 텍스트 ───────────────────────────
// 임베딩 차원(현재 모델 5120)이 pgvector ANN 인덱스 한계(vector 2000)를 넘어
// HNSW 인덱스가 없다. 저장은 vector(무차원) 컬럼, 검색은 도메인(인메모리) 유지.
function toVec(arr) {
  return Array.isArray(arr) && arr.length ? `[${arr.join(",")}]` : null;
}
function fromVec(s) {
  if (s == null) return undefined;
  if (Array.isArray(s)) return s;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function groupIds(rows, keyField, valField) {
  const m = new Map();
  for (const r of rows) {
    const k = r[keyField];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r[valField]);
  }
  return m;
}

// ======================================================================
//  매퍼 — 저장소 name → 실제 테이블 SQL + 레코드⇄행 변환
// ======================================================================

// ---- api_key (+ api_key_collection / api_key_rule) --------------------
function rowToApiKey(row, collectionIds, ruleIds) {
  return {
    id: row.id,
    key: row.secret,
    name: row.name,
    enabled: row.enabled,
    allowedTiers: row.allowed_tiers,
    tokenLimit: row.token_limit == null ? null : Number(row.token_limit),
    tokenUsed: Number(row.token_used),
    knowledge: {
      collectionIds: collectionIds || [],
      mode: row.knowledge_mode,
      topK: row.knowledge_topk,
    },
    rules: { ruleIds: ruleIds || [], allowCustom: row.allow_custom },
    limits: row.limits || {},
    reset: row.reset || {},
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
    lastUsedAt: isoOrNull(row.last_used_at),
  };
}

async function apiKeyUpsertTx(c, rec) {
  await c.query(
    `INSERT INTO api_key
       (id,secret,name,enabled,allowed_tiers,token_limit,token_used,
        knowledge_mode,knowledge_topk,allow_custom,limits,reset,
        created_at,updated_at,last_used_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (id) DO UPDATE SET
       secret=EXCLUDED.secret, name=EXCLUDED.name, enabled=EXCLUDED.enabled,
       allowed_tiers=EXCLUDED.allowed_tiers, token_limit=EXCLUDED.token_limit,
       token_used=EXCLUDED.token_used, knowledge_mode=EXCLUDED.knowledge_mode,
       knowledge_topk=EXCLUDED.knowledge_topk, allow_custom=EXCLUDED.allow_custom,
       limits=EXCLUDED.limits, reset=EXCLUDED.reset, created_at=EXCLUDED.created_at,
       updated_at=EXCLUDED.updated_at, last_used_at=EXCLUDED.last_used_at`,
    [
      rec.id,
      rec.key,
      rec.name ?? "",
      rec.enabled !== false,
      Array.isArray(rec.allowedTiers) ? rec.allowedTiers : [],
      rec.tokenLimit == null ? null : rec.tokenLimit,
      rec.tokenUsed ?? 0,
      rec.knowledge?.mode || "strict",
      rec.knowledge?.topK ?? 4,
      rec.rules?.allowCustom === true,
      JSON.stringify(rec.limits || {}),
      JSON.stringify(rec.reset || {}),
      rec.createdAt || new Date().toISOString(),
      rec.updatedAt || null,
      rec.lastUsedAt || null,
    ],
  );
  // 바인딩 재동기화 — 존재하는 id 만 넣어 FK 위반 방지
  await c.query(`DELETE FROM api_key_collection WHERE key_id=$1`, [rec.id]);
  const cids = rec.knowledge?.collectionIds || [];
  if (cids.length) {
    await c.query(
      `INSERT INTO api_key_collection (key_id, collection_id)
       SELECT $1, id FROM knowledge_collection WHERE id = ANY($2)
       ON CONFLICT DO NOTHING`,
      [rec.id, cids],
    );
  }
  await c.query(`DELETE FROM api_key_rule WHERE key_id=$1`, [rec.id]);
  const rids = rec.rules?.ruleIds || [];
  if (rids.length) {
    await c.query(
      `INSERT INTO api_key_rule (key_id, rule_id)
       SELECT $1, id FROM rule WHERE id = ANY($2)
       ON CONFLICT DO NOTHING`,
      [rec.id, rids],
    );
  }
}

const apiKeyMapper = {
  async selectAll() {
    const keys = (await query(`SELECT * FROM api_key`)).rows;
    const cols = (
      await query(`SELECT key_id, collection_id FROM api_key_collection`)
    ).rows;
    const rules = (await query(`SELECT key_id, rule_id FROM api_key_rule`)).rows;
    const colMap = groupIds(cols, "key_id", "collection_id");
    const ruleMap = groupIds(rules, "key_id", "rule_id");
    return keys.map((r) =>
      rowToApiKey(r, colMap.get(r.id), ruleMap.get(r.id)),
    );
  },
  upsert(rec) {
    return withTx((c) => apiKeyUpsertTx(c, rec));
  },
  upsertMany(arr) {
    return withTx(async (c) => {
      for (const rec of arr) await apiKeyUpsertTx(c, rec);
    });
  },
  async remove(id) {
    const r = await query(`DELETE FROM api_key WHERE id=$1`, [id]);
    return r.rowCount > 0;
  },
  deleteAll() {
    return query(`DELETE FROM api_key`);
  },
};

// ---- rule ------------------------------------------------------------
function rowToRule(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    keywords: row.keywords || [],
    schema: row.schema || {},
    intent: row.intent,
    instruction: row.instruction,
    skipRag: row.skip_rag,
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
  };
}
function ruleUpsert(c, rec) {
  return c.query(
    `INSERT INTO rule (id,name,enabled,keywords,schema,intent,instruction,skip_rag,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, enabled=EXCLUDED.enabled, keywords=EXCLUDED.keywords,
       schema=EXCLUDED.schema, intent=EXCLUDED.intent, instruction=EXCLUDED.instruction,
       skip_rag=EXCLUDED.skip_rag, created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at`,
    [
      rec.id,
      rec.name,
      rec.enabled !== false,
      Array.isArray(rec.keywords) ? rec.keywords : [],
      JSON.stringify(rec.schema || {}),
      rec.intent ?? "",
      rec.instruction ?? "",
      rec.skipRag !== false,
      rec.createdAt || new Date().toISOString(),
      rec.updatedAt || null,
    ],
  );
}
const ruleMapper = {
  async selectAll() {
    return (await query(`SELECT * FROM rule`)).rows.map(rowToRule);
  },
  upsert(rec) {
    return withTx((c) => ruleUpsert(c, rec));
  },
  upsertMany(arr) {
    return withTx(async (c) => {
      for (const rec of arr) await ruleUpsert(c, rec);
    });
  },
  async remove(id) {
    const r = await query(`DELETE FROM rule WHERE id=$1`, [id]);
    return r.rowCount > 0;
  },
  deleteAll() {
    return query(`DELETE FROM rule`);
  },
};

// ---- knowledge_collection --------------------------------------------
function rowToCollection(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
  };
}
function collectionUpsert(c, rec) {
  return c.query(
    `INSERT INTO knowledge_collection (id,name,description,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, description=EXCLUDED.description,
       created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at`,
    [
      rec.id,
      rec.name,
      rec.description ?? "",
      rec.createdAt || new Date().toISOString(),
      rec.updatedAt || null,
    ],
  );
}
const collectionMapper = {
  async selectAll() {
    return (await query(`SELECT * FROM knowledge_collection`)).rows.map(
      rowToCollection,
    );
  },
  upsert(rec) {
    return withTx((c) => collectionUpsert(c, rec));
  },
  upsertMany(arr) {
    return withTx(async (c) => {
      for (const rec of arr) await collectionUpsert(c, rec);
    });
  },
  async remove(id) {
    const r = await query(`DELETE FROM knowledge_collection WHERE id=$1`, [id]);
    return r.rowCount > 0;
  },
  deleteAll() {
    return query(`DELETE FROM knowledge_collection`);
  },
};

const COLLECTION_MAPPERS = {
  "apiKeys.json": apiKeyMapper,
  "rules.json": ruleMapper,
  "knowledge.json": collectionMapper,
};

// ---- stats (tier_stats + app_meta) -----------------------------------
const statsMapper = {
  async read() {
    const tiers = (
      await query(`SELECT tier,requests,tokens,total_ms FROM tier_stats`)
    ).rows;
    const meta = (
      await query(`SELECT value FROM app_meta WHERE key='stats.since'`)
    ).rows[0];
    if (!tiers.length && !meta) return null;
    const byTier = {};
    for (const r of tiers) {
      byTier[r.tier] = {
        requests: Number(r.requests),
        tokens: Number(r.tokens),
        totalMs: Number(r.total_ms),
      };
    }
    return { since: meta ? meta.value : undefined, byTier };
  },
  save(obj) {
    const byTier = obj?.byTier || {};
    const since = obj?.since;
    return withTx(async (c) => {
      for (const tier of ["small", "medium", "large"]) {
        const t = byTier[tier];
        if (!t) continue;
        await c.query(
          `INSERT INTO tier_stats (tier,requests,tokens,total_ms)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (tier) DO UPDATE SET
             requests=EXCLUDED.requests, tokens=EXCLUDED.tokens, total_ms=EXCLUDED.total_ms`,
          [tier, t.requests || 0, t.tokens || 0, t.totalMs || 0],
        );
      }
      if (since != null) {
        await c.query(
          `INSERT INTO app_meta (key,value) VALUES ('stats.since',$1)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
          [JSON.stringify(since)],
        );
      }
    });
  },
};

// ---- keyStats (key_stats.data jsonb, 키당 1행) ------------------------
const keyStatsMapper = {
  async read() {
    const rows = (await query(`SELECT key_id, data FROM key_stats`)).rows;
    const keys = {};
    for (const r of rows) keys[r.key_id] = r.data;
    return { keys };
  },
  save(obj) {
    const keys = obj?.keys || {};
    const ids = Object.keys(keys);
    return withTx(async (c) => {
      if (ids.length) {
        await c.query(`DELETE FROM key_stats WHERE key_id <> ALL($1)`, [ids]);
      } else {
        await c.query(`DELETE FROM key_stats`);
      }
      for (const kid of ids) {
        await c.query(
          `INSERT INTO key_stats (key_id,data) VALUES ($1,$2)
           ON CONFLICT (key_id) DO UPDATE SET data=EXCLUDED.data`,
          [kid, JSON.stringify(keys[kid])],
        );
      }
    });
  },
};

// ---- server_status (server_status.data jsonb, 서버명당 1행) -----------
const serverStatusMapper = {
  async read() {
    const rows = (await query(`SELECT name, data FROM server_status`)).rows;
    const map = {};
    for (const r of rows) map[r.name] = r.data || {};
    return map;
  },
  save(map) {
    const entries = Object.entries(map || {});
    return withTx(async (c) => {
      await c.query(`DELETE FROM server_status`);
      for (const [name, v] of entries) {
        // error/at 컬럼도 채워 SQL 조회 편의를 준다(원본은 data jsonb)
        await c.query(
          `INSERT INTO server_status (name,error,at,data) VALUES ($1,$2,$3,$4)`,
          [
            name,
            v?.error ?? null,
            v?.at ? new Date(v.at) : null,
            JSON.stringify(v ?? {}),
          ],
        );
      }
    });
  },
};

// ---- rag 인덱스 (rag_document + rag_chunk) — 값 {docs, chunks} -----------
// 이미지 바이너리는 파일(data/rag/images)로 유지, DB 엔 image_file 참조만.
const ragMapper = {
  async read() {
    const docRows = (await query(`SELECT * FROM rag_document`)).rows;
    const chunkRows = (await query(`SELECT * FROM rag_chunk`)).rows;
    if (!docRows.length && !chunkRows.length) return null;
    const docs = docRows.map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: isoOrNull(d.created_at),
      chunkCount: d.chunk_count,
      kind: d.kind || undefined,
      imageFile: d.image_file || undefined,
      collectionId: d.collection_id ?? null,
      summary: d.summary || undefined,
      questions: d.questions || undefined,
    }));
    const chunks = chunkRows.map((c) => ({
      id: c.id,
      docId: c.doc_id,
      docName: c.doc_name,
      idx: c.idx,
      text: c.text,
      kind: c.kind || "text",
      imageFile: c.image_file || null,
      collectionId: c.collection_id ?? null,
      embedding: fromVec(c.embedding),
    }));
    return { docs, chunks };
  },
  save(obj) {
    const docs = Array.isArray(obj?.docs) ? obj.docs : [];
    const chunks = Array.isArray(obj?.chunks) ? obj.chunks : [];
    return withTx(async (c) => {
      await c.query(`DELETE FROM rag_document`); // rag_chunk / rag_image CASCADE
      for (const d of docs) {
        await c.query(
          `INSERT INTO rag_document (id,collection_id,name,chunk_count,summary,questions,kind,image_file,created_at)
           VALUES ($1,(SELECT id FROM knowledge_collection WHERE id=$2),$3,$4,$5,$6,$7,$8,$9)`,
          [
            d.id,
            d.collectionId ?? null,
            d.name,
            d.chunkCount ?? 0,
            d.summary ?? null,
            d.questions ? JSON.stringify(d.questions) : null,
            d.kind ?? null,
            d.imageFile ?? null,
            d.createdAt || new Date().toISOString(),
          ],
        );
      }
      for (const ch of chunks) {
        await c.query(
          `INSERT INTO rag_chunk (id,doc_id,idx,text,embedding,kind,image_file,doc_name,collection_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            ch.id,
            ch.docId,
            ch.idx,
            ch.text,
            toVec(ch.embedding),
            ch.kind ?? null,
            ch.imageFile ?? null,
            ch.docName ?? null,
            ch.collectionId ?? null,
          ],
        );
      }
    });
  },
};

const DOC_MAPPERS = {
  "stats.json": statsMapper,
  "keyStats.json": keyStatsMapper,
  "server-status.json": serverStatusMapper,
  "rag/index.json": ragMapper,
};

// ---- request_log (요청/응답 append 로그) -----------------------------
// 콘솔 테스트 대화 + 외부 API 호출을 함께 담는다(channel 로 구분). "채팅" 전용이 아니라
// 요청 로그이므로 request_log. uid/sid 는 요청 당시의 U_ID/S_ID (varchar(32)) —
// 나중에 외부 시스템과 대조·검증용. 컬럼 상한(32자)을 넘지 않도록 방어적으로 자른다.
function clip32(v) {
  return v == null ? null : String(v).slice(0, 32);
}
const requestLogMapper = {
  append(record) {
    return query(
      `INSERT INTO request_log (channel,ts,uid,sid,entry) VALUES ($1, now(), $2, $3, $4)`,
      [
        record?.channel || "console",
        clip32(record?.uid),
        clip32(record?.sid),
        JSON.stringify(record),
      ],
    );
  },
  async readAll() {
    return (await query(`SELECT entry FROM request_log ORDER BY id ASC`)).rows.map(
      (r) => r.entry,
    );
  },
  overwrite(records) {
    return withTx(async (c) => {
      await c.query(`DELETE FROM request_log`);
      for (const rec of records || []) {
        await c.query(
          `INSERT INTO request_log (channel,ts,uid,sid,entry) VALUES ($1, now(), $2, $3, $4)`,
          [
            rec?.channel || "console",
            clip32(rec?.uid),
            clip32(rec?.sid),
            JSON.stringify(rec),
          ],
        );
      }
    });
  },
  clear() {
    return query(`DELETE FROM request_log`);
  },
};

const APPENDLOG_MAPPERS = { "history.jsonl": requestLogMapper };

// ---- load_session (keyed doc) ----------------------------------------
const loadSessionMapper = {
  put(id, obj) {
    return query(
      `INSERT INTO load_session (id,label,state,started_at,ended_at,duration_ms,report)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         label=EXCLUDED.label, state=EXCLUDED.state, started_at=EXCLUDED.started_at,
         ended_at=EXCLUDED.ended_at, duration_ms=EXCLUDED.duration_ms, report=EXCLUDED.report`,
      [
        id,
        obj?.label ?? null,
        obj?.state ?? "",
        obj?.startedAt ? new Date(obj.startedAt) : null,
        obj?.endedAt ? new Date(obj.endedAt) : null,
        obj?.durationMs ?? null,
        JSON.stringify(obj ?? {}),
      ],
    );
  },
  async get(id) {
    const r = (await query(`SELECT report FROM load_session WHERE id=$1`, [id]))
      .rows[0];
    return r ? r.report : null;
  },
  async list() {
    return (await query(`SELECT report FROM load_session`)).rows.map(
      (r) => r.report,
    );
  },
  async remove(id) {
    const r = await query(`DELETE FROM load_session WHERE id=$1`, [id]);
    return r.rowCount > 0;
  },
};

// ---- 개인 장기기억 (memory_entry, uid 당 여러 행) — 값 {entries} --------
const memoryMapper = {
  put(uid, obj) {
    const entries = Array.isArray(obj?.entries) ? obj.entries : [];
    return withTx(async (c) => {
      await c.query(`DELETE FROM memory_entry WHERE uid=$1`, [uid]);
      for (const e of entries) {
        await c.query(
          `INSERT INTO memory_entry (uid, entry_id, text, ts, meta, embedding)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            uid,
            e.id ?? null,
            e.text ?? "",
            e.createdAt ? new Date(e.createdAt) : new Date(),
            e.meta ? JSON.stringify(e.meta) : null,
            toVec(e.embedding),
          ],
        );
      }
    });
  },
  async get(uid) {
    const rows = (
      await query(
        `SELECT entry_id,text,ts,meta,embedding FROM memory_entry WHERE uid=$1 ORDER BY id ASC`,
        [uid],
      )
    ).rows;
    if (!rows.length) return null;
    return {
      entries: rows.map((r) => ({
        id: r.entry_id ?? undefined,
        text: r.text,
        createdAt: isoOrNull(r.ts),
        meta: r.meta ?? undefined,
        embedding: fromVec(r.embedding),
      })),
    };
  },
  async list() {
    // memoryStore 는 uid별 get/put 만 사용 — 전수 조회는 미사용.
    const uids = (await query(`SELECT DISTINCT uid FROM memory_entry`)).rows;
    const out = [];
    for (const { uid } of uids) out.push(await this.get(uid));
    return out.filter(Boolean);
  },
  async remove(uid) {
    const r = await query(`DELETE FROM memory_entry WHERE uid=$1`, [uid]);
    return r.rowCount > 0;
  },
};

const KEYED_MAPPERS = {
  loadsessions: loadSessionMapper,
  memory: memoryMapper,
};

// ======================================================================
//  캐시형 저장소 (동기 접근용) — 하이드레이션 + write-through
// ======================================================================
function logErr(name, err) {
  logger.error(`[pg:${name}] ${err?.message || err}`);
}

/** 저장소별 쓰기 직렬화 체인 */
function serializer() {
  let chain = Promise.resolve();
  return {
    run(name, fn) {
      chain = chain.then(fn).catch((e) => logErr(name, e));
      return chain;
    },
    wait: () => chain,
  };
}

export function pgCollectionStore(name, opts = {}) {
  const mapper = COLLECTION_MAPPERS[name];
  if (!mapper)
    throw new Error(`pgBackend: collectionStore("${name}") 매퍼가 없습니다.`);
  const idField = opts.idField || "id";
  const sanitize = typeof opts.sanitize === "function" ? opts.sanitize : (x) => x;
  const w = serializer();
  let items = null;

  function ensure() {
    if (!items)
      throw new Error(
        `pgBackend: "${name}" 미하이드레이션 — storage.init() 를 먼저 호출하세요.`,
      );
    return items;
  }

  const store = {
    async __hydrate() {
      const rows = await mapper.selectAll();
      items = rows.map(sanitize).filter(Boolean);
    },
    loadSync: ensure,
    all: ensure,
    get(id) {
      return ensure().find((x) => x[idField] === id) || null;
    },
    upsert(rec) {
      ensure();
      const i = items.findIndex((x) => x[idField] === rec[idField]);
      if (i >= 0) items[i] = rec;
      else items.push(rec);
      w.run(name, () => mapper.upsert(rec));
      return rec;
    },
    remove(id) {
      ensure();
      const i = items.findIndex((x) => x[idField] === id);
      if (i === -1) return false;
      items.splice(i, 1);
      w.run(name, () => mapper.remove(id));
      return true;
    },
    persist() {
      const snapshot = ensure().slice();
      w.run(name, () => mapper.upsertMany(snapshot));
    },
    replaceAll(arr) {
      items = Array.isArray(arr) ? arr : [];
      const snapshot = items.slice();
      w.run(name, async () => {
        await mapper.deleteAll();
        await mapper.upsertMany(snapshot);
      });
      return items;
    },
    flush: () => w.wait(),
  };
  hydratables.push(store);
  return store;
}

export function pgDocStore(name, opts = {}) {
  const mapper = DOC_MAPPERS[name];
  if (!mapper) throw new Error(`pgBackend: docStore("${name}") 매퍼가 없습니다.`);
  // lazy: 부팅 하이드레이션을 건너뛴다(readSync 를 안 쓰는 비동기 전용 저장소 — 예: rag).
  const lazy = opts.lazy === true;
  const w = serializer();
  let cache;
  let hydrated = false;

  const store = {
    async __hydrate() {
      cache = await mapper.read();
      hydrated = true;
    },
    readSync() {
      if (!hydrated)
        throw new Error(
          `pgBackend: "${name}" 미하이드레이션 — storage.init() 를 먼저 호출하세요.`,
        );
      return cache ?? null;
    },
    async read() {
      if (!hydrated) {
        cache = await mapper.read();
        hydrated = true;
      }
      return cache ?? null;
    },
    save(obj) {
      cache = obj;
      hydrated = true;
      w.run(name, () => mapper.save(obj));
    },
    flush: () => w.wait(),
  };
  if (!lazy) hydratables.push(store);
  return store;
}

export function pgAppendLog(name) {
  const mapper = APPENDLOG_MAPPERS[name];
  if (!mapper) throw new Error(`pgBackend: appendLog("${name}") 매퍼가 없습니다.`);
  return {
    append: (rec) => mapper.append(rec),
    readAll: () => mapper.readAll(),
    overwrite: (recs) => mapper.overwrite(recs),
    clear: () => mapper.clear(),
  };
}

export function pgKeyedDocStore(name) {
  const mapper = KEYED_MAPPERS[name];
  if (!mapper)
    throw new Error(`pgBackend: keyedDocStore("${name}") 매퍼가 없습니다.`);
  return {
    put: (id, obj) => mapper.put(id, obj),
    get: (id) => mapper.get(id),
    list: () => mapper.list(),
    remove: (id) => mapper.remove(id),
  };
}

/**
 * data/*.json → DB 1회성 임포트용. 매퍼로 직접 기록(하이드레이션 불필요, idempotent).
 * kind: "collection" | "doc" | "appendlog" | "keyed"
 */
export async function importStore(kind, name, payload) {
  if (kind === "collection") {
    const m = COLLECTION_MAPPERS[name];
    if (!m) throw new Error(`매퍼 없음 collection:${name}`);
    return m.upsertMany(payload || []);
  }
  if (kind === "doc") {
    const m = DOC_MAPPERS[name];
    if (!m) throw new Error(`매퍼 없음 doc:${name}`);
    return m.save(payload);
  }
  if (kind === "appendlog") {
    const m = APPENDLOG_MAPPERS[name];
    if (!m) throw new Error(`매퍼 없음 appendlog:${name}`);
    return m.overwrite(payload || []);
  }
  if (kind === "keyed") {
    const m = KEYED_MAPPERS[name];
    if (!m) throw new Error(`매퍼 없음 keyed:${name}`);
    for (const { id, obj } of payload || []) await m.put(id, obj);
    return;
  }
  throw new Error(`알 수 없는 kind: ${kind}`);
}

/** 부팅 시: 연결 확인 후 모든 캐시형 저장소를 DB 에서 하이드레이션. */
export async function initPg() {
  await ping();
  for (const s of hydratables) await s.__hydrate();
  logger.info(
    `pg 저장소 하이드레이션 완료 (${hydratables.length}개 캐시형 저장소)`,
  );
}

/** 종료 시: 대기 중인 write-through 를 모두 반영하고 풀 종료. */
export async function flushPg() {
  await Promise.all(hydratables.map((s) => (s.flush ? s.flush() : null)));
}

export async function shutdownPg() {
  await flushPg();
  await closePool();
}
