import { allBackendSpecs, config, normalizeSkills } from "./config.js";
import {
    chatCompletion,
    chatCompletionStream,
    checkHealth,
    createEmbeddings,
    fetchModel,
} from "./llamaClient.js";
import {
    isFixedRole,
    normalizeFixedRole,
    readFixedFlags,
} from "./fixedRoles.js";
import { resolveServerSecurity } from "./securityPolicies.js";
import { logger } from "./logger.js";
import { recordChat } from "./stats.js";

const CHAT_TIERS = new Set(["small", "medium", "large"]);
const TIER_RANK = { small: 0, medium: 1, large: 2 };

/**
 * 여러 llama-server 백엔드를 관리하는 풀.
 * 백엔드마다 해결·라우터·파이프라인설계·임베딩·보안검증 역할을 켠다.
 */
class Backend {
    constructor(
        url,
        tier = "large",
        device = null,
        alias = null,
        router = false,
        skills = null,
        roleIds = null,
        customSkills = null,
        fixed = null,
    ) {
        this.url = url;
        this.tier = tier;
        this.device = device;
        this.alias = alias || null;
        // 공통 역할 id + 커스텀 역할 텍스트. skills 는 라우팅용 병합 목록.
        this.roleIds = Array.isArray(roleIds) ? [...roleIds] : [];
        this.customSkills = normalizeSkills(
            customSkills ?? (roleIds == null ? skills : null),
        );
        this.skills = normalizeSkills(skills ?? this.customSkills);
        const f = fixed && typeof fixed === "object" ? fixed : {};
        // solveEnabled: 답변(해결) 풀 포함. chatEnabled 는 구호환 별칭.
        this.solveEnabled = f.solve !== false && f.chat !== false;
        this.chatEnabled = this.solveEnabled;
        this.routerEnabled = Boolean(f.router ?? router);
        this.plannerEnabled = Boolean(f.planner);
        this.embeddingEnabled = Boolean(f.embedding);
    this.securityEnabled = Boolean(f.security);
    this.securityIds = Array.isArray(f.securityIds) ? [...f.securityIds] : [];
    this.securityPolicy = String(f.securityPolicy ?? "").trim();
    this.healthy = false;
        this.model = null;
        this.inFlight = 0;
        this.totalRequests = 0;
        this.routerRequests = 0;
        this.chatRequests = 0;
        this.totalErrors = 0;
        this.totalLatencyMs = 0;
        this.lastLatencyMs = null;
        this.healthLatencyMs = null;
        this.lastError = null;
        this.lastCheck = null;
    }

    /** 전용 인프라 역할이 켜져 있으면 해결(답변) 풀에서 제외 */
    get exclusiveInfra() {
        return (
            this.routerEnabled ||
            this.plannerEnabled ||
            this.embeddingEnabled ||
            this.securityEnabled
        );
    }

    get canChat() {
        return (
            this.solveEnabled &&
            !this.exclusiveInfra &&
            CHAT_TIERS.has(this.tier)
        );
    }

    get avgLatencyMs() {
        const done = this.totalRequests - this.inFlight;
        return done > 0 ? Math.round(this.totalLatencyMs / done) : null;
    }

    snapshot() {
        return {
            url: this.url,
            tier: this.tier,
            device: this.device,
            alias: this.alias,
            roleIds: this.roleIds,
            customSkills: this.customSkills,
            skills: this.skills,
            skill: this.skills[0] ?? null, // 구호환
            roles: {
                solve: this.solveEnabled,
                chat: this.solveEnabled, // 구호환
                router: this.routerEnabled,
                planner: this.plannerEnabled,
                embedding: this.embeddingEnabled,
                security: this.securityEnabled,
            },
            solveEnabled: this.solveEnabled,
            chatEnabled: this.solveEnabled, // 구호환
            routerEnabled: this.routerEnabled,
            plannerEnabled: this.plannerEnabled,
            embeddingEnabled: this.embeddingEnabled,
      securityEnabled: this.securityEnabled,
      securityIds: this.securityIds,
      securityPolicy: this.securityPolicy,
            healthy: this.healthy,
            model: this.model,
            inFlight: this.inFlight,
            totalRequests: this.totalRequests,
            routerRequests: this.routerRequests,
            chatRequests: this.chatRequests,
            totalErrors: this.totalErrors,
            avgLatencyMs: this.avgLatencyMs,
            lastLatencyMs: this.lastLatencyMs,
            healthLatencyMs: this.healthLatencyMs,
            lastError: this.lastError,
            lastCheck: this.lastCheck,
        };
    }
}

