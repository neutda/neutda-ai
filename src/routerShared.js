import { formatHistorySnippet } from "./historyContext.js";

/**
 * 라우터·설계기가 공유하는 분류 프롬프트/파서.
 * 특정 한국어 예문·인사 정규식 하드코딩 없이, 역할 모델이 판단하도록 둔다.
 */

export const VALID_TIERS = new Set(["small", "medium", "large"]);

/** 티어 분류 공통 원칙 (예시 문장 나열 없음) */
export const ROUTER_SYSTEM_BASE = `You are a request router for a multi-tier LLM system.
Analyze the user request and respond with ONLY one JSON object — no markdown, no explanation outside JSON.

Decision order (important):
1) SPECIALTY/ROLE first: if a listed specialty matches the user's PRIMARY job, pick that skill number.
2) Then set tier to fit that specialty (use a tier the specialty actually has), or the task demand if skill is 0.

Tiers (when skill is 0, or as the specialty's tier):
- small: only when a greeting specialty applies, or otherwise the weakest pure opener
- medium: normal chat, Q&A, explanations, identity/product questions, short follow-ups (yes/ok/ack in an ongoing chat)
- large: complex reasoning, coding, math, deep analysis, long documents

Identity / product / meaning questions → skill 0, at least medium (not a greeting specialty).
Short mid-chat yes/ok/ack (not a hello) → skill 0, medium — NOT greeting specialty.
If the CURRENT message is a hello/greeting, use greeting specialty even when recent_history exists.
Short length alone does NOT mean greeting specialty.
If system_prompt has non-trivial instructions, choose at least medium (unless a specialty applies).
difficulty: integer 0–100 (higher = more compute).`;

export const ROUTER_OUT_PLAIN = `Output format: {"tier":"small|medium|large","difficulty":0-100,"reason":"brief Korean reason"}`;

export const ROUTER_OUT_WITH_SKILL = `Output format: {"skill":0,"tier":"small|medium|large","difficulty":0-100,"reason":"brief Korean reason"}`;

/**
 * 특기 선택 공통 규칙 — 역할 먼저, 티어는 그다음.
 * 매칭 기준은 항상 현재 user_question (recent_history 는 참고만).
 */
export const SKILL_PICK_RULES = `Specialty / role matching (do this BEFORE picking a general tier):
- Match the CURRENT user_question to a specialty using its name AND description. recent_history is context only — it does NOT block a specialty.
- Greeting specialty applies ONLY when the ENTIRE current message is a bare greeting word (안녕/안녕하세요/hi) with nothing else. If it contains ANY question, request, statement, opinion, or feeling → skill 0.
- Statements or feelings (덥다/배고프다/피곤하다, comments, reactions) are NOT greetings → skill 0, medium.
- Mid-chat yes/ok/ack (그래/응/ok, not a hello) → skill 0, medium. Do not use greeting specialty for those.
- Information asks (what/who/why, product/name meaning) → skill 0, medium+.
- Lexical overlap with a specialty label is NOT enough — the specialty description must fit the current message.
- Short length alone does NOT mean greeting.
- If unsure, use 0 (general pool).`;

/**
 * 특기 목록을 번호로 제시한다. 0 = 특기 무관.
 * roles.json 설명을 함께 보여 라우터가 역할 적합성을 판단하게 한다.
 */
export function skillMenu(options) {
  if (!options?.length) return null;
  const lines = options.map((o, i) => {
    const tiers = o.tiers.join(",");
    const desc = String(o.description || "").trim();
    const descPart = desc ? ` — ${truncate(desc, 120)}` : "";
    return `${i + 1}) ${o.skill} [${tiers} · ${o.healthy}대]${descPart}`;
  });
  return ["0) 특기 무관 (일반 풀에서 처리)", ...lines].join("\n");
}

/** CLUSTER_SLOTS 힌트 블록 (권위 아님 — 부하 인식용) */
export function formatClusterSlotsHint(promptBlock) {
  const block = String(promptBlock || "").trim();
  if (!block) return "";
  return `\n\n${block}`;
}

/** 라우터 시스템 프롬프트 (특기 메뉴 포함/미포함) */
export function buildRouterSystemPrompt(skillOptions = [], slotsHint = "") {
  const hint = formatClusterSlotsHint(slotsHint);
  const menu = skillMenu(skillOptions);
  if (!menu) {
    return `${ROUTER_SYSTEM_BASE}${hint}\n\n${ROUTER_OUT_PLAIN}`;
  }
  return `${ROUTER_SYSTEM_BASE}${hint}

${SKILL_PICK_RULES}
skills:
${menu}

${ROUTER_OUT_WITH_SKILL}`;
}

/** 설계기용 특기 블록 (스키마 포함) */
export function buildPlannerSkillBlock(skillOptions = [], stepSchema) {
  const menu = skillMenu(skillOptions);
  if (!menu) {
    return `

JSON only:
{"mode":"direct","tier":"small|medium|large","difficulty":0-100,"reason":"한국어 한줄"}
or
{"mode":"workflow","difficulty":0-100,"reason":"한국어 한줄","steps":[${stepSchema}, ...]}
("reads" optional; indices are 0-based prior steps. "user" = original question.)`;
  }
  return `

${SKILL_PICK_RULES}
skills:
${menu}

JSON only ("skill" is required, use 0 when no specialty fits):
{"mode":"direct","tier":"small|medium|large","skill":0,"difficulty":0-100,"reason":"한국어 한줄"}
or
{"mode":"workflow","difficulty":0-100,"reason":"한국어 한줄","steps":[${stepSchema}, ...]}
("reads" optional; indices are 0-based prior steps. "user" = original question.)`;
}

/** 라우터가 고른 번호를 특기 텍스트로. 범위 밖 → null */
export function resolveSkillChoice(value, options) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > (options?.length ?? 0)) return null;
  return options[n - 1].skill;
}

export function truncate(s, max) {
  const t = String(s ?? "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

export function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

/** 모델 응답에서 JSON 객체 추출 */
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
      /* next */
    }
  }
  return null;
}

export function buildRouterUserPrompt(body) {
  const userText = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const sysText = typeof body?.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "";
  const history = Array.isArray(body?.HISTORY) ? body.HISTORY : [];
  const historyTurns = history.length;
  const hasImage =
    body?.content !== undefined && body?.content !== null && body?.content !== "";
  const histSnippet = formatHistorySnippet(history, {
    maxTurns: 6,
    perTurnMax: 220,
  });

  return [
    `system_prompt: ${truncate(sysText, 400) || "(none)"}`,
    `user_question_chars: ${userText.length}`,
    `user_question: ${truncate(userText, 1200)}`,
    `history_turns: ${historyTurns}`,
    histSnippet
      ? `recent_history (context only; match specialty to user_question, not history):\n${histSnippet}`
      : null,
    `has_image: ${hasImage}`,
  ]
    .filter(Boolean)
    .join("\n");
}
