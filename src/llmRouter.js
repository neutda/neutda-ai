import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./pool.js";
import { chooseTierHeuristic } from "./router.js";
import {
  VALID_TIERS,
  buildRouterSystemPrompt,
  buildRouterUserPrompt,
  resolveSkillChoice,
  parseRouterJson,
  clamp,
  truncate,
  skillMenu,
} from "./routerShared.js";

// 하위 호환: 기존 import 경로 유지
export { parseRouterJson, resolveSkillChoice, skillMenu };

/**
 * 라우터 역할 백엔드에 분류를 먼저 요청한다 (풀 경유 → 통계 반영).
 * 실패·파싱 오류 시 null (호출측에서 휴리스틱 폴백).
 *
 * @returns {Promise<{ tier, difficulty, device, reason, deviceReason, routerBackend } | null>}
 */
export async function classifyWithLlm(body) {
  if (!pool.hasActiveRouter()) return null;

  const started = Date.now();
  const skillOptions = pool.skillOptions();
  const slotsHint = pool.slotSnapshot()?.promptBlock || "";
  try {
    const out = await pool.classify({
      messages: [
        {
          role: "system",
          content: buildRouterSystemPrompt(skillOptions, slotsHint),
        },
        { role: "user", content: buildRouterUserPrompt(body) },
      ],
      temperature: config.routerTemperature,
      maxTokens: config.routerMaxTokens,
      // 긴 글·고난도면 상위 라우터가 분류하도록 요구 티어를 넘긴다.
      minTier: chooseTierHeuristic(body).tier,
    });
    if (!out) return null;

    const {
      result,
      backendUrl,
      tier: routerTier,
      device: routerDevice,
      alias: routerAlias,
      model: routerModel,
    } = out;
    const parsed = parseRouterJson(result.content);
    if (!parsed) {
      logger.warn(
        `라우터 모델 JSON 파싱 실패 @ ${backendUrl}: ${truncate(result.content, 120)}`,
      );
      return null;
    }

    const tierRaw = String(parsed.tier ?? "").toLowerCase();
    if (!VALID_TIERS.has(tierRaw)) {
      logger.warn(
        `라우터 모델이 잘못된 tier 반환 @ ${backendUrl}: ${parsed.tier}`,
      );
      return null;
    }
    let tier = tierRaw;

    const difficulty = clamp(
      Math.round(Number(parsed.difficulty) || 50),
      0,
      100,
    );
    const device = difficulty >= config.gpuMinDifficulty ? "gpu" : "cpu";
    const reasonText =
      typeof parsed.reason === "string" ? parsed.reason.trim() : "classified";
    let skill = resolveSkillChoice(parsed.skill, skillOptions);
    const qLen = String(body?.ROLE_USER ?? "").trim().length;
    const hasCodeFence = /```/.test(String(body?.ROLE_USER ?? ""));
    // 현재 질문이 길거나 코드면 단문 특기 오매칭 차단 (HISTORY 길이로 막지 않음)
    if (skill && (qLen >= config.smallMaxChars || hasCodeFence)) {
      logger.info(
        `라우터 특기 무시(현재질문 구조): skill="${skill}" qLen=${qLen}`,
      );
      skill = null;
    }
    // 역할(특기)이 맞으면 티어를 특기 서버에 맞춤 (역할 우선)
    if (skill) {
      if (!pool.skillHasTier(skill, tier)) {
        const st = pool.tierForSkill(skill);
        if (st) {
          logger.info(
            `라우터 티어 정렬(특기 우선): ${tier} → ${st} skill="${skill}"`,
          );
          tier = st;
        } else {
          logger.info(`라우터 특기 무시(서버 없음): skill="${skill}"`);
          skill = null;
        }
      }
    }

    logger.info(
      `라우터 선행 분류 @ ${routerAlias || routerTier || "?"} ${backendUrl} → tier=${tier}${skill ? ` skill="${skill}"` : ""} diff=${difficulty} device=${device} (${Date.now() - started}ms): ${reasonText}`,
    );

    return {
      tier,
      skill,
      difficulty,
      device,
      reason: skill
        ? `llm-router: ${reasonText} (특기: ${skill})`
        : `llm-router: ${reasonText}`,
      deviceReason: `llm:score=${difficulty}`,
      routerBackend: backendUrl,
      routerTier: routerTier || null,
      routerAlias: routerAlias || null,
      routerDevice: routerDevice || null,
      routerModel: routerModel || null,
    };
  } catch (err) {
    logger.warn(
      `라우터 선행 분류 실패 → 휴리스틱 폴백 (${Date.now() - started}ms): ${err.message}`,
    );
    return null;
  }
}