class Pool {
    constructor(specs) {
        this.backends = specs.map(
            (s) =>
                new Backend(
                    s.url,
                    s.tier,
                    s.device,
                    s.alias ?? null,
                    s.router === true,
                    s.skills ?? s.skill ?? null,
                    s.roleIds ?? null,
                    s.customSkills ?? null,
                    {
                        solve: s.solve !== false && s.chat !== false,
                        router: s.router === true,
                        planner: s.planner === true,
                        embedding: s.embedding === true,
            security: s.security === true,
            securityIds: s.securityIds ?? [],
            securityPolicy: s.securityPolicy ?? "",
          },
        ),
    );
        this.applyDefaultRouterRoles();
        this.rrCursor = 0;
        this.healthTimer = null;
        this.completed = [];
    }

    async checkAll() {
        await Promise.all(
            this.backends.map(async (b) => {
                const prev = b.healthy;
                const { ok, latencyMs } = await checkHealth(b.url);
                b.healthy = ok;
                b.healthLatencyMs = latencyMs;
                b.lastCheck = new Date().toISOString();
                if (ok && !b.model) b.model = await fetchModel(b.url);
                if (!ok && !b.lastError) b.lastError = "health check failed";
                if (prev !== ok) {
                    if (ok)
                        logger.info(
                            `백엔드 복구됨 ✅ ${b.tier}/${b.device ?? "-"} @ ${b.url} (${latencyMs}ms)`,
                        );
                    else
                        logger.warn(
                            `백엔드 다운 ⚠️ ${b.tier}/${b.device ?? "-"} @ ${b.url}`,
                        );
                }
            }),
        );
    }

    startHealthChecks() {
        if (this.healthTimer) return;
        this.checkAll();
        this.healthTimer = setInterval(
            () => this.checkAll(),
            config.healthIntervalMs,
        );
        if (this.healthTimer.unref) this.healthTimer.unref();
    }

    stopHealthChecks() {
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.healthTimer = null;
    }

    /**
     * 시작 시 라우터 = servers.json 의 "router": true (모니터 저장값).
     * ROUTING_MODE=heuristic 이어도 파일에 표시된 라우터는 지우지 않는다
     * (껐다 켜면 풀리던 원인).
     */
    applyDefaultRouterRoles() {
        const marked = this.backends.filter((b) => b.routerEnabled);
        if (marked.length) {
            // 다중 라우터 허용: servers.json 에 router:true 로 표시된 것 전부 유지.
            logger.info(
                `라우터 역할(servers.json) → ${marked
                    .map(
                        (b) =>
                            `${b.tier}@${b.url}${b.alias ? `(${b.alias})` : ""}`,
                    )
                    .join(", ")}`,
            );
            return;
        }

        if (config.routingMode === "heuristic") {
            logger.info(
                "라우터 없음 (ROUTING_MODE=heuristic, servers.json 에도 router 미지정)",
            );
            return;
        }

        if (config.routerBackendUrl) {
            const b = this.backends.find(
                (x) => x.url === config.routerBackendUrl,
            );
            if (b) {
                b.routerEnabled = true;
                logger.info(
                    `라우터 역할(ROUTER_BACKEND_URL) → ${b.tier} @ ${b.url}`,
                );
                return;
            }
        }

        logger.info(
            "라우터 역할 없음 → 휴리스틱 라우팅 (모델 관리에서 원하는 서버의 라우터를 켜세요)",
        );
    }

    /** 런타임에 백엔드 추가 (이미 있으면 null) */
    addBackend(
        url,
        tier,
        device = null,
        alias = null,
        router = false,
        skills = null,
        roleIds = null,
        customSkills = null,
        fixed = null,
    ) {
        if (this.backends.some((b) => b.url === url)) return null;
        const b = new Backend(
            url,
            tier,
            device,
            alias,
            router,
            skills,
            roleIds,
            customSkills,
            fixed,
        );
        this.backends.push(b);
        logger.info(
            `백엔드 추가됨 ➕ ${tier}/${device ?? "-"} @ ${url}${alias ? ` (${alias})` : ""}${router ? " [router]" : ""}`,
        );
        return b;
    }

