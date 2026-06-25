import "dotenv/config";

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeUrl(u) {
  return u.trim().replace(/\/+$/, "");
}

// 백엔드 목록을 [{ url, tier }] 형태로 파싱한다.
// 우선순위: LLAMA_BACKENDS(tier@url 태그) > LLAMA_SERVERS(평면, tier=large) > LLAMA_SERVER_URL > 기본값
function parseBackends() {
  const tagged = process.env.LLAMA_BACKENDS;
  if (tagged) {
    const seen = new Set();
    const out = [];
    for (const part of tagged.split(",")) {
      const token = part.trim();
      if (!token) continue;
      // 형식: "tier@url" 또는 "tier@url@device"(device=gpu|cpu)
      const segs = token.split("@");
      let tier = "large";
      let url = token;
      let device = null;
      if (segs.length >= 2) {
        tier = segs[0].trim().toLowerCase() || "large";
        const last = segs[segs.length - 1].trim().toLowerCase();
        if (segs.length >= 3 && (last === "gpu" || last === "cpu")) {
          device = last;
          url = segs.slice(1, -1).join("@");
        } else {
          url = segs.slice(1).join("@");
        }
      }
      url = normalizeUrl(url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, tier, device });
    }
    if (out.length) return out;
  }
  const raw = process.env.LLAMA_SERVERS || process.env.LLAMA_SERVER_URL || "http://127.0.0.1:8080";
  const seen = new Set();
  return raw
    .split(",")
    .map(normalizeUrl)
    .filter((u) => u && !seen.has(u) && seen.add(u))
    .map((url) => ({ url, tier: "large" }));
}

export const config = {
  port: num(process.env.PORT, 3000),
  backends: parseBackends(),
  modelName: process.env.MODEL_NAME || "qwen",
  // 외부 API 키(우선 고정값). .env 의 API_KEY 로 덮어쓸 수 있음
  apiKey: process.env.API_KEY || "tw-demo-key-2026",
  defaultTemperature: num(process.env.DEFAULT_TEMPERATURE, 0.7),
  defaultMaxTokens: num(process.env.DEFAULT_MAX_TOKENS, 2048),
  // 컨텍스트 초과 방지: 티어별 max_tokens 와 프롬프트(시스템+히스토리+질문) 글자수 상한
  // small/medium 은 ctx 4096 가정 → 보수적으로 제한, large 는 ctx 8192 가정
  maxTokensSmall: num(process.env.MAX_TOKENS_SMALL, 1024),
  maxPromptCharsSmall: num(process.env.MAX_PROMPT_CHARS_SMALL, 1800),
  maxPromptCharsLarge: num(process.env.MAX_PROMPT_CHARS_LARGE, 3500),
  requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 120000),
  // Qwen3.6 는 thinking(추론) 모델. 기본은 끔(직접 답변). 켜면 추론에 토큰을 많이 사용.
  enableThinking: String(process.env.ENABLE_THINKING).toLowerCase() === "true",
  // 풀/로드밸런서 설정
  healthIntervalMs: num(process.env.HEALTH_INTERVAL_MS, 5000),
  maxRetries: num(process.env.MAX_RETRIES, 2),
  // 라우팅 설정
  defaultTier: (process.env.DEFAULT_TIER || "small").toLowerCase(),
  escalateTier: String(process.env.ESCALATE_TIER ?? "true").toLowerCase() === "true",
  // 휴리스틱 임계값(글자수): smallMaxChars 이하=small, 그 사이=medium, largeMinChars 초과=large
  smallMaxChars: num(process.env.SMALL_MAX_CHARS, 200),
  largeMinChars: num(process.env.LARGE_MIN_CHARS, 600),
  // 난이도 점수(0~100)가 이 값 이상이면 같은 티어 내에서 GPU 백엔드 선호
  gpuMinDifficulty: num(process.env.GPU_MIN_DIFFICULTY, 50),
};
