/**
 * 외부 API 키별 요청 한도(RPM/RPD)와 동시 요청(concurrency) — 인메모리 고정창.
 * 프로세스 재시작 시 초기화된다(토큰 누적 한도와 달리 순간 보호 목적).
 */
const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const state = new Map(); // keyId -> { minStart, minCount, dayStart, dayCount, inflight }

function get(keyId) {
    let s = state.get(keyId);
    if (!s) {
        s = { minStart: 0, minCount: 0, dayStart: 0, dayCount: 0, inflight: 0 };
        state.set(keyId, s);
    }
    return s;
}

/** 한도 확인만(증가 없음). 초과 시 { ok:false, scope, retryAfter(초) } */
export function checkRate(keyId, limits) {
    if (!limits) return { ok: true };
    const now = Date.now();
    const s = get(keyId);
    if (now - s.minStart >= MIN_MS) {
        s.minStart = now;
        s.minCount = 0;
    }
    if (now - s.dayStart >= DAY_MS) {
        s.dayStart = now;
        s.dayCount = 0;
    }
    if (limits.rpm && s.minCount >= limits.rpm) {
        return {
            ok: false,
            scope: "rpm",
            retryAfter: Math.max(1, Math.ceil((s.minStart + MIN_MS - now) / 1000)),
        };
    }
    if (limits.rpd && s.dayCount >= limits.rpd) {
        return {
            ok: false,
            scope: "rpd",
            retryAfter: Math.max(1, Math.ceil((s.dayStart + DAY_MS - now) / 1000)),
        };
    }
    return { ok: true };
}

/** 요청 1건 카운트(검사 통과 후 실제 수락 시 호출) */
export function countRate(keyId) {
    const s = get(keyId);
    s.minCount++;
    s.dayCount++;
}

/** 동시 요청 슬롯 확보. max 초과면 false */
export function acquire(keyId, max) {
    const s = get(keyId);
    if (max && s.inflight >= max) return false;
    s.inflight++;
    return true;
}

/** 동시 요청 슬롯 반납 */
export function release(keyId) {
    const s = get(keyId);
    if (s.inflight > 0) s.inflight--;
}

export function clearRate(keyId) {
    state.delete(keyId);
}
