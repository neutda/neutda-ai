// 부모(관리서버) 측 하위 관리서버(agent) 레지스트리.
//
// - 하위 관리서버가 부팅 시 register 로 자기 host + 관리 중인 llama 서버 목록을 보고한다.
// - 부모는 그 서버들을 풀 백엔드로 얹는다(데이터 플레인은 부모 → llama 직결).
// - 부모는 주기적으로 각 agent 의 /agent/metrics·/agent/health 를 폴링해
//   리소스를 모으고 생사(liveness)를 판정한다.
//
// 참고: llama 백엔드의 헬스는 풀이 이미 직접 체크한다(pool.startHealthChecks).
// agent 폴링은 "그 머신의 관리 프로세스가 살아있는가 + 리소스" 를 본다.
import { pool } from "./pool.js";
import { serverUrl } from "./serverUrl.js";
import { upsertBackendFromDef } from "./poolSync.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

/** id → { id, agentUrl, host, servers, urls:Set, metrics, status, lastSeen, misses } */
const agents = new Map();

/** 하위 관리서버가 관리하는 def 에 host 를 주입 (부모가 원격 llama 로 접속하도록) */
function withHost(servers, host) {
    return (Array.isArray(servers) ? servers : [])
        .filter((s) => s && Number.isFinite(Number(s.port)))
        .map((s) => ({ ...s, host }));
}

/**
 * 등록/재등록(하트비트 겸용).
 * 재등록 시 사라진 백엔드는 풀에서 빼고, 새 것만 추가한다(기존 것은 통계 유지).
 */
export function registerAgent({ id, agentUrl, host, servers }) {
    const agentId = String(id ?? "").trim();
    if (!agentId) throw new Error("agent id 가 필요합니다.");
    const url = String(agentUrl ?? "").trim();
    if (!url) throw new Error("agentUrl 이 필요합니다.");
    const agentHost = String(host ?? "").trim();
    if (!agentHost) throw new Error("host 가 필요합니다.");

    const defs = withHost(servers, agentHost);
    const newUrls = new Set(defs.map((d) => serverUrl(d)));
    const prev = agents.get(agentId);
    const oldUrls = prev?.urls ?? new Set();

    // 사라진 백엔드 제거
    for (const u of oldUrls) {
        if (!newUrls.has(u)) pool.removeBackend(u);
    }
    // 새 백엔드 추가(기존은 그대로 두어 health/통계 유지)
    let added = 0;
    for (const d of defs) {
        const r = upsertBackendFromDef(d);
        if (r.added) added++;
    }

    agents.set(agentId, {
        id: agentId,
        agentUrl: url,
        host: agentHost,
        servers: defs,
        urls: newUrls,
        metrics: prev?.metrics ?? null,
        status: "up",
        lastSeen: Date.now(),
        misses: 0,
    });

    if (!prev) {
        logger.info(
            `하위 관리서버 등록 ➕ ${agentId} @ ${agentHost} (agent=${url}, llama ${newUrls.size}개)`,
        );
    } else if (added || oldUrls.size !== newUrls.size) {
        logger.info(
            `하위 관리서버 갱신 ✎ ${agentId} @ ${agentHost} (llama ${newUrls.size}개, 신규 ${added})`,
        );
    }
    return { ok: true, id: agentId, backends: newUrls.size };
}

/** 하위 관리서버 등록 해제(정상 종료 등) → 관리하던 백엔드도 풀에서 제거 */
export function deregisterAgent(id) {
    const agentId = String(id ?? "").trim();
    const a = agents.get(agentId);
    if (!a) return false;
    for (const u of a.urls) pool.removeBackend(u);
    agents.delete(agentId);
    logger.error(`하위 관리서버 해제 ➖ ${agentId} @ ${a.host} (llama ${a.urls.size}개 제거)`);
    return true;
}

/** id 로 등록된 agent 조회 (프록시용). 없으면 null. */
export function getAgent(id) {
    return agents.get(String(id ?? "").trim()) ?? null;
}

/** 백엔드 URL 을 소유한 agent (풀 URL 기준). 없으면 null. */
export function findAgentByBackendUrl(url) {
    const u = String(url ?? "").trim();
    if (!u) return null;
    for (const a of agents.values()) {
        if (a.urls.has(u)) return a;
    }
    return null;
}

/** 서버 이름(servers.json name)을 관리하는 agent. 없으면 null. */
export function findAgentByServerName(name) {
    const n = String(name ?? "").trim();
    if (!n) return null;
    for (const a of agents.values()) {
        if (a.servers.some((s) => s.name === n)) return a;
    }
    return null;
}

/** 등록된 agent 가 하나뿐이면 그 id, 아니면 null (추가 API 등에서 기본 대상). */
export function soleAgentId() {
    if (agents.size !== 1) return null;
    return agents.keys().next().value;
}

/** 모니터/상태 API 용 스냅샷 */
export function listAgents() {
    return [...agents.values()].map((a) => ({
        id: a.id,
        agentUrl: a.agentUrl,
        host: a.host,
        status: a.status,
        lastSeen: a.lastSeen ? new Date(a.lastSeen).toISOString() : null,
        backends: [...a.urls],
        servers: a.servers.map((s) => ({
            name: s.name,
            alias: s.alias || s.name,
            tier: s.tier,
            port: s.port,
            url: serverUrl(s),
            ngl: s.ngl ?? null,
            ctx: s.ctx ?? null,
            parallel:
                Number(s.parallel) > 0
                    ? Math.floor(Number(s.parallel))
                    : null,
            gpu: s.gpu != null && s.gpu !== "" ? String(s.gpu) : "",
            device: Number(s.ngl) > 0 ? "gpu" : "cpu",
            pid: s.pid ?? null,
            needsRestart: s.needsRestart ?? null,
            runningConfig: s.runningConfig ?? null,
        })),
        metrics: a.metrics,
    }));
}

async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function pollAgent(id) {
    const a0 = agents.get(id);
    if (!a0) return;
    const url = `${a0.agentUrl}/agent/metrics`;
    try {
        const m = await fetchJson(url, config.agentRequestTimeoutMs);
        // 재등록(heartbeat)이 그새 객체를 교체했을 수 있으므로 현재 것을 다시 조회.
        const a = agents.get(id);
        if (!a) return;
        a.metrics = m;
        a.lastSeen = Date.now();
        a.misses = 0;
        if (a.status !== "up") {
            a.status = "up";
            logger.info(`하위 관리서버 복구 ✅ ${a.id} @ ${a.host}`);
        }
    } catch (e) {
        const a = agents.get(id);
        if (!a) return;
        a.misses++;
        if (a.misses >= config.agentDownAfterMisses && a.status !== "down") {
            a.status = "down";
            logger.error(
                `하위 관리서버 응답 없음 ⚠️ ${a.id} @ ${a.host} (${a.misses}회 실패: ${e.message}) — llama 백엔드는 풀 헬스체크로 판정`,
            );
        }
    }
}

let pollTimer = null;

/** 부모 기동 시 호출: 등록된 하위 관리서버들을 주기적으로 폴링 */
export function startAgentPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
        for (const id of [...agents.keys()]) pollAgent(id);
    }, config.agentPollIntervalMs);
    if (pollTimer.unref) pollTimer.unref();
}

export function stopAgentPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}