    /** servers.json 의 고정 역할 플래그를 풀에 다시 반영 */
    applyFixedRolesFromDefs(defs) {
        if (!Array.isArray(defs)) return null;
        const byUrl = new Map(
            defs.map((d) => [`http://127.0.0.1:${d.port}`, readFixedFlags(d)]),
        );
        for (const b of this.backends) {
            const f = byUrl.get(b.url);
            if (!f) continue;
            b.solveEnabled = f.solve;
            b.chatEnabled = f.solve;
            b.routerEnabled = f.router;
            b.plannerEnabled = f.planner;
      b.embeddingEnabled = f.embedding;
      b.securityEnabled = f.security;
    }
    // 보안 정책 배정(securityIds) → 검사 본문 복원
    for (const d of defs) {
      const url = `http://127.0.0.1:${d.port}`;
      const b = this.backends.find((x) => x.url === url);
      if (!b) continue;
      const sec = resolveServerSecurity(d);
      b.securityIds = sec.securityIds;
      b.securityPolicy = sec.securityPolicyText;
    }
        const routers = this.backends.filter((b) => b.routerEnabled);
        if (routers.length) {
            logger.info(
                `고정 역할 복원 · 라우터 ${routers
                    .map((b) => `${b.tier}@${b.url}`)
                    .join(", ")}`,
            );
        }
        return routers;
    }

    /** @deprecated applyFixedRolesFromDefs 사용 */
    applyRouterFromDefs(defs) {
        return this.applyFixedRolesFromDefs(defs);
    }

    /** 런타임에 백엔드 제거 */
    removeBackend(url) {
        const idx = this.backends.findIndex((b) => b.url === url);
        if (idx < 0) return false;
        const [b] = this.backends.splice(idx, 1);
        logger.info(`백엔드 제거됨 ➖ ${b.tier}/${b.device ?? "-"} @ ${b.url}`);
        return true;
    }

    setAlias(url, alias) {
        const b = this.backends.find((x) => x.url === url);
        if (!b) return false;
        b.alias = alias || null;
        return true;
    }

    /**
     * 공통 역할·커스텀 역할 반영.
     * @param {{ roleIds?: string[], customSkills?: string[], skills?: string[] }} assignment
     */
    setRoleAssignment(url, assignment = {}) {
        const b = this.backends.find((x) => x.url === url);
        if (!b) return false;
        if (Array.isArray(assignment.roleIds))
            b.roleIds = [...assignment.roleIds];
        if (Array.isArray(assignment.customSkills)) {
            b.customSkills = normalizeSkills(assignment.customSkills);
        }
        if (Array.isArray(assignment.skills)) {
            b.skills = normalizeSkills(assignment.skills);
        } else {
            b.skills = normalizeSkills([
                ...(assignment.commonSkills ?? []),
                ...b.customSkills,
            ]);
        }
        logger.info(
            `백엔드 역할 ${b.skills.length ? b.skills.map((s) => `"${s}"`).join(", ") : "해제"} (공통 ${b.roleIds.length} · 커스텀 ${b.customSkills.length}) → ${b.tier} @ ${b.url}${b.alias ? ` (${b.alias})` : ""}`,
        );
        return true;
    }

    setSkills(url, skills) {
        return this.setRoleAssignment(url, {
            customSkills: skills,
            skills,
            roleIds: [],
        });
    }

    /** @deprecated setRoleAssignment 사용 */
    setSkill(url, skill) {
        return this.setSkills(url, skill);
    }

    /** roles.json 변경 후 전체 백엔드 특기 재해석 */
    applyResolvedRoles(resolvedByUrl) {
        if (!resolvedByUrl || typeof resolvedByUrl !== "object") return;
        for (const b of this.backends) {
            const r = resolvedByUrl[b.url];
            if (!r) continue;
            this.setRoleAssignment(b.url, r);
        }
    }

    /**
     * 라우터에게 보여줄 특기 목록.
     * solve 가능한(채팅 역할·정상) 백엔드의 특기만 중복 제거해 반환하므로,
     * 꺼져 있는 모델의 특기로 라우팅되는 일이 없다.
     * 한 서버가 여러 특기를 가지면 각각 별도 항목으로 올라간다.
     */
    skillOptions() {
        const map = new Map();
        for (const b of this.backends) {
            if (!b.canChat || !b.skills.length) continue;
            for (const skill of b.skills) {
                const e = map.get(skill) ?? {
                    skill,
                    backends: 0,
                    healthy: 0,
                    tiers: new Set(),
                };
                e.backends++;
                if (b.healthy) e.healthy++;
                e.tiers.add(b.tier);
                map.set(skill, e);
            }
        }
        return [...map.values()]
            .filter((e) => e.healthy > 0)
            .map((e) => ({
                skill: e.skill,
                backends: e.backends,
                healthy: e.healthy,
                tiers: [...e.tiers],
            }))
            .sort((a, b) => a.skill.localeCompare(b.skill, "ko"));
    }

