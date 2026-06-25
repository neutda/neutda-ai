import { config } from "./config.js";
import { classifyWithLlm } from "./llmRouter.js";
import { pool } from "./pool.js";

const VALID_TIERS = new Set(["small", "medium", "large"]);

// 복잡한 작업을 시사하는 키워드(휴리스틱 폴백용)
const COMPLEX_KEYWORDS = [
  "분석", "비교", "요약", "작성", "설계", "추론", "증명", "코드", "디버그", "리팩터",
  "알고리즘", "수식", "계산", "단계별", "왜", "근거", "전략", "기획", "번역",
  "analyze", "compare", "summari", "explain why", "step by step", "reasoning",
  "code", "debug", "refactor", "algorithm", "prove", "translate", "design",
];

/**
 * 명시 지정·이미지·THINKING 등 LLM 라우터를 건너뛰는 하드 규칙.
 * @returns {{ tier: string, reason: string } | null}
 */
export function checkHardOverrides(body) {
  const explicit = String(body?.MODEL_TIER ?? "").toLowerCase();
  if (VALID_TIERS.has(explicit)) {
    return { tier: explicit, reason: "explicit MODEL_TIER" };
  }

  const content = body?.content;
  const hasImage = content !== undefined && content !== null && content !== "";
  if (hasImage) {
    return { tier: "large", reason: "image input requires vision model" };
  }

  if (body?.THINKING === true) {
    return { tier: "large", reason: "thinking enabled" };
  }

  return null;
}

/**
 * 글자수·키워드 기반 휴리스틱 티어 판정 (하드 규칙 이후 단계).
 * @returns {{ tier: string, reason: string }}
 */
export function chooseTierHeuristic(body) {
  const text = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const sys = typeof body?.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "";
  const len = text.length + sys.length;

  const lower = (text + " " + sys).toLowerCase();
  const hasCode = /```|\bfunction\b|=>|;\s*$|\bclass\b|def |#include/i.test(text);
  const hasKeyword = COMPLEX_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));

  if (hasCode || hasKeyword || len > config.largeMinChars) {
    const why = [
      len > config.largeMinChars ? `length>${config.largeMinChars}` : null,
      hasCode ? "code-like" : null,
      hasKeyword ? "complex-keyword" : null,
    ]
      .filter(Boolean)
      .join(",");
    return { tier: "large", reason: `heuristic: ${why}` };
  }

  if (len > config.smallMaxChars) {
    return { tier: "medium", reason: `heuristic: length>${config.smallMaxChars}` };
  }

  return {
    tier: VALID_TIERS.has(config.defaultTier) ? config.defaultTier : "small",
    reason: "heuristic: simple",
  };
}

/**
 * 요청을 보고 사용할 티어("small" | "medium" | "large")를 결정한다.
 * @returns {{ tier: string, reason: string }}
 */
export function chooseTier(body) {
  return checkHardOverrides(body) ?? chooseTierHeuristic(body);
}

/**
 * 선택된 티어 "내부"에서의 난이도를 0~100으로 정규화한다.
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

  if (tier === "large" || hasImage || thinking || hasCode) {
    const why = tier === "large" ? "large-tier" : hasImage ? "image" : thinking ? "thinking" : "code-like";
    return { difficulty: 100, device: "gpu", reason: `heavy:${why}` };
  }

  let lo = 0;
  let hi = config.smallMaxChars;
  if (tier === "medium") {
    lo = config.smallMaxChars;
    hi = config.largeMinChars;
  }
  const span = Math.max(hi - lo, 1);
  const posScore = Math.min(Math.max((len - lo) / span, 0), 1) * 70;
  const historyScore = Math.min(historyTurns / 4, 1) * 30;
  const difficulty = Math.round(Math.min(posScore + historyScore, 100));

  const device = difficulty >= config.gpuMinDifficulty ? "gpu" : "cpu";
  return { difficulty, device, reason: `score=${difficulty}(pos:${Math.round(posScore)},hist:${Math.round(historyScore)})` };
}

function routeFromHeuristic(body) {
  const t = chooseTierHeuristic(body);
  const d = scoreDifficulty(body, t.tier);
  return {
    tier: t.tier,
    reason: t.reason,
    device: d.device,
    difficulty: d.difficulty,
    deviceReason: d.reason,
  };
}

/**
 * 티어 + 난이도 기반 장치 선호를 한 번에 결정한다.
 * 라우터 역할이 켜진 모델이 있으면 해당 모델이 티어·난이도를 분류한다.
 *
 * @returns {Promise<{ tier, reason, device, difficulty, deviceReason }>}
 */
export async function chooseRoute(body) {
  const hard = checkHardOverrides(body);
  if (hard) {
    const d = scoreDifficulty(body, hard.tier);
    return {
      tier: hard.tier,
      reason: hard.reason,
      device: d.device,
      difficulty: d.difficulty,
      deviceReason: d.reason,
    };
  }

  const useLlmRouter = pool.hasActiveRouter();

  if (useLlmRouter) {
    const llm = await classifyWithLlm(body);
    if (llm) return llm;
  }

  return routeFromHeuristic(body);
}
