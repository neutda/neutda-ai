import { config } from "./config.js";
import { classifyWithLlm } from "./llmRouter.js";
import { pool } from "./pool.js";

const VALID_TIERS = new Set(["small", "medium", "large"]);

// 복잡한 작업을 시사하는 키워드(휴리스틱 폴백용) — config(.env)로 외부화.
// LLM 라우터가 있으면 그쪽이 역할 설명 기준으로 판단하고, 이 목록은 폴백에만 쓴다.

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
  const hasKeyword = config.complexKeywords.some((k) =>
    lower.includes(k.toLowerCase()),
  );

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

  // 시스템 지시문(페르소나·출력형식 등)이 있으면 small(0.5B)은 지시 준수가
  // 어려우므로 최소 medium 으로 올린다.
  if (sys.trim()) {
    return { tier: "medium", reason: "heuristic: system-prompt → min medium" };
  }

  return {
    tier: "medium",
    reason: "heuristic: simple → medium (no router)",
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

  // 이미지·thinking·코드만 100 고정.
  // tier===large 를 100으로 두면 load-aware 강등(diff<75)이 영원히 막힌다.
  if (hasImage || thinking || hasCode) {
    const why = hasImage ? "image" : thinking ? "thinking" : "code-like";
    return { difficulty: 100, device: "gpu", reason: `heavy:${why}` };
  }

  let lo = 0;
  let hi = config.smallMaxChars;
  if (tier === "medium") {
    lo = config.smallMaxChars;
    hi = config.largeMinChars;
  } else if (tier === "large") {
    // large 선호여도 실제 난이도는 길이 기반으로 — 중간대(50~74)면 슬롯 포화 시 medium 강등 가능
    lo = config.smallMaxChars;
    hi = Math.max(config.largeMinChars * 2, config.largeMinChars + 1);
  }
  const span = Math.max(hi - lo, 1);
  const posScore = Math.min(Math.max((len - lo) / span, 0), 1) * 70;
  const historyScore = Math.min(historyTurns / 4, 1) * 30;
  let difficulty = Math.round(Math.min(posScore + historyScore, 100));
  // large 로 분류됐으면 하한만 살짝 (small 난이도로 착각 방지), 강등 임계(75) 미만은 유지
  if (tier === "large") {
    difficulty = Math.max(difficulty, 55);
  }

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

  let route;
  if (useLlmRouter) {
    const llm = await classifyWithLlm(body);
    route = llm || routeFromHeuristic(body);
  } else {
    route = routeFromHeuristic(body);
  }

  const { applyLoadAwareRoute } = await import("./loadAwareRoute.js");
  return applyLoadAwareRoute(route, body);
}