    /**
     * 고정 역할 on/off. 다중 허용 — 한 역할을 켜도 다른 서버의 같은 역할은 끄지 않는다.
     * @returns {boolean}
     */
    setRoleEnabled(url, role, enabled) {
        const b = this.backends.find((x) => x.url === url);
        if (!b || !isFixedRole(role)) return false;
        const on = Boolean(enabled);
        const key = normalizeFixedRole(role);
        if (key === "solve") {
            b.solveEnabled = on;
            b.chatEnabled = on;
        } else if (key === "router") b.routerEnabled = on;
        else if (key === "planner") b.plannerEnabled = on;
        else if (key === "embedding") b.embeddingEnabled = on;
    else if (key === "security") {
      b.securityEnabled = on;
      if (!on) {
        b.securityIds = [];
        b.securityPolicy = "";
      }
    } else return false;
    logger.info(
      `백엔드 ${key} ${on ? "ON" : "OFF"} → ${b.tier} @ ${b.url}${b.alias ? ` (${b.alias})` : ""}`,
    );
    return true;
  }

  /** 보안 정책 배정 반영 (카탈로그 id + 병합 본문) */
  setSecurityAssignment(url, { securityIds, securityPolicy } = {}) {
    const b = this.backends.find((x) => x.url === url);
    if (!b) return false;
    if (Array.isArray(securityIds)) b.securityIds = [...securityIds];
    if (securityPolicy !== undefined) {
      b.securityPolicy = String(securityPolicy ?? "").trim();
    }
    return true;
  }

    hasActiveRouter() {
        return this.backends.some((b) => b.routerEnabled);
    }

    hasActiveRole(role) {
        const key = normalizeFixedRole(role);
        if (key === "router") return this.hasActiveRouter();
        if (key === "planner")
            return this.backends.some((b) => b.plannerEnabled);
        if (key === "embedding")
            return this.backends.some((b) => b.embeddingEnabled);
        if (key === "security")
            return this.backends.some((b) => b.securityEnabled);
        if (key === "solve") return this.backends.some((b) => b.canChat);
        return false;
    }

    hasActivePlanner() {
        return this.hasActiveRole("planner");
    }

    /** 고정 역할 백엔드 선택 (least-connections, healthy 우선) */
    pickFixed(role, exclude = new Set(), minRank = 0) {
        const key = normalizeFixedRole(role);
        const flag =
            key === "router"
                ? "routerEnabled"
                : key === "planner"
                  ? "plannerEnabled"
                  : key === "embedding"
                    ? "embeddingEnabled"
                    : key === "security"
                      ? "securityEnabled"
                      : null;
        if (!flag) return null;
        let candidates = this.backends.filter(
            (b) =>
                b[flag] &&
                !exclude.has(b.url) &&
                (TIER_RANK[b.tier] ?? 0) >= minRank,
        );
        if (!candidates.length && minRank > 0) {
            // minRank 미달이면 제한 없이 다시 (에스컬레이션 실패 시 폴백)
            candidates = this.backends.filter(
                (b) => b[flag] && !exclude.has(b.url),
            );
        }
        if (!candidates.length) return null;
        const healthy = candidates.filter((b) => b.healthy);
        if (healthy.length) candidates = healthy;
        let min = Infinity;
        for (const b of candidates) min = Math.min(min, b.inFlight);
        const least = candidates.filter((b) => b.inFlight === min);
        this.rrCursor = (this.rrCursor + 1) % least.length;
        return least[this.rrCursor];
    }

    getActiveRouterUrl() {
        return this.pickRouter()?.url ?? null;
    }

    /**
     * 라우터 역할 백엔드 선택 (least-connections).
     * @param minRank 이 티어 랭크 이상인 라우터만 후보 (에스컬레이션용). 0=제한 없음.
     */
    pickRouter(exclude = new Set(), minRank = 0) {
        let candidates = this.backends.filter(
            (b) =>
                b.routerEnabled &&
                !exclude.has(b.url) &&
                (TIER_RANK[b.tier] ?? 0) >= minRank,
        );
        if (!candidates.length) return null;

        const healthy = candidates.filter((b) => b.healthy);
        if (healthy.length) candidates = healthy;

        let min = Infinity;
        for (const b of candidates) min = Math.min(min, b.inFlight);
        const leastLoaded = candidates.filter((b) => b.inFlight === min);
        this.rrCursor = (this.rrCursor + 1) % leastLoaded.length;
        return leastLoaded[this.rrCursor];
    }

