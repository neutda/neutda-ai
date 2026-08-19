/**
 * 생성 결과 건강도 판정 — 입력(질문)의 표현을 추측하지 않고, 출력된 텍스트
 * 자체의 병리를 본다. 약/양자화 모델이 무너지는 두 가지 실제 증상:
 *   1) 디코딩 붕괴: 같은 문자 폭주(＠＠＠…)
 *   2) 언어 이탈: 한국어 질문인데 답이 중국어(한자 다발)로 새어나감
 * 라우팅에서 키워드로 "예측"하는 대신, 결과에서 "관측"해 대응한다.
 */

// 한글 음절
const HANGUL = /[가-힣]/;
// CJK 한자(중국어) 다발 — 한국어 채팅 답변엔 사실상 나오지 않는 8자 이상 연속
const HAN_RUN = /[一-鿿㐀-䶿]{8,}/;
// 한자 1자
const HAN_CHAR = /[一-鿿㐀-䶿]/g;

/**
 * 디코딩 붕괴(＠＠＠… 무한반복, 같은 글자 폭주) 여부.
 * 공백 아닌 같은 문자가 20회 이상 연속이면 붕괴로 본다.
 * (정상 채팅 답변에서 동일 문자 20연속은 사실상 없음. 구분선 "---" 등은 짧다)
 */
export function looksDegenerate(text) {
  const t = String(text || "");
  if (!t) return false;
  return /([^\s])\1{19,}/u.test(t);
}

/**
 * 사용자가 한국어로 물었는지. 한글이 있고, 스스로 중국어(한자 다발)로
 * 쓰지 않았을 때만 true. (중국어 질문엔 중국어 답이 정상이므로 이탈 아님)
 */
export function isKoreanQuestion(question) {
  const q = String(question || "");
  if (!HANGUL.test(q)) return false;
  if (HAN_RUN.test(q)) return false;
  return true;
}

/**
 * 언어 이탈: 한국어 질문에 대한 답이 중국어로 새어나갔는가.
 * (a) 한자 8자 이상 연속, 또는
 * (b) 한자 12자 이상이면서 전체 글자 대비 비율 15% 이상.
 * 정상 한국어 답변은 한자가 거의 0이라 오탐이 사실상 없다.
 */
export function looksLanguageDrift(answer, question) {
  const a = String(answer || "");
  if (!a || !isKoreanQuestion(question)) return false;
  if (HAN_RUN.test(a)) return true;
  const han = (a.match(HAN_CHAR) || []).length;
  const letters = (a.match(/\p{L}/gu) || []).length || 1;
  return han >= 12 && han / letters >= 0.15;
}
