# DB 스키마 설계 초안 (neutda-ai)

프로토타입은 파일(JSON/JSONL)로 저장하지만, 실제 운영 데이터는 DB 로 관리한다.
`src/storage/` 추상화 계층이 이미 도메인 코드와 저장 매체를 분리해 두었으므로, 이 문서의
스키마대로 DB 백엔드(`src/storage/pgBackend.js`)를 구현하고 임포터로 옮기면 이행이 끝난다.

> 상태: **구현·검증 완료**(`STORAGE_BACKEND=postgres`). 실DB 왕복 테스트 통과.
> 아래 §2.1 은 구현하며 원안에서 조정된 2가지(정직한 매핑을 위한 불가피한 변경)입니다.

## 2.1 원안 대비 조정 (구현 반영)

블롭 형태라 고정 컬럼으로 정규화가 안 되는 두 저장소는 jsonb 페이로드로 저장한다:

- **`keyStats`** → **`key_stats(key_id text PK, data jsonb)`** 신설 사용.
  이유: keyStats 블롭은 "시간별 합계"와 "티어별 합계"를 각각 **주변합**으로만 갖고 있어
  `(시간 × 티어)` 결합 셀(`key_stat_hourly`)로 복원 불가. 관측용 데이터라 키당 1행 jsonb 가 충실·안전.
  → 원안의 `key_stat_hourly`·`key_error` 는 **현재 미사용**(향후 keyStats 를 증분기록식으로
  재설계하면 활용 가능).
- **`server_status`** → 컬럼 `data jsonb` **추가**(`ALTER TABLE server_status ADD COLUMN data jsonb`).
  이유: 서버별 상태가 `error/at` 뿐 아니라 `running{ngl,ctx,parallel,gpu,at}`·`pendingRestart` 중첩
  필드도 담음. `data` 에 전체 객체를 저장(편의상 `error/at` 컬럼도 함께 채움).

### 벡터 저장소 (rag / memory) — ⚠️ 중요 제약

`rag.js`·`memoryStore.js` 를 이행하며 확인된 사실: **현재 임베딩 모델의 차원은 5120**이다.
그런데 **pgvector 의 ANN 인덱스(HNSW)는 `vector` 기준 최대 2000차원**만 지원한다(halfvec 4000).
→ **5120차원은 ANN 인덱스 불가.** 따라서:

- `rag_chunk.embedding`·`memory_entry.embedding` 을 `vector(1024)` → **`vector`(무차원)** 으로 변경,
  **HNSW 인덱스 제거**. 임베딩은 `vector` 로 저장돼 `<=>` 코사인 연산은 가능하나 **브루트포스**만 됨.
- 그래서 **검색은 현행처럼 도메인(인메모리)에서** 수행하고, DB 는 **영속**만 담당한다
  (rag: `docStore("rag/index.json")`→`rag_document`+`rag_chunk`, memory: `keyedDocStore("memory")`→`memory_entry`).
- **ANN 을 켜려면 임베딩 모델을 ≤2000차원으로 교체**해야 함(그때 `vector(N)` + HNSW 인덱스 부여 →
  in-DB ANN 검색으로 전환 가능). 이게 "브루트포스 코사인 제거"의 전제조건.

추가 컬럼(파일 저장이 쓰던 denormalized 필드 보존): `rag_document`(kind, image_file),
`rag_chunk`(kind, image_file, doc_name, collection_id), `memory_entry`(entry_id, meta).
RAG 이미지 바이너리는 파일(`data/rag/images`) 유지, DB 엔 `image_file` 참조만.

---

## 1. DB 선택

**권장: PostgreSQL 16 + `pgvector`**

- 관계형(키·통계·히스토리·바인딩)에 강하고, 유연한 값 객체는 `JSONB` 로 수용.
- **RAG/기억 임베딩을 `pgvector` 의 ANN 인덱스(HNSW)로 검색** → 현재의 브루트포스 코사인
  (전체 청크 O(n) 스캔) 문제가 근본 해소된다. 이게 DB 이행의 가장 큰 실익.
- 시간축 통계(키별 시간버킷)는 파티셔닝/롤오프로 바운드.

**단일 노드 대안: SQLite + `sqlite-vec`**

- 운영 부담 최소. 다만 다중 프로세스(부모+agent 가 같은 DB) 동시쓰기에 약하므로,
  분산 구성이면 Postgres 를 권장.

