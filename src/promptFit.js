/**
 * 백엔드 ctx 한도에 맞게 messages 를 줄인다.
 * - 비전(mmproj) 없는 모델에 image_url(base64)이 실리면 수만 토큰으로 폭주한다.
 * - 추정 토큰이 ctx - max_tokens 를 넘으면 텍스트를 앞에서부터/끝에서 자른다.
 */
import { estimateTokens } from "./longContent.js";

function cloneMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    if (!m || typeof m !== "object") return m;
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((p) =>
          p && typeof p === "object" ? { ...p } : p,
        ),
      };
    }
    return { ...m };
  });
}

export function messagesHaveImages(messages) {
  for (const m of messages || []) {
    if (!Array.isArray(m?.content)) continue;
    if (m.content.some((p) => p && p.type === "image_url")) return true;
  }
  return false;
}

/** image_url 파트를 제거하고 텍스트만 남긴다. */
export function stripImagesFromMessages(messages) {
  const out = [];
  let stripped = 0;
  for (const m of messages || []) {
    if (!Array.isArray(m?.content)) {
      out.push(m);
      continue;
    }
    const parts = [];
    for (const p of m.content) {
      if (p && p.type === "image_url") {
        stripped++;
        continue;
      }
      if (p && p.type === "text" && typeof p.text === "string") {
        parts.push(p);
      } else if (typeof p === "string") {
        parts.push({ type: "text", text: p });
      }
    }
    if (parts.length === 0) {
      out.push({ ...m, content: "(이미지 생략 — 이 모델은 비전 미지원)" });
    } else if (parts.length === 1 && parts[0].type === "text") {
      out.push({ ...m, content: parts[0].text });
    } else {
      out.push({ ...m, content: parts });
    }
  }
  return { messages: out, stripped };
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((p) => {
      if (!p) return "";
      if (typeof p === "string") return p;
      if (p.type === "text") return String(p.text ?? "");
      if (p.type === "image_url") {
        const url = String(p.image_url?.url ?? "");
        // data URI 는 토큰 폭탄 — 길이만 반영
        if (url.startsWith("data:")) {
          return `[image ~${Math.ceil(url.length / 8)}tok]`;
        }
        return "[image]";
      }
      return "";
    })
    .join("\n");
}

export function estimateMessagesTokens(messages) {
  let n = 8; // 채팅 템플릿 여유
  for (const m of messages || []) {
    n += 4;
    n += estimateTokens(contentToText(m?.content));
    // 실제 이미지는 비전 모델에서 해상도 따라 큼 — data URI 기준 보수 가산
    if (Array.isArray(m?.content)) {
      for (const p of m.content) {
        if (p?.type !== "image_url") continue;
        const url = String(p.image_url?.url ?? "");
        if (url.startsWith("data:")) {
          // base64 문자 수 / 750 ≈ 대략 이미지 타일 토큰 하한 보정
          n += Math.min(12000, Math.ceil(url.length / 750));
        } else {
          n += 800;
        }
      }
    }
  }
  return n;
}

function setMessageText(msg, text) {
  if (Array.isArray(msg.content)) {
    const images = msg.content.filter((p) => p && p.type === "image_url");
    msg.content = [{ type: "text", text }, ...images];
  } else {
    msg.content = text;
  }
}

function truncateTextToTokens(text, maxTok) {
  const s = String(text ?? "");
  if (estimateTokens(s) <= maxTok) return s;
  // 이진 탐색로 글자 수 줄이기
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(s.slice(0, mid)) <= maxTok) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, Math.max(0, lo)) + "…";
}

/**
 * @param {object[]} messages
 * @param {{ ctx?: number, vision?: boolean, alias?: string, url?: string }} backend
 * @param {number} [maxTokens]
 */
export function fitMessagesForBackend(messages, backend, maxTokens = 512) {
  const ctx = Number(backend?.ctx) > 0 ? Number(backend.ctx) : 4096;
  const gen = Math.max(
    64,
    Math.min(Number(maxTokens) || 512, Math.floor(ctx * 0.4)),
  );
  // 템플릿·특수토큰 여유
  const budget = Math.max(256, ctx - gen - 48);

  let msgs = cloneMessages(messages);
  const notes = [];

  if (!backend?.vision && messagesHaveImages(msgs)) {
    const r = stripImagesFromMessages(msgs);
    msgs = r.messages;
    if (r.stripped) {
      notes.push(
        `비전 미지원 백엔드라 이미지 ${r.stripped}장 제거 (${backend.alias || backend.url || "?"})`,
      );
    }
  }

  let est = estimateMessagesTokens(msgs);
  if (est <= budget) {
    return { messages: msgs, truncated: false, est, budget, ctx, notes };
  }

  // 1) 시스템 제외하고 앞쪽(히스토리)부터 드롭
  while (est > budget && msgs.length > 2) {
    const idx = msgs.findIndex(
      (m, i) => i > 0 && i < msgs.length - 1 && m.role !== "system",
    );
    if (idx < 0) break;
    msgs.splice(idx, 1);
    est = estimateMessagesTokens(msgs);
    notes.push("컨텍스트 초과로 이전 대화 턴 일부 제거");
  }

  // 2) 남은 메시지 텍스트를 예산에 맞게 축소 (뒤에서부터 = 최신 user 우선 유지하되 길이 제한)
  if (est > budget) {
    const nonSystem = msgs.filter((m) => m.role !== "system");
    const sysTok = estimateMessagesTokens(
      msgs.filter((m) => m.role === "system"),
    );
    let remain = Math.max(128, budget - sysTok - nonSystem.length * 4);
    // 최신 메시지에 예산의 65% 할당
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const share =
        i === nonSystem.length - 1
          ? Math.floor(remain * 0.65)
          : Math.floor(remain / Math.max(1, i + 1));
      const text = contentToText(nonSystem[i].content);
      const next = truncateTextToTokens(text, Math.max(64, share));
      if (next !== text) {
        setMessageText(nonSystem[i], next);
        notes.push(`메시지 축소 (role=${nonSystem[i].role})`);
      }
      remain -= estimateTokens(contentToText(nonSystem[i].content));
    }
    est = estimateMessagesTokens(msgs);
  }

  // 3) 그래도 초과면 마지막 user 만 강하게 자르기
  if (est > budget) {
    const last = [...msgs].reverse().find((m) => m.role === "user") || msgs.at(-1);
    if (last) {
      const sysTok = estimateMessagesTokens(
        msgs.filter((m) => m !== last),
      );
      const allow = Math.max(96, budget - sysTok);
      setMessageText(
        last,
        truncateTextToTokens(contentToText(last.content), allow),
      );
      notes.push("최종 사용자 메시지 강제 축소");
      est = estimateMessagesTokens(msgs);
    }
  }

  // 4) 시스템(개인기억·역할)이 예산을 채우면 user만 잘라선 부족하다.
  //    긴 코드 붙여넣기가 기억으로 재주입된 경우가 전형적.
  if (est > budget) {
    for (const m of msgs) {
      if (m.role !== "system") continue;
      const othersTok = estimateMessagesTokens(msgs.filter((x) => x !== m));
      const allow = Math.max(64, budget - othersTok);
      const text = contentToText(m.content);
      const next = truncateTextToTokens(text, allow);
      if (next !== text) {
        setMessageText(m, next);
        notes.push("시스템 메시지 강제 축소");
      }
    }
    est = estimateMessagesTokens(msgs);
  }

  return {
    messages: msgs,
    truncated: true,
    est,
    budget,
    ctx,
    notes,
  };
}
