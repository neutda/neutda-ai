# neutda-ai

Node.js + Express API 게이트웨이. 요청을 받아 로컬 **llama-server**(llama.cpp, OpenAI 호환 API) 클러스터로 프록시하고,
티어·난이도에 따라 **small / medium / large** 모델로 자동 라우팅합니다.

추론은 llama.cpp **`llama-server`** 가 담당하고, Express 는 그 앞단에서 요청 변환·로드밸런싱·모니터링·RAG 를 제공합니다.

```
외부 시스템 ──▶ Express (3000)
                    │
        ┌───────────┼───────────┬──────────────┐
        ▼           ▼           ▼              ▼
   large:8080  medium:8085  small:8081…   (라우터 역할)
   Qwen3.6 27B  Qwen2.5 3B   Qwen2.5 0.5B   small 백엔드 1대
   + mmproj     (텍스트)      (텍스트/GPU·CPU)
```

**주요 기능**

- **멀티 티어 라우팅**: `small` / `medium` / `large` — LLM 라우터(`ROUTING_MODE=llm`) 또는 휴리스틱(글자수·키워드)으로 자동 선택
- **GPU/CPU 선호**: 같은 티어 안에서 난이도 점수에 따라 GPU 또는 CPU 백엔드 우선
- **로드밸런싱**: 헬스체크 + least-connections + 장애 시 failover
- **비전**: 이미지 입력 시 large(비전 모델)로 라우팅
- **스트리밍**: SSE 기반 실시간 토큰 전송 (`/api/chat/stream`)
- **RAG**: PDF/DOCX/HWPX/HWP/이미지 등 문서 업로드 → BM25 검색 → 문서 기반 답변
- **외부 API**: API 키 인증 GET `/api/ask` (비동기·동기 모두 지원)
- **모니터링**: 백엔드 상태, GPU/CPU 지표, 로그, 대화 히스토리

> ⚠️ **VRAM 주의**: Qwen3.6-27B-Q4 한 인스턴스가 약 16GB. RTX 3090(24GB) 한 장엔 보통 large 1개만 올라갑니다.
> 여러 large 인스턴스는 **서로 다른 GPU / 여러 머신**에 분산하세요. small·medium 은 0.5B~3B 모델로 CPU/GPU 혼용이 가능합니다.

## 1. 사전 준비

- Node.js 20+
- `llama-server` 바이너리 (아래 설치 스크립트로 자동 다운로드 가능)
- 모델 파일 (`servers.json` 참고):
  - **large**: `models/Qwen3.6-27B-Q4_K_M.gguf`, `models/mmproj-Qwen3.6-27B-BF16.gguf`
  - **medium**: `models/qwen2.5-3b-instruct-q4_k_m.gguf`
  - **small**: `models/qwen2.5-0.5b-instruct-q5_k_m.gguf`

## 2. 설치

```powershell
npm install
Copy-Item .env.example .env   # 필요 시 값 수정

# llama-server(Windows CUDA 빌드 + CUDA 런타임)을 ./llama 에 자동 다운로드
powershell -ExecutionPolicy Bypass -File scripts/download-llama-server.ps1
```

> NVIDIA GPU 가 아니면 [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) 에서
> `...-vulkan-x64.zip` 또는 `...-cpu-x64.zip` 을 직접 받아 `./llama` 에 풀어주세요.

## 3. 실행

### 한 번에 전체 기동 (권장)

`servers.json` 에 정의된 모든 LLM 서버 + Express 를 한 번에 띄웁니다.

```powershell
npm run up      # servers.json 기반 LLM 클러스터 + Express
npm run down    # Express + 모든 llama-server 종료
```

`npm run up` 동작:
1. `servers.json` 의 각 서버를 백그라운드로 실행 (이미 떠 있는 포트는 건너뜀)
2. 모든 LLM `/health` 응답 대기
3. `LLAMA_BACKENDS` 환경변수를 자동 구성해 Express 실행

로그: `./llama/logs/server-<port>.log`, `./llama/logs/express.log`

### 수동 실행

```powershell
# 단일 large 인스턴스 (비전 모델)
npm run llama

# 옵션 직접 지정
powershell -ExecutionPolicy Bypass -File scripts/run-llama-server.ps1 -Ngl 0 -Ctx 32768

# 동일 모델 여러 인스턴스 (로드밸런싱용)
npm run cluster -- -Count 2 -Gpus "0,1"
```

클러스터 실행 후 출력되는 `LLAMA_SERVERS=...` 줄을 `.env` 에 붙여넣으면 Express 가 해당 백엔드로 분산합니다.

```powershell
# Express 만 별도 실행 (터미널 2)
npm start
npm run dev     # 파일 변경 시 자동 재시작
```

## 4. 웹 UI

