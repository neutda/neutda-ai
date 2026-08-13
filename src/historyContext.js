/**
 * 대화 HISTORY 예산 선택 (공용).
 * 한 턴이 예산을 넘어도 break로 통째 버리지 않고 truncate 해서라도 넣는다.
 */

function truncateText(s, max) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  if (max <= 1) return "…";
  return t.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * @param {Array<{role?: string, content?: string}>} history
 * @param {number} budgetChars 전체 HISTORY에 쓸 글자 예산
 * @param {{ perTurnMax?: number, maxTurns?: number }} [opts]
 * @returns {{ turns: Array<{role: string, content: string}>, usedChars: number, dropped: number }}
 */
export function selectHistoryTurns(history, budgetChars, opts = {}) {
  const perTurnMax = Math.max(80, Number(opts.perTurnMax) || 800);
  const maxTurns = Math.max(1, Number(opts.maxTurns) || 12);
  const budget = Math.max(0, Number(budgetChars) || 0);

  const valid = (Array.isArray(history) ? history : []).filter(
    (t) =>
      t &&
      (t.role === "user" || t.role === "assistant") &&
      typeof t.content === "string" &&
      t.content.trim() !== "",
  );

  if (!budget || !valid.length) {
    return { turns: [], usedChars: 0, dropped: valid.length };
  }

  const kept = [];
  let remaining = budget;
  let dropped = 0;

  for (let i = valid.length - 1; i >= 0 && kept.length < maxTurns; i--) {
    if (remaining <= 0) {
      dropped += i + 1;
      break;
    }
    const turn = valid[i];
    const raw = turn.content;
    const cap = Math.min(perTurnMax, remaining);
    const content = truncateText(raw, cap);
    if (!content) {
      dropped++;
      continue;
    }
    remaining -= content.length;
    kept.push({ role: turn.role, content });
  }

  kept.reverse();
  const usedChars = kept.reduce((n, t) => n + t.content.length, 0);
  return { turns: kept, usedChars, dropped };
}

/**
 * 라우터/프롬프트용 최근 대화 스니펫 텍스트.
 */
export function formatHistorySnippet(history, opts = {}) {
  const maxTurns = Math.max(1, Number(opts.maxTurns) || 4);
  const perTurnMax = Math.max(40, Number(opts.perTurnMax) || 200);
  const budget = maxTurns * perTurnMax;
  const { turns } = selectHistoryTurns(history, budget, {
    perTurnMax,
    maxTurns,
  });
  if (!turns.length) return "";
  return turns
    .map(
      (t) =>
        `${t.role === "assistant" ? "assistant" : "user"}: ${t.content}`,
    )
    .join("\n");
}

/**
 * 파이프라인 user 블록용 「이전 대화」섹션.
 */
export function formatHistoryBlock(history, budgetChars, opts = {}) {
  const { turns, usedChars } = selectHistoryTurns(history, budgetChars, opts);
  if (!turns.length) return { block: "", usedChars: 0, turnCount: 0 };
  const body = turns
    .map(
      (t) =>
        `[${t.role === "assistant" ? "assistant" : "user"}]\n${t.content}`,
    )
    .join("\n\n");
  return {
    block: `### 이전 대화\n${body}`,
    usedChars,
    turnCount: turns.length,
  };
}
