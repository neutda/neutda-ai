// 채팅 요청 본문에서 반복적으로 도출하던 값들을 한곳에 모은 순수 헬퍼.
// server.js 의 /api/chat, /api/chat/stream, /api/ask, /api/chat/stress 등이
// 같은 로직을 여러 번 인라인으로 반복하던 것을 대체한다.
import { config } from "./config.js";

/** body.TEMPERATURE → 유효 숫자면 그 값, 아니면 기본 온도. */
export function resolveTemperature(body) {
  const raw = Number(body?.TEMPERATURE);
  return Number.isFinite(raw) ? raw : config.defaultTemperature;
}

/** body.THINKING 미지정이면 기본값, 지정되면 불리언 강제. */
export function resolveThinking(body) {
  return body?.THINKING === undefined
    ? config.enableThinking
    : Boolean(body.THINKING);
}

/** body.ROLE_USER 가 문자열이면 그대로, 아니면 빈 문자열. */
export function resolveUserQuestion(body) {
  return typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
}

/**
 * 컨텍스트 초과 폴백에서 RAG 문서가 아직 로드 안 됐으면 로드해 body._rag 채운다.
 * (loadRagForRequest 는 server.js 의 RAG 로더 — 순환참조 방지 위해 주입받는다)
 * @param {object} body
 * @param {(body:object)=>Promise<{hits:any,context:any,sources:any,strict:any,topK:any}>} loadRagForRequest
 */
export async function ensureRagLoaded(body, loadRagForRequest) {
  if (body._rag) return body._rag;
  const pack = await loadRagForRequest(body);
  body._rag = {
    hits: pack.hits,
    context: pack.context,
    sources: pack.sources,
    strict: pack.strict,
    topK: pack.topK,
  };
  return body._rag;
}
