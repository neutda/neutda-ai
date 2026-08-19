# neutda-ai 외부 API 호출 가이드

외부 시스템이 API 키로 neutda-ai에 질문을 보내고 답변을 받는 방법을 설명합니다.

- **기본 URL**: `http://<호스트>:3000` (기본 포트 3000)
- **인증**: API 키 (아래 참조)
- **응답 형식**: JSON

| 엔드포인트 | 용도 |
|---|---|
| `GET`·`POST /api/ask` | 질문 → 답변 (§2~§9) |
| `GET /api/key/info` (별칭 `/api/usage`) | 키의 할당 정보·사용량 조회 (§10) |

---

## 1. 인증

발급받은 API 키를 두 방법 중 하나로 전달합니다.

| 방법 | 예 |
|---|---|
| 쿼리 파라미터 | `GET /api/ask?key=<API_KEY>&q=...` |
| HTTP 헤더 | `x-api-key: <API_KEY>` |

키가 없거나 비활성/무효면 `401`을 반환합니다.

---

## 2. 요청 파라미터

`GET`은 쿼리스트링, `POST`는 JSON 본문으로 보냅니다. (`POST`는 본문이 쿼리보다 우선하며, 긴 질문은 URL 길이 제한 때문에 `POST` 권장)

| 파라미터 | 필수 | 설명 |
|---|---|---|
| `q` | ✅ | 질문 본문. 별칭: `content`, `ROLE_USER` |
| `system` | | 시스템 프롬프트(역할·말투·출력형식 지시) |
| `tier` | | 모델 티어 강제: `small` \| `medium` \| `large`. 키에 허용된 티어만 가능(아니면 `403`) |
| `temperature` | | 생성 온도(숫자). 미지정 시 서버 기본값 |
| `U_ID` | | **장기 기억** 사용자 식별자. 주면 이 사용자의 개인 기억을 회상/저장 (최대 32자) |
| `S_ID` | | **단기 세션** 식별자. 주면 같은 세션의 이전 대화를 이어감 (최대 32자) |
| `WAIT` | | `Y` = 완료까지 동기 대기 후 결과 반환. 미지정/`N` = 비동기(즉시 접수 응답 + 결과 URL) |
| `USAGE` | | `N` = dry-run(토큰 집계·한도 제외, 테스트용). 미지정 = 실제 집계 |
| `ref` | | 요청-응답 매칭용 식별자. 응답에 그대로 echo. 별칭: `reqKey` |
| `rule` | | 호출자 JSON 스키마(응답을 JSON으로 강제). 키에 `allowCustom`이 켜진 경우만. 별칭: `schema` |

> `U_ID`/`S_ID`는 소문자(`u_id`/`s_id`)도 허용됩니다.

---

## 3. 동기(WAIT=Y) vs 비동기(WAIT=N)

### 비동기 (기본, `WAIT=N`)

즉시 **접수 응답**을 받고, 답변은 백그라운드에서 생성되어 결과 파일에 기록됩니다.

접수 응답:
```json
{
  "status": "generating",
  "message": "답변을 생성중입니다",
  "id": "mszbijecjo33cn",
  "ref": "your-ref-123",
  "resultUrl": "/results/mszbijecjo33cn.json"
}
```

이후 `resultUrl`을 폴링해서 `status`가 `done`이 될 때까지 조회합니다:
```
GET http://<호스트>:3000/results/<id>.json
```

### 동기 (`WAIT=Y`)

생성이 끝날 때까지 기다렸다가 **완료 결과를 바로** 반환합니다. (폴링 불필요, 대신 응답이 느릴 수 있음)

---

## 4. 완료 응답 스키마

`WAIT=Y`의 응답, 또는 폴링한 결과 파일의 내용입니다.

```json
{
  "status": "done",
  "id": "mszbijecjo33cn",
  "ref": "your-ref-123",
  "question": "대한민국의 역사에 대해 설명해줘",
  "answer": "대한민국은 ...",
  "quality": {
    "checked": true,
    "ok": false,
    "regenerated": true,
    "reason": "답변 중간에 다른 언어가 섞여 가독성이 떨어짐"
  },
  "reasoning": "",
  "model": "Qwen3.8-27B-Q4_K_M.gguf",
  "tier": "large",
  "device": "gpu",
  "backend": "http://127.0.0.1:8082",
  "tokens": 185,
  "rag": false,
  "strict": false,
  "sources": [],
  "dryRun": false,
  "U_ID": "user-abc",
  "S_ID": "sess-xyz",
  "elapsedMs": 19076,
  "finishedAt": "2026-08-19T00:26:50.197Z"
}
```

