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
Requests for a LONG or DETAILED answer (자세히/상세히/길게/구체적으로/풀어서, "in detail", "elaborate", "step by step") → large, because a long generation needs the strongest model to stay coherent and on-language.
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
- Match CURRENT user_question to a listed specialty by name AND description. The user does NOT need to say the specialty's name.
- Work material pasted as-is (meeting chat, comments, logs, memos, quotes, timestamps+names) IS a match when a listed specialty's description is about turning that material into a structured output. Treat it as "do that specialty's job with this source", not idle chat.
- recent_history: if a recent user turn already asked for a specialty's job and the current message is source material, pick that specialty.
- Greeting specialty applies ONLY when the ENTIRE current message is a bare greeting word (안녕/안녕하세요/hi) with nothing else.
- Casual feelings (덥다/배고프다) are NOT greetings and are NOT a work specialty unless they look like notes matching a listed description.
- Mid-chat yes/ok/ack (그래/응/ok, not a hello) → skill 0, medium. Do not use greeting specialty for those.
- Information asks (what/who/why, product/name meaning) → skill 0, medium+ — unless a listed specialty clearly fits.
- Lexical overlap with a specialty label is NOT enough by itself. Judge by the specialty description vs the user's actual job.
- Short length alone does NOT mean greeting.
- If unsure between a listed work specialty and 0, prefer the specialty. If unsure between greeting and anything else, use 0.`;

/**
 * 특기 목록을 번호로 제시한다. 0 = 특기 무관.
 * roles.json 설명을 함께 보여 라우터가 역할 적합성을 판단하게 한다.
 */
export function skillMenu(options) {
  if (!options?.length) return null;
  const lines = options.map((o, i) => {
    const tiers = o.tiers.join(",");
    const desc = String(o.description || "").trim();
    const descPart = desc ? ` — ${truncate(desc, 200)}` : "";
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

/**
 * 인사처럼 "짧은 현재 문장 전용" 특기인지 — 긴 붙여넣기에서 오매칭 차단용.
 * 역할 이름을 단어로 추측하지 않는다(사용자가 어떤 이름으로 만들지 모름).
 * 대신 구조적 신호: 가장 약한 티어(small)에만 배정된 특기를 단문 전용으로 본다.
 * (인사 등 경량 역할은 small 백엔드에만 얹는 설계 의도를 그대로 활용)
 */
export function isShortFormSkill(skill, options = []) {
  const o = Array.isArray(options)
    ? options.find((x) => x.skill === skill)
    : null;
  const tiers = Array.isArray(o?.tiers) ? o.tiers : [];
  if (!tiers.length) return false;
  return tiers.every((t) => t === "small");
}

export function truncate(s, max) {
  const t = String(s ?? "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

/** 앞·뒤를 남겨 요청 문장과 붙여넣기 성격을 라우터가 같이 보게 한다. */
export function truncateHeadTail(s, head = 900, tail = 400) {
  const t = String(s ?? "").trim();
  if (t.length <= head + tail + 20) return t;
  return `${t.slice(0, head)}\n…\n${t.slice(-tail)}`;
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
    `user_question: ${truncateHeadTail(userText, 900, 400)}`,
    `history_turns: ${historyTurns}`,
    histSnippet
      ? `recent_history (context; if a prior turn set the job, current paste may be that job's source material):\n${histSnippet}`
      : null,
    `has_image: ${hasImage}`,
  ]
    .filter(Boolean)
    .join("\n");
}
