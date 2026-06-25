import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./pool.js";

const VALID_TIERS = new Set(["small", "medium", "large"]);

const ROUTER_SYSTEM = `You are a request router for a multi-tier LLM system.
Analyze the user request and respond with ONLY one JSON object — no markdown, no explanation outside JSON.

Tiers:
- small: greetings, simple facts, one-line answers, trivial lookups
- medium: moderate explanations, summaries, light multi-step tasks
- large: complex reasoning, coding, math/proofs, deep analysis, long creative writing, translation of long text

difficulty: integer 0–100 (higher = more compute needed; coding and multi-step reasoning should be high)

Output format: {"tier":"small|medium|large","difficulty":0-100,"reason":"brief Korean reason"}`;

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

function truncate(s, max) {
  const t = String(s ?? "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

/** 모델 응답에서 JSON 객체를 추출한다. */
export function parseRouterJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const attempts = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1].trim());
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) attempts.push(brace[0]);

  for (const candidate of attempts) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object") return obj;
    } catch {
      /* try next */
    }
  }
  return null;
}

function buildRouterPrompt(body) {
  const userText = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const sysText = typeof body?.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "";
  const historyTurns = Array.isArray(body?.HISTORY) ? body.HISTORY.length : 0;
  const hasImage = body?.content !== undefined && body?.content !== null && body?.content !== "";

  return [
    `system_prompt: ${truncate(sysText, 400) || "(none)"}`,
    `user_question: ${truncate(userText, 1200)}`,
    `history_turns: ${historyTurns}`,
    `has_image: ${hasImage}`,
  ].join("\n");
}

/**
 * 라우터 역할 백엔드에 분류를 먼저 요청한다 (풀 경유 → 통계 반영).
 * 실패·파싱 오류 시 null (호출측에서 휴리스틱 폴백).
 *
 * @returns {Promise<{ tier, difficulty, device, reason, deviceReason, routerBackend } | null>}
 */
export async function classifyWithLlm(body) {
  if (!pool.hasActiveRouter()) return null;

  const started = Date.now();
  try {
    const out = await pool.classify({
      messages: [
        { role: "system", content: ROUTER_SYSTEM },
        { role: "user", content: buildRouterPrompt(body) },
      ],
      temperature: config.routerTemperature,
      maxTokens: config.routerMaxTokens,
    });
    if (!out) return null;

    const { result, backendUrl } = out;
    const parsed = parseRouterJson(result.content);
    if (!parsed) {
      logger.warn(`라우터 모델 JSON 파싱 실패 @ ${backendUrl}: ${truncate(result.content, 120)}`);
      return null;
    }

    const tier = String(parsed.tier ?? "").toLowerCase();
    if (!VALID_TIERS.has(tier)) {
      logger.warn(`라우터 모델이 잘못된 tier 반환 @ ${backendUrl}: ${parsed.tier}`);
      return null;
    }

    const difficulty = clamp(Math.round(Number(parsed.difficulty) || 50), 0, 100);
    const device = difficulty >= config.gpuMinDifficulty ? "gpu" : "cpu";
    const reasonText = typeof parsed.reason === "string" ? parsed.reason.trim() : "classified";

    logger.info(
      `라우터 선행 분류 @ ${backendUrl} → tier=${tier} diff=${difficulty} device=${device} (${Date.now() - started}ms): ${reasonText}`,
    );

    return {
      tier,
      difficulty,
      device,
      reason: `llm-router: ${reasonText}`,
      deviceReason: `llm:score=${difficulty}`,
      routerBackend: backendUrl,
    };
  } catch (err) {
    logger.warn(`라우터 선행 분류 실패 → 휴리스틱 폴백 (${Date.now() - started}ms): ${err.message}`);
    return null;
  }
}
