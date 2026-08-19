/**
 * 인프라 고정 역할 (카탈로그 특기와 별개).
 *
 * - solve: 답변(해결) 풀
 * - router: 티어·난이도 분류 (요청마다 계속 도는 상위 관제)
 * - planner: 파이프라인 설계 (workflow 단계 구성) — 라우터와 분리
 * - embedding: RAG 임베딩
 * - security: 보안검증 (켜면 securityPolicy 텍스트로 입력 검사)
 * - quality: 답변품질검증 (켜면 최종 답 직전, 질문과 답의 맥락 일치를 판정)
 *
 * 요약·추출 등은 역할 관리(카탈로그)에서 만든다.
 * 예전 "chat" → solve. "guardrail" 은 제거됨.
 */
export const FIXED_ROLES = [
    "solve",
    "router",
    "planner",
    "embedding",
    "security",
    "quality",
];

/**
 * 켜면 해결(답변) 풀에서 제외되는 전용 역할.
 * embedding 은 제외하지 않음 — 비전·대형 모델이 임베딩+답변을 겸하는 경우가 흔함.
 * 임베딩 전용으로 쓰려면 solve 를 끄면 된다.
 */
export const EXCLUSIVE_FIXED_ROLES = ["router", "planner", "security"];

/** API·저장용 정규 이름 */
export function normalizeFixedRole(role) {
    const key = String(role || "").toLowerCase();
    if (key === "chat") return "solve";
    if (key === "pipeline" || key === "design" || key === "파이프라인")
        return "planner";
    if (key === "보안검증" || key === "seccheck") return "security";
    if (key === "답변품질검증" || key === "품질검증" || key === "qualitycheck")
        return "quality";
    return key;
}

export function isFixedRole(role) {
    return FIXED_ROLES.includes(normalizeFixedRole(role));
}

export function isExclusiveFixedRole(role) {
    return EXCLUSIVE_FIXED_ROLES.includes(normalizeFixedRole(role));
}

/** servers.json 필드 → boolean */
export function readFixedFlags(def = {}) {
    const solveOff =
        def.solve === false ||
        def.solve === "false" ||
        def.solve === 0 ||
        def.chat === false ||
        def.chat === "false" ||
        def.chat === 0;
    const flag = (k) =>
        def[k] === true || def[k] === "true" || def[k] === 1;
    return {
        solve: !solveOff,
        chat: !solveOff,
        router: flag("router"),
        planner: flag("planner") || flag("pipeline"),
        embedding: flag("embedding"),
        security: flag("security"),
        quality: flag("quality"),
    };
}
