/**
 * 답변 언어 = 질문 언어.
 * Qwen 이 한국어 질문인데 중국어로 새는 경우만 강하게 막고,
 * 영어·중국어 질문이면 그 언어로 답하게 한다.
 */
import { config } from "./config.js";

const HANGUL = /[가-힣]/;
const LATIN = /[A-Za-z]/;

/** @returns {"ko"|"zh"|"en"|"other"} */
export function detectReplyLang(text) {
  const s = String(text ?? "");
  const hangul = (s.match(/[가-힣]/g) || []).length;
  const han = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (hangul >= 2 && hangul >= han) return "ko";
  if (han >= 2 && han > hangul * 2) return "zh";
  if (latin >= 8 && latin > hangul + han) return "en";
  if (hangul > 0) return "ko";
  if (han > 0) return "zh";
  if (latin > 0) return "en";
  return "other";
}

/** 시스템 프롬프트용 (질문 언어 기준) — 지시는 목표 언어로 써야 소형 모델이 고정된다 */
export function replyLanguageSystemLine(userText) {
  if (!config.enforceLanguage) return "";
  const lang = detectReplyLang(userText);
  if (lang === "ko") {
    return (
      "반드시 한국어로만 답하세요(사용자와 같은 언어). " +
      "중국어(中文)·일본어·아랍어·러시아어·영어 등 다른 언어의 글자를 한 자도 섞지 마세요. " +
      "(Answer ONLY in Korean — never mix any other script.)"
    );
  }
  if (lang === "en") {
    return (
      "Answer ONLY in English (the user's language). " +
      "Never mix Korean, Chinese, or any other script."
    );
  }
  if (lang === "zh") {
    return "只用中文回答（与用户语言一致）。绝不要混入韩语、英语或其他任何文字。";
  }
  return (
    config.langDirective ||
    "Reply in the same language as the user's question. Do not switch languages."
  );
}

/**
 * 사용자 메시지 끝 리마인더 (생성 직전 recency). 리마인더도 목표 언어로.
 * @param {string} userText
 * @param {{ pipeline?: boolean }} [opts]
 */
export function replyLanguageReminder(userText, opts = {}) {
  if (!config.enforceLanguage) return "";
  const lang = detectReplyLang(userText);
  if (lang === "ko") {
    const pipe = opts.pipeline
      ? " 동료 출력이 다른 언어여도 한국어로 바꿔 답하세요."
      : "";
    return `\n\n(반드시) 한국어로만 답하세요. 다른 언어 글자를 섞지 마세요.${pipe}`;
  }
  if (lang === "en") {
    const pipe = opts.pipeline
      ? " Match the user's language even if colleague outputs differ."
      : "";
    return `\n\n(Required) Reply in English only. Do not mix other scripts.${pipe}`;
  }
  if (lang === "zh") {
    const pipe = opts.pipeline ? " 即使同事输出是别的语言，也要用中文。" : "";
    return `\n\n(必须) 只用中文作答，不要混入其他任何文字。${pipe}`;
  }
  return `\n\n(Required) Reply in the same language as the user's question.`;
}

/** 파이프라인 단계 instruction 등에 넣을 짧은 언어 지시 */
export function replyLanguageStepHint(userText) {
  const lang = detectReplyLang(userText);
  if (lang === "ko") return "사용자 질문과 같이 한국어로 출력";
  if (lang === "en") return "output in English (same as the question)";
  if (lang === "zh") return "用与问题相同的中文输出";
  return "output in the same language as the user question";
}

export function hasHangul(text) {
  return HANGUL.test(String(text ?? ""));
}

export function looksMostlyChinese(text) {
  const s = String(text ?? "");
  const hangul = (s.match(/[가-힣]/g) || []).length;
  const han = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return han >= 8 && han > hangul * 2 && !LATIN.test(s.slice(0, 40));
}