    /**
     * 고정 역할(router / planner) 백엔드에 JSON 판정 요청.
     * fixedRole 기본값 "router" (티어 분류). 파이프라인 설계는 "planner".
     */
    async classify(params = {}) {
        const { minTier = "small", fixedRole = "router", ...rest } = params;
        const role = normalizeFixedRole(fixedRole);
        const roleKey = role === "planner" ? "planner" : "router";
        const flag = roleKey === "planner" ? "plannerEnabled" : "routerEnabled";
        const label = roleKey === "planner" ? "파이프라인설계" : "라우터";
        const minRank = TIER_RANK[minTier] ?? 0;
        const tried = new Set();
        const maxAttempts = Math.max(
            this.backends.filter((b) => b[flag]).length,
            1,
        );
        let lastErr = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let backend = this.pickFixed(roleKey, tried);
            if (!backend) break;
            if ((TIER_RANK[backend.tier] ?? 0) < minRank) {
                const higher = this.pickFixed(roleKey, tried, minRank);
                if (higher && higher.url !== backend.url) {
                    logger.info(
                        `${label} 에스컬레이션: ${backend.tier}@${backend.url} → ${higher.tier}@${higher.url} (요구 티어 ${minTier})`,
                    );
                    backend = higher;
                }
            }
            tried.add(backend.url);

            backend.inFlight++;
            backend.totalRequests++;
            backend.chatRequests++;
            if (roleKey === "router") backend.routerRequests++;
            const started = Date.now();
            try {
                const result = await chatCompletion({
                    baseUrl: backend.url,
                    ...rest,
                    enableThinking: false,
                });
                backend.lastLatencyMs = Date.now() - started;
                backend.totalLatencyMs += backend.lastLatencyMs;
                return {
                    result,
                    backendUrl: backend.url,
                    tier: backend.tier,
                    device: backend.device,
                    alias: backend.alias,
                    model: backend.model,
                    fixedRole: roleKey,
                };
            } catch (err) {
                backend.totalErrors++;
                backend.lastError = err.message;
                lastErr = err;
                if (!err.retryable) throw err;
                backend.healthy = false;
                logger.warn(
                    `${label} 백엔드 실패 → 재시도 (${backend.url}): ${err.message}`,
                );
            } finally {
                backend.inFlight--;
                this.completed.push(Date.now());
            }
        }

