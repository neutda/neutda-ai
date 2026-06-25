import { config } from "./config.js";

const VALID_TIERS = new Set(["small", "medium", "large"]);

// 복잡한 작업을 시사하는 키워드(있으면 large 쪽으로 가중)
const COMPLEX_KEYWORDS = [
  "분석", "비교", "요약", "작성", "설계", "추론", "증명", "코드", "디버그", "리팩터",
  "알고리즘", "수식", "계산", "단계별", "왜", "근거", "전략", "기획", "번역",
  "analyze", "compare", "summari", "explain why", "step by step", "reasoning",
  "code", "debug", "refactor", "algorithm", "prove", "translate", "design",
];

/**
 * 요청을 보고 사용할 티어("small" | "medium" | "large")를 결정한다.
 * 우선순위: 명시적 지정 > 이미지(비전) > THINKING > 휴리스틱(복잡도)
 *
 * @returns {{ tier: string, reason: string }}
 */
export function chooseTier(body) {
  // 1) 명시적 지정
  const explicit = String(body?.MODEL_TIER ?? "").toLowerCase();
  if (VALID_TIERS.has(explicit)) {
    return { tier: explicit, reason: "explicit MODEL_TIER" };
  }

  // 2) 이미지 입력 → 비전 가능한 large 강제 (소형 텍스트 모델은 비전 불가)
  const content = body?.content;
  const hasImage = content !== undefined && content !== null && content !== "";
  if (hasImage) {
    return { tier: "large", reason: "image input requires vision model" };
  }

  // 3) THINKING(추론) 요청 → large
  if (body?.THINKING === true) {
    return { tier: "large", reason: "thinking enabled" };
  }

  // 4) 휴리스틱 복잡도 판정
  const text = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const sys = typeof body?.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "";
  const len = text.length + sys.length;

  const lower = (text + " " + sys).toLowerCase();
  const hasCode = /```|\bfunction\b|=>|;\s*$|\bclass\b|def |#include/i.test(text);
  const hasKeyword = COMPLEX_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));

  // 복잡한 작업(코드/키워드) 또는 아주 긴 입력 → large
  if (hasCode || hasKeyword || len > config.largeMinChars) {
    const why = [
      len > config.largeMinChars ? `length>${config.largeMinChars}` : null,
      hasCode ? "code-like" : null,
      hasKeyword ? "complex-keyword" : null,
    ].filter(Boolean).join(",");
    return { tier: "large", reason: `heuristic: ${why}` };
  }

  // 중간 길이 → medium
  if (len > config.smallMaxChars) {
    return { tier: "medium", reason: `heuristic: length>${config.smallMaxChars}` };
  }

  // 짧고 단순 → small (기본 티어)
  return { tier: VALID_TIERS.has(config.defaultTier) ? config.defaultTier : "small", reason: "heuristic: simple" };
}

/**
 * 선택된 티어 "내부"에서의 난이도를 0~100으로 정규화한다.
 * - 티어 구간(small: 0~smallMaxChars, medium: smallMaxChars~largeMinChars) 안에서의 위치
 * - 대화 누적(history)이 길수록 가중
 * 점수 >= config.gpuMinDifficulty 이면 GPU 선호, 아니면 CPU 선호.
 * (large 티어 및 이미지/THINKING/코드 등 무거운 작업은 항상 GPU)
 *
 * @returns {{ difficulty: number, device: "gpu"|"cpu", reason: string }}
 */
export function scoreDifficulty(body, tier) {
  const text = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const sys = typeof body?.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "";
  const len = text.length + sys.length;
  const historyTurns = Array.isArray(body?.HISTORY) ? body.HISTORY.length : 0;

  const content = body?.content;
  const hasImage = content !== undefined && content !== null && content !== "";
  const thinking = body?.THINKING === true;
  const hasCode = /```|\bfunction\b|=>|;\s*$|\bclass\b|def |#include/i.test(text);

  // large 티어이거나 무거운 작업 → 항상 최고 난이도(GPU)
  if (tier === "large" || hasImage || thinking || hasCode) {
    const why = tier === "large" ? "large-tier" : hasImage ? "image" : thinking ? "thinking" : "code-like";
    return { difficulty: 100, device: "gpu", reason: `heavy:${why}` };
  }

  // 티어 구간 결정
  let lo = 0;
  let hi = config.smallMaxChars;
  if (tier === "medium") {
    lo = config.smallMaxChars;
    hi = config.largeMinChars;
  }
  const span = Math.max(hi - lo, 1);
  // 구간 내 위치(0~70) + 대화 누적 가중(0~30)
  const posScore = Math.min(Math.max((len - lo) / span, 0), 1) * 70;
  const historyScore = Math.min(historyTurns / 4, 1) * 30;
  const difficulty = Math.round(Math.min(posScore + historyScore, 100));

  const device = difficulty >= config.gpuMinDifficulty ? "gpu" : "cpu";
  return { difficulty, device, reason: `score=${difficulty}(pos:${Math.round(posScore)},hist:${Math.round(historyScore)})` };
}

/**
 * 티어 + 난이도 기반 장치 선호를 한 번에 결정한다.
 * @returns {{ tier, reason, device, difficulty, deviceReason }}
 */
export function chooseRoute(body) {
  const t = chooseTier(body);
  const d = scoreDifficulty(body, t.tier);
  return {
    tier: t.tier,
    reason: t.reason,
    device: d.device,
    difficulty: d.difficulty,
    deviceReason: d.reason,
  };
}
