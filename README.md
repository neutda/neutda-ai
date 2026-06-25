# neutda-ai

Node.js + Express API. 엔드포인트로 파라미터를 전달받아 `models/` 의 Qwen 비전 모델로 답변을 생성합니다.

추론은 llama.cpp 의 **`llama-server`** (OpenAI 호환 API, mmproj 비전 지원)가 담당하고,
Express 는 그 앞단에서 요청을 받아 변환·프록시합니다.
LLM 백엔드를 **여러 개(N개)** 두면 Express 가 **헬스체크 + 최소부하(least-connections) 라우팅 + 장애 시 failover**
로 로드밸런싱하며, `/api/status` 와 모니터링 대시보드로 상태를 볼 수 있습니다.

또한 백엔드를 **티어(`large`/`small`)** 로 묶어, 요청 복잡도에 따라 **간단한 건 작은 모델 / 복잡한 건 큰 모델**
로 라우팅합니다(모델 라우팅). 판정 우선순위: `MODEL_TIER` 명시 > 이미지(비전→large) > `THINKING`(→large) >
휴리스틱(입력 길이/코드·수식/복잡 키워드). 선택 티어가 모두 다운이면 다른 티어로 폴백(`ESCALATE_TIER`).

```
                          ┌──▶ llama-server #1 (8080) ──▶ Qwen GGUF + mmproj
외부 시스템 ──▶ Express ───┼──▶ llama-server #2 (8081) ──▶ ...
 (3000, 게이트웨이)  LB    └──▶ llama-server #N (192.168.x.x:8080)
```

> ⚠️ VRAM 주의: 27B-Q4 한 인스턴스가 약 16GB. RTX 3090(24GB) 한 장엔 보통 1개만 올라갑니다.
> N개를 띄우려면 **서로 다른 GPU / 여러 머신**에 분산하세요(단일 GPU 동시처리는 llama-server 슬롯이 담당).

## 1. 사전 준비

- Node.js 20+
- `models/Qwen3.6-27B-Q4_K_M.gguf`, `models/mmproj-Qwen3.6-27B-BF16.gguf` (이미 존재)
- `llama-server` 바이너리 (아래 2단계 스크립트로 자동 다운로드 가능)

## 2. 설치

```powershell
npm install
Copy-Item .env.example .env   # 필요 시 값 수정

# llama-server(Windows CUDA 빌드 + CUDA 런타임)을 ./llama 에 자동 다운로드
powershell -ExecutionPolicy Bypass -File scripts/download-llama-server.ps1
```

> NVIDIA GPU 가 아니면 `https://github.com/ggml-org/llama.cpp/releases` 에서
> `...-vulkan-x64.zip` 또는 `...-cpu-x64.zip` 을 직접 받아 `./llama` 에 풀어주세요.

## 3. 모델 서버 실행 (터미널 1)

```powershell
# 단일 인스턴스 (./llama/llama-server.exe 자동 탐색)
npm run llama

# 옵션 직접 지정 (예: GPU 미사용 / 컨텍스트 확장)
powershell -ExecutionPolicy Bypass -File scripts/run-llama-server.ps1 -Ngl 0 -Ctx 32768
```

### 여러 인스턴스(클러스터) 실행 — 로드밸런싱

```powershell
# 2개 인스턴스를 8080, 8081 에 GPU 0,1 로 분산
npm run cluster -- -Count 2 -Gpus "0,1"
```

실행 후 출력되는 `LLAMA_SERVERS=...` 줄을 `.env` 에 붙여넣으면 Express 가 해당 백엔드들로 분산합니다.
로그는 `./llama/logs/server-<port>.log`, 종료는 `Get-Process llama-server | Stop-Process -Force`.

`http://127.0.0.1:8080` 에서 대기합니다. GPU 가 없으면 `-Ngl 0` 으로 실행하세요(느림).

## 4. Express 서버 실행 (터미널 2)

```powershell
npm start
# 개발 모드(파일 변경 자동 재시작)
npm run dev
```

`http://localhost:3000` 에서 대기합니다.

## 5. 테스트 페이지 / 모니터링

- **테스트 콘솔**: `http://localhost:3000/` — 폼에서 `ROLE_SYSTEM / ROLE_USER / TEMPERATURE / content / THINKING`
  입력 후 전송. 이미지는 URL/경로/파일 선택(자동 base64)으로 첨부.
