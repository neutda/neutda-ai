/**
 * 슬롯 인지 라우팅: preferred tier 를 슬롯 여유에 맞게 조정.
 * LLM 힌트와 별개로 최종 권위는 여기(결정적).
 */
import { config } from "./config.js";
import { pool } from "./pool.js";
import { logger } from "./logger.js";

const TIER_RANK = { small: 0, medium: 1, large: 2 };
const VALID_TIERS = new Set(["small", "medium", "large"]);

/** router.checkHardOverrides 와 동일 기준 (순환 import 방지) */
function isHardLocked(body, reason = "") {
  const explicit = String(body?.MODEL_TIER ?? "").toLowerCase();
  if (VALID_TIERS.has(explicit)) return true;
  const content = body?.content;
  if (content !== undefined && content !== null && content !== "") return true;
  if (body?.THINKING === true) return true;
  if (/^(image|thinking|explicit MODEL_TIER)/i.test(String(reason || ""))) {
    return true;
  }
  return false;
}

function tierBag(snap) {
  return snap?.byTier || {};
}

/**
 * @param {object} route - { tier, reason, difficulty, ... }
 * @param {object} body
 * @param {{ snapshot?: object, lockTier?: boolean, maxDemoteDifficulty?: number }} [opts]
 * @returns {object} adjusted route (shallow copy)
 */
export function applyLoadAwareRoute(route, body, opts = {}) {
  if (!route || !config.loadAware) return route;

  const preferred = String(route.tier || "medium").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(TIER_RANK, preferred)) return route;

  const lockTier =
    opts.lockTier === true || isHardLocked(body, route.reason);

  if (lockTier) {
    pool.recordLoadSkip("hard");
    return route;
  }

  const snap = opts.snapshot || pool.slotSnapshot();
  const by = tierBag(snap);
  const pref = by[preferred] || { cap: 0, used: 0, free: 0 };
  const difficulty = Number(route.difficulty);
  const diff = Number.isFinite(difficulty) ? difficulty : 50;
  const maxDemote =
    opts.maxDemoteDifficulty != null
      ? Number(opts.maxDemoteDifficulty)
      : config.loadDemoteMaxDifficulty;

  // preferred 에 여유 있으면 유지 (free 는 0 하한이라 used/cap 로 판정)
  const prefRoom = (pref.cap || 0) - (pref.used || 0);
  if (pref.cap > 0 && prefRoom > 0) {
    pool.recordLoadSkip("free");
    return route;
  }
  // preferred 서버가 없으면(cap=0) 손대지 않음 — 기존 pick/페일오버에 맡김
  if (pref.cap <= 0) return route;

  // medium 포화 → 유휴 large 가 있으면 승격(강등의 대칭). large 유휴 활용.
  if (preferred === "medium" && config.loadPromote) {
    const lg = by.large || { cap: 0, used: 0, free: 0 };
    const lgRoom = (lg.cap || 0) - (lg.used || 0);
    const minPromote = Number(config.loadPromoteMinDifficulty) || 0;
    if (lg.cap > 0 && lgRoom > 0) {
      if (diff >= minPromote) {
        const note =
          `load: medium ${pref.used}/${pref.cap} 포화 → promote large ${lg.used || 0}/${lg.cap} ` +
          `(diff=${diff}>=${minPromote}, 유휴 ${lgRoom})`;
        pool.recordLoadPromote(note);
        logger.info(`슬롯 인지 승격 ${note}`);
        return {
          ...route,
          tier: "large",
          reason: `${route.reason || "route"} → ${note}`,
          loadPromoted: true,
          loadPromoteFrom: "medium",
          preferredTier: preferred,
        };
      }
      // large 여유는 있으나 난이도 낮아 빠른 medium 대기가 나음 → 승격 보류
      pool.recordLoadSkip("promoLowDiff");
    } else if (lg.cap > 0) {
      // medium·large 둘 다 포화 → 승격 불가(양 티어 압박 신호)
      pool.recordLoadSkip("promoBusy");
    }
  }

  // large 포화(또는 초과) → medium 강등
  // medium 도 꽉 찬 뒤에도 large 에 나머지를 몰지 않음 (예전: medium.free>0 일 때만
  // 강등 → #1–4 large, #5–12 medium 이후 #13+ 가 다시 large 로 폭주)
  if (preferred === "large") {
    const med = by.medium || { cap: 0, used: 0, free: 0 };
    if (med.cap > 0 && prefRoom <= 0 && diff < maxDemote) {
      const note =
        `load: large ${pref.used}/${pref.cap} → demote medium ${med.used || 0}/${med.cap} ` +
        `(diff=${diff}<${maxDemote})`;
      pool.recordLoadDemote(note);
      logger.info(`슬롯 인지 강등 ${note}`);
      return {
        ...route,
        tier: "medium",
        reason: `${route.reason || "route"} → ${note}`,
        loadDemoted: true,
        loadDemoteFrom: "large",
        preferredTier: preferred,
      };
    }
    if (diff >= maxDemote) {
      pool.recordLoadSkip("diff");
    }
  }

  return route;
}

/**
 * createPlan 결과(plan)에 load-aware 적용.
 * - direct: plan.tier 조정
 * - workflow: 마지막 스텝만 조정
 */
export function applyLoadAwarePlan(plan, body, opts = {}) {
  if (!plan || !config.loadAware) return plan;

  const snap = opts.snapshot || pool.slotSnapshot();

  if (plan.mode === "direct" || !plan.mode) {
    const route = applyLoadAwareRoute(
      {
        tier: plan.tier,
        reason: plan.reason,
        difficulty: plan.difficulty,
        device: plan.device,
        deviceReason: plan.deviceReason,
        skill: plan.skill,
      },
      body,
      { ...opts, snapshot: snap },
    );
    if (route.tier === plan.tier && !route.loadDemoted && !route.loadPromoted)
      return plan;
    return {
      ...plan,
      tier: route.tier,
      reason: route.reason,
      loadDemoted: route.loadDemoted || false,
      loadDemoteFrom: route.loadDemoteFrom || null,
      loadPromoted: route.loadPromoted || false,
      loadPromoteFrom: route.loadPromoteFrom || null,
    };
  }

  if (plan.mode === "workflow" && Array.isArray(plan.steps) && plan.steps.length) {
    const steps = [...plan.steps];
    const last = steps.length - 1;
    const s = steps[last];
    const route = applyLoadAwareRoute(
      {
        tier: s.tier,
        reason: plan.reason,
        difficulty: plan.difficulty,
        skill: s.skill ?? plan.skill,
      },
      body,
      { ...opts, snapshot: snap },
    );
    if (route.tier !== s.tier) {
      steps[last] = { ...s, tier: route.tier };
      return {
        ...plan,
        steps,
        tier: route.tier,
        reason: route.reason,
        loadDemoted: route.loadDemoted || false,
        loadDemoteFrom: route.loadDemoteFrom || null,
        loadPromoted: route.loadPromoted || false,
        loadPromoteFrom: route.loadPromoteFrom || null,
      };
    }
  }

  return plan;
}