| 페이지 | URL | 설명 |
| --- | --- | --- |
| 테스트 콘솔 | `http://localhost:3000/` | 채팅·이미지·스트리밍·대화 기억 테스트 |
| 모니터링 | `http://localhost:3000/monitor.html` | 백엔드 상태, 라우터 역할 토글, GPU/CPU 지표 |
| 로그 | `http://localhost:3000/logs.html` | 서버 로그 실시간 조회 |
| 외부 API | `http://localhost:3000/api.html` | `/api/ask` 호출 예시 |
| RAG | `http://localhost:3000/rag.html` | 문서 업로드·문서 기반 질의 |

## 5. API

### `GET /health`

게이트웨이 상태 + 정상 백엔드 수.

### `GET /api/status`

풀/백엔드별 상세 통계 (모니터링 대시보드가 사용).

### `POST /api/backends/role`

백엔드의 `chat` / `router` 역할을 개별 on·off.

```json
{ "url": "http://127.0.0.1:8087", "role": "router", "enabled": true }
```

### `GET /api/metrics`

GPU/CPU/RAM 시스템 자원 지표.

### `GET /api/logs`

서버 로그 조회. 쿼리: `level`(all|info|warn|error), `limit`, `sinceId`.

### `GET /api/history` · `DELETE /api/history`

대화 히스토리 조회·전체 삭제.

### `POST /api/chat`

동기 채팅. 요청 body (flat):

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `ROLE_SYSTEM` | string | X | 시스템 지시문 |
| `ROLE_USER` | string | O | 사용자 질문 |
| `TEMPERATURE` | number | X | 생성 온도 (기본 0.7) |
| `content` | string \| string[] | X | 이미지 URL / 로컬 경로 / `data:` URI (→ large 라우팅) |
| `THINKING` | boolean | X | Qwen3.6 추론 모드 (→ large 라우팅) |
| `MODEL_TIER` | small\|medium\|large | X | 티어 강제 지정 |
| `HISTORY` | `{role, content}[]` | X | 이전 대화 (컨텍스트 예산 내 최신 순 삽입) |

```powershell
curl -X POST http://localhost:3000/api/chat `
  -H "Content-Type: application/json" `
  -d '{ "ROLE_USER": "한국의 수도는?", "TEMPERATURE": 0.7 }'
```

응답 예시:

```json
{
  "answer": "모델이 생성한 답변",
  "reasoning": "(THINKING=true 일 때만)",
  "model": "qwen",
  "tier": "small",
  "routedTier": "small",
  "routeReason": "heuristic: simple",
  "device": "cpu",
  "difficulty": 12,
  "backend": "http://127.0.0.1:8081",
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

### `POST /api/chat/stream`

SSE 스트리밍 채팅. body 는 `/api/chat` 과 동일.
이벤트: `meta` → `token`(반복) → `done`(TTFT, tokens/sec 포함).

### `GET /api/ask`

외부 시스템용 GET API. API 키 인증.

| 쿼리 | 설명 |
| --- | --- |
| `key` | API 키 (`.env` 의 `API_KEY`, 기본 `tw-demo-key-2026`) |
| `q` | 질문 (필수) |
| `ref` | 호출자 식별용 키 (응답에 echo) |
| `system` | 시스템 지시문 |
| `tier` | 티어 강제 지정 |
| `WAIT` | `Y`=동기 완료 대기, `N`(기본)=비동기 |

비동기(`WAIT=N`) 응답:

```json
{
  "status": "generating",
  "message": "답변을 생성중입니다",
  "id": "abc123",
  "resultUrl": "/results/abc123.json"
}
```

결과는 `public/results/<id>.json` 에 기록됩니다.

```powershell
curl "http://localhost:3000/api/ask?key=tw-demo-key-2026&q=안녕하세요"
```

### RAG API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/rag/docs` | 문서 목록 + 통계 |
| `POST` | `/api/rag/upload` | 파일 업로드 (multipart, field `file`) |
| `POST` | `/api/rag/docs` | 텍스트 직접 추가 `{ name, text }` |
| `DELETE` | `/api/rag/docs/:id` | 문서 삭제 |
| `GET` | `/api/rag/images/:docId` | 이미지 문서 미리보기 |
| `POST` | `/api/rag/ask` | 문서 기반 질문 |

**지원 업로드 형식**: PDF, DOCX, HWPX, HWP(구형), TXT/MD/CSV/JSON, PNG/JPG/GIF/WebP/BMP(비전 모델로 설명 추출 후 인덱싱)

`POST /api/rag/ask` body:

| 필드 | 설명 |
| --- | --- |
| `q` 또는 `ROLE_USER` | 질문 (필수) |
| `topK` | 검색 청크 수 (1~8, 기본 4) |
| `strict` | `true`(기본)=문서에 없으면 "문서 내용에 없습니다" |
| `content` | 질문에 첨부할 이미지 |