- **모니터링 대시보드**: `http://localhost:3000/monitor.html` — 각 LLM 백엔드의 정상/다운, 진행 중(in-flight),
  총 요청/오류, 평균 응답시간, 헬스 응답시간을 2초마다 갱신.

## 6. API

### `GET /health`

게이트웨이 상태 + 정상 백엔드 수.

### `GET /api/status`

풀/백엔드별 상세 통계 (모니터링 대시보드가 사용).

### `POST /api/chat`

요청 body (flat):

| 필드          | 타입               | 필수 | 설명                                                                                       |
| ------------- | ------------------ | ---- | ------------------------------------------------------------------------------------------ |
| `ROLE_SYSTEM` | string             | X    | 시스템 지시문                                                                              |
| `ROLE_USER`   | string             | O    | 사용자 질문                                                                                |
| `TEMPERATURE` | number             | X    | 생성 온도 (기본 0.7)                                                                       |
| `content`     | string \| string[] | X    | 이미지. URL / 로컬 경로 / `data:` URI (여러 장은 배열)                                     |
| `THINKING`    | boolean            | X    | Qwen3.6 추론 모드. 기본 false(바로 답변). true 면 응답에 `reasoning` 포함 (→ large 라우팅) |
| `MODEL_TIER`  | "small"\|"large"   | X    | 티어 강제 지정. 없으면 자동 라우팅                                                         |

> Qwen3.6 은 추론(thinking) 모델입니다. 기본은 추론을 끄고 바로 답변(`answer`)을 반환하며,
> `THINKING: true` 로 켜면 추론 과정(`reasoning`)도 함께 받습니다. 추론을 켜면 토큰을 많이 쓰므로
> `DEFAULT_MAX_TOKENS` 를 충분히(예: 2048+) 두세요.

#### 텍스트 요청 예시

```powershell
curl -X POST http://localhost:3000/api/chat `
  -H "Content-Type: application/json" `
  -d '{ "ROLE_SYSTEM": "너는 친절한 비서야.", "ROLE_USER": "한국의 수도는?", "TEMPERATURE": 0.7 }'
```

#### 이미지 포함 요청 예시

```powershell
curl -X POST http://localhost:3000/api/chat `
  -H "Content-Type: application/json" `
  -d '{ "ROLE_USER": "이 이미지를 설명해줘.", "content": "C:\\images\\photo.jpg" }'
```

#### 응답

```json
{
    "answer": "모델이 생성한 답변 텍스트",
    "reasoning": "(THINKING=true 일 때만) 모델의 추론 과정",
    "model": "qwen",
    "tier": "small",
    "routedTier": "small",
    "routeReason": "heuristic: simple",
    "backend": "http://127.0.0.1:8081",
    "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

## 환경 변수 (`.env`)

| 변수                  | 기본값                      | 설명                                                                 |
| --------------------- | --------------------------- | -------------------------------------------------------------------- |
| `PORT`                | 3000                        | Express 포트                                                         |
| `LLAMA_BACKENDS`      | large@http://127.0.0.1:8080 | 백엔드 목록 `tier@url`(콤마 구분). 티어=large/small                  |
| `LLAMA_SERVERS`       | http://127.0.0.1:8080       | (호환) 태그 없는 평면 목록. `LLAMA_BACKENDS` 있으면 무시(전부 large) |
| `LLAMA_SERVER_URL`    | http://127.0.0.1:8080       | (호환) 단일 백엔드                                                   |
| `DEFAULT_TIER`        | small                       | 휴리스틱상 "간단"일 때 쓸 티어                                       |
| `SMALL_MAX_CHARS`     | 200                         | 입력이 이 글자수 초과 시 large 로 라우팅                             |
| `ESCALATE_TIER`       | true                        | 선택 티어 전부 다운 시 다른 티어로 폴백                              |
| `MODEL_NAME`          | qwen                        | 응답에 표기될 모델 라벨                                              |
| `DEFAULT_TEMPERATURE` | 0.7                         | 기본 온도                                                            |
| `DEFAULT_MAX_TOKENS`  | 2048                        | 기본 최대 토큰                                                       |
| `ENABLE_THINKING`     | false                       | 추론 모드 기본값                                                     |
| `REQUEST_TIMEOUT_MS`  | 120000                      | 추론 요청 타임아웃                                                   |
| `HEALTH_INTERVAL_MS`  | 5000                        | 백엔드 헬스체크 주기                                                 |
| `MAX_RETRIES`         | 2                           | 실패 시 다른 백엔드로 재시도 횟수                                    |