이 문서 DDL 은 Postgres 기준이다. 타입 매핑만 바꾸면 SQLite 에도 적용된다.

---

## 2. 저장소 계층 ↔ 테이블 매핑

| 도메인 모듈 | storage 종류 | 테이블 |
| --- | --- | --- |
| `apiKeys.js` | `collectionStore` | `api_key` (+ `api_key_collection`, `api_key_rule`) |
| `rulesStore.js` | `collectionStore` | `rule` |
| `knowledgeStore.js` | `collectionStore` | `knowledge_collection` |
| `stats.js` | `docStore` | `tier_stats` + `app_meta` |
| `keyStats.js` | `docStore` | `key_stat_hourly` + `key_error` |
| `serverManager.js` | `docStore` | `server_status` |
| `history.js` | `appendLog` | `request_log` |
| `loadSession.js` | `keyedDocStore` | `load_session` |
| `rag.js` | **`vectorStore`(신설)** | `rag_document` · `rag_chunk` · `rag_image` |
| `memoryStore.js` | **`vectorStore`(신설)** | `memory_entry` |
| `sessionMemory.js` | (휘발성) | Redis 권장 / 필요 시 `session_memory` |

> `collectionStore.upsert` → SQL `INSERT … ON CONFLICT (id) DO UPDATE`, `remove` → `DELETE`,
> `appendLog.append` → `INSERT`, `keyedDocStore.put` → id PK upsert.
> 벡터 저장소는 계약이 다르므로(`indexDoc`/`search(queryVec, topK)`) 별도 팩토리를 신설한다.

---

## 3. DDL

ID 는 앱이 생성하는 접두어 문자열(`k_`, `kc_`, `rl_`, `ls_`, 문서 id 등)을 그대로 **text PK**
로 보존한다(참조 무결성·임포트 단순화). 임의로 serial/uuid 로 바꾸지 않는다.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- ===== 전역 메타/통계 =====
CREATE TABLE app_meta (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);  -- 예: ('stats.since', '"2026-08-01T..."')

CREATE TABLE tier_stats (
  tier     text PRIMARY KEY,           -- small | medium | large
  requests bigint NOT NULL DEFAULT 0,
  tokens   bigint NOT NULL DEFAULT 0,
  total_ms bigint NOT NULL DEFAULT 0
);

-- ===== 외부 API 키 =====
CREATE TABLE api_key (
  id            text PRIMARY KEY,
  secret        text NOT NULL UNIQUE,          -- 배포 키 값
  name          text NOT NULL DEFAULT '',
  enabled       boolean NOT NULL DEFAULT true,
  allowed_tiers text[] NOT NULL DEFAULT '{small,medium,large}',
  token_limit   bigint,                        -- NULL = 무제한
  token_used    bigint NOT NULL DEFAULT 0,
  knowledge_mode text NOT NULL DEFAULT 'strict',-- strict | augment
  knowledge_topk int  NOT NULL DEFAULT 4,
  allow_custom  boolean NOT NULL DEFAULT false, -- rules.allowCustom
  limits        jsonb NOT NULL DEFAULT '{}',    -- {rpm,rpd,concurrency,maxTokens,overAction}
  reset         jsonb NOT NULL DEFAULT '{}',    -- {mode,unit,every,lastResetAt,nextResetAt}
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  last_used_at  timestamptz
);
CREATE INDEX api_key_secret_idx ON api_key (secret);

-- 키↔지식셋 / 키↔법칙 바인딩 (JSONB 배열 대신 조인 테이블).
-- ON DELETE CASCADE 로 unbindCollection/unbindRule 로직이 DB 에서 자동 처리됨.
CREATE TABLE api_key_collection (
  key_id        text REFERENCES api_key(id) ON DELETE CASCADE,
  collection_id text REFERENCES knowledge_collection(id) ON DELETE CASCADE,
  PRIMARY KEY (key_id, collection_id)
);
CREATE TABLE api_key_rule (
  key_id  text REFERENCES api_key(id) ON DELETE CASCADE,
  rule_id text REFERENCES rule(id) ON DELETE CASCADE,
  PRIMARY KEY (key_id, rule_id)
);

