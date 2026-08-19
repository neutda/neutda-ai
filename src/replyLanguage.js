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

function systemLineForLang(lang) {
  if (lang === "ko") {
    return (
      "반드시 한국어로만 답하세요. " +
      "중국어(中文)·일본어·아랍어·러시아어·영어 등 다른 언어의 글자를 한 자도 섞지 마세요. " +
      "(Answer ONLY in Korean — never mix any other script.)"
    );
  }
  if (lang === "en") {
    return "Answer ONLY in English. Never mix Korean, Chinese, or any other script.";
  }
  if (lang === "zh") {
    return "只用中文回答。绝不要混入韩语、英语或其他任何文字。";
  }
  return (
    config.langDirective ||
    "Reply in the same language as the user's question. Do not switch languages."
  );
}

function reminderForLang(lang, pipeline) {
  if (lang === "ko") {
    const pipe = pipeline
      ? " 동료 출력이 다른 언어여도 한국어로 바꿔 답하세요."
      : "";
    return `\n\n(반드시) 한국어로만 답하세요. 다른 언어 글자를 섞지 마세요.${pipe}`;
  }
  if (lang === "en") {
    const pipe = pipeline
      ? " Match the target language even if colleague outputs differ."
      : "";
    return `\n\n(Required) Reply in English only. Do not mix other scripts.${pipe}`;
  }
  if (lang === "zh") {
    const pipe = pipeline ? " 即使同事输出是别的语言，也要用中文。" : "";
    return `\n\n(必须) 只用中文作答，不要混入其他任何文字。${pipe}`;
  }
  return `\n\n(Required) Reply in the same language as the user's question.`;
}

/**
 * 시스템 프롬프트용 언어 지시.
 * @param {string} userText
 * @param {{ forcedLang?: "ko"|"en"|"zh"|null }} [opts] 역할이 언어를 고정하면 질문 언어·전역 설정을 무시
 */
export function replyLanguageSystemLine(userText, opts = {}) {
  if (opts.forcedLang) return systemLineForLang(opts.forcedLang);
  if (!config.enforceLanguage) return "";
  return systemLineForLang(detectReplyLang(userText));
}

// 순수 인사·단답 판정 — smallTalkPattern(설정) 단일 소스. 인사에만 리마인더를 생략한다.
// (인사는 답할 내용이 없어 약한 모델이 리마인더를 그대로 복창함. 반면 실제 질문은
//  짧아도 리마인더가 언어 드리프트(예: 한국어→중국어)를 막는 앵커라 유지해야 한다.)
const GREETING_ONLY_RE = new RegExp(
  `^(${config.smallTalkPattern})[\\s!.~]*$`,
  "i",
);
function isGreetingOnly(userText) {
  const s = String(userText ?? "").trim();
  return s.length > 0 && s.length <= 40 && GREETING_ONLY_RE.test(s);
}

/**
 * 사용자 메시지 끝 리마인더 (생성 직전 recency).
 * 순수 인사에는 붙이지 않는다 — 약한 모델이 "앞으로 한국어로만 답하겠습니다…"처럼
 * 지시문을 복창하기 때문. 그 외(실제 질문)에는 붙여 언어 드리프트를 막는다.
 * 언어 강제 자체는 시스템 프롬프트로 항상 유지된다.
 * @param {string} userText
 * @param {{ pipeline?: boolean, forcedLang?: "ko"|"en"|"zh"|null }} [opts]
 */
export function replyLanguageReminder(userText, opts = {}) {
  if (isGreetingOnly(userText)) return "";
  if (opts.forcedLang) {
    return reminderForLang(opts.forcedLang, opts.pipeline);
  }
  if (!config.enforceLanguage) return "";
  return reminderForLang(detectReplyLang(userText), opts.pipeline);
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