## 6. 라우팅

### 판정 우선순위

1. **하드 규칙**: `MODEL_TIER` 명시 > 이미지(→large) > `THINKING`(→large)
2. **LLM 라우터** (`ROUTING_MODE=llm`): 라우터 역할이 켜진 small 백엔드가 티어·난이도 분류
3. **휴리스틱 폴백**: 글자수·코드 패턴·복잡 키워드

### 휴리스틱 임계값

| 조건 | 티어 |
| --- | --- |
| `SMALL_MAX_CHARS`(200) 이하 | small |
| 그 사이 ~ `LARGE_MIN_CHARS`(600) | medium |
| 600자 초과 / 코드·복잡 키워드 | large |

### GPU/CPU 선호

티어가 정해진 뒤 난이도 점수(0~100)를 계산합니다. `GPU_MIN_DIFFICULTY`(50) 이상이면 같은 티어 내 GPU 백엔드를, 미만이면 CPU 백엔드를 선호합니다.

백엔드 등록 형식: `tier@url@device` (device = `gpu` | `cpu`, 생략 가능)

```
LLAMA_BACKENDS=large@http://127.0.0.1:8080@gpu,medium@http://127.0.0.1:8085@gpu,small@http://127.0.0.1:8081@gpu,small@http://127.0.0.1:8082@cpu
```

선택 티어가 전부 다운이면 `ESCALATE_TIER=true` 일 때 다른 티어로 폴백합니다.

## 7. servers.json

`npm run up` 이 읽는 LLM 서버 정의 파일입니다. 각 항목:

```json
{
  "name": "small-1",
  "tier": "small",
  "port": 8081,
  "model": "models/qwen2.5-0.5b-instruct-q5_k_m.gguf",
  "ctx": 4096,
  "ngl": 99,
  "gpu": ""
}
```

- `ngl`: GPU 레이어 수 (`0` = CPU 전용)
- `mmproj`: large 비전 모델에만 필요
- `gpu`: `CUDA_VISIBLE_DEVICES` 값 (빈 문자열이면 기본 GPU)

## 8. 환경 변수 (`.env`)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | 3000 | Express 포트 |
| `LLAMA_BACKENDS` | large@8080,small@8081 | `tier@url@device` 콤마 구분 |
| `LLAMA_SERVERS` | http://127.0.0.1:8080 | (호환) 태그 없는 평면 목록 → 전부 large |
| `LLAMA_SERVER_URL` | http://127.0.0.1:8080 | (호환) 단일 백엔드 |
| `API_KEY` | tw-demo-key-2026 | `/api/ask` 인증 키 |
| `ROUTING_MODE` | llm | `heuristic` \| `llm` \| `hybrid` |
| `ROUTER_BACKEND_URL` | (없음) | 라우터 역할 백엔드 URL (없으면 첫 small) |
| `ROUTER_TEMPERATURE` | 0.1 | 라우터 분류 온도 |
| `ROUTER_MAX_TOKENS` | 128 | 라우터 분류 최대 토큰 |
| `DEFAULT_TIER` | small | 휴리스틱 "간단" 판정 시 티어 |
| `SMALL_MAX_CHARS` | 200 | small 상한 글자수 |
| `LARGE_MIN_CHARS` | 600 | large 하한 글자수 |
| `GPU_MIN_DIFFICULTY` | 50 | GPU 선호 난이도 임계값 |
| `ESCALATE_TIER` | true | 선택 티어 전부 다운 시 폴백 |
| `MODEL_NAME` | qwen | 응답 모델 라벨 |
| `DEFAULT_TEMPERATURE` | 0.7 | 기본 온도 |
| `DEFAULT_MAX_TOKENS` | 2048 | large 티어 최대 토큰 |
| `MAX_TOKENS_SMALL` | 1024 | small/medium 최대 토큰 |
| `MAX_PROMPT_CHARS_SMALL` | 1800 | small/medium 프롬프트 글자 상한 |
| `MAX_PROMPT_CHARS_LARGE` | 3500 | large 프롬프트 글자 상한 |
| `ENABLE_THINKING` | false | 추론 모드 기본값 |
| `REQUEST_TIMEOUT_MS` | 120000 | 요청 타임아웃 |
| `HEALTH_INTERVAL_MS` | 5000 | 헬스체크 주기 |
| `MAX_RETRIES` | 2 | failover 재시도 횟수 |

## npm scripts

| 명령 | 설명 |
| --- | --- |
| `npm start` | Express 서버 |
| `npm run dev` | Express (watch 모드) |
| `npm run up` | servers.json 기반 전체 기동 |
| `npm run down` | 전체 종료 |
| `npm run llama` | 단일 large llama-server |
| `npm run cluster` | 동일 모델 N개 클러스터 |