-- ===== 키별 사용 통계(시간버킷) =====
CREATE TABLE key_stat_hourly (
  key_id     text NOT NULL,
  hour_epoch bigint NOT NULL,          -- floor(ts_ms / 3600000)
  tier       text NOT NULL DEFAULT '', -- '' = 티어무관 총계행
  requests   int    NOT NULL DEFAULT 0,
  tokens     bigint NOT NULL DEFAULT 0,
  errors     int    NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, hour_epoch, tier)
);
CREATE INDEX key_stat_hourly_key_idx ON key_stat_hourly (key_id, hour_epoch);

CREATE TABLE key_error (
  id     bigserial PRIMARY KEY,
  key_id text NOT NULL,
  ts     timestamptz NOT NULL DEFAULT now(),
  code   text NOT NULL
);
CREATE INDEX key_error_key_ts_idx ON key_error (key_id, ts DESC);
-- 14일 롤오프: 파티셔닝(월별) 또는 주기 DELETE (아래 §5).

-- ===== JSON 결과 법칙 / 지식셋 =====
CREATE TABLE rule (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  keywords    text[] NOT NULL DEFAULT '{}',
  schema      jsonb  NOT NULL DEFAULT '{}',
  intent      text NOT NULL DEFAULT '',
  instruction text NOT NULL DEFAULT '',
  skip_rag    boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);

CREATE TABLE knowledge_collection (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);