| 필드 | 설명 |
|---|---|
| `status` | `done` \| `generating` \| `error` |
| `answer` | 최종 답변 텍스트 |
| `quality` | 답변품질검증 결과. 꺼져 있으면 `null` (아래 §5) |
| `model` / `tier` / `device` / `backend` | 실제 응답한 모델·티어·장치·백엔드 |
| `tokens` | 생성 토큰 수 |
| `rag` / `strict` / `sources` | 문서 검색(RAG) 사용 여부·근거 문서 |
| `dryRun` | `USAGE=N` 여부(집계 제외) |
| `U_ID` / `S_ID` | 요청 당시의 기억 식별자(그대로 echo) |
| `elapsedMs` / `finishedAt` | 처리 시간·완료 시각 |

### JSON 스키마(`rule`/`schema`) 사용 시

응답에 파싱된 JSON이 `data` 필드로, 적용된 규칙이 `rule` 필드로 추가됩니다:
```json
{ "status": "done", "answer": "{...}", "data": { /* 스키마대로 파싱된 객체 */ }, "rule": { "id": "...", "name": "...", "ok": true } }
```

---

## 5. 답변품질검증(`quality`)

서버·모델관리에서 **답변품질검증**을 켜면, 최종 답 직전에 질문↔답변 맥락 일치를 판정합니다.

| 필드 | 의미 |
|---|---|
| `checked` | 검증 수행 여부 |
| `ok` | `true`=통과, `false`=미통과(초기 답이 부적합) |
| `regenerated` | 미통과 시 상위 모델(large)로 재작성했는지 |
| `reason` | 미통과 사유(한국어) |

- `ok:false, regenerated:true` → 초기 답이 미통과라 **상위 모델로 다시 쓴 답**이 `answer`에 담김.
- 검증 기능이 꺼져 있으면 `quality: null`.

---

## 6. 기억(U_ID / S_ID)

| 구분 | 파라미터 | 성격 |
|---|---|---|
| 장기 기억 | `U_ID` | 사용자별 개인 기억. 기억할 가치가 있는 발화를 저장하고, 다음 호출에서 회상 |
| 단기 세션 | `S_ID` | 같은 세션의 직전 대화 맥락 유지(휘발성) |

- 둘 다 생략하면 **익명**으로 처리되어 기억이 비활성화됩니다(무상태).
- 요청 당시의 `U_ID`/`S_ID`는 DB `request_log` 테이블에 기록되어, 나중에 외부 시스템과 대조·검증할 수 있습니다.

---

## 7. 에러 코드

| HTTP | 상황 | 응답 예 |
|---|---|---|
| `400` | `q` 누락 / 스키마 파싱 실패 | `{ "error": "q (질문) 파라미터가 필요합니다." }` |
| `401` | 키 무효·비활성 | `{ "error": "유효하지 않은 API KEY 입니다." }` |
| `403` | 비허용 티어 / 커스텀 JSON 미허용 | `{ "error": "이 키는 'large' 티어를 사용할 수 없습니다.", "allowedTiers": [...] }` |
| `429` | 토큰 한도·요청수(RPM/RPD)·동시요청 초과 | `{ "error": "...한도를 초과했습니다.", "retryAfter": 12 }` |
| `502` | 생성 실패(`status:"error"`) | `{ "status": "error", "error": "..." }` |

- `429`(요청수 초과)에는 `Retry-After` 헤더가 함께 옵니다.
- 토큰 한도 초과 시, 키 설정이 `downgrade`면 거절 대신 허용 최저 티어로 강등되어 처리됩니다.

---

## 8. 제한 (키별 설정)

- **토큰 한도**: 누적 토큰 상한. 초과 시 거절 또는 강등.
- **요청수 한도**: 분당(RPM)·일일(RPD).
- **동시 요청**: concurrency 상한.
- **허용 티어**: `allowedTiers`에 포함된 티어만.
- **최대 토큰**: 응답당 `maxTokens` 상한.

---

## 9. 예제

### 9-1. 비동기 호출 후 폴링 (기본)

```bash
# 1) 접수 (즉시 응답)
curl -s "http://localhost:3000/api/ask" \
  -H "x-api-key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "q": "대한민국의 역사를 요약해줘", "U_ID": "user-abc", "S_ID": "sess-xyz", "ref": "req-001" }'
# → { "status":"generating", "id":"...", "resultUrl":"/results/<id>.json" }

# 2) 결과 폴링 (status 가 done 될 때까지)
curl -s "http://localhost:3000/results/<id>.json"
```