        if (lastErr) throw lastErr;
        return null;
    }

    getRoutingSummary() {
        const activeRouters = this.backends.filter((b) => b.routerEnabled);
        const activePlanners = this.backends.filter((b) => b.plannerEnabled);
        return {
            effectiveMode:
                this.hasActiveRouter() || this.hasActivePlanner()
                    ? "llm"
                    : "heuristic",
            activeRouterCount: activeRouters.length,
            activeRouterUrl: activeRouters[0]?.url ?? null,
            activeRouters: activeRouters.map((b) => ({
                url: b.url,
                tier: b.tier,
                alias: b.alias,
            })),
            activePlannerCount: activePlanners.length,
            activePlannerUrl: activePlanners[0]?.url ?? null,
            activePlanners: activePlanners.map((b) => ({
                url: b.url,
                tier: b.tier,
                alias: b.alias,
            })),
        };
    }

    pick(
        exclude = new Set(),
        preferredTier = null,
        allowOtherTiers = true,
        preferredDevice = null,
        preferredSkill = null,
    ) {
        const healthy = this.backends.filter(
            (b) => b.healthy && b.canChat && !exclude.has(b.url),
        );
        if (healthy.length === 0) return null;

        let candidates = preferredTier
            ? healthy.filter((b) => b.tier === preferredTier)
            : healthy;
        if (candidates.length === 0) {
            if (!allowOtherTiers) return null;
            // 선호 티어가 비어 있으면 "상위 티어 우선" 폴백: 가까운 상위 → 없을 때만 하위.
            // (medium 요청이 small 로 떨어져 지시 준수·품질이 깨지는 것을 방지)
            const want = TIER_RANK[preferredTier] ?? 0;
            const fallbackScore = (b) => {
                const r = TIER_RANK[b.tier] ?? 0;
                return r >= want ? r - want : 10 + (want - r);
            };
            let best = Infinity;
            for (const b of healthy) best = Math.min(best, fallbackScore(b));
            candidates = healthy.filter((b) => fallbackScore(b) === best);
        }

        // 특기는 "선호"다. 티어 후보 안에서만 적용해 티어 하한을 뚫지 못하게 하고,
        // 해당 특기 백엔드가 없거나 전부 다운이면 그냥 티어 풀로 넘어간다.
        if (preferredSkill) {
            const bySkill = candidates.filter((b) =>
                b.skills.includes(preferredSkill),
            );
            if (bySkill.length > 0) candidates = bySkill;
        }

        if (preferredDevice) {
            const byDevice = candidates.filter(
                (b) => b.device === preferredDevice,
            );
            if (byDevice.length > 0) candidates = byDevice;
        }

        let min = Infinity;
        for (const b of candidates) min = Math.min(min, b.inFlight);
        const leastLoaded = candidates.filter((b) => b.inFlight === min);

        this.rrCursor = (this.rrCursor + 1) % leastLoaded.length;
        return leastLoaded[this.rrCursor];
    }

    async chat(params = {}) {
        const {
            preferredTier = null,
            allowOtherTiers = config.escalateTier,
            preferredDevice = null,
            preferredSkill = null,
            preferFixedRole = null,
            ...rest
        } = params;
        const tried = new Set();
        const maxAttempts = Math.max(this.backends.length, 1);
        let lastErr = null;
        const useFixed =
            Boolean(preferFixedRole) && this.hasActiveRole(preferFixedRole);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let backend = useFixed
                ? this.pickFixed(preferFixedRole, tried)
                : null;
            if (!backend) {
                backend = this.pick(
                    tried,
                    preferredTier,
                    allowOtherTiers,
                    preferredDevice,
                    preferredSkill,
                );
            }
            if (!backend) break;
            tried.add(backend.url);

            backend.inFlight++;
            backend.totalRequests++;
            backend.chatRequests++;
            const started = Date.now();
            try {
                const result = await chatCompletion({
                    baseUrl: backend.url,
                    ...rest,
                });
                backend.lastLatencyMs = Date.now() - started;
                backend.totalLatencyMs += backend.lastLatencyMs;
                recordChat({
                    tier: backend.tier,
                    usage: result.raw?.usage ?? null,
                    ms: backend.lastLatencyMs,
                });
                return {
                    result,
                    backendUrl: backend.url,
                    tier: backend.tier,
                    device: backend.device,
                    alias: backend.alias,
                    skills: backend.skills,
                    skill: backend.skills[0] ?? null,
                };
            } catch (err) {
                backend.totalErrors++;
                backend.lastError = err.message;
                lastErr = err;
                if (!err.retryable) throw err;
                backend.healthy = false;
                logger.warn(
                    `백엔드 실패 → 페일오버 시도 (${backend.url}): ${err.message}`,
                );
            } finally {
                backend.inFlight--;
                this.completed.push(Date.now());
            }
        }

        const healthyCount = this.backends.filter(
            (b) => b.healthy && b.canChat,
        ).length;
        if (healthyCount === 0) {
            throw new Error(
                "사용 가능한 llama-server 백엔드가 없습니다(모두 비정상 또는 해결 역할 비활성).",
            );
        }
        throw lastErr ?? new Error("요청을 처리할 백엔드를 찾지 못했습니다.");
    }

    async chatStream(params = {}) {
        const {
            preferredTier = null,
            allowOtherTiers = config.escalateTier,
            preferredDevice = null,
            preferredSkill = null,
            preferFixedRole = null,
            onToken,
            onMeta,
            ...rest
        } = params;
        const tried = new Set();
        const maxAttempts = Math.max(this.backends.length, 1);
        let lastErr = null;
        const useFixed =
            Boolean(preferFixedRole) && this.hasActiveRole(preferFixedRole);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let backend = useFixed
                ? this.pickFixed(preferFixedRole, tried)
                : null;
            if (!backend) {
                backend = this.pick(
                    tried,
                    preferredTier,
                    allowOtherTiers,
                    preferredDevice,
                    preferredSkill,
                );
            }
            if (!backend) break;
            tried.add(backend.url);

            backend.inFlight++;
            backend.totalRequests++;
            backend.chatRequests++;
            const started = Date.now();
            let gotToken = false;
            try {
                onMeta?.({
                    backend: backend.url,
                    tier: backend.tier,
                    device: backend.device,
                    alias: backend.alias,
                    skills: backend.skills,
                    skill: backend.skills[0] ?? null,
                    model: backend.model,
                });
                const out = await chatCompletionStream({
                    baseUrl: backend.url,
                    ...rest,
                    onToken: (t) => {
                        gotToken = true;
                        onToken?.(t);
                    },
                });
                const totalMs = Date.now() - started;
                backend.lastLatencyMs = totalMs;
                backend.totalLatencyMs += totalMs;
                recordChat({
                    tier: backend.tier,
                    usage: out.usage ?? null,
                    ms: totalMs,
                });
                return {
                    ...out,
                    backendUrl: backend.url,
                    tier: backend.tier,
                    device: backend.device,
                    alias: backend.alias,
                    skills: backend.skills,
                    skill: backend.skills[0] ?? null,
                    model: backend.model,
                    ttftMs: out.firstTokenAt
                        ? out.firstTokenAt - started
                        : null,
                    totalMs,
                };
            } catch (err) {
                backend.totalErrors++;
                backend.lastError = err.message;
                lastErr = err;
                if (gotToken || !err.retryable) throw err;
                backend.healthy = false;
                logger.warn(
                    `스트리밍 백엔드 실패 → 페일오버 시도 (${backend.url}): ${err.message}`,
                );
            } finally {
                backend.inFlight--;
                this.completed.push(Date.now());
            }
        }

        throw lastErr ?? new Error("스트리밍 가능한 백엔드를 찾지 못했습니다.");
    }

    /**
     * 임베딩 역할 백엔드로 벡터 생성.
     * @returns {Promise<{ vectors: number[][], backendUrl: string, model?: string }|null>}
     */
    async embed(input) {
        const texts = Array.isArray(input) ? input : [input];
        if (!texts.length || !this.hasActiveRole("embedding")) return null;
        const tried = new Set();
        let lastErr = null;
        for (let i = 0; i < this.backends.length; i++) {
            const backend = this.pickFixed("embedding", tried);
            if (!backend) break;
            tried.add(backend.url);
            backend.inFlight++;
            backend.totalRequests++;
            const started = Date.now();
            try {
                const out = await createEmbeddings({
                    baseUrl: backend.url,
                    input: texts,
                });
                backend.lastLatencyMs = Date.now() - started;
                backend.totalLatencyMs += backend.lastLatencyMs;
                return {
                    vectors: out.vectors,
                    backendUrl: backend.url,
                    model: out.model,
                    alias: backend.alias,
                };
            } catch (err) {
                backend.totalErrors++;
                backend.lastError = err.message;
                lastErr = err;
                if (!err.retryable) throw err;
                backend.healthy = false;
                logger.warn(
                    `임베딩 실패 → 페일오버 (${backend.url}): ${err.message}`,
                );
            } finally {
                backend.inFlight--;
            }
        }
        if (lastErr) throw lastErr;
        return null;
    }

    setSecurityPolicy(url, policy) {
        const b = this.backends.find((x) => x.url === url);
        if (!b) return false;
        b.securityPolicy = String(policy ?? "").trim();
        return true;
    }

    /**
   * 보안검증 (최종 답변 직전 워크플로우).
   * 보안검증 기능이 켜진 백엔드 중, 보안 관리에서 배정한 정책 본문으로 판정.
   * 정책이 비어 있으면 통과. 모호하면 허용(fail-open).
   * @param {"pre_final"|"input"|"output"} _stage
   */
  async runSecurityCheck(text, _stage = "pre_final") {
    if (!this.hasActiveRole("security")) {
      return { allow: true, skipped: true, reason: "보안검증 역할 없음" };
    }
    const snippet = String(text ?? "").slice(0, 5000);
    const tried = new Set();
    let lastErr = null;
    let sawEmptyPolicy = false;

        const parseSecurity = (raw) => {
            const m = String(raw ?? "").match(/\{[\s\S]*?\}/);
            if (!m) {
                return {
                    allow: true,
                    reason: "보안검증 JSON 없음 → 허용",
                    ambiguous: true,
                };
            }
            let j;
            try {
                j = JSON.parse(m[0]);
            } catch {
                return {
                    allow: true,
                    reason: "보안검증 JSON 파싱 실패 → 허용",
                    ambiguous: true,
                };
            }
            const explicitFalse =
                j.allow === false ||
                j.allow === "false" ||
                j.allow === 0 ||
                j.safe === false;
            const reason =
                String(j.reason ?? j.message ?? "").trim() || "blocked";
            if (!explicitFalse) {
                return {
                    allow: true,
                    reason: reason === "blocked" ? "ok" : reason,
                };
            }
            // 프롬프트 베끼기·정책에 없는 자체 규칙(짧다/일반대화 등) → 신뢰 불가
            const junk =
                /general questions|coding help|fiction|research|Stage=|티어 하한|llm-router|PIPELINE|You are|allow\s*=|짧은한국어|SECURITY POLICY|POLICY:|최종 직전|너무\s*짧|짧은\s*답|일반적인\s*대화|분류되지|길이가\s*짧|답변이\s*짧|인사|greeting|hello|하이/i.test(
                    reason,
                );
            if (junk || reason.length < 2) {
                return {
                    allow: true,
                    reason: `보안검증 사유 무효(“${reason.slice(0, 40)}”) → 허용`,
                    ambiguous: true,
                };
            }
            return { allow: false, reason };
        };

        for (let i = 0; i < this.backends.length; i++) {
            const backend = this.pickFixed("security", tried);
            if (!backend) break;
            tried.add(backend.url);
            const policy = String(backend.securityPolicy || "").trim();
            if (!policy) {
                sawEmptyPolicy = true;
                continue;
            }
            const system = `You are a security gate (NOT a pipeline planner). Output ONE JSON only.
Default: {"allow":true,"reason":"ok"}
ALWAYS allow: greetings (하이/hello/안녕), short replies, normal Q&A, coding, docs.
Block ONLY if the DRAFT clearly violates the POLICY text below.
Do NOT invent extra rules (length, "too short", "not a conversation", style).
If unsure → allow.

POLICY:
${policy.slice(0, 6000)}`;
            backend.inFlight++;
            backend.totalRequests++;
            const started = Date.now();
            try {
                const result = await chatCompletion({
                    baseUrl: backend.url,
                    messages: [
                        { role: "system", content: system },
                        { role: "user", content: snippet || "(empty)" },
                    ],
                    temperature: 0,
                    maxTokens: 80,
                    enableThinking: false,
                });
                backend.lastLatencyMs = Date.now() - started;
                backend.totalLatencyMs += backend.lastLatencyMs;
                const raw = String(result.content || result.reasoning || "");
                const parsed = parseSecurity(raw);
                if (parsed.ambiguous) {
                    logger.warn(
                        `보안검증 모호 → 허용 @ ${backend.alias || backend.url}: ${String(raw).replace(/\s+/g, " ").slice(0, 100)}`,
                    );
                } else if (!parsed.allow) {
                    logger.info(
                        `보안검증 차단 @ ${backend.alias || backend.url}: ${parsed.reason}`,
                    );
                }
                return {
                    allow: parsed.allow,
                    reason: parsed.reason,
                    skipped: Boolean(parsed.ambiguous),
                    backendUrl: backend.url,
                    alias: backend.alias,
                    ms: backend.lastLatencyMs,
                };
            } catch (err) {
                backend.totalErrors++;
                backend.lastError = err.message;
                lastErr = err;
                if (!err.retryable) break;
                backend.healthy = false;
            } finally {
                backend.inFlight--;
            }
        }
        if (sawEmptyPolicy && !lastErr) {
            return {
                allow: true,
                skipped: true,
                reason: "보안 정책 미작성 → 허용",
            };
        }
        logger.warn(
            `보안검증 실패 → 허용 폴백: ${lastErr?.message || "백엔드 없음"}`,
        );
        return {
            allow: true,
            skipped: true,
            reason: lastErr?.message || "보안검증 실패 → 허용",
        };
    }

    status() {
        const backends = this.backends.map((b) => b.snapshot());
        const tiers = {};
        for (const b of backends) {
            if (!CHAT_TIERS.has(b.tier)) continue;
            const t = (tiers[b.tier] ??= { total: 0, healthy: 0, active: 0 });
            t.total++;
            if (b.healthy) t.healthy++;
            // 전용 인프라 역할은 해결 풀에서 제외 → active 로 세지 않는다.
            if (
                (b.roles?.solve ?? b.roles?.chat) &&
                !b.roles?.router &&
                !b.roles?.planner &&
                !b.roles?.embedding &&
                !b.roles?.security
            ) {
                t.active++;
            }
        }
        const now = Date.now();
        this.completed = this.completed.filter((t) => now - t < 60000);
        return {
            totalBackends: backends.length,
            healthyBackends: backends.filter((b) => {
                const r = b.roles || {};
                return (
                    b.healthy &&
                    (r.solve ?? r.chat) &&
                    !r.router &&
                    !r.planner &&
                    !r.embedding &&
                    !r.security &&
                    CHAT_TIERS.has(b.tier)
                );
            }).length,
            totalInFlight: backends.reduce((s, b) => s + b.inFlight, 0),
            totalRequests: backends.reduce((s, b) => s + b.totalRequests, 0),
            totalErrors: backends.reduce((s, b) => s + b.totalErrors, 0),
            requestsLastMin: this.completed.length,
            tiers,
            backends,
            routing: this.getRoutingSummary(),
        };
    }
}

export const pool = new Pool(allBackendSpecs);
