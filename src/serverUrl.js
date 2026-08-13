// 서버 정의(def) → 접속 URL 변환의 단일 출처.
//
// 지금까지 백엔드 URL 은 코드 곳곳에서 `http://127.0.0.1:${port}` 로 직접
// 만들어졌다. 물리 분산(부모 관리서버 ↔ 하위 관리서버) 을 대비해, 정의에
// 선택적 `host` 필드를 두고 이 헬퍼로만 URL 을 만든다. host 가 없으면
// 127.0.0.1 이므로 단일 머신 동작은 그대로다.

export const DEFAULT_HOST = "127.0.0.1";

/** 로컬(부모 자신)을 가리키는 호스트로 취급하는 값들 */
const LOCAL_HOSTS = new Set([
    "",
    "127.0.0.1",
    "localhost",
    "::1",
    "0.0.0.0", // llama 바인드 주소 — 부모 관점에선 로컬로 본다
]);

/** def.host 정규화 (문자열/공백 정리, 없으면 기본값) */
export function serverHost(def) {
    const h =
        def && typeof def.host === "string" ? def.host.trim().toLowerCase() : "";
    return h || DEFAULT_HOST;
}

/** def → `http://<host>:<port>` (풀·헬스체크·추론 호출의 기준 URL) */
export function serverUrl(def) {
    return `http://${serverHost(def)}:${def.port}`;
}

/**
 * 이 정의가 부모(현재 프로세스)와 같은 머신인가?
 * 로컬 프로세스 제어(spawn/kill, netstat, nvidia-smi)는 로컬 정의에만 유효하다.
 * 원격 정의는 하위 관리서버(agent)가 제어한다.
 */
export function isLocalDef(def) {
    return LOCAL_HOSTS.has(serverHost(def));
}