### 9-2. 동기 호출 (한 번에 결과)

```bash
curl -s "http://localhost:3000/api/ask?WAIT=Y" \
  -H "x-api-key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "q": "라오스의 수도는?", "tier": "medium" }'
# → { "status":"done", "answer":"...", "quality":..., "tokens":..., ... }
```

### 9-3. GET (짧은 질문)

```bash
curl -s "http://localhost:3000/api/ask?key=<API_KEY>&q=안녕&WAIT=Y"
```

### 9-4. dry-run (토큰 집계 제외 테스트)

```bash
curl -s "http://localhost:3000/api/ask?WAIT=Y&USAGE=N" \
  -H "x-api-key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "q": "테스트 질문" }'
```

---

## 10. 키 정보·사용량 조회 (`GET /api/key/info`)

API 키만 전달하면, 그 키에 할당된 정보와 현재 사용량을 반환합니다. **이 호출은 사용량으로 집계되지 않고 요청수(RPM/RPD)도 소모하지 않습니다.**

- **엔드포인트**: `GET /api/key/info` (별칭 `GET /api/usage`)
- **인증**: `key` 쿼리 또는 `x-api-key` 헤더 (질문 API와 동일)

### 응답 예

```json
{
  "id": "k_mss7kemf2ec81f",
  "name": "외부 연동 A",
  "keyMasked": "tw-a1b2…9f0e",
  "enabled": true,
  "allowedTiers": ["small", "medium", "large"],
  "allowCustomJson": false,
  "token": {
    "limit": 1000000,
    "used": 123456,
    "remaining": 876544,
    "overLimit": false
  },
  "limits": {
    "rpm": 60,
    "rpd": 10000,
    "concurrency": 5,
    "maxTokens": 2048,
    "overAction": "reject"
  },
  "rate": {
    "rpm": { "used": 3, "remaining": 57, "resetInSec": 42 },
    "rpd": { "used": 120, "remaining": 9880, "resetInSec": 33900 },
    "inflight": 1
  },
  "reset": { "mode": "auto", "unit": "day", "every": 1, "lastResetAt": "...", "nextResetAt": "..." },
  "createdAt": "2026-08-01T00:00:00.000Z",
  "lastUsedAt": "2026-08-19T00:26:50.197Z"
}
```

### 필드 설명

| 필드 | 설명 |
|---|---|
| `token.limit` | 누적 토큰 한도. `null` = 무한대 |
| `token.used` | 누적 사용 토큰 |
| `token.remaining` | 남은 토큰. `null` = 무한대 |
| `token.overLimit` | 한도 초과 여부 |
| `limits.rpm` / `rpd` | 분당·일일 요청수 한도 |
| `limits.concurrency` | 동시 요청 한도 |
| `limits.maxTokens` | 응답당 최대 토큰 |
| `limits.overAction` | 한도 초과 시 `reject`(거절) \| `downgrade`(하위 티어로 강등) |
| `rate.rpm/rpd` | **현재 창의** 요청수 사용/남은량 + 초기화까지 남은 초(`resetInSec`) |
| `rate.inflight` | 진행 중(동시) 요청 수 |
| `reset` | 토큰 사용량 자동 초기화 스케줄(`mode/unit/every/nextResetAt`) |
| `allowCustomJson` | 호출 시 커스텀 JSON 스키마(`rule`/`schema`) 사용 가능 여부 |

> 요청수(RPM/RPD)는 **프로세스 인메모리**라 서버 재시작 시 초기화됩니다. 토큰 누적량(`token.used`)은 영속되며 `reset` 스케줄로만 0이 됩니다.

### 예제

```bash
curl -s "http://localhost:3000/api/key/info" -H "x-api-key: <API_KEY>"
# 또는
curl -s "http://localhost:3000/api/usage?key=<API_KEY>"
```

### 에러

| HTTP | 상황 |
|---|---|
| `401` | 키 무효·비활성 |

---

## 참고

- 요청/응답 기록은 DB `request_log` 테이블에 `channel = ask:<keyId>`로 저장됩니다(그 시점의 `uid`/`sid` 포함).
- 비동기 결과 파일(`/results/<id>.json`)은 생성 완료 후 조회 가능하며, 서버가 정적으로 제공합니다.
