# 저장소 계층 (src/storage)

도메인 모듈이 파일 시스템(`fs`)을 직접 호출하지 않도록 감싼 얇은 추상화 계층입니다.
**지금은 프로토타입이라 파일(JSON/JSONL)로 저장하지만, 실제 운영 데이터는 DB 로 관리할 예정**이라,
그 이행이 이 폴더 안으로 국소화되도록 만든 것이 목적입니다.

## 저장소 종류 (백엔드 계약)

| 팩토리 | 용도 | 메서드 |
| --- | --- | --- |
| `docStore(name)` | 단일 JSON 문서 | `read()` · `readSync()` · `save(obj)` · `flush()` |
| `collectionStore(name, {rootKey, idField, sanitize, pretty})` | id 기반 레코드 목록 | `all()` · `get(id)` · `upsert(rec)` · `remove(id)` · `replaceAll(arr)` · `persist()` · `loadSync()` · `flush()` |
| `appendLog(name)` | append 전용 로그(JSONL) | `append(rec)` · `readAll()` · `overwrite(recs)` · `clear()` |
| `keyedDocStore(name)` | id 로 키된 다중 문서(디렉터리) | `put(id,obj)` · `get(id)` · `list()` · `remove(id)` |

> `collectionStore.upsert(rec)` 는 단일 레코드 삽입/교체(DB: UPSERT), `persist()` 는 레코드를
> 제자리 수정한 뒤 컬렉션 전체 저장 예약(DB: dirty 레코드 upsert)용입니다.

`name` 은 논리 이름(파일 백엔드에선 `data/<name>`)입니다. DB 백엔드에선 테이블명으로 매핑하면 됩니다.

## 파일 백엔드 특성

- **원자적 쓰기**: 모든 저장은 `tmp` 파일에 쓴 뒤 `rename` — 도중 크래시로 파일이 잘려 손상되지 않습니다.
- **debounce coalescing**: 잦은 저장은 마지막 값만 남겨 묶어서 씁니다(쓰기 순서는 프라미스 체인으로 직렬화).
- 기준 디렉터리: `DATA_DIR`(기본 `<repo>/data`, 환경변수 `DATA_DIR` 로 재정의).

## 백엔드 선택

환경변수 `STORAGE_BACKEND`:

- **`file`**(기본) — `data/*.json` / `*.jsonl` (프로토타입).
- **`postgres`** — PostgreSQL 정규화 스키마([`docs/db-schema.md`](../../docs/db-schema.md)). `DATABASE_URL` 필요.

그 외 값은 부팅 시 명확한 에러로 실패합니다(fail-fast).

### postgres 백엔드 켜기

```
STORAGE_BACKEND=postgres
DATABASE_URL=postgres://postgres:password@localhost:5432/neutdaAI
```

- 서버는 요청을 받기 전에 `storage.init()` 로 **연결 확인 + 동기 접근 저장소(캐시형) 하이드레이션**을
  수행합니다(`server.js` 가 `app.listen` 전에 `await`). 종료 시 `storage.shutdown()` 이 대기 쓰기를 flush.
- **동기 접근 처리**: 도메인은 `collectionStore.all()/get()`·`docStore.readSync()` 를 동기로 씁니다.
  pg 는 비동기뿐이라, 부팅 시 DB→인메모리 캐시로 하이드레이션한 뒤 읽기는 캐시에서 동기로,
  쓰기는 캐시 갱신 + DB write-through(저장소별 프라미스 체인으로 직렬화)로 처리합니다.
- **주의**: DB 가 닿는 컨트롤플레인에서만 `postgres` 로. 원격 agent 노드는 `file` 유지 권장.

### DB 백엔드 구현 위치

`src/storage/pg.js`(연결 풀) + `src/storage/pgBackend.js`(팩토리 + 테이블별 매퍼 + 하이드레이션).
새 저장소를 pg 로 이행하려면 `pgBackend.js` 의 매퍼 레지스트리
(`COLLECTION_MAPPERS`/`DOC_MAPPERS`/`APPENDLOG_MAPPERS`/`KEYED_MAPPERS`)에 항목을 추가하면 됩니다.

## 이행 현황

**완료 (이 계층 사용 중)**

- `stats.js` — `docStore("stats.json")`
- `keyStats.js` — `docStore("keyStats.json")`
- `rulesStore.js` — `collectionStore("rules.json")`
- `knowledgeStore.js` — `collectionStore("knowledge.json")`
- `history.js` — `appendLog("history.jsonl")`
- `apiKeys.js` — `collectionStore("apiKeys.json")` (레거시 키 시드는 최초 로드 1회 유지)
- `loadSession.js` — `keyedDocStore("loadsessions")`
- `serverManager.js` — `docStore("server-status.json")` (상태 파일은 즉시 쓰기 = debounce 0)

- `rag.js` — `docStore("rag/index.json")` (postgres: `rag_document`+`rag_chunk`, 이미지는 파일 유지)
- `memoryStore.js` — `keyedDocStore("memory")` (postgres: `memory_entry`)

위 10개는 `STORAGE_BACKEND=postgres` 에서 정규화 테이블에 매핑됩니다(실DB 왕복 테스트 통과).
- `keyStats`·`server_status` 는 값이 블롭이라 jsonb 컬럼으로 저장(`docs/db-schema.md` §2.1).
- **rag/memory 검색은 도메인(인메모리) 유지, DB 는 영속만.** 임베딩 차원(5120)이 pgvector ANN
  한계(2000)를 넘어 HNSW 인덱스가 없기 때문(브루트포스만 가능). ≤2000차원 모델로 바꾸면 in-DB ANN 전환 가능.

`data/*.json` → DB 이관은 `scripts/import-json-to-db.mjs` (10개 저장소 전부, idempotent).

**남은 대상**: 없음(휘발성 `sessionMemory`·`rateLimit` 제외). rag 이미지 바이너리는 파일 유지.

> `sessionMemory.js`·`rateLimit.js` 는 의도적으로 휘발성(인메모리)입니다. DB/Redis 이행 시
> 같은 `get/append/clear` 인터페이스를 유지한 채 백엔드만 교체하면 됩니다.
>
> `servers.json`·`modelconfig.json`·`roles.json`·`security.json` 은 **데이터가 아니라 설정**이라
> 이 계층 대상이 아닙니다(파일 유지).