-- ===== RAG 문서/청크/이미지 (벡터 저장소) =====
CREATE TABLE rag_document (
  id            text PRIMARY KEY,
  collection_id text REFERENCES knowledge_collection(id) ON DELETE CASCADE, -- NULL=콘솔 전역
  name          text NOT NULL,
  chunk_count   int  NOT NULL DEFAULT 0,
  summary       text,
  questions     jsonb,                 -- string[] (예상 질문)
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rag_document_collection_idx ON rag_document (collection_id);

CREATE TABLE rag_chunk (
  id        text PRIMARY KEY,
  doc_id    text NOT NULL REFERENCES rag_document(id) ON DELETE CASCADE,
  idx       int  NOT NULL,
  text      text NOT NULL,
  tokens    int,
  len       int,
  embedding vector(1024),              -- NULL 허용(임베더 없으면 BM25만). 차원은 §결정대기
  UNIQUE (doc_id, idx)
);
CREATE INDEX rag_chunk_doc_idx ON rag_chunk (doc_id);
CREATE INDEX rag_chunk_vec_idx ON rag_chunk USING hnsw (embedding vector_cosine_ops);

CREATE TABLE rag_image (
  doc_id text PRIMARY KEY REFERENCES rag_document(id) ON DELETE CASCADE,
  mime   text NOT NULL,
  data   bytea NOT NULL                -- 또는 오브젝트 스토리지 키/경로
);

-- ===== 개인 장기기억 (U_ID 벡터 저장소) =====
CREATE TABLE memory_entry (
  id        bigserial PRIMARY KEY,
  uid       text NOT NULL,
  text      text NOT NULL,
  ts        timestamptz NOT NULL DEFAULT now(),
  embedding vector(1024)
);
CREATE INDEX memory_entry_uid_ts_idx ON memory_entry (uid, ts DESC);
CREATE INDEX memory_entry_vec_idx    ON memory_entry USING hnsw (embedding vector_cosine_ops);
-- maxEntries(기본 200) cap: 앱에서 uid별 오래된 것 삭제 또는 트리거.

-- ===== 대화 히스토리 (append 로그) =====
-- request_log: 콘솔 테스트 대화 + 외부 API 호출을 함께 담는 요청/응답 로그.
-- "채팅" 전용이 아니라 요청 로그이므로 request_log (channel 로 출처 구분).
CREATE TABLE request_log (
  id      bigserial PRIMARY KEY,
  channel text NOT NULL DEFAULT 'console',   -- console | sess:<sid> | ask:<keyId>
  ts      timestamptz NOT NULL DEFAULT now(),
  uid     varchar(32),                        -- 요청 당시 U_ID (장기기억 키) — 외부 대조·검증용
  sid     varchar(32),                        -- 요청 당시 S_ID (세션 키)
  entry   jsonb NOT NULL                      -- 요청/응답 레코드 전체
);
CREATE INDEX request_log_channel_idx ON request_log (channel, id DESC);
CREATE INDEX request_log_uid_idx     ON request_log (uid) WHERE uid IS NOT NULL;
CREATE INDEX request_log_sid_idx     ON request_log (sid) WHERE sid IS NOT NULL;
-- 자주 조회하는 필드는 생성 컬럼으로 승격 가능:
--   tier text GENERATED ALWAYS AS (entry->>'tier') STORED 등.

-- ===== 부하 스냅샷 세션 =====
CREATE TABLE load_session (
  id          text PRIMARY KEY,
  label       text,
  state       text NOT NULL,          -- recording | done
  started_at  timestamptz,
  ended_at    timestamptz,
  duration_ms bigint,
  report      jsonb NOT NULL          -- config/baseline/final/delta/samples 통째
);
CREATE INDEX load_session_started_idx ON load_session (started_at DESC);

-- ===== 모델 서버 기동 실패 상태 =====
CREATE TABLE server_status (
  name  text PRIMARY KEY,
  error text,
  at    timestamptz
);

-- ===== (선택) 단기기억 — Redis 미사용 시 =====
CREATE TABLE session_memory (
  sid        text PRIMARY KEY,
  turns      jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz NOT NULL
);
CREATE INDEX session_memory_expires_idx ON session_memory (expires_at);
```

---

## 4. 검색(하이브리드) 처리 방침

- **벡터**: `pgvector` HNSW + `vector_cosine_ops` 로 ANN. `cosineCutoff` 는 앱에서 거리→유사도 변환 후 적용.
- **어휘(BM25/한글 bigram)**: 현행 앱 로직 유지가 가장 안전(커스텀 bigram 토크나이징 때문).
  1차 이행에선 청크 텍스트를 앱으로 로드해 BM25 계산, 벡터는 DB ANN.
  이후 `pg_trgm`/`tsvector`(bigram) 로 DB 측 이관 검토.
- **융합**: 우선순위-2 항목이던 **RRF 하이브리드**는 이 스키마 위에서 (벡터 top-N ∪ 어휘 top-N)
  → RRF 재랭크로 자연스럽게 얹을 수 있다.

---

## 5. 마이그레이션 / 임포터 계획

1. 드라이버·확장 추가: `pg` (또는 `postgres`) 의존성, `CREATE EXTENSION vector`.
2. **마이그레이션 파일**: `migrations/0001_init.sql`(위 DDL). 러너는 `node-pg-migrate` 또는
   자체 순번 적용기. 스키마 버전은 `app_meta('schema.version', N)` 로 관리.
3. **백엔드 구현**: `src/storage/pgBackend.js` 에 `docStore/collectionStore/appendLog/keyedDocStore`
   + 신설 `vectorStore` 를 같은 시그니처로 구현. `index.js` 의 `STORAGE_BACKEND` 분기에 `postgres` 추가.
4. **임포터**(`scripts/import-json-to-db.mjs`): `data/*.json`·`data/rag/index.json`·
   `data/memory/*.json`·`data/loadsessions/*.json`·`data/history.jsonl` 를 읽어 INSERT.
   - id 보존, 바인딩(JSON 배열)→조인 테이블 전개, 임베딩 배열→`vector` 캐스팅.
5. 검증 후 `STORAGE_BACKEND=postgres` 로 전환. 롤백은 파일 백엔드로 즉시 복귀 가능.

---

## 6. 결정 대기 (선택 필요)

| 항목 | 선택지 | 메모 |
| --- | --- | --- |
| DB | **Postgres+pgvector**(권장) / SQLite+sqlite-vec | 분산(부모+agent)이면 Postgres |
| 임베딩 차원 `vector(N)` | 임베딩 모델의 실제 dim | 현재 `pool.embed` 사용 모델 dim 확인 필요(예 768/1024) |
| 키 바인딩 | **조인 테이블**(권장) / api_key 내 JSONB | 조인 테이블이면 언바인딩이 CASCADE 로 자동 |
| history/load_session | JSONB 통째(권장·유연) / 정규화 컬럼 | 조회 잦은 필드만 생성 컬럼으로 승격 |
| 단기기억 | **Redis**(TTL 네이티브·권장) / `session_memory` 테이블 | 휘발성이라 DB 필수는 아님 |
| key_stats 롤오프 | 월 파티셔닝 / 주기 DELETE | 14일 바운드 유지 |
| RAG 이미지 | `bytea` / 오브젝트 스토리지 키 | 용량 크면 외부 스토리지 |

---

관련: 저장소 추상화 계약과 이행 현황은 [`src/storage/README.md`](../src/storage/README.md) 참고.
