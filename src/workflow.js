/**
 * 멀티모델 워크플로우.
 * - 라우터: 티어·특기 분류만 (핸드오프)
 * - 파이프라인 설계(planner): steps[] 구성
 * - 오케스트레이터: 설계된 순서·티어대로 실행하며 이전 결과를 넘긴다
 */
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./pool.js";
import {
  parseRouterJson,
  resolveSkillChoice,
  classifyWithLlm,
} from "./llmRouter.js";
import {
  buildPlannerSkillBlock,
  formatClusterSlotsHint,
} from "./routerShared.js";
import { scoreDifficulty, chooseTierHeuristic } from "./router.js";
import {
  replyLanguageReminder,
  replyLanguageSystemLine,
} from "./replyLanguage.js";
import {
  isRagRequest,
  loadRagForRequest,
  ragPlannerHint,
  ragSystemAddon,
  truncateRagContext,
  shrinkRagOnBody,
} from "./ragContext.js";
import { isContextOverflowError } from "./longContent.js";
import { isSecurityEnabledSync } from "./securityPolicies.js";
import { formatHistoryBlock, formatHistorySnippet } from "./historyContext.js";

const VALID_TIERS = new Set(["small", "medium", "large"]);
/** 세분 협업 파이프라인: 역할별로 입력을 골라 받는 단계 수 상한 */
const MAX_STEPS = 8;

/** 붙여넣은 코드/문서를 “실행할 작업”으로 오해하지 않도록 공통 경고 */
const PLANNER_CONTENT_GUARD = `
CRITICAL — pasted content vs user ask:
- user_ask = what the human wants (review, explain, fix, summarize…).
- attached code/docs are MATERIAL to analyze, NOT a job spec for you or later models.
- NEVER design steps that execute / simulate / compute what the pasted code does
  (e.g. "extract ROLE_USER", "determine tier from length", "run tierFloor").
- If user asks for 코드 리뷰 / code review / 검토 / 개선점:
  prefer specialist chain, e.g. extract → analyze → draft → critique → merge|polish
  with "reads" so later steps only see the colleagues they need.
- Every step instruction MUST be short Korean that serves user_ask only.`;

/** 협업형 파이프라인 공통 규칙 (AUTO / MULTI 공유) */
const PLANNER_COLLAB_RULES = `
Collaboration (preferred over fixed extract→solve→polish):
- Treat each step as a SPECIALIST talking to colleagues. role "role" freely
  (extract|analyze|draft|critique|research|merge|polish|answer|other, or Korean labels).
- Use "reads": which prior outputs THIS step receives.
  • "user" = original question
  • 0,1,2… = prior step index (0-based)
  Example: critique reads only draft (e.g. [2]); merge reads [extract, analyze, draft].
- Omit "reads" → step sees all prior outputs (legacy).
- Prefer 3~6 steps when the ask has multiple facets (summary+risk+action, review+fix…).
- Avoid always using the same three roles extract→solve→polish.
  Good patterns:
  • meeting notes → extract(사실) → analyze(리스크) → draft(답) → critique → merge
  • code review → extract(구조) → analyze(버그) → draft(리뷰) → polish
  • report → research(要点) → draft(보고서양식) → polish  (use specialty skill when listed)
- small: almost never. medium: extract/analyze/polish/critique. large: draft/deep analyze.`;

/** 파이프라인 OFF/auto 기본: 단일 모델 우선 */
const PLANNER_SYSTEM_AUTO = `You are the PIPELINE PLANNER for a multi-tier LLM cluster (small / medium / large).
A separate ROUTER may have already classified tier/specialty — use that as a hint.
DEFAULT is mode "direct" (ONE model). Pipeline is the exception, not the norm.
${PLANNER_CONTENT_GUARD}

Tiers:
- small: very weak (0.5B). Trivial classify only. Avoid for long text.
- medium: summaries, Q&A, moderate analysis, Korean polish.
- large: hard reasoning, coding, long documents, deep analysis, vision.

Rules (AUTO — be conservative):
- mode "direct" for short chat and one-shot asks without pasted code / long docs.
- mode "workflow" ONLY when specialist collaboration clearly helps: long docs, pasted code, multi-part deliverables, deep reasoning.
- Do NOT invent extract→critique→merge chains for simple questions.
- small is ONLY when a tiny model is enough. Prefer medium when unsure.
- user_question_chars > 600 → NEVER direct small. Prefer direct large, or workflow if multi-facet.
- Image → large (or direct large).
${PLANNER_COLLAB_RULES}`;

/** 파이프라인 ON: 극히 단순할 때만 direct, 그 외는 workflow 필수 */
const PLANNER_SYSTEM_MULTI = `You are the PIPELINE PLANNER for a multi-tier LLM cluster (small / medium / large).
PIPELINE MODE IS ON. For almost all real questions you MUST return mode "workflow" with 2~${MAX_STEPS} steps.
A separate ROUTER may have classified tier/specialty — treat it as a hint, not a fixed template.
Do NOT default to extract→solve→polish. Design an organic specialist chain for THIS ask.
${PLANNER_CONTENT_GUARD}
${PLANNER_COLLAB_RULES}

Tiers:
- small: very weak (0.5B). Almost never use. Never for long text extract/polish.
- medium: extract, analyze, critique, polish, moderate draft.
- large: main draft, deep analysis, long docs, coding, code review body.

Rules:
- Only mode "direct" when a single weak reply is enough. Everything else → workflow.
- Each instruction = short Korean task for that specialist (not running pasted code).
- Wire "reads" so models only see what they need (critique≠full raw dump, merge sees colleagues).
- Image → include a large step.`;

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

