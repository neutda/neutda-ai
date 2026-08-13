/**
 * RAG 컨텍스트 공유 (server ↔ workflow 순환 import 방지).
 * chat/파이프라인 경로와 /api/rag/* 가 같은 포맷·옵션을 쓴다.
 */
import * as rag from "./rag.js";
import { replyLanguageSystemLine } from "./replyLanguage.js";

export function isRagRequest(body) {
  const v = body?.RAG ?? body?.rag;
  if (v === true || v === "Y" || v === "on" || v === "true") return true;
  if (v === 1 || v === "1") return true;
  return false;
}

export function ragOptions(body) {
  const strict = body?.strict !== false && body?.ragStrict !== false;
  const raw = Number(body?.topK ?? body?.TOP_K);
  const topK = Number.isFinite(raw) ? Math.max(1, Math.min(8, raw)) : 4;
  return { strict, topK };
}

/** 문서 검색 질의 = 현재 질문 그대로 */
export function ragRetrieveQuery(body) {
  return String(
    typeof body?.ROLE_USER === "string"
      ? body.ROLE_USER
      : typeof body?.q === "string"
        ? body.q
        : "",
  ).trim();
}

export function formatRagContext(hits) {
  if (!hits?.length) return "";
  return hits
    .map(
      (h, i) =>
        `[출처 ${i + 1}] (${h.docName} #${h.idx})\n${h.text}`,
    )
    .join("\n\n");
}

export function ragSources(hits) {
  return (hits || []).map((h, i) => ({
    n: i + 1,
    docName: h.docName,
    idx: h.idx,
    score: h.score,
    kind: h.kind,
    preview: String(h.text || "").slice(0, 200),
    imageUrl: h.imageFile ? `/api/rag/images/${h.docId}` : null,
  }));
}

/**
 * 문서-근거 시스템 지시 (언어 라인 포함).
 * userSystem 은 호출측에서 별도 붙이거나 인자로 넘긴다.
 */
export function ragSystemAddon(strict, hasVision, question = "", userSystem) {
  const vision = hasVision
    ? " 참고 문서에 첨부된 이미지가 있으면 이미지 속 글자와 시각적 내용 모두를 근거로 사용하라."
    : "";
  const lang =
    replyLanguageSystemLine(question) ||
    "Reply in the same language as the user's question.";
  let base;
  if (strict) {
    base =
      "너는 제공된 '참고 문서'만 근거로 답하는 어시스턴트다." +
      vision +
      " 문서에 없는 내용은 절대 추측하지 말고, 질문 언어에 맞춰 '문서 내용에 없습니다.'에 해당하는 짧은 거절만 하라. " +
      "답변에 [출처 N] 같은 출처 표기는 넣지 말고 내용만 자연스럽게 답하라. " +
      lang;
  } else {
    base =
      "너는 '참고 문서'를 우선 근거로 사용하는 어시스턴트다." +
      vision +
      " 문서에 없으면 너의 일반 지식으로 보완해 답하라. " +
      "답변에 [출처 N] 같은 출처 표기는 넣지 말고 내용만 자연스럽게 답하라. " +
      lang;
  }
  const extra =
    typeof userSystem === "string" && userSystem.trim()
      ? ` 추가 지시사항: ${userSystem.trim()}`
      : "";
  return base + extra;
}

/** 플래너 힌트용 한 줄 */
export function ragPlannerHint(body, ragState) {
  if (!isRagRequest(body) && !ragState) return null;
  const strict = ragState?.strict ?? ragOptions(body).strict;
  const n = ragState?.hits?.length ?? 0;
  return (
    `RAG ON — retrieved_docs=${n}. Steps must use retrieved docs; ` +
    `prefer analyze/extract of docs early; final answer grounded in docs.` +
    (strict
      ? " STRICT: do not invent facts outside docs; refuse if unsupported."
      : " Docs are primary; general knowledge may fill gaps.")
  );
}

/**
 * 문서 검색 로드. body._rag 가 이미 있으면 재검색하지 않는다.
 * @returns {{ hits, context, sources, strict, topK, skipped?: boolean, emptyStrict?: boolean }}
 */
export async function loadRagForRequest(body) {
  if (body?._rag && Array.isArray(body._rag.hits)) {
    const hits = body._rag.hits;
    const strict = body._rag.strict !== false;
    const context =
      typeof body._rag.context === "string"
        ? body._rag.context
        : formatRagContext(hits);
    return {
      hits,
      context,
      sources: body._rag.sources || ragSources(hits),
      strict,
      topK: body._rag.topK ?? ragOptions(body).topK,
      skipped: false,
      emptyStrict: strict && hits.length === 0,
      reused: true,
    };
  }

  const { strict, topK } = ragOptions(body);
  const q = ragRetrieveQuery(body);

  await rag.load();
  const hits = q.trim() ? await rag.retrieveAsync(q, topK) : [];
  const context = formatRagContext(hits);
  const sources = ragSources(hits);
  return {
    hits,
    context,
    sources,
    strict,
    topK,
    skipped: false,
    emptyStrict: strict && hits.length === 0,
    reused: false,
    retrieveQuery: q,
  };
}

/** 티어 예산에 맞게 참고 문서 블록 truncate */
export function truncateRagContext(context, maxChars) {
  const t = String(context ?? "");
  if (!maxChars || t.length <= maxChars) return t;
  return t.slice(0, Math.max(0, maxChars - 1)) + "…";
}

/**
 * ctx 초과 시 body._rag.context 를 비율만큼 줄인다.
 * @returns {boolean} 축소했는지
 */
export function shrinkRagOnBody(body, ratio = 0.5) {
  if (!body?._rag) return false;
  const ctx = String(body._rag.context ?? "");
  if (ctx.length < 200) return false;
  const next = Math.max(200, Math.floor(ctx.length * ratio));
  body._rag.context = truncateRagContext(ctx, next);
  body._rag.shrinkPass = (body._rag.shrinkPass || 0) + 1;
  // hits 도 앞에서부터 줄여 출처 표시와 맞춤
  if (Array.isArray(body._rag.hits) && body._rag.hits.length > 1) {
    const keep = Math.max(1, Math.ceil(body._rag.hits.length * ratio));
    body._rag.hits = body._rag.hits.slice(0, keep);
    body._rag.sources = ragSources(body._rag.hits);
  }
  return true;
}