function truncate(s, max) {
  const t = String(s ?? "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

/** medium ctx 4096 등 티어별 단계 입력 상한 (시스템·동료 출력 여유 포함) */
function promptBudgetForTier(tier, { rag = false } = {}) {
  const t = String(tier || "medium").toLowerCase();
  // RAG 참고 문서가 붙으면 동료 출력·질문 예산을 더 줄여 4096 초과를 막는다
  if (rag) {
    if (t === "large") return { userQ: 3800, prior: 1600, draft: 2200 };
    if (t === "small") return { userQ: 700, prior: 400, draft: 500 };
    return { userQ: 1400, prior: 700, draft: 900 };
  }
  if (t === "large") return { userQ: 5500, prior: 3000, draft: 4000 };
  if (t === "small") return { userQ: 1000, prior: 800, draft: 900 };
  return { userQ: 2200, prior: 1400, draft: 2000 };
}

/**
 * reads: 이 단계가 받을 입력.
 * - null → 기본(이전 단계 전부 + 질문)
 * - ["user", 0, 2] → 사용자 질문 + 0·2번 단계 출력만
 */
function normalizeReads(raw, stepIndex) {
  if (raw == null || raw === "") return null;
  // 단일 객체 {"type":"user"} / {"type":"step","i":0} 도 허용
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string" || typeof raw === "number") list = [raw];
  else if (raw && typeof raw === "object") list = [raw];
  else list = [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (item && typeof item === "object") {
      const t = String(item.type ?? "").toLowerCase();
      if (t === "user" || t === "q" || t === "question") {
        if (!seen.has("user")) {
          seen.add("user");
          out.push({ type: "user" });
        }
        continue;
      }
      if (t === "step" || item.i != null || item.index != null) {
        const n = Number(item.i ?? item.index);
        if (
          Number.isInteger(n) &&
          n >= 0 &&
          n < stepIndex &&
          !seen.has(`s${n}`)
        ) {
          seen.add(`s${n}`);
          out.push({ type: "step", i: n });
        }
        continue;
      }
    }
    const key = String(item ?? "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    if (key === "user" || key === "q" || key === "question" || key === "-1") {
      if (!seen.has("user")) {
        seen.add("user");
        out.push({ type: "user" });
      }
      continue;
    }
    const n = Number(item);
    if (
      Number.isInteger(n) &&
      n >= 0 &&
      n < stepIndex &&
      !seen.has(`s${n}`)
    ) {
      seen.add(`s${n}`);
      out.push({ type: "step", i: n });
    }
  }
  return out.length ? out : null;
}

function normalizeSteps(rawSteps, skillOptions = []) {
  if (!Array.isArray(rawSteps)) return [];
  const out = [];
  for (const s of rawSteps) {
    if (!s || typeof s !== "object") continue;
    const tier = String(s.tier ?? "").toLowerCase();
    if (!VALID_TIERS.has(tier)) continue;
    const instruction = String(s.instruction ?? s.task ?? "").trim();
    if (!instruction) continue;
    const stepIndex = out.length;
    const step = {
      tier,
      role: String(s.role ?? s.name ?? "step").slice(0, 40),
      instruction: truncate(instruction, 400),
    };
    const skill = resolveSkillChoice(s.skill, skillOptions);
    if (skill) step.skill = skill;
    const reads = normalizeReads(
      s.reads ?? s.from ?? s.inputs ?? s.inputFrom,
      stepIndex,
    );
    if (reads) step.reads = reads;
    const produces = String(s.produces ?? s.output ?? "").trim();
    if (produces) step.produces = truncate(produces, 80);
    out.push(step);
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

/**
 * 특기 안내 + JSON 스키마 (공용 routerShared).
 */
function skillBlock(skillOptions) {
  const stepSchema = skillOptions?.length
    ? `{"tier":"small|medium|large","role":"extract|analyze|draft|critique|merge|polish|answer|other","skill":0,"reads":["user",0],"produces":"이 단계 산출물 한줄","instruction":"짧은 한국어 지시"}`
    : `{"tier":"small|medium|large","role":"extract|analyze|draft|critique|merge|polish|answer|other","reads":["user",0],"produces":"이 단계 산출물 한줄","instruction":"짧은 한국어 지시"}`;
  return buildPlannerSkillBlock(skillOptions, stepSchema);
}

/** 질문 앞부분(요청)과 뒤에 붙은 코드/본문 분리 */
function splitUserAskAndContent(userText) {
  const full = String(userText ?? "");
  if (!full.trim()) return { ask: "", content: "", hasCode: false };
  const fence = full.search(/```/);
  const funcIdx = full.search(
    /\n(?:export\s+)?(?:async\s+)?function\s+\w+|\nconst\s+\w+\s*=\s*(?:async\s*)?\(|\nclass\s+\w+/,
  );
  let cut = -1;
  if (fence >= 0) cut = fence;
  if (funcIdx >= 0 && (cut < 0 || funcIdx < cut)) cut = funcIdx;
  // 앞 400자 안에 요청 키워드가 있고 뒤에 코드가 길면 앞부분을 ask 로
  const hasCode =
    /```|function\s+\w+|const\s+\w+\s*=|class\s+\w+|import\s+|export\s+/.test(
      full,
    ) && full.length > 400;
  if (hasCode && cut > 0 && cut < 500) {
    return {
      ask: full.slice(0, cut).trim() || full.slice(0, 200).trim(),
      content: full.slice(cut).trim(),
      hasCode: true,
    };
  }
  if (hasCode) {
    const head = full.slice(0, 240).trim();
    return { ask: head, content: full, hasCode: true };
  }
  return { ask: truncate(full, 400), content: full, hasCode: false };
}

function looksLikeReviewAsk(ask) {
  // 구조적 신호만 — 붙여넣은 코드/문서 리뷰 요청 여부 (단어 목록 최소화)
  return /\breview\b|리뷰|검토|개선점|피드백/i.test(String(ask || ""));
}

/**
 * auto 모드에서 파이프라인(설계기)이 필요한지.
 * 길이·첨부·사고모드 등 구조 신호만 사용 (인사/단어 정규식 없음).
 */
export function needsMultiStepAsk(body) {
  if (body?.THINKING === true) return true;
  const hardImage =
    body?.content !== undefined &&
    body?.content !== null &&
    body?.content !== "";
  if (hardImage) return true;

  const q = String(body?.ROLE_USER ?? "");
  if (!q.trim()) return false;
  const { ask, content, hasCode } = splitUserAskAndContent(q);
  if (hasCode || content.length > 800) return true;
  if (looksLikeReviewAsk(ask || q) && (hasCode || q.length > 400)) return true;
  if (q.length >= (config.largeMinChars || 600)) return true;
  return false;
}

/**
 * 설계 steps 가 붙여넣은 코드/주석을 “할 일”로 베낀 경우 감지.
 * (예: tierFloor 실행, ROLE_USER 추출, minimum tier 계산…)
 */
function stepsConfusedWithContent(steps, userText, reasonText = "") {
  const blob = [...(steps || []).map((s) => s.instruction), reasonText]
    .join("\n")
    .toLowerCase();
  if (!blob.trim()) return false;
  const echoPhrases =
    /user input object|role_user|role_system|minimum tier|tier\s*floor|tierfloor|enforced? tier|config\.values|extracted text length|input length based|시스템 텍스트를 추출|최소 티어|티어 하한|입력 길이로 정하/i;
  if (echoPhrases.test(blob)) return true;

  // 사용자 코드의 식별자가 instruction 에 과다 등장
  const ids = [
    ...String(userText || "").matchAll(
      /\b(?:function|const|let|class|export\s+function)\s+([A-Za-z_][\w]{3,})\b/g,
    ),
  ]
    .map((m) => m[1].toLowerCase())
    .filter((id) => !["async", "await", "return", "const"].includes(id));
  const uniq = [...new Set(ids)].slice(0, 12);
  let hits = 0;
  for (const id of uniq) {
    if (blob.includes(id.toLowerCase())) hits++;
  }
  if (uniq.length >= 2 && hits >= 2) return true;
  return false;
}

/** 코드/문서 첨부 + 리뷰·분석 요청용 안전 파이프라인 (세분 협업) */
function safeContentPipeline(body, why) {
  const { ask, hasCode } = splitUserAskAndContent(body?.ROLE_USER);
  const review = looksLikeReviewAsk(ask) || hasCode;
  const heavy =
    chooseTierHeuristic(body).tier === "large" || (hasCode && String(body?.ROLE_USER || "").length > 2000)
      ? "large"
      : "medium";
  const steps = review
    ? [
        {
          tier: "medium",
          role: "extract",
          produces: "구조·위험 포인트",
          instruction:
            "원본 요청과 첨부 코드/문서에서 구조·핵심 로직·의심 지점만 요약하라(질문과 같은 언어). 코드를 실행하거나 그 결과 JSON을 만들지 마라.",
        },
        {
          tier: heavy,
          role: "analyze",
          reads: ["user", 0],
          produces: "결함·개선 분석",
          instruction:
            "추출 요약을 바탕으로 버그·설계·가독성 이슈를 구체적으로 분석하라(질문과 같은 언어). 첨부 코드를 실행·흉내 내지 마라.",
        },
        {
          tier: heavy,
          role: "draft",
          reads: ["user", 0, 1],
          produces: "리뷰 초안",
          instruction:
            "분석 결과를 반영해 사용자 요청(코드 리뷰/검토)에 대한 완성된 리뷰 초안을 작성하라(질문과 같은 언어).",
        },
        {
          tier: "medium",
          role: "critique",
          reads: [2],
          produces: "빠진 점·과장 지적",
          instruction:
            "리뷰 초안에서 빠진 위험·과장·모호한 표현만 짧게 지적하라(질문과 같은 언어). 새 본문을 쓰지 마라.",
        },
        {
          tier: "medium",
          role: "merge",
          reads: [2, 3],
          produces: "최종 리뷰",
          instruction:
            "초안과 비판을 합쳐 최종 리뷰만 질문과 같은 언어로 간결히 출력하라.",
        },
      ]
    : [
        {
          tier: "medium",
          role: "extract",
          produces: "핵심 요약",
          instruction: "원본 요청·첨부에서 답에 필요한 핵심만 추출하라(질문과 같은 언어).",
        },
        {
          tier: heavy,
          role: "draft",
          reads: ["user", 0],
          produces: "답변 초안",
          instruction: "추출 요약을 바탕으로 원본 사용자 질문에 대한 본 답변을 작성하라(질문과 같은 언어).",
        },
        {
          tier: "medium",
          role: "polish",
          reads: [1],
          instruction: "초안을 질문과 같은 언어로 간결히 다듬어 최종 답만 출력하라.",
        },
      ];
  return pipelinePlan(steps, why, body);
}

const TIER_RANK = { small: 0, medium: 1, large: 2 };

/**
 * 입력 길이로 정하는 최소 티어.
 * 긴 글을 0.5B(small)가 direct 로 처리해 버리는 것을 막는다.
 */
function tierFloor(body) {
  const text = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const sys = typeof body?.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "";
  const len = text.length + sys.length;
  if (len > config.largeMinChars) {
    return { tier: "large", len, reason: `입력 ${len}자 > ${config.largeMinChars}` };
  }
  if (len > config.smallMaxChars) {
    return { tier: "medium", len, reason: `입력 ${len}자 > ${config.smallMaxChars}` };
  }
  return { tier: "small", len, reason: null };
}

/** 라우터 분류 + 파이프라인 설계 메타 (history/UI용) */
function planMetaOf(plan) {
  return {
    plannerRole: plan.plannerRole ?? null,
    plannerBackend: plan.plannerBackend ?? null,
    plannerTier: plan.plannerTier ?? null,
    plannerAlias: plan.plannerAlias ?? null,
    plannerDevice: plan.plannerDevice ?? null,
    plannerModel: plan.plannerModel ?? null,
    routerBackend: plan.routerBackend ?? null,
    routerTier: plan.routerTier ?? null,
    routerAlias: plan.routerAlias ?? null,
    routerDevice: plan.routerDevice ?? null,
    routerModel: plan.routerModel ?? null,
  };
}

/** direct/workflow 플랜 필드를 명시 병합 (spread 충돌 방지) */
function mergePlan(base, overrides = {}) {
  const meta = planMetaOf({ ...base, ...overrides });
  return {
    mode: overrides.mode ?? base.mode ?? "direct",
    tier: overrides.tier ?? base.tier ?? "medium",
    steps: overrides.steps ?? base.steps ?? [],
    reason: overrides.reason ?? base.reason ?? "",
    skill:
      overrides.skill !== undefined ? overrides.skill : (base.skill ?? null),
    difficulty:
      overrides.difficulty !== undefined
        ? overrides.difficulty
        : (base.difficulty ?? null),
    device:
      overrides.device !== undefined ? overrides.device : (base.device ?? null),
    deviceReason:
      overrides.deviceReason !== undefined
        ? overrides.deviceReason
        : (base.deviceReason ?? null),
    ...meta,
  };
}

/** 라우터 결과 → direct 플랜 */
function mergeDirectFromRoute(route, body, reason) {
  const base = directPlan(
    route?.tier || "medium",
    reason || route?.reason || "router → direct",
    body,
  );
  return mergePlan(base, {
    skill: route?.skill ?? null,
    difficulty: route?.difficulty ?? base.difficulty,
    device: route?.device ?? base.device,
    deviceReason: route?.deviceReason ?? base.deviceReason,
    reason: reason || route?.reason || base.reason,
    ...planMetaOf(route || {}),
  });
}

/** 파이프라인 강제 ON: 이미 workflow면 유지, direct면 승격 */
function ensureWorkflowIfForced(plan, body, wantOn) {
  if (!wantOn) return plan;
  if (plan?.mode === "workflow" && Array.isArray(plan.steps) && plan.steps.length >= 2) {
    return plan;
  }
  const promoted = promoteToPipeline(plan, body);
  if (promoted.mode === "workflow") {
    logger.info(
      `파이프라인 ON: → workflow 승격 ${promoted.steps.map((s) => s.tier).join("→")}`,
    );
  }
  return mergePlan(promoted, {
    skill: plan?.skill ?? promoted.skill ?? null,
    difficulty: plan?.difficulty ?? promoted.difficulty,
    device: plan?.device ?? promoted.device,
    deviceReason: plan?.deviceReason ?? promoted.deviceReason,
    ...planMetaOf(plan || {}),
  });
}

/** 라우터 판단이 입력 길이에 비해 너무 작은 티어면 끌어올린다. meta/skill 보존 */
function enforceTierFloor(plan, body) {
  const floor = tierFloor(body);
  if (floor.tier === "small") return plan;
  const need = TIER_RANK[floor.tier];

  if (plan.mode === "direct") {
    if (TIER_RANK[plan.tier] >= need) return plan;
    logger.info(
      `티어 하한 적용: direct ${plan.tier} → ${floor.tier} (${floor.reason})`,
    );
    const bumped = directPlan(
      floor.tier,
      `${plan.reason} → ${floor.tier} 승격 (${floor.reason})`,
      body,
    );
    return mergePlan(bumped, {
      skill: plan.skill ?? null,
      difficulty: plan.difficulty ?? bumped.difficulty,
      device: plan.device ?? bumped.device,
      deviceReason: plan.deviceReason ?? bumped.deviceReason,
      reason: bumped.reason,
      ...planMetaOf(plan),
    });
  }

  const steps = (plan.steps || []).map((s, i) =>
    i === 0 && TIER_RANK[s.tier] < need ? { ...s, tier: floor.tier } : s,
  );
  if (
    plan.steps &&
    steps.every((s, i) => s.tier === plan.steps[i].tier)
  ) {
    return plan;
  }
  logger.info(`티어 하한 적용: 1단계 → ${floor.tier} (${floor.reason})`);
  const bumped = pipelinePlan(
    steps,
    `${plan.reason} → 1단계 ${floor.tier} 승격 (${floor.reason})`,
    body,
  );
  return mergePlan(bumped, {
    skill: plan.skill ?? null,
    difficulty: plan.difficulty ?? bumped.difficulty,
    device: plan.device ?? bumped.device,
    deviceReason: plan.deviceReason ?? bumped.deviceReason,
    reason: bumped.reason,
    ...planMetaOf(plan),
  });
}

export function isBlankAsk(body) {
  return !String(body?.ROLE_USER ?? "").trim();
}

/** @deprecated 호환용 — 단어 패턴 없이 빈 질문만 */
export function isTrivialQuestion(body) {
  return isBlankAsk(body);
}

/** @deprecated 호환용 — 라우터가 판단. 패턴 매칭 없음 */
export function isGreetingQuestion(_body) {
  return false;
}

/** @deprecated 호환용 — 라우터+시스템 정체성으로 처리. 패턴 매칭 없음 */
export function isMetaIdentityQuestion(_body) {
  return false;
}

/** 단일 티어 direct 플랜 */
export function directPlan(tier, reason, body) {
  const t = VALID_TIERS.has(tier) ? tier : "small";
  const d = scoreDifficulty(body, t);
  return {
    mode: "direct",
    tier: t,
    difficulty: d.difficulty,
    device: d.device,
    deviceReason: d.reason,
    reason: reason || `direct:${t}`,
    steps: [{ tier: t, role: "answer", instruction: "사용자 질문에 바로 답한다." }],
  };
}

function pipelinePlan(steps, reason, body) {
  const heavy = steps.some((s) => s.tier === "large")
    ? "large"
    : steps.some((s) => s.tier === "medium")
      ? "medium"
      : "small";
  const d = scoreDifficulty(body, heavy);
  return {
    mode: "workflow",
    tier: heavy,
    difficulty: d.difficulty,
    device: d.device,
    deviceReason: d.reason,
    reason,
    steps,
  };
}

/**
 * 파이프라인 ON 용 휴리스틱 (small 강제 시작 없음).
 */
export function heuristicPipelinePlan(body) {
  const hardImage =
    body?.content !== undefined && body?.content !== null && body?.content !== "";
  if (hardImage) return directPlan("large", "heuristic: image → large", body);
  if (body?.THINKING === true) {
    return pipelinePlan(
      [
        {
          tier: "large",
          role: "solve",
          instruction: "사용자 질문에 대해 깊게 추론하며 본 답변을 작성하라.",
        },
        {
          tier: "medium",
          role: "polish",
          instruction: "초안을 질문과 같은 언어로 간결히 다듬어 최종 답만 출력하라.",
        },
      ],
      "heuristic-pipeline: thinking",
      body,
    );
  }

  const explicit = String(body?.MODEL_TIER ?? "").toLowerCase();
  if (VALID_TIERS.has(explicit)) {
    return directPlan(explicit, "heuristic: explicit MODEL_TIER", body);
  }

  if (isBlankAsk(body)) {
    return directPlan("small", "heuristic-pipeline: empty → direct", body);
  }

  const userText = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const split = splitUserAskAndContent(userText);
  if (looksLikeReviewAsk(split.ask) || (split.hasCode && userText.length > 800)) {
    return safeContentPipeline(
      body,
      "heuristic-pipeline: code/doc review",
    );
  }

  const t = chooseTierHeuristic(body);
  const heavy = t.tier === "small" ? "medium" : t.tier;

  if (heavy === "large") {
    return pipelinePlan(
      [
        {
          tier: "large",
          role: "solve",
          instruction: "사용자 질문에 대한 본 답변을 작성하라.",
        },
        {
          tier: "medium",
          role: "polish",
          instruction:
            "초안을 질문과 같은 언어로 자연스럽고 간결하게 다듬어 최종 답만 출력하라.",
        },
      ],
      `heuristic-pipeline: ${t.reason}`,
      body,
    );
  }

  return pipelinePlan(
    [
      {
        tier: "medium",
        role: "solve",
        instruction: "사용자 질문에 답하라.",
      },
      {
        tier: "medium",
        role: "polish",
        instruction: "초안을 질문과 같은 언어로 간결히 다듬어 최종 답만 출력하라.",
      },
    ],
    `heuristic-pipeline: ${t.reason}`,
    body,
  );
}

/** direct 플랜을 파이프라인으로 승격 (ON 모드). 라우터≠첫 단계. medium 강제 시작 안 함. */
function promoteToPipeline(direct, body) {
  if (direct.tier === "small" || isBlankAsk(body)) return direct;
  const heavy = direct.tier === "large" ? "large" : "medium";
  // 3B 급 소형 클러스터에서 critique→merge 는 품질 향상 없이 메타-잡음만 만든다.
  // 주력 모델(draft)이 실제 답을 쓰고 polish 로 가볍게 다듬는 2단계로만 승격.
  // (polish 는 reads 없이 두어 buildStepMessages 의 경량 polish 경로를 타게 함)
  return {
    ...pipelinePlan(
      [
        {
          tier: heavy,
          role: "draft",
          produces: "답변",
          instruction: "사용자 질문에 대한 완성된 답변을 작성하라.",
          ...(direct.skill ? { skill: direct.skill } : {}),
        },
        {
          tier: "medium",
          role: "polish",
          produces: "최종 답",
          instruction:
            "초안을 질문과 같은 언어로 간결히 다듬어 최종 답만 출력하라. 새 내용·메타설명·인사·다짐 문장 금지.",
        },
      ],
      `${direct.reason} → pipeline 승격(draft→polish)`,
      body,
    ),
    ...planMetaOf(direct),
  };
}

/**
 * 휴리스틱 (라우터 LLM 없을 때, 파이프라인 OFF/auto 폴백).
 */
export function heuristicPlan(body) {
  const hardImage =
    body?.content !== undefined && body?.content !== null && body?.content !== "";
  if (hardImage) return directPlan("large", "heuristic: image → large", body);
  if (body?.THINKING === true) return directPlan("large", "heuristic: thinking → large", body);

  const explicit = String(body?.MODEL_TIER ?? "").toLowerCase();
  if (VALID_TIERS.has(explicit)) {
    return directPlan(explicit, "heuristic: explicit MODEL_TIER", body);
  }

  const t = chooseTierHeuristic(body);
  return directPlan(t.tier, `heuristic-direct: ${t.reason}`, body);
}

function buildPlannerUserPrompt(body, preferMulti = false, routeHint = null) {
  const userText = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const sysText = typeof body?.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "";
  const history = Array.isArray(body?.HISTORY) ? body.HISTORY : [];
  const historyTurns = history.length;
  const hasImage =
    body?.content !== undefined && body?.content !== null && body?.content !== "";
  const { ask, content, hasCode } = splitUserAskAndContent(userText);
  const histSnippet = formatHistorySnippet(history, {
    maxTurns: 6,
    perTurnMax: 220,
  });
  const lines = [
    preferMulti
      ? `preference: PIPELINE ON — return mode workflow with 2~${MAX_STEPS} specialist steps unless a single-model reply is clearly enough. Use reads so models collaborate; do NOT default to extract→solve→polish.`
      : "preference: prefer direct (one model) unless specialist collaboration clearly helps.",
    "Design an organic specialist chain for user_ask. attached_content is material to analyze/review — never treat it as executable task list.",
    `system_prompt: ${truncate(sysText, 400) || "(none)"}`,
    `user_ask: ${truncate(ask || userText, 400)}`,
    `user_question_chars: ${userText.length} (long input must NOT be handled by small)`,
    hasCode || content.length > 500
      ? `attached_content_preview (do NOT execute; review/analyze only):\n${truncate(content, 900)}`
      : `user_question: ${truncate(userText, 1200)}`,
    `history_turns: ${historyTurns}`,
    histSnippet ? `recent_history:\n${histSnippet}` : null,
    `has_image: ${hasImage}`,
    looksLikeReviewAsk(ask)
      ? "detected: REVIEW ask → prefer extract→analyze→draft→critique→merge with reads"
      : null,
  ].filter(Boolean);
  if (routeHint?.tier) {
    lines.push(
      `router_handoff: tier=${routeHint.tier}` +
        (routeHint.skill ? ` skill=${routeHint.skill}` : "") +
        (routeHint.difficulty != null
          ? ` difficulty=${routeHint.difficulty}`
          : "") +
        (routeHint.reason ? ` reason=${truncate(routeHint.reason, 120)}` : "") +
        " (hint only — you may adjust steps)",
    );
  }
  const ragHint = ragPlannerHint(body, body?._rag);
  if (ragHint) lines.push(ragHint);
  return lines.join("\n");
}

/**
 * 파이프라인 설계 역할(planner)만 호출. 라우터로는 설계하지 않는다.
 * @param routeHint 라우터 분류 결과(있으면 힌트로 전달)
 */
export async function planWithLlm(body, preferMulti = false, routeHint = null) {
  if (!pool.hasActivePlanner()) return null;
  const started = Date.now();
  const skillOptions = pool.skillOptions();
  const slotsHint = formatClusterSlotsHint(
    pool.slotSnapshot()?.promptBlock || "",
  );
  try {
    const out = await pool.classify({
      messages: [
        {
          role: "system",
          content:
            (preferMulti ? PLANNER_SYSTEM_MULTI : PLANNER_SYSTEM_AUTO) +
            slotsHint +
            skillBlock(skillOptions),
        },
        {
          role: "user",
          content: buildPlannerUserPrompt(body, preferMulti, routeHint),
        },
      ],
      temperature: config.routerTemperature,
      maxTokens: Math.max(config.routerMaxTokens, 384),
      minTier: chooseTierHeuristic(body).tier,
      fixedRole: "planner",
    });
    if (!out) return null;

    const {
      result,
      backendUrl,
      tier: plannerTier,
      device: plannerDevice,
      alias: plannerAlias,
      model: plannerModel,
    } = out;
    const meta = {
      plannerRole: "planner",
      plannerBackend: backendUrl,
      plannerTier: plannerTier || null,
      plannerAlias: plannerAlias || null,
      plannerDevice: plannerDevice || null,
      plannerModel: plannerModel || null,
      routerBackend: routeHint?.routerBackend ?? null,
      routerTier: routeHint?.routerTier ?? null,
      routerAlias: routeHint?.routerAlias ?? null,
      routerDevice: routeHint?.routerDevice ?? null,
      routerModel: routeHint?.routerModel ?? null,
    };
    const parsed = parseRouterJson(result.content);
    if (!parsed) {
      logger.warn(
        `파이프라인 설계 JSON 파싱 실패 @ ${backendUrl}: ${truncate(result.content, 120)}`,
      );
      return null;
    }

    const mode = String(parsed.mode ?? "direct").toLowerCase();
    const difficulty = clamp(Math.round(Number(parsed.difficulty) || 50), 0, 100);
    const reasonText =
      typeof parsed.reason === "string" ? parsed.reason.trim() : "planned";
    const planSkill = resolveSkillChoice(parsed.skill, skillOptions);

    if (mode === "workflow") {
      let steps = normalizeSteps(parsed.steps, skillOptions).map((s) => {
        const sk = s.skill || null;
        if (sk) return { ...s, skill: sk };
        const { skill: _drop, ...rest } = s;
        return rest;
      });
      const userText =
        typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
      // 붙여넣은 코드를 실행 계획으로 오해한 설계 → 안전 파이프라인으로 교체
      if (
        steps.length >= 2 &&
        stepsConfusedWithContent(steps, userText, reasonText)
      ) {
        logger.warn(
          `파이프라인 설계 오해 감지(첨부코드=작업으로 해석) → 안전 파이프라인 교체 @ ${backendUrl}: ${truncate(reasonText, 100)}`,
        );
        const safe = safeContentPipeline(
          body,
          `llm-planner 오해 교정: ${truncate(reasonText, 80)}`,
        );
        return { ...safe, skill: planSkill, ...meta };
      }
      if (steps.length < 2) {
        const tier = String(parsed.tier ?? steps[0]?.tier ?? "medium").toLowerCase();
        const t = VALID_TIERS.has(tier) ? tier : "medium";
        const d = scoreDifficulty(body, t);
        logger.info(
          `파이프라인 설계 workflow→direct 강등 @ ${backendUrl} (${Date.now() - started}ms)`,
        );
        return {
          mode: "direct",
          tier: t,
          skill: planSkill,
          difficulty: d.difficulty,
          device: d.device,
          deviceReason: d.reason,
          reason: `llm-planner: ${reasonText}`,
          ...meta,
          steps: [
            {
              tier: t,
              role: "answer",
              instruction: "사용자 질문에 바로 답한다.",
              ...(planSkill ? { skill: planSkill } : {}),
            },
          ],
        };
      }
      const heavy =
        steps.map((s) => s.tier).includes("large")
          ? "large"
          : steps.map((s) => s.tier).includes("medium")
            ? "medium"
            : "small";
      const device = difficulty >= config.gpuMinDifficulty ? "gpu" : "cpu";
      logger.info(
        `파이프라인 설계 workflow @ ${plannerAlias || plannerTier || "?"} ${backendUrl} → ${steps
          .map((s) => (s.skill ? `${s.tier}[${s.skill}]` : s.tier))
          .join("→")} (${Date.now() - started}ms): ${reasonText}`,
      );
      return {
        mode: "workflow",
        tier: heavy,
        difficulty,
        device,
        deviceReason: `llm:score=${difficulty}`,
        reason: `llm-planner: ${reasonText}`,
        ...meta,
        steps,
      };
    }

    const tier = String(parsed.tier ?? "small").toLowerCase();
    const t = VALID_TIERS.has(tier) ? tier : "small";
    const device = difficulty >= config.gpuMinDifficulty ? "gpu" : "cpu";
    logger.info(
      `파이프라인 설계 direct @ ${plannerAlias || plannerTier || "?"} ${backendUrl} → ${t}${planSkill ? `[${planSkill}]` : ""} (${Date.now() - started}ms): ${reasonText}`,
    );
    return {
      mode: "direct",
      tier: t,
      skill: planSkill,
      difficulty,
      device,
      deviceReason: `llm:score=${difficulty}`,
      reason: `llm-planner: ${reasonText}`,
      ...meta,
      steps: [
        {
          tier: t,
          role: "answer",
          instruction: "사용자 질문에 바로 답한다.",
          ...(planSkill ? { skill: planSkill } : {}),
        },
      ],
    };
  } catch (err) {
    logger.warn(
      `파이프라인 설계 실패 → 폴백 (${Date.now() - started}ms): ${err.message}`,
    );
    return null;
  }
}

/**
 * - off: 라우터 분류 → 단일 모델
 * - on: 파이프라인 강제 (설계기 + ensureWorkflowIfForced)
 * - auto(체크 해제): 단순 질문=단일, 긴글·코드리뷰 등만 설계기/파이프라인
 */
async function finishPlan(plan, body) {
  const floored = enforceTierFloor(plan, body);
  const { applyLoadAwarePlan } = await import("./loadAwareRoute.js");
  return applyLoadAwarePlan(floored, body);
}

export async function createPlan(body) {
  const modeEnv = (config.workflowMode || "auto").toLowerCase();
  const flag = body?.WORKFLOW;
  let wantWorkflow = modeEnv;
  if (flag === true || flag === "Y" || flag === "on") wantWorkflow = "on";
  if (flag === false || flag === "N" || flag === "off") wantWorkflow = "off";

  const explicit = String(body?.MODEL_TIER ?? "").toLowerCase();
  const hasImage =
    body?.content !== undefined && body?.content !== null && body?.content !== "";
  if (hasImage) {
    return finishPlan(directPlan("large", "image → large", body), body);
  }
  if (VALID_TIERS.has(explicit)) {
    return finishPlan(
      directPlan(explicit, "explicit MODEL_TIER", body),
      body,
    );
  }
  if (body?.THINKING === true && wantWorkflow !== "on") {
    return finishPlan(directPlan("large", "thinking → large", body), body);
  }

  if (wantWorkflow === "off") {
    const { chooseRoute } = await import("./router.js");
    const route = await chooseRoute({ ...body, WORKFLOW: false });
    return finishPlan(
      mergeDirectFromRoute(route, body, route.reason),
      body,
    );
  }

  // 1) 라우터: 티어·특기 분류
  let route = null;
  if (pool.hasActiveRouter()) {
    if (pool.shouldSkipLlmRouter()) {
      logger.warn(
        "라우터 슬롯 없음(실시간 대화 vs 부하) → 휴리스틱 분류로 빈 답변 슬롯 사용",
      );
    } else {
      route = await classifyWithLlm(body);
    }
  }

  // auto: 설계기 없이 라우터 단일 (강제 ON 이거나 협업 신호일 때만 설계기)
  const multiOk = wantWorkflow === "on" || needsMultiStepAsk(body);
  if (!multiOk) {
    if (route) {
      logger.info(
        `auto·단일 → router direct: ${truncate(route.reason || "", 80)}`,
      );
      return finishPlan(
        mergeDirectFromRoute(
          route,
          body,
          `router → direct (${route.reason || "router"})`,
        ),
        body,
      );
    }
    logger.warn("라우터 없음/실패 → heuristic 폴백 (single)");
    const fb = heuristicPlan(body);
    return finishPlan(
      mergePlan(fb, { reason: `router-fallback: ${fb.reason}` }),
      body,
    );
  }

  // 2) 파이프라인 설계기
  if (pool.hasActivePlanner()) {
    const llm = await planWithLlm(body, wantWorkflow === "on", route);
    if (llm) {
      // ON이면 direct→workflow 승격만; auto는 설계기 결과 신뢰(강등 휴리스틱 제거)
      const plan = ensureWorkflowIfForced(llm, body, wantWorkflow === "on");
      return finishPlan(plan, body);
    }
  }

  // 3) 설계기 없음 → 라우터 direct (ON 이면 승격)
  if (route) {
    const plan = mergeDirectFromRoute(route, body, route.reason);
    return finishPlan(
      ensureWorkflowIfForced(plan, body, wantWorkflow === "on"),
      body,
    );
  }

  if (wantWorkflow === "on") {
    return finishPlan(heuristicPipelinePlan(body), body);
  }
  logger.warn("라우터/설계기 없음 → heuristic 폴백");
  const fb = heuristicPlan(body);
  return finishPlan(
    mergePlan(fb, { reason: `router-fallback: ${fb.reason}` }),
    body,
  );
}

function buildStepMessages({
  body,
  step,
  stepIndex,
  totalSteps,
  prior,
  isLast,
}) {
  const userQ = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const sysUser =
    typeof body?.ROLE_SYSTEM === "string" && body.ROLE_SYSTEM.trim()
      ? body.ROLE_SYSTEM.trim()
      : "";

  const roleKey = String(step.role || "").toLowerCase();
  const isPolish = roleKey === "polish";
  const isCritique = roleKey === "critique" || roleKey === "critic";

  const ragState = body?._rag;
  const hasRag = Boolean(
    ragState && (ragState.context || ragState.hits?.length),
  );
  const memoryCtx =
    typeof body?._memory?.context === "string" ? body._memory.context.trim() : "";
  const hasMemory = Boolean(memoryCtx);
  const budget = promptBudgetForTier(step.tier, { rag: hasRag });
  const hasVision =
    Boolean(ragState?.hits?.some((h) => h.imageFile)) ||
    (body?.content !== undefined &&
      body?.content !== null &&
      body?.content !== "");

  // polish: 0.5B small 은 프롬프트를 베끼므로 호출 생략(직전 초안 사용).
  if (isPolish && prior.length > 0 && !step.reads) {
    const draft = truncate(prior[prior.length - 1].output, budget.draft);
    const langLine = replyLanguageSystemLine(userQ);
    const system = [
      "문장 다듬기만 한다. 새 사실·새 문단을 만들지 마라.",
      "초안의 의미는 유지하되, 출력 언어는 반드시 사용자 질문과 같게 하라.",
      hasRag
        ? ragSystemAddon(ragState.strict !== false, hasVision, userQ)
        : "",
      hasMemory
        ? "개인 기억 블록에 과거 사용자 사실이 있으면 관련될 때 활용하라. 목록에 없는 기억을 지어내지 마라."
        : "",
      langLine,
      "초안 언어가 질문과 다르면 질문 언어로 번역·다듬어 출력하라.",
      "최종 답 본문만 출력. 라벨·번호·메타·질문 인용 금지.",
    ]
      .filter(Boolean)
      .join("\n");
    const user =
      `초안:\n${draft}\n\n다듬은 답만:` +
      replyLanguageReminder(userQ, { pipeline: true });
    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  }

  const { ask: userAsk } = splitUserAskAndContent(userQ);

  /** reads 가 있으면 지정된 동료/질문만, 없으면 이전 단계 전부 */
  const includeUser =
    !step.reads || step.reads.some((r) => r.type === "user");
  const priorIndices = step.reads
    ? step.reads.filter((r) => r.type === "step").map((r) => r.i)
    : prior.map((_, i) => i);

  const colleagueBlocks = [];
  for (const i of priorIndices) {
    const p = prior[i];
    if (!p) continue;
    const label =
      p.produces || p.role || `단계${i + 1}`;
    colleagueBlocks.push(
      `[동료 ${i + 1} · ${label} · ${p.tier || "?"}${p.skill ? ` · 특기:${p.skill}` : ""}]\n${truncate(p.output, isCritique ? Math.min(budget.prior, 1800) : budget.prior)}`,
    );
  }
  const dialogue =
    colleagueBlocks.length === 0
      ? ""
      : `### 동료 모델 메시지 (이 단계가 읽을 입력)\n${colleagueBlocks.join("\n\n")}`;

  // RAG 문서는 티어 예산의 상당 부분을 쓰고, 질문 텍스트는 나머지로
  // (후반 단계는 동료 출력이 크므로 문서 비중을 더 줄임)
  const ragBudget = hasRag
    ? Math.min(
        Math.floor(budget.userQ * (prior.length > 0 ? 0.4 : 0.65)),
        Math.max(500, budget.userQ - 350),
      )
    : 0;
  const userQBudget = hasRag
    ? Math.max(400, budget.userQ - ragBudget)
    : budget.userQ;
  const ragBlock =
    hasRag && includeUser
      ? `참고 문서:\n${truncateRagContext(ragState.context, ragBudget)}`
      : "";
  const memBudget = hasMemory
    ? Math.min(1200, Math.max(300, Math.floor(budget.userQ * 0.25)))
    : 0;
  const memoryBlock =
    hasMemory && includeUser
      ? truncateRagContext(memoryCtx, memBudget)
      : "";

  // 이전 대화 (파이프라인에도 주입 — 없으면 "기억 못 함" 답변)
  const histBudget = includeUser
    ? Math.min(1800, Math.max(400, Math.floor(budget.userQ * 0.4)))
    : 0;
  const { block: historyBlock } = includeUser
    ? formatHistoryBlock(body?.HISTORY, histBudget, {
        perTurnMax: 600,
        maxTurns: 12,
      })
    : { block: "" };

  const langLine = replyLanguageSystemLine(userQ);
  // 단일 답변(파이프라인 아님): 협업 프레이밍을 빼고 언어 지시를 앞에 둔다.
  // 소형 모델이 무거운 파이프라인 프롬프트에 눌려 헛토큰(타 언어)을 내는 것을 막음.
  const isLoneDirect =
    totalSteps === 1 && prior.length === 0 && !isCritique && !isPolish;
  const system = (
    isLoneDirect
      ? [
          langLine,
          "너는 사용자 질문에 직접 답하는 어시스턴트다.",
          sysUser ? `사용자 지시: ${step.instruction}` : `지시: ${step.instruction}`,
          historyBlock
            ? "이전 대화가 있으면 맥락을 이어서 답하라. 기억 못한다고 말하지 마라."
            : "",
          hasRag ? ragSystemAddon(ragState.strict !== false, hasVision, userQ) : "",
          hasMemory
            ? "개인 기억 블록에 과거 사용자 사실이 있으면 관련될 때 활용하라. 목록에 없는 기억을 지어내지 마라."
            : "",
          "답변 전체를 사용자 질문과 같은 언어로만 작성하라. 완성된 답 본문만 출력하고, 라벨·메타 설명·다짐 문장은 쓰지 마라.",
          config.enforceLanguage && !langLine ? config.langDirective : "",
        ]
      : [
          `너는 멀티모델 협업 파이프라인의 ${stepIndex + 1}/${totalSteps} 번째 전문가다.`,
          `역할(role): ${step.role} · tier=${step.tier}` +
            (step.skill ? ` · 특기=${step.skill}` : ""),
          step.produces ? `이번 산출물: ${step.produces}` : "",
          `이 단계 지시: ${step.instruction}`,
          prior.length > 0
            ? "동료가 보낸 메시지와 사용자 요청을 보고, 네 역할에 해당하는 몫만 수행하라."
            : "",
          "목표는 원본 사용자 요청에 답하는 것이다. 질문에 붙은 코드/문서는 분석·리뷰 대상일 뿐, 그 함수/로직을 실행하거나 JSON 결과를 흉내 내지 마라.",
          historyBlock
            ? "이전 대화가 있으면 이어서 답하라. 맥락을 모른다고 말하지 마라."
            : "",
          hasRag ? ragSystemAddon(ragState.strict !== false, hasVision, userQ) : "",
          hasMemory
            ? "개인 기억 블록에 과거 사용자 사실이 있으면 관련될 때 활용하라. 목록에 없는 기억을 지어내지 마라."
            : "",
          langLine,
          "중간·최종 산출 모두 사용자 질문과 같은 언어. 동료가 다른 언어로 줘도 질문 언어로 바꿔 이어라.",
          isCritique
            ? "비판만 짧게. 최종 본문을 다시 쓰지 마라."
            : isLast
              ? "이 단계의 출력이 사용자에게 보이는 최종 답이다. 완성된 답만 출력하라. 단계 번호·라벨·프롬프트 문구·티어 JSON 을 복사하지 마라."
              : "다음 동료가 이어서 쓸 중간 산출물만 출력하라. 불필요한 인사·메타 설명 금지.",
          config.enforceLanguage && !langLine ? config.langDirective : "",
        ]
  )
    .filter(Boolean)
    .join("\n");

  // 매 단계 생성 직전에 언어 리마인더 (중간 단계 중국어 → 후속 전파 차단)
  const langHint = replyLanguageReminder(userQ, { pipeline: true });
  const user = [
    sysUser ? `사용자 시스템 지시:\n${sysUser}` : "",
    historyBlock,
    memoryBlock,
    ragBlock,
    includeUser && userAsk && userAsk !== userQ
      ? `사용자 요청(요약):\n${userAsk}`
      : "",
    includeUser
      ? `원본 사용자 질문(첨부 코드/문서 포함):\n${truncate(userQ, userQBudget)}`
      : "(원본 질문은 이 단계 reads 에 없음 — 동료 메시지만 참고. 그래도 출력 언어는 원본 질문과 같게.)",
    dialogue,
    body?.content && includeUser
      ? "(참고: 원본 요청에 이미지가 포함되어 있을 수 있다. 필요 시 반영.)"
      : "",
    langHint,
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * 보안검증 게이트 사용 여부 (파이프라인과 무관).
 * 전역 스위치 ON + 보안검증 기능·배정 정책이 있는 모델이 있을 때만.
 */
export function hasSecurityWorkflow() {
  if (!isSecurityEnabledSync()) return false;
  return pool.backends.some(
    (b) => b.securityEnabled && String(b.securityPolicy || "").trim(),
  );
}

function securityRefuseMessage(reason) {
  const why = String(reason || "정책 위반").trim();
  return `보안 정책에 따라 이 답변을 제공할 수 없습니다.\n사유: ${why}`;
}

/**
 * 최종 답변 직후 보안 게이트 (파이프라인 단계가 아님).
 * 인사·단답은 건너뛰고, 정책이 있을 때만 초안을 검사한다.
 */
export async function runSecurityPreFinal({
  userQ,
  draft,
  onEvent,
  stepIndex = 0,
}) {
  if (!hasSecurityWorkflow()) {
    return {
      allow: true,
      skipped: true,
      answer: draft,
      check: { allow: true, skipped: true, reason: "보안검증 없음" },
      stepRec: null,
    };
  }
  // 빈 질문만 생략 (단어 패턴으로 스킵하지 않음)
  if (isBlankAsk({ ROLE_USER: userQ })) {
    return {
      allow: true,
      skipped: true,
      answer: draft,
      check: { allow: true, skipped: true, reason: "empty → 보안검증 생략" },
      stepRec: null,
    };
  }

  const started = Date.now();
  // step_* 가 아닌 security_* — UI/파이프라인 단계로 취급하지 않음
  onEvent?.({
    type: "security_start",
    i: stepIndex,
    role: "security",
    instruction: "최종 답변 보안검증",
  });

  const payload = `【사용자 질문】\n${truncate(userQ, 1500)}\n\n【최종 직전 답변(검토 대상)】\n${truncate(draft, 2500)}`;
  const check = await pool.runSecurityCheck(payload, "pre_final");
  const ms = Date.now() - started;
  const allow = check.allow !== false;
  const answer = allow ? draft : securityRefuseMessage(check.reason);
  const stepRec = {
    kind: "security",
    title: "보안검증",
    i: null,
    role: "security",
    instruction: "최종 답변 보안검증 (파이프라인 외)",
    tier: "security",
    device: null,
    alias: check.alias || null,
    backend: check.backendUrl || null,
    model: null,
    ms: check.ms ?? ms,
    allow,
    reason: check.reason,
    skipped: Boolean(check.skipped),
    receivedFrom: {
      kind: "model",
      label: "최종 답변 초안",
      text: truncate(draft, 2000),
    },
    output: allow
      ? `통과 · ${check.reason || "ok"}`
      : `차단 · ${check.reason || "정책 위반"}`,
    isLast: false,
  };

  onEvent?.({
    type: "security_done",
    allow,
    reason: check.reason,
    alias: check.alias || null,
    backend: check.backendUrl || null,
    ms: stepRec.ms,
    output: stepRec.output,
  });

  logger.info(
    `보안검증(게이트) ${allow ? "통과" : "차단"} @ ${check.alias || check.backendUrl || "-"}: ${check.reason} (${stepRec.ms}ms)`,
  );

  return { allow, skipped: false, answer, check, stepRec };
}

/**
 * 워크플로우 실행.
 * @param onEvent (ev) => void  — plan | step_start | step_done | token
 * @returns answer + steps + trace(라우터→각 모델 호출·입출력 스토리)
 */
export async function runWorkflow({
  plan,
  body,
  temperature,
  enableThinking = false,
  onEvent,
}) {
  const steps = plan.steps?.length
    ? plan.steps
    : [{ tier: plan.tier || "small", role: "answer", instruction: "답변" }];

  const userQ = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  // 보안 게이트가 켜져 있으면 검사 통과 전까지 최종 답을 스트리밍하지 않는다
  // (내용이 보였다가 '금지'로 바뀌는 것 방지 — 마지막 단계는 논스트림 생성).
  const securityHold = hasSecurityWorkflow();
  const willRag = isRagRequest(body) || Boolean(body?._rag);
  const stepOffset = willRag ? 1 : 0;
  const flowLabel = [
    ...(willRag ? ["retrieve(rag)"] : []),
    ...steps.map((s) => `${s.role || s.tier}(${s.tier})`),
  ].join(" → ");
  const formatReads = (reads) => {
    if (!Array.isArray(reads) || !reads.length) return null;
    return reads.map((r) =>
      r.type === "user" ? "user" : String((r.i ?? 0) + 1),
    );
  };
  const formatBackend = (alias, tier, model, backend) =>
    [alias || null, tier || null, model ? String(model).split(/[\\/]/).pop() : null, backend]
      .filter(Boolean)
      .join(" · ");

  const stepsPlan = [
    ...(willRag
      ? [
          {
            i: 1,
            tier: "rag",
            role: "retrieve",
            skill: null,
            produces: "참고 문서",
            reads: null,
            instruction: "문서 검색",
          },
        ]
      : []),
    ...steps.map((s, i) => ({
      i: i + 1 + stepOffset,
      tier: s.tier,
      role: s.role,
      skill: s.skill ?? null,
      produces: s.produces ?? null,
      reads: formatReads(s.reads),
      instruction: s.instruction,
    })),
  ];

  const trace = [];
  let ragPack = null;

  // 0a. 라우터 분류 (핸드오프) — 있으면 먼저
  if (plan.routerBackend || plan.routerAlias) {
    trace.push({
      kind: "router",
      title: "라우터 분류",
      planner: `LLM 라우터 · ${formatBackend(
        plan.routerAlias,
        plan.routerTier,
        plan.routerModel,
        plan.routerBackend,
      )}`,
      routerAlias: plan.routerAlias || null,
      routerTier: plan.routerTier || null,
      routerDevice: plan.routerDevice || null,
      routerBackend: plan.routerBackend || null,
      routerModel: plan.routerModel || null,
      reason: plan.reason?.includes("llm-router")
        ? plan.reason
        : `핸드오프 → 설계기 · tier=${plan.tier}${plan.skill ? ` skill=${plan.skill}` : ""}`,
      decision: plan.tier
        ? `${plan.tier}${plan.skill ? ` · ${plan.skill}` : ""}`
        : null,
      flow: flowLabel,
      stepsPlan: [],
    });
  }
  // 0b. 파이프라인 설계 (steps)
  if (
    plan.plannerRole === "planner" ||
    plan.plannerBackend ||
    plan.mode === "workflow" ||
    !trace.length
  ) {
    const plannerLabel = plan.plannerBackend
      ? formatBackend(
          plan.plannerAlias,
          plan.plannerTier,
          plan.plannerModel,
          plan.plannerBackend,
        )
      : null;
    trace.push({
      kind: "planner",
      title: "파이프라인 설계",
      planner: plannerLabel
        ? `파이프라인 설계 · ${plannerLabel}`
        : plan.reason?.includes("heuristic")
          ? "휴리스틱 설계 (LLM 설계기 미사용)"
          : "파이프라인 설계",
      plannerAlias: plan.plannerAlias || null,
      plannerTier: plan.plannerTier || null,
      plannerDevice: plan.plannerDevice || null,
      plannerBackend: plan.plannerBackend || null,
      plannerModel: plan.plannerModel || null,
      routerAlias: plan.routerAlias || null,
      routerTier: plan.routerTier || null,
      reason: plan.reason,
      flow: flowLabel,
      stepsPlan,
    });
  }

  onEvent?.({
    type: "plan",
    mode: plan.mode,
    reason: plan.reason,
    plannerRole: plan.plannerRole || null,
    plannerBackend: plan.plannerBackend || null,
    plannerAlias: plan.plannerAlias || null,
    plannerTier: plan.plannerTier || null,
    routerBackend: plan.routerBackend || null,
    routerAlias: plan.routerAlias || null,
    routerTier: plan.routerTier || null,
    routerDevice: plan.routerDevice || null,
    routerModel: plan.routerModel || null,
    flow: flowLabel,
    steps: stepsPlan.map((s, i) => ({
      i,
      tier: s.tier,
      role: s.role,
      skill: s.skill ?? null,
      produces: s.produces ?? null,
      reads: s.reads ?? null,
      instruction: s.instruction,
    })),
  });

  // 파이프라인 1단계: 문서 검색 (RAG)
  if (willRag) {
    onEvent?.({
      type: "step_start",
      i: 0,
      tier: "rag",
      role: "retrieve",
      instruction: "문서 검색",
    });
    const ragStarted = Date.now();
    ragPack = await loadRagForRequest(body);
    body._rag = {
      hits: ragPack.hits,
      context: ragPack.context,
      sources: ragPack.sources,
      strict: ragPack.strict,
      topK: ragPack.topK,
    };
    const ragMs = Date.now() - ragStarted;
    const ragOut = ragPack.hits.length
      ? `관련 청크 ${ragPack.hits.length}개`
      : "검색 결과 없음";
    trace.push({
      kind: "rag",
      title: "문서 검색",
      i: 1,
      role: "retrieve",
      tier: "rag",
      hits: ragPack.hits.length,
      strict: ragPack.strict,
      sources: ragPack.sources,
      ms: ragMs,
      output: ragOut,
    });
    onEvent?.({
      type: "rag",
      hits: ragPack.hits.length,
      sources: ragPack.sources,
      strict: ragPack.strict,
      ms: ragMs,
    });
    onEvent?.({
      type: "step_done",
      i: 0,
      tier: "rag",
      role: "retrieve",
      instruction: "문서 검색",
      preview: ragOut,
      output: ragOut,
      ms: ragMs,
      isLast: false,
    });
    logger.info(
      `워크플로우 단계 1/${steps.length + 1} 문서검색(rag) → ${ragPack.hits.length}건 ${ragMs}ms`,
    );
  }

  const prior = [];
  let last = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const uiI = i + stepOffset;
    const isLast = i === steps.length - 1;
    // 마지막 단계 토큰 스트리밍 — 단, 보안 게이트가 켜져 있으면 억제(통과 후 공개)
    const emitTokensNow = isLast && Boolean(onEvent) && !securityHold;
    const isLarge = step.tier === "large";
    const maxTokens = isLarge ? config.defaultMaxTokens : config.maxTokensSmall;

    const readIdx = step.reads
      ? step.reads.filter((r) => r.type === "step").map((r) => r.i)
      : i > 0
        ? [i - 1]
        : [];
    const readUser =
      !step.reads || step.reads.some((r) => r.type === "user") || i === 0;
    const receivedFrom =
      i === 0
        ? {
            kind: "user",
            label: "사용자 질문",
            text: truncate(userQ, 2000),
          }
        : {
            kind: "collab",
            label: [
              readUser ? "사용자" : null,
              ...readIdx.map(
                (j) =>
                  `${prior[j]?.produces || prior[j]?.role || `단계${j + 1}`}`,
              ),
            ]
              .filter(Boolean)
              .join(" + "),
            tier: prior[readIdx[readIdx.length - 1]]?.tier,
            alias: prior[readIdx[readIdx.length - 1]]?.alias,
            role: prior[readIdx[readIdx.length - 1]]?.role,
            text: readIdx
              .map((j) => prior[j]?.output)
              .filter(Boolean)
              .join("\n---\n"),
          };

    onEvent?.({
      type: "step_start",
      i: uiI,
      tier: step.tier,
      role: step.role,
      skill: step.skill ?? null,
      produces: step.produces ?? null,
      reads: formatReads(step.reads),
      instruction: step.instruction,
      receivedFrom: {
        label: receivedFrom.label,
        preview: truncate(receivedFrom.text, 240),
      },
    });

    // small polish 는 0.5B 가 초안/질문을 베끼므로 호출 생략 → 직전 초안을 최종으로
    if (
      String(step.role || "").toLowerCase() === "polish" &&
      step.tier === "small" &&
      prior.length > 0
    ) {
      const draft = prior[prior.length - 1];
      last = {
        content: draft.output,
        reasoning: undefined,
        tier: draft.tier,
        device: draft.device,
        alias: draft.alias,
        backendUrl: draft.backend,
        model: draft.model,
        usage: null,
        totalMs: 0,
      };
      const stepRec = {
        kind: "model",
        i: uiI + 1,
        role: step.role,
        instruction: step.instruction + " (small polish 생략 → 직전 초안 사용)",
        tier: last.tier,
        device: last.device,
        alias: last.alias,
        backend: last.backendUrl,
        model: last.model,
        ms: 0,
        receivedFrom,
        output: last.content,
        isLast,
        skipped: "small-polish",
      };
      prior.push({
        tier: last.tier,
        role: step.role,
        skill: step.skill ?? null,
        produces: step.produces ?? null,
        instruction: step.instruction,
        output: last.content,
        alias: last.alias,
        backend: last.backendUrl,
        device: last.device,
        model: last.model,
        ms: 0,
        receivedFrom,
        isLast,
      });
      trace.push(stepRec);
      onEvent?.({
        type: "step_done",
        i: uiI,
        tier: last.tier,
        role: step.role,
        device: last.device,
        alias: last.alias,
        backend: last.backendUrl,
        model: last.model,
        instruction: step.instruction,
        preview: truncate(last.content, 240),
        output: last.content,
        receivedFrom: {
          label: receivedFrom.label,
          preview: truncate(receivedFrom.text, 240),
        },
        ms: 0,
        isLast,
        skipped: "small-polish",
      });
      if (emitTokensNow) {
        onEvent({ type: "token", text: last.content, i: uiI });
      }
      logger.info(
        `워크플로우 단계 ${uiI + 1}/${steps.length + stepOffset} polish@small 생략 → 직전 초안 사용`,
      );
      continue;
    }

    const messages = buildStepMessages({
      body,
      step,
      stepIndex: i,
      totalSteps: steps.length,
      prior,
      isLast,
    });

    if (body?.content && step.tier === "large") {
      const { toImageUrl } = await import("./image.js");
      try {
        const images = Array.isArray(body.content) ? body.content : [body.content];
        const parts = [{ type: "text", text: messages[1].content }];
        for (const img of images) {
          parts.push({
            type: "image_url",
            image_url: { url: await toImageUrl(img) },
          });
        }
        messages[1] = { role: "user", content: parts };
      } catch (e) {
        logger.warn(`워크플로우 이미지 첨부 실패: ${e.message}`);
      }
    }

    const started = Date.now();
    const runStepOnce = async (msgs) => {
      if (emitTokensNow) {
        const out = await pool.chatStream({
          messages: msgs,
          temperature,
          maxTokens,
          enableThinking: isLarge ? enableThinking : false,
          preferredTier: step.tier,
          preferredDevice: null,
          preferredSkill: step.skill ?? null,
          allowOtherTiers: config.escalateTier,
          onMeta: (m) => onEvent({ type: "step_meta", i: uiI, ...m }),
          onToken: (t) => onEvent({ type: "token", text: t, i: uiI }),
        });
        return {
          content: out.content,
          reasoning: out.reasoning,
          tier: out.tier,
          device: out.device,
          alias: out.alias,
          skill: out.skill,
          backendUrl: out.backendUrl,
          model: out.model,
          usage: out.usage,
          ttftMs: out.ttftMs,
          totalMs: out.totalMs,
          tokenCount: out.tokenCount,
        };
      }
      const { result, backendUrl, tier, device, alias, skill } =
        await pool.chat({
          messages: msgs,
          temperature: Math.min(temperature ?? 0.7, 0.5),
          maxTokens: isLast ? maxTokens : Math.min(maxTokens, 1024),
          enableThinking: isLast && isLarge ? enableThinking : false,
          preferredTier: step.tier,
          preferredDevice: null,
          preferredSkill: step.skill ?? null,
          allowOtherTiers: config.escalateTier,
        });
      return {
        content: result.content,
        reasoning: result.reasoning,
        tier,
        device,
        alias,
        skill,
        backendUrl,
        model: result.raw?.model,
        usage: result.raw?.usage,
        totalMs: Date.now() - started,
      };
    };

    let stepMessages = messages;
    try {
      last = await runStepOnce(stepMessages);
    } catch (err) {
      // RAG+파이프라인: 맵리듀스(질문만 분할)로 가지 말고 문서·동료 입력을 줄여 재시도
      if (
        isContextOverflowError(err) &&
        body._rag &&
        (body._rag.shrinkPass || 0) < 3
      ) {
        shrinkRagOnBody(body, 0.45);
        logger.warn(
          `워크플로우 단계 ${uiI + 1} 컨텍스트 초과 → RAG/입력 축소 재시도 (pass=${body._rag.shrinkPass}): ${err.message}`,
        );
        onEvent?.({
          type: "step_meta",
          i: uiI,
          overflowRetry: true,
          shrinkPass: body._rag.shrinkPass,
        });
        stepMessages = buildStepMessages({
          body,
          step,
          stepIndex: i,
          totalSteps: steps.length,
          prior,
          isLast,
        });
        last = await runStepOnce(stepMessages);
      } else {
        throw err;
      }
    }

    const stepRec = {
      kind: "model",
      i: uiI + 1,
      role: step.role,
      instruction: step.instruction,
      tier: last.tier,
      device: last.device,
      alias: last.alias,
      // wantedSkill = 라우터가 고른 특기, skill = 실제 처리한 백엔드의 특기
      wantedSkill: step.skill ?? null,
      skill: last.skill ?? null,
      produces: step.produces ?? null,
      reads: formatReads(step.reads),
      backend: last.backendUrl,
      model: last.model,
      ms: last.totalMs,
      receivedFrom,
      output: last.content,
      isLast,
    };

    // 최종 단계가 (a) 프롬프트/원문을 베끼거나 (b) 실제 답 대신
    // "~하겠습니다" 식 메타-확인문만 낸 경우 → 실질 산출물로 폴백
    const outText = String(last.content || "");
    const flatOut = outText.replace(/\s+/g, " ").trim();
    const echoedPrompt =
      isLast &&
      prior.length > 0 &&
      (/사용자\s*요청\s*:|초안\s*:|\[이전\s*단계|\[단계\s*\d|\[원본\s*사용자|다듬은\s*답만/.test(
        outText,
      ) ||
        (userQ.length > 80 &&
          outText.length > userQ.length * 0.5 &&
          outText.includes(userQ.slice(0, 40))));
    // 짧은 답이 지시를 수행 대신 "복명복창"한 경우 (내용 없음)
    const metaAck =
      isLast &&
      prior.length > 0 &&
      flatOut.length <= 160 &&
      /출력하겠|작성하겠|반영하겠|답변을\s*직접|말씀해\s*주세요|어떻게\s*도와|이해했습니다[.!]/.test(
        flatOut,
      );
    if (echoedPrompt || metaAck) {
      // draft/solve/answer 역할의 실제 산출물 우선, 없으면 가장 긴 이전 출력
      const best =
        [...prior]
          .reverse()
          .find((p) =>
            /draft|solve|answer/.test(String(p.role || "").toLowerCase()),
          ) ||
        prior.reduce((a, b) =>
          String(b.output || "").length > String(a.output || "").length
            ? b
            : a,
        );
      logger.warn(
        `워크플로우 최종 단계 ${metaAck ? "메타-확인문" : "프롬프트/원문 에코"} 감지 → 실질 산출물 폴백 (role=${best?.role})`,
      );
      last.content = best?.output ?? prior[prior.length - 1].output;
      stepRec.output = last.content;
      stepRec.fallbackFrom = best?.role || "prior";
    }

    prior.push({
      tier: last.tier,
      role: step.role,
      produces: step.produces ?? null,
      instruction: step.instruction,
      output: last.content,
      alias: last.alias,
      wantedSkill: step.skill ?? null,
      skill: last.skill ?? null,
      backend: last.backendUrl,
      device: last.device,
      model: last.model,
      ms: last.totalMs,
      receivedFrom,
      isLast,
    });
    trace.push(stepRec);

    onEvent?.({
      type: "step_done",
      i: uiI,
      tier: last.tier,
      role: step.role,
      device: last.device,
      alias: last.alias,
      skill: last.skill ?? null,
      backend: last.backendUrl,
      model: last.model,
      instruction: step.instruction,
      preview: truncate(last.content, 240),
      output: last.content,
      receivedFrom: {
        label: receivedFrom.label,
        preview: truncate(receivedFrom.text, 240),
      },
      ms: last.totalMs,
      isLast,
    });

    const skillLog = step.skill
      ? ` skill="${step.skill}"${last.skill === step.skill ? "" : " (특기 백엔드 없음 → 티어 풀)"}`
      : "";
    logger.info(
      `워크플로우 단계 ${uiI + 1}/${steps.length + stepOffset} ${step.role}@${last.tier}/${last.device ?? "-"}${skillLog} ${last.totalMs ?? "?"}ms`,
    );
  }

  let answer = last?.content ?? "";
  // 파이프라인 steps 와 별개 — 보안 게이트만 태움 (trace 에 security 노드로만 기록)
  if (securityHold) {
    const sec = await runSecurityPreFinal({
      userQ,
      draft: answer,
      onEvent,
      stepIndex: steps.length + stepOffset,
    });
    answer = sec.answer;
    if (last) last.content = answer;
    if (sec.stepRec) trace.push(sec.stepRec);
  }

  return {
    answer,
    reasoning: last?.reasoning,
    model: last?.model ?? config.modelName,
    tier: last?.tier,
    device: last?.device,
    alias: last?.alias,
    backend: last?.backendUrl,
    usage: last?.usage ?? null,
    ttftMs: last?.ttftMs ?? null,
    totalMs: last?.totalMs ?? null,
    tokens: last?.usage?.completion_tokens ?? last?.tokenCount,
    steps: prior,
    trace,
    plan,
    rag: Boolean(ragPack),
    sources: ragPack?.sources ?? [],
    strict: ragPack?.strict,
  };
}
