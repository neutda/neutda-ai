import { config, normalizeSkills } from "./config.js";
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
import { loadRolesSync, roleSkillKey } from "./roles.js";
import { resolveServerSecurity } from "./securityPolicies.js";
import { serverUrl } from "./serverUrl.js";
import { logger } from "./logger.js";
import { recordChat } from "./stats.js";
import { fitMessagesForBackend, messagesHaveImages } from "./promptFit.js";

const CHAT_TIERS = new Set(["small", "medium", "large"]);
const TIER_RANK = { small: 0, medium: 1, large: 2 };
/** 백엔드 슬롯 대기 우선순위. 대화·인프라가 스트레스 백로그를 앞선다. */
const SLOT_PRI_STRESS = 0;
const SLOT_PRI_CHAT = 10;
const SLOT_PRI_INFRA = 20;

// ── 보안 게이트(judge 응답) 판정용 정규식 (매 호출 재생성 방지 위해 모듈 상수) ──
// 스키마 예시·포괄 라벨을 reason 으로 베끼는 무효 사유
const SEC_JUNK_LABEL_RE =
    /^(short_?label|long_?label|label|blocked|violation|policy|reason|unsafe|harmful|offensive|abuse|욕설|혐오|위반|차단)$/i;
const SEC_JUNK_PHRASE_RE =
    /general questions|coding help|fiction|research|Stage=|티어 하한|llm-router|PIPELINE|You are|allow\s*=|짧은한국어|SECURITY POLICY|POLICY:|최종 직전|너무\s*짧|짧은\s*답|일반적인\s*대화|인사|greeting|hello|하이|short_label|contains_offensive|inappropriate|violates?\s*policy/i;
// 욕설·혐오 정책인지, 인용이 실제 금칙어인지, 오히려 무해한 단어인지 판별
const SEC_ABUSE_POLICY_RE =
    /욕설|혐오|비하|협박|차별|profanity|abuse|hate|insult|slur/i;
const SEC_ABUSE_HIT_RE =
    /씨발|시발|씨빨|병신|좆|지랄|꺼져|닥쳐|미친\s*놈|미친\s*년|개새|쓰레기\s*년|한남충|한녀|느금마|니미|씹|ㅅㅂ|ㅄ|fuck|shit|bitch|asshole|cunt|nigger|faggot/i;
const SEC_BENIGN_QUOTE_RE =
    /^(분석|요약|확인|개선|내용|답변|요청|회의|담당|기능|체크|삭제|채팅|사용자|의견|이해|동료|메시지|최종|초안|비판|병합|리뷰|배포|예산|일정)$/;

/**
 * 보안 judge 의 원시 응답(JSON 문자열)을 판정으로 해석한다. 순수 함수 — 백엔드 상태와 무관.
 * 기본 ALLOW: JSON 없음/파싱 실패/근거 인용 없음/무효 사유/욕설 근거 없음이면 허용(ambiguous).
 * 차단은 explicit allow=false + 초안에 실재하는 짧은 인용(quote)이 있을 때만.
 * @param {string} raw judge 응답
 * @param {string} policyText 배정된 보안 정책 본문
 * @param {string} draftOnly 검토 대상(최종 직전 답변)
 */
function parseSecurityVerdict(raw, policyText, draftOnly) {
    // 첫 JSON 객체 (중첩 최소화 — 모델이 한 줄로 내는 전제)
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
    const reason = String(j.reason ?? j.message ?? "").trim() || "blocked";
    if (!explicitFalse) {
        return { allow: true, reason: reason === "blocked" ? "ok" : reason };
    }

    const quote = String(j.quote ?? j.span ?? j.evidence ?? j.match ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const draftFlat = String(draftOnly).replace(/\s+/g, " ");

    // 허위차단 방지: 초안에 실제로 있는 짧은 인용(quoteMin~quoteMax 자)이 필수
    const quoteOk =
        quote.length >= config.security.quoteMin &&
        quote.length <= config.security.quoteMax &&
        draftFlat.includes(quote);
    if (!quoteOk) {
        return {
            allow: true,
            reason: `보안검증 근거 부족(quote 없음/불일치/과장 “${reason.slice(0, 40)}”) → 허용`,
            ambiguous: true,
        };
    }

    // 스키마 예시·포괄 라벨을 reason 으로 베끼는 경우 (short_label «분석» 등)
    const junkReason =
        SEC_JUNK_LABEL_RE.test(reason) || SEC_JUNK_PHRASE_RE.test(reason);
    if (junkReason || reason.length < 2) {
        return {
            allow: true,
            reason: `보안검증 사유 무효(“${reason.slice(0, 40)}”) → 허용`,
            ambiguous: true,
        };
    }

    // 욕설·혐오 정책: quote 자체가 금칙/욕설 신호여야 함 (일반 단어 «분석» 차단 방지)
    if (SEC_ABUSE_POLICY_RE.test(String(policyText || ""))) {
        if (SEC_BENIGN_QUOTE_RE.test(quote) || !SEC_ABUSE_HIT_RE.test(quote)) {
            return {
                allow: true,
                reason: `욕설 근거 없음(quote “${quote.slice(0, 20)}”) → 허용`,
                ambiguous: true,
            };
        }
    }

    return { allow: false, reason: `${reason} «${quote.slice(0, 40)}»` };
}

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
        this.securityIds = Array.isArray(f.securityIds)
            ? [...f.securityIds]
            : [];
        this.securityPolicy = String(f.securityPolicy ?? "").trim();
        this.ctx = Number(f.ctx) > 0 ? Number(f.ctx) : config.llamaDefaultCtx;
        this.parallel =
            Number(f.parallel) > 0
                ? Math.min(
                      config.llamaParallelCap,
                      Math.floor(Number(f.parallel)),
                  )
                : Math.max(1, Number(config.llamaParallel) || 4);
        this.vision = Boolean(f.vision);
        this.healthy = false;
        this.model = null;
        this.inFlight = 0;
        this.totalRequests = 0;
        this.routerRequests = 0;
        this.plannerRequests = 0;
        this.securityRequests = 0;
        this.chatRequests = 0;
        this.totalErrors = 0;
        this.totalLatencyMs = 0;
        this.lastLatencyMs = null;
        this.healthLatencyMs = null;
        this.lastError = null;
        this.lastCheck = null;
    }

    /** 다른 인프라 역할도 겸하는지 (표시/참고용). 답변 풀 포함 여부는 solve 로만 결정. */
    get exclusiveInfra() {
        return (
            this.routerEnabled || this.plannerEnabled || this.securityEnabled
        );
    }

    /**
     * 답변(해결) 풀 포함 여부 = solve 가 켜져 있으면 포함.
     * 라우터/설계/보안을 겸해도 solve 가 켜져 있으면 답변한다.
     * "답변 안 함"은 solve:false 로 명시(그게 전용 인프라 지정 방법).
     */
    get canChat() {
        return this.solveEnabled && CHAT_TIERS.has(this.tier);
    }

    /**
     * 특기(역할) 전용 서버: solve 가 꺼져 있어도 해당 특기 요청은 받을 수 있음.
     * (예: 소형 +「간단한 인사」만 담당)
     */
    get canServeSkill() {
        return this.skills.length > 0 && CHAT_TIERS.has(this.tier);
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
            ctx: this.ctx,
            parallel: this.parallel,
            inFlight: this.inFlight,
            totalRequests: this.totalRequests,
            routerRequests: this.routerRequests,
            plannerRequests: this.plannerRequests,
            securityRequests: this.securityRequests,
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
                        ctx:
                            Number(s.ctx) > 0
                                ? Number(s.ctx)
                                : config.llamaDefaultCtx,
                        parallel:
                            Number(s.parallel) > 0
                                ? Math.min(
                                      config.llamaParallelCap,
                                      Math.floor(Number(s.parallel)),
                                  )
                                : undefined,
                        vision: Boolean(s.vision || s.mmproj),
                    },
                ),
        );
        this.applyDefaultRouterRoles();
        this.rrCursor = 0;
        this.healthTimer = null;
        this.completed = [];
        /** 채팅(solve) 동시 실행 수 */
        this._chatRunning = 0;
        /** @type {{ resolve: Function, reject: Function, at: number, kind: string, timer: any, onQueue?: Function, preview?: string }[]} */
        this._chatQueue = [];
        /**
         * 백엔드 슬롯 세마포어 대기자. inFlight < parallel 인 백엔드가 없을 때
         * _chatDispatch/_chatStreamDispatch 가 여기서 대기하다 슬롯이 비면 재획득.
         * priority 높은 순 → 같은 priority 는 seq(도착 순) → 대화가 스트레스
         * 백로그를 앞질러 슬롯을 받는다.
         * @type {{ tryAcquire: () => any, resolve: Function, reject: Function, timer: any, priority: number, seq: number }[]}
         */
        this._slotWaiters = [];
        this._slotWaiterSeq = 0;
        /** 모델로 나간 진행 중 호출 (질문 미리보기·잔여 리스트용) */
        this._modelJobs = new Map();
        this._modelJobSeq = 0;
        /** 최근 완료/실패 작업 (부하현황 탭용, 메모리 ring) */
        this._jobHistory = [];
        this._jobHistoryMax = config.poolJobHistoryMax;
        this._jobHistorySeq = 0;
        /** 스트레스 워커 풀에서 아직 시작 전인 대기 건 */
        this._stressPending = new Map();
        this._stressPendingSeq = 0;
        /**
         * 실시간 대화 HTTP (chat / chat/stream). 스트레스 워커가 빈 슬롯을
         * 가로채기 전에 대화를 보드에 올리고, 슬롯 양보를 강제한다.
         * @type {Map<number, { preview: string, at: number }>}
         */
        this._interactive = new Map();
        this._interactiveSeq = 0;
        this._queueStats = {
            enqueued: 0,
            started: 0,
            rejected: 0,
            timedOut: 0,
            peakDepth: 0,
            lastEnqueueAt: null,
            lastStartAt: null,
        };
        /** load-aware 강등·승격 통계 */
        this._loadStats = {
            demoteLargeToMedium: 0,
            skippedHardLock: 0,
            skippedFreeOk: 0,
            skippedHighDiff: 0,
            lastDemoteAt: null,
            lastDemoteReason: null,
            // 승격(medium→large): 유휴 large 활용
            promoteMediumToLarge: 0,
            skippedPromoteLowDiff: 0, // medium 포화지만 난이도 낮아 승격 안 함
            skippedPromoteBusy: 0, // medium 포화 + large 도 포화 → 승격 불가
            lastPromoteAt: null,
            lastPromoteReason: null,
        };
        /** 부하 스냅샷 세션 에러 sink (loadSession.recordError). 없으면 no-op */
        this._errorSink = null;
    }

    /** 부하 스냅샷 세션이 dispatch 에러를 수집하도록 콜백 등록 */
    setErrorSink(fn) {
        this._errorSink = typeof fn === "function" ? fn : null;
    }

    /** dispatch 실패 시 세션 sink 로 에러 이벤트 전달 (활성 세션 없으면 sink 가 무시) */
    _emitError(kind, backend, err) {
        const sink = this._errorSink;
        if (!sink) return;
        try {
            sink({
                ts: Date.now(),
                kind,
                tier: backend?.tier ?? null,
                url: backend?.url ?? null,
                alias: backend?.alias ?? null,
                model: backend?.model ?? null,
                status: err?.status ?? null,
                retryable: Boolean(err?.retryable),
                message: String(err?.message ?? err ?? "").slice(0, 500),
            });
        } catch {
            /* sink 실패는 무시 */
        }
    }

    /** 해결(답변) 가능·정상 백엔드 수 */
    healthySolveCount() {
        return this.backends.filter((b) => b.healthy && b.canChat).length;
    }

    /** 백엔드별 parallel 합 (없으면 LLAMA_PARALLEL) */
    backendParallel(b) {
        const p = Number(b?.parallel);
        if (Number.isFinite(p) && p >= 1)
            return Math.min(config.llamaParallelCap, Math.floor(p));
        return Math.max(1, Number(config.llamaParallel) || 4);
    }

    /** 동시에 돌릴 채팅 작업 한도 (= 건강한 solve 백엔드 parallel 합) */
    chatMaxInFlight() {
        const healthy = this.backends.filter((b) => b.healthy && b.canChat);
        if (healthy.length <= 0) return 0;
        const bySlots = healthy.reduce(
            (s, b) => s + this.backendParallel(b),
            0,
        );
        const cap = Number(config.chatMaxInFlight);
        // 0/미지정 = 자동: solve 백엔드 parallel 합
        if (!Number.isFinite(cap) || cap <= 0) return bySlots;
        return Math.min(Math.max(1, Math.floor(cap)), bySlots);
    }

    chatQueueMax() {
        return Math.max(0, Number(config.chatQueueMax) || 0);
    }

    /**
     * idle | normal | busy | saturated | offline
     * - busy = 실제로 대기열이 있거나 슬롯이 가득 차 다음 요청이 큐에 들어갈 상태
     * - 실행 중만으로 "큐 대기"라고 하지 않음 (깜빡임·오해 방지)
     */
    chatLoadLevel() {
        const running = this._chatRunning;
        const depth = this._chatQueue.length;
        const maxF = this.chatMaxInFlight();
        const maxQ = this.chatQueueMax();
        if (this.healthySolveCount() <= 0) return "offline";
        if (maxQ > 0 && depth >= maxQ) return "saturated";
        if (depth > 0) return "busy";
        if (maxF > 0 && running >= maxF) return "busy";
        if (running === 0 && depth === 0) return "idle";
        return "normal";
    }

    queueSnapshot() {
        const depth = this._chatQueue.length;
        const running = this._chatRunning;
        const maxInFlight = this.chatMaxInFlight();
        const maxDepth = this.chatQueueMax();
        const load = this.chatLoadLevel();
        const oldestMs = depth ? Date.now() - this._chatQueue[0].at : 0;
        const backendInFlight = this.backends.reduce(
            (s, b) => s + (b.inFlight || 0),
            0,
        );
        const solveInFlight = this.backends
            .filter((b) => b.canChat)
            .reduce((s, b) => s + (b.inFlight || 0), 0);
        return {
            depth,
            running,
            maxInFlight,
            maxDepth,
            load,
            loadLabel:
                {
                    idle: "한가함",
                    normal: "처리 중",
                    busy: depth > 0 ? "혼잡 (대기열)" : "혼잡 (슬롯 가득)",
                    saturated: "포화 (큐 가득)",
                    offline: "해결 서버 없음 (복구 대기)",
                }[load] || load,
            oldestWaitMs: oldestMs,
            backendInFlight,
            solveInFlight,
            healthySolve: this.healthySolveCount(),
            stats: { ...this._queueStats },
        };
    }

    /**
     * solve 백엔드 슬롯 스냅샷 (라우팅·load-aware 용)
     * @returns {{
     *   backends: Array<{tier,alias,url,parallel,inFlight,free}>,
     *   byTier: Record<string,{cap:number,used:number,free:number,pressure:number}>,
     *   promptBlock: string
     * }}
     */
    slotSnapshot() {
        const solve = this.backends.filter((b) => b.healthy && b.canChat);
        const backends = solve.map((b) => {
            const parallel = this.backendParallel(b);
            const inFlight = Number(b.inFlight) || 0;
            return {
                tier: b.tier,
                alias: b.alias || b.name || null,
                url: b.url,
                parallel,
                inFlight,
                free: Math.max(0, parallel - inFlight),
            };
        });

        const byTier = { small: null, medium: null, large: null };
        for (const t of ["small", "medium", "large"]) {
            const list = backends.filter((x) => x.tier === t);
            if (!list.length) {
                byTier[t] = { cap: 0, used: 0, free: 0, pressure: 0 };
                continue;
            }
            const cap = list.reduce((s, x) => s + x.parallel, 0);
            const used = list.reduce((s, x) => s + x.inFlight, 0);
            const free = Math.max(0, cap - used);
            byTier[t] = {
                cap,
                used,
                free,
                pressure: cap > 0 ? used / cap : 0,
            };
        }

        const lines = ["CLUSTER_SLOTS:"];
        for (const t of ["large", "medium", "small"]) {
            const g = byTier[t];
            if (!g || g.cap <= 0) continue;
            lines.push(
                `- ${t}: ${g.used}/${g.cap} free=${g.free} pressure=${g.pressure.toFixed(2)}`,
            );
        }
        if (lines.length === 1) {
            lines.push("- (no healthy solve backends)");
        }
        lines.push(
            "Prefer a less loaded tier when quality allows. Do not pick large if free=0 unless the task truly needs it.",
        );

        return {
            backends,
            byTier,
            promptBlock: lines.join("\n"),
        };
    }

    recordLoadDemote(reason) {
        this._loadStats.demoteLargeToMedium++;
        this._loadStats.lastDemoteAt = new Date().toISOString();
        this._loadStats.lastDemoteReason = String(reason || "").slice(0, 200);
    }

    recordLoadSkip(kind) {
        if (kind === "hard") this._loadStats.skippedHardLock++;
        else if (kind === "free") this._loadStats.skippedFreeOk++;
        else if (kind === "diff") this._loadStats.skippedHighDiff++;
        else if (kind === "promoLowDiff")
            this._loadStats.skippedPromoteLowDiff++;
        else if (kind === "promoBusy") this._loadStats.skippedPromoteBusy++;
    }

    recordLoadPromote(reason) {
        this._loadStats.promoteMediumToLarge++;
        this._loadStats.lastPromoteAt = new Date().toISOString();
        this._loadStats.lastPromoteReason = String(reason || "").slice(0, 200);
    }

    /**
     * 부하 보드용 작업 목록 수집: 진행 중 모델 잡 / 대화 대기 / 스트레스 대기.
     * (모델 잡에 이미 보이는 대화는 interactiveWaiting 에서 제외해 중복 표시 방지)
     */
    _collectLoadJobs(now) {
        const jobs = [...this._modelJobs.values()]
            .sort((a, b) => a.startedAt - b.startedAt)
            .map((j) => ({
                preview: j.preview || "(미리보기 없음)",
                kind: j.kind || "chat",
                tier: j.tier || null,
                alias: j.alias || null,
                backend: j.backendUrl || null,
                elapsedMs: now - j.startedAt,
            }));

        const jobPreviews = new Set(
            [...this._modelJobs.values()]
                .filter((j) => j.kind && j.kind !== "stress")
                .map((j) => j.preview),
        );
        const interactiveWaiting = [...this._interactive.values()]
            .filter((j) => !jobPreviews.has(j.preview))
            .sort((a, b) => a.at - b.at)
            .map((j, i) => ({
                i: i + 1,
                preview: j.preview || "(대화)",
                kind: "chat-wait",
                tier: null,
                alias: null,
                backend: null,
                waitMs: now - j.at,
            }));

        const stressWaiting = [...this._stressPending.values()]
            .sort((a, b) => a.at - b.at)
            .map((j, i) => ({
                i: i + 1,
                preview: j.preview || "(스트레스 대기)",
                kind: "stress-wait",
                tier: null,
                alias: null,
                backend: null,
                waitMs: now - j.at,
            }));

        return { jobs, interactiveWaiting, stressWaiting };
    }

    /**
     * 통계용 부하 보드: API / 모델 / 잔여(모델이 바로 못 받는 것) 분리
     */
    loadBoard() {
        const now = Date.now();
        const solve = this.backends.filter((b) => b.healthy && b.canChat);
        const capacity = solve.reduce((s, b) => s + this.backendParallel(b), 0);
        const inFlight = solve.reduce((s, b) => s + (b.inFlight || 0), 0);
        const defaultPar = Math.max(1, Number(config.llamaParallel) || 4);

        const { jobs, interactiveWaiting, stressWaiting } =
            this._collectLoadJobs(now);

        const processing = capacity > 0 ? jobs.slice(0, capacity) : [];
        // llama 초과 추정 + 스트레스 워커 대기(슬롯 열려야 시작)
        const waitingModel = [
            ...interactiveWaiting,
            ...(capacity > 0 ? jobs.slice(capacity) : jobs),
            ...stressWaiting,
        ];
        const pendingCount = this._stressPending.size;
        // 워커가 집었지만 빈 슬롯이 없어 세마포어에서 대기 중인 건
        // (슬롯 게이트 도입 후 실제 대기는 여기에 쌓인다)
        const slotWaiting = this._slotWaiters.length;
        // 보드용: 슬롯 초과(=슬롯 대기) + 아직 워커가 안 집은 스트레스 대기
        const overflow =
            Math.max(0, inFlight - capacity) +
            slotWaiting +
            pendingCount +
            interactiveWaiting.length;

        const apiWaiting = this._chatQueue.map((e, i) => ({
            i: i + 1,
            kind: e.kind || "chat",
            waitMs: now - e.at,
            preview: e.preview || "(API 대기 — 아직 모델로 미전송)",
        }));

        const apiJobs = this._chatRunning;
        const apiCap = this.chatMaxInFlight();
        const totalWork =
            inFlight + slotWaiting + pendingCount + interactiveWaiting.length;

        return {
            api: {
                label: "API 서버",
                jobs: apiJobs,
                cap: apiCap,
                utilPct:
                    apiCap > 0
                        ? Math.min(100, Math.round((apiJobs / apiCap) * 100))
                        : 0,
                queueDepth: this._chatQueue.length,
                queueMax: this.chatQueueMax(),
                waiting: apiWaiting,
                note: "외부 시스템이 친 HTTP 작업. 보통 짧게 비어 있음.",
            },
            model: {
                label: "모델",
                inFlight,
                capacity,
                pending: pendingCount,
                interactive: interactiveWaiting.length,
                slotWaiting,
                totalWork,
                parallelPerServer: defaultPar,
                healthySolve: solve.length,
                utilPct:
                    capacity > 0
                        ? Math.min(100, Math.round((inFlight / capacity) * 100))
                        : inFlight > 0
                          ? 100
                          : 0,
                overflow,
                backends: solve.map((b) => {
                    const parallel = this.backendParallel(b);
                    return {
                        name: b.alias || b.name || b.url,
                        url: b.url,
                        tier: b.tier,
                        inFlight: b.inFlight || 0,
                        parallel,
                        utilPct: Math.min(
                            100,
                            Math.round(((b.inFlight || 0) / parallel) * 100),
                        ),
                    };
                }),
                note: `용량 = 각 solve 모델 parallel 합 (기본 env=${defaultPar})`,
            },
            leftover: {
                label: "잔여 질문 (모델이 바로 못 받은 것)",
                overflowEstimate: overflow,
                pending: pendingCount,
                interactive: interactiveWaiting.length,
                slotWaiting,
                waiting: waitingModel,
                processing,
                apiWaiting,
                note:
                    "slotWaiting = 워커가 집었으나 빈 슬롯 대기 중. " +
                    "pending = 아직 워커가 안 집은 스트레스 대기. " +
                    "interactive = 실시간 대화(라우팅 전 포함). " +
                    "API waiting 은 Express가 아직 모델로 안 보낸 건.",
            },
            history: this._jobHistoryLists(),
        };
    }

    _trackStressPending(meta = {}) {
        const id = ++this._stressPendingSeq;
        this._stressPending.set(id, {
            preview: String(meta.preview || "").slice(0, 120),
            at: Date.now(),
            i: meta.i ?? null,
        });
        return id;
    }

    _untrackStressPending(id) {
        if (id != null) this._stressPending.delete(id);
    }

    /**
     * 스트레스 N건을 즉시 "대기"로 등록한다(라우팅·프롬프트 준비 전에 호출).
     * 이렇게 해야 요청을 받는 즉시 부하 보드의 대기 수치가 바로 오른다.
     * 반환한 ids 를 stressChat 에 넘기면 워커가 하나씩 소진한다.
     * @returns {number[]}
     */
    beginStressBatch(count, preview = "") {
        const n = Math.max(1, Math.floor(Number(count) || 1));
        const label = String(preview || "").slice(0, 120);
        const ids = [];
        for (let i = 1; i <= n; i++) {
            ids.push(
                this._trackStressPending({
                    i,
                    preview: label
                        ? `[대기 #${i}/${n}] ${label}`
                        : `stress 대기 #${i}/${n}`,
                }),
            );
        }
        return ids;
    }

    /** beginStressBatch 로 잡은 대기 마커를 모두 해제(누수 방지 안전망). */
    releaseStressBatch(ids) {
        if (!Array.isArray(ids)) return;
        for (const id of ids) this._untrackStressPending(id);
    }

    /**
     * 실시간 대화 시작. 라우팅·임베딩 전에 호출해야 스트레스가 빈 슬롯을
     * 다시 채우지 않고, 부하 보드에 대화가 바로 보인다.
     * @returns {number} endInteractive 에 넘길 id
     */
    beginInteractive(preview = "") {
        const id = ++this._interactiveSeq;
        this._interactive.set(id, {
            preview: String(preview || "").slice(0, 120) || "(대화)",
            at: Date.now(),
        });
        this._logQueue(
            `대화 우선 진입: "${String(preview || "").slice(0, 40)}" ` +
                `(실시간 ${this._interactive.size}건 · 스트레스 대기 ${this._stressPending.size}건)`,
        );
        return id;
    }

    endInteractive(id) {
        if (id == null) return;
        this._interactive.delete(id);
        this.pumpSlotWaiters();
    }

    _mergeExclude(tried, skip) {
        if (!skip || skip.size === 0) return tried;
        const s = new Set(tried);
        for (const u of skip) s.add(u);
        return s;
    }

    _backendHasFreeSlot(b) {
        if (!b) return false;
        return (Number(b.inFlight) || 0) < this.backendParallel(b);
    }

    _preferFree(list) {
        if (!list?.length) return list;
        const free = list.filter((b) => this._backendHasFreeSlot(b));
        return free.length ? free : list;
    }

    _interactiveJobCount() {
        let n = 0;
        for (const j of this._modelJobs.values()) {
            if (j.kind && j.kind !== "stress") n++;
        }
        return n;
    }

    /**
     * 실시간 대화가 아직 슬롯을 못 잡았으면 스트레스는 빈 슬롯을 가져가면 안 됨.
     * (인사는 라우터/임베딩을 먼저 타서, 그 전에 스트레스가 슬롯을 다시 채우면
     *  보드엔 빈 칸이 보여도 대화는 스트레스가 끝날 때까지 답이 안 온다.)
     */
    _holdStressSlots() {
        if (this._interactive.size <= 0) return false;
        if (this._slotWaiters.some((w) => (Number(w.priority) || 0) > 0)) {
            return true;
        }
        return this._interactive.size > this._interactiveJobCount();
    }

    /** 라우터 역할 백엔드에 빈 슬롯이 있는지 */
    routerHasFreeSlot() {
        return this.backends.some(
            (b) => b.routerEnabled && b.healthy && this._backendHasFreeSlot(b),
        );
    }

    /**
     * 실시간 대화인데 라우터 슬롯이 없으면 LLM 분류를 건너뛴다.
     * 대형 라우터가 스트레스에 점유된 채 휴리스틱으로 바로 답변 슬롯(비어 있는
     * medium 등)을 쓰게 한다.
     */
    shouldSkipLlmRouter() {
        if (this._interactive.size <= 0) return false;
        if (!this.hasActiveRouter()) return false;
        return !this.routerHasFreeSlot();
    }

    _trackModelJob(meta = {}) {
        const id = ++this._modelJobSeq;
        this._modelJobs.set(id, {
            preview: String(meta.preview || "").slice(0, 120),
            kind: meta.kind || "chat",
            tier: meta.tier || null,
            alias: meta.alias || null,
            backendUrl: meta.backendUrl || null,
            startedAt: Date.now(),
        });
        return id;
    }

    _updateModelJob(id, patch = {}) {
        const cur = this._modelJobs.get(id);
        if (!cur) return;
        Object.assign(cur, patch);
    }

    _pushJobHistory(entry) {
        this._jobHistory.push(entry);
        while (this._jobHistory.length > this._jobHistoryMax) {
            this._jobHistory.shift();
        }
    }

    /** 진행 중 작업 종료 → 완료/실패 히스토리로 이동 */
    _finishModelJob(id, { ok = false, error = null } = {}) {
        const cur = this._modelJobs.get(id);
        if (!cur) return;
        this._modelJobs.delete(id);
        const endedAt = Date.now();
        this._pushJobHistory({
            id: ++this._jobHistorySeq,
            ok: Boolean(ok),
            preview: cur.preview || "(미리보기 없음)",
            kind: cur.kind || "chat",
            tier: cur.tier || null,
            alias: cur.alias || null,
            backend: cur.backendUrl || null,
            error: ok ? null : String(error || "실패").slice(0, 200),
            startedAt: cur.startedAt,
            endedAt,
            ms: Math.max(0, endedAt - (cur.startedAt || endedAt)),
            ts: new Date(endedAt).toISOString(),
        });
    }

    _untrackModelJob(id) {
        // 호환: 결과 없이 지우면 실패로 남기지 않음(호출부에서 _finishModelJob 사용)
        this._modelJobs.delete(id);
    }

    _jobHistoryLists() {
        const done = [];
        const failed = [];
        // 최신순
        for (let i = this._jobHistory.length - 1; i >= 0; i--) {
            const j = this._jobHistory[i];
            if (j.ok) done.push(j);
            else failed.push(j);
        }
        return { done, failed };
    }

    _logQueue(msg) {
        logger.info(msg);
    }

    /**
     * 채팅 슬롯 획득. 바쁠 때/해결 서버 없을 때 큐 대기.
     * @returns {Promise<{ waitedMs: number, queued: boolean }>}
     */
    acquireChatSlot({ kind = "chat", onQueue, preview = "" } = {}) {
        const tryImmediate = () => {
            const maxF = this.chatMaxInFlight();
            if (maxF > 0 && this._chatRunning < maxF) {
                this._chatRunning++;
                this._queueStats.started++;
                this._queueStats.lastStartAt = new Date().toISOString();
                return { waitedMs: 0, queued: false };
            }
            return null;
        };

        const immediate = tryImmediate();
        if (immediate) return Promise.resolve(immediate);

        const maxQ = this.chatQueueMax();
        if (maxQ <= 0 || this._chatQueue.length >= maxQ) {
            this._queueStats.rejected++;
            this._logQueue(
                `채팅 큐 거절: 대기열 가득 (${this._chatQueue.length}/${maxQ || 0}), 실행중 ${this._chatRunning}, 요청이 많아 더 받을 수 없음`,
            );
            return Promise.reject(
                new Error(
                    `채팅 대기열이 가득 찼습니다 (${this._chatQueue.length}/${maxQ}). 잠시 후 다시 시도해 주세요.`,
                ),
            );
        }

        const waitMs = Math.max(
            5_000,
            Number(config.chatQueueWaitMs) || 120_000,
        );

        return new Promise((resolve, reject) => {
            const entry = {
                resolve,
                reject,
                at: Date.now(),
                kind,
                onQueue,
                preview: String(preview || "").slice(0, 120),
                timer: null,
            };
            entry.timer = setTimeout(() => {
                const i = this._chatQueue.indexOf(entry);
                if (i < 0) return;
                this._chatQueue.splice(i, 1);
                this._queueStats.timedOut++;
                this._logQueue(
                    `채팅 큐 대기 초과: ${waitMs}ms, 남은 대기 ${this._chatQueue.length}건`,
                );
                reject(
                    new Error(
                        `채팅 대기 시간이 초과되었습니다 (${Math.round(waitMs / 1000)}초). 서버가 바쁩니다. 잠시 후 다시 시도해 주세요.`,
                    ),
                );
            }, waitMs);

            this._chatQueue.push(entry);
            this._queueStats.enqueued++;
            this._queueStats.peakDepth = Math.max(
                this._queueStats.peakDepth,
                this._chatQueue.length,
            );
            this._queueStats.lastEnqueueAt = new Date().toISOString();
            const pos = this._chatQueue.length;
            this._logQueue(
                `채팅 큐 적재: 대기 ${pos}건 · 실행중 ${this._chatRunning}/${this.chatMaxInFlight()} · ` +
                    `해결서버 ${this.healthySolveCount()} · 요청이 많아 큐가 쌓이는 중 (${kind})`,
            );
            try {
                onQueue?.({
                    position: pos,
                    depth: pos,
                    running: this._chatRunning,
                    maxInFlight: this.chatMaxInFlight(),
                    load: this.chatLoadLevel(),
                });
            } catch {
                /* ignore */
            }
        });
    }

    releaseChatSlot() {
        this._chatRunning = Math.max(0, this._chatRunning - 1);
        this.pumpChatQueue();
    }

    /** 대기열 → 실행 슬롯 출고 */
    pumpChatQueue() {
        while (this._chatQueue.length > 0) {
            const maxF = this.chatMaxInFlight();
            if (maxF <= 0 || this._chatRunning >= maxF) break;
            const entry = this._chatQueue.shift();
            if (!entry) break;
            if (entry.timer) clearTimeout(entry.timer);
            this._chatRunning++;
            this._queueStats.started++;
            this._queueStats.lastStartAt = new Date().toISOString();
            const waitedMs = Date.now() - entry.at;
            this._logQueue(
                `채팅 큐 출고: 대기 ${waitedMs}ms → 실행 (남은 대기 ${this._chatQueue.length}건, 실행중 ${this._chatRunning}/${maxF})`,
            );
            entry.resolve({ waitedMs, queued: true });
        }
    }

    /**
     * 백엔드 슬롯 세마포어 획득.
     * pickFn 은 현재 후보 백엔드(라우팅·failover 반영)를 고른다.
     * - pickFn 이 null → 후보 자체가 없음 → null 반환(디스패치 루프 종료).
     * - 고른 백엔드에 빈 슬롯(inFlight<parallel) → 즉시 inFlight++ 하고 반환.
     * - 후보는 있으나 전부 참 → 슬롯이 빌 때까지 대기 후 재획득.
     * 이로써 백엔드별 inFlight 는 절대 parallel 을 넘지 않는다(전역 상한 = 슬롯 합).
     * @param {() => (object|null)} pickFn
     * @param {{ priority?: number }} [opts] priority 높을수록 먼저 슬롯 획득
     *        (대화=10, 스트레스=0). 대화가 스트레스 백로그를 앞지른다.
     * @returns {Promise<object|null>} inFlight 이미 증가된 백엔드, 또는 후보 없으면 null
     */
    acquireBackendSlot(pickFn, { priority = 0 } = {}) {
        const myPri = Number(priority) || 0;
        // 동기 시도: 빈 슬롯 있으면 바로 잡고, 후보 없으면 null, 다 차면 대기 신호.
        // pickFn(skip) 이 가득 찬 백엔드를 돌려도 skip 에 넣어 다른 후보(다른 티어)를 본다.
        const tryAcquire = () => {
            const skip = new Set();
            while (true) {
                const b = pickFn(skip);
                if (!b) {
                    return skip.size > 0
                        ? { state: "full" }
                        : { state: "none" };
                }
                if (skip.has(b.url)) return { state: "full" };
                const parallel = this.backendParallel(b);
                if ((b.inFlight || 0) < parallel) {
                    b.inFlight++;
                    return { state: "got", backend: b };
                }
                skip.add(b.url);
                if (skip.size > 64) return { state: "full" };
            }
        };

        const rollback = (backend) => {
            if (backend) {
                backend.inFlight = Math.max(0, (backend.inFlight || 0) - 1);
            }
        };

        const first = tryAcquire();
        if (first.state === "got") {
            const higherWaiter = this._slotWaiters.some(
                (w) => (Number(w.priority) || 0) > myPri,
            );
            const holdStress =
                myPri <= SLOT_PRI_STRESS && this._holdStressSlots();
            if (higherWaiter || holdStress) {
                rollback(first.backend);
            } else {
                return Promise.resolve(first.backend);
            }
        } else if (first.state === "none") {
            return Promise.resolve(null);
        }

        // 후보는 있으나 슬롯이 가득(또는 대화 양보) → 릴리스될 때까지 대기
        const waitMs = Math.max(
            5_000,
            Number(config.chatQueueWaitMs) || 120_000,
        );
        return new Promise((resolve, reject) => {
            const waiter = {
                tryAcquire,
                resolve,
                reject,
                timer: null,
                priority: myPri,
                seq: ++this._slotWaiterSeq,
            };
            waiter.timer = setTimeout(() => {
                const i = this._slotWaiters.indexOf(waiter);
                if (i >= 0) this._slotWaiters.splice(i, 1);
                reject(
                    new Error(
                        `모델 슬롯 대기 시간이 초과되었습니다 (${Math.round(waitMs / 1000)}초). 서버가 바쁩니다.`,
                    ),
                );
            }, waitMs);
            this._slotWaiters.push(waiter);
            // 방금 양보로 비운 슬롯·이미 비어 있던 슬롯을 높은 우선순위가 바로 집게
            this.pumpSlotWaiters();
        });
    }

    /** 백엔드 슬롯 반납: inFlight-- 후 대기자에게 빈 슬롯을 넘긴다. */
    releaseBackendSlot(backend) {
        if (backend)
            backend.inFlight = Math.max(0, (backend.inFlight || 0) - 1);
        this.pumpSlotWaiters();
    }

    /**
     * 슬롯이 비면 대기자를 깨워 재획득 시도.
     * priority 높은 순 → 같은 priority 는 seq(도착 순). 이렇게 해야 대화가
     * 스트레스 백로그(수십 건)를 앞질러 빈 슬롯을 받는다.
     */
    pumpSlotWaiters() {
        if (!this._slotWaiters.length) return;
        const holdStress = this._holdStressSlots();
        // 우선순위·도착순으로 시도 순서 결정 (원본 배열은 건드리지 않고 정렬 사본)
        const order = [...this._slotWaiters].sort(
            (a, b) => b.priority - a.priority || a.seq - b.seq,
        );
        const done = new Set();
        for (const waiter of order) {
            if (
                holdStress &&
                (Number(waiter.priority) || 0) <= SLOT_PRI_STRESS
            ) {
                continue;
            }
            const r = waiter.tryAcquire();
            if (r.state === "got") {
                if (waiter.timer) clearTimeout(waiter.timer);
                waiter.resolve(r.backend);
                done.add(waiter);
            } else if (r.state === "none") {
                // 이 대기자의 후보가 사라짐(모두 비정상 등) → null 로 종료
                if (waiter.timer) clearTimeout(waiter.timer);
                waiter.resolve(null);
                done.add(waiter);
            }
            // "full" 은 그대로 대기 유지
        }
        if (done.size) {
            this._slotWaiters = this._slotWaiters.filter((w) => !done.has(w));
        }
    }

    async withChatSlot(kind, onQueue, fn, preview = "") {
        const slot = await this.acquireChatSlot({ kind, onQueue, preview });
        try {
            return await fn(slot);
        } finally {
            this.releaseChatSlot();
        }
    }

    async checkAll() {
        try {
            await Promise.all(
                this.backends.map(async (b) => {
                    const prev = b.healthy;
                    const { ok, latencyMs } = await checkHealth(b.url);
                    b.healthy = ok;
                    b.healthLatencyMs = latencyMs;
                    b.lastCheck = new Date().toISOString();
                    if (ok && !b.model) b.model = await fetchModel(b.url);
                    if (!ok && !b.lastError)
                        b.lastError = "health check failed";
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
            // 해결 서버가 다시 살아나면 대기 큐 출고
            this.pumpChatQueue();
        } catch (err) {
            logger.error(`헬스체크 실패: ${err.message}`);
        }
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
            "라우터 역할 없음 → 휴리스틱 라우팅 (서버/모델관리에서 원하는 서버의 라우터를 켜세요)",
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
            defs.map((d) => [serverUrl(d), readFixedFlags(d)]),
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
            const url = serverUrl(d);
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
        const nextRoleIds = Array.isArray(assignment.roleIds)
            ? [...assignment.roleIds]
            : b.roleIds;
        const nextCustom = Array.isArray(assignment.customSkills)
            ? normalizeSkills(assignment.customSkills)
            : b.customSkills;
        const nextSkills = Array.isArray(assignment.skills)
            ? normalizeSkills(assignment.skills)
            : normalizeSkills([
                  ...(assignment.commonSkills ?? []),
                  ...nextCustom,
              ]);
        const same =
            nextRoleIds.length === b.roleIds.length &&
            nextRoleIds.every((id, i) => id === b.roleIds[i]) &&
            nextCustom.length === b.customSkills.length &&
            nextCustom.every((s, i) => s === b.customSkills[i]) &&
            nextSkills.length === b.skills.length &&
            nextSkills.every((s, i) => s === b.skills[i]);
        if (same) return true;
        b.roleIds = nextRoleIds;
        b.customSkills = nextCustom;
        b.skills = nextSkills;
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
     * solve 가 꺼진 특기 전용 서버도 포함. roles.json 설명도 붙여 역할 매칭에 씀.
     */
    skillOptions() {
        const descByName = new Map();
        for (const r of loadRolesSync()) {
            const key = roleSkillKey(r);
            if (key) descByName.set(key, String(r.description || "").trim());
        }
        const map = new Map();
        for (const b of this.backends) {
            if (!b.canServeSkill || !b.skills.length) continue;
            for (const skill of b.skills) {
                const e = map.get(skill) ?? {
                    skill,
                    backends: 0,
                    healthy: 0,
                    tiers: new Set(),
                    description: descByName.get(skill) || "",
                };
                e.backends++;
                if (b.healthy) e.healthy++;
                e.tiers.add(b.tier);
                if (!e.description && descByName.has(skill)) {
                    e.description = descByName.get(skill);
                }
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
                description: e.description || "",
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
        const prev =
            key === "solve"
                ? b.solveEnabled
                : key === "router"
                  ? b.routerEnabled
                  : key === "planner"
                    ? b.plannerEnabled
                    : key === "embedding"
                      ? b.embeddingEnabled
                      : key === "security"
                        ? b.securityEnabled
                        : null;
        if (prev === on) return true; // heartbeat 재등록 시 노이즈 로그 방지
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
        candidates = this._preferFree(candidates);
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
        candidates = this._preferFree(candidates);

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
            const pick = (skip = new Set()) => {
                const excl = this._mergeExclude(tried, skip);
                let b = this.pickFixed(roleKey, excl);
                if (!b) return null;
                if ((TIER_RANK[b.tier] ?? 0) < minRank) {
                    const higher = this.pickFixed(roleKey, excl, minRank);
                    if (higher && higher.url !== b.url) {
                        logger.info(
                            `${label} 에스컬레이션: ${b.tier}@${b.url} → ${higher.tier}@${higher.url} (요구 티어 ${minTier})`,
                        );
                        b = higher;
                    }
                }
                return b;
            };
            const backend = await this.acquireBackendSlot(pick, {
                priority: SLOT_PRI_INFRA,
            });
            if (!backend) break;
            tried.add(backend.url);

            backend.totalRequests++;
            // 분류(라우터)·설계(설계기) 호출은 채팅이 아님 — 역할별 카운터로 분리
            if (roleKey === "planner") backend.plannerRequests++;
            else backend.routerRequests++;
            const jobId = this._trackModelJob({
                preview: `${label} 분류`,
                kind: roleKey,
                tier: backend.tier,
                alias: backend.alias || null,
                backendUrl: backend.url,
            });
            const started = Date.now();
            let jobOk = false;
            try {
                const result = await chatCompletion({
                    baseUrl: backend.url,
                    ...rest,
                    enableThinking: false,
                });
                backend.lastLatencyMs = Date.now() - started;
                backend.totalLatencyMs += backend.lastLatencyMs;
                jobOk = true;
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
                this._emitError(
                    roleKey === "planner" ? "planner" : "router",
                    backend,
                    err,
                );
                if (!err.retryable) throw err;
                // 연결 실패(backendDown)일 때만 즉시 unhealthy 처리.
                // 500·타임아웃은 요청/과부하 문제라 페일오버만 하고 상태는
                // 헬스체크에 맡긴다(부하 중 모델 깜빡임 방지).
                if (err.backendDown) backend.healthy = false;
                logger.warn(
                    `${label} 백엔드 실패 → 재시도 (${backend.url}): ${err.message}`,
                );
            } finally {
                this.releaseBackendSlot(backend);
                this.completed.push(Date.now());
                this._finishModelJob(jobId, {
                    ok: jobOk,
                    error: lastErr?.message || null,
                });
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

    /** 최소 inFlight 후보 중 라운드로빈으로 하나 선택 (동률이면 분산). 빈 목록은 null. */
    _leastLoadedRR(list) {
        if (!list?.length) return null;
        let min = Infinity;
        for (const b of list) min = Math.min(min, b.inFlight);
        const least = list.filter((b) => b.inFlight === min);
        this.rrCursor = (this.rrCursor + 1) % least.length;
        return least[this.rrCursor];
    }

    /** 비전 선호 시 vision 가능한 백엔드만 남긴다(있을 때만). */
    _preferVision(list, preferVision) {
        if (!preferVision || !list?.length) return list;
        const vis = list.filter((b) => b.vision);
        return vis.length ? vis : list;
    }

    /**
     * 역할(특기) 우선 선택. preferredSkill 이 없거나 매칭 백엔드가 없으면 null 을
     * 반환해 호출자가 일반 해결 풀로 폴백하게 한다.
     */
    _pickBySkill(
        healthySkill,
        { preferredSkill, preferredTier, preferredDevice, preferVision },
    ) {
        if (!preferredSkill) return null;
        let bySkill = healthySkill.filter((b) =>
            b.skills.includes(preferredSkill),
        );
        if (bySkill.length === 0) return null;
        if (preferredTier) {
            const atTier = bySkill.filter((b) => b.tier === preferredTier);
            if (atTier.length > 0) bySkill = atTier;
        }
        if (preferredDevice) {
            const byDevice = bySkill.filter(
                (b) => b.device === preferredDevice,
            );
            if (byDevice.length > 0) bySkill = byDevice;
        }
        bySkill = this._preferVision(bySkill, preferVision);
        bySkill = this._preferFree(bySkill);
        return this._leastLoadedRR(bySkill);
    }

    /** 일반 해결(solve) 풀에서 티어/장치/비전 선호를 반영해 최소 부하 백엔드 선택. */
    _pickByTier(
        healthyChat,
        { preferredTier, allowOtherTiers, preferredDevice, preferVision },
    ) {
        if (healthyChat.length === 0) return null;
        let candidates = preferredTier
            ? healthyChat.filter((b) => b.tier === preferredTier)
            : healthyChat;
        if (candidates.length === 0) {
            if (!allowOtherTiers) return null;
            // 원하는 티어가 없으면: 상위 티어 우선(가까운 순), 없으면 하위 티어
            const want = TIER_RANK[preferredTier] ?? 0;
            const fallbackScore = (b) => {
                const r = TIER_RANK[b.tier] ?? 0;
                return r >= want ? r - want : 10 + (want - r);
            };
            let best = Infinity;
            for (const b of healthyChat)
                best = Math.min(best, fallbackScore(b));
            candidates = healthyChat.filter((b) => fallbackScore(b) === best);
        }
        if (preferredDevice) {
            const byDevice = candidates.filter(
                (b) => b.device === preferredDevice,
            );
            if (byDevice.length > 0) candidates = byDevice;
        }
        candidates = this._preferVision(candidates, preferVision);
        candidates = this._preferFree(candidates);
        return this._leastLoadedRR(candidates);
    }

    /** 건강한 해결(solve) 백엔드가 있는 티어. 없으면 preferred 그대로. */
    resolveSolveTier(preferred) {
        const want = String(preferred || "medium").toLowerCase();
        const healthy = this.backends.filter((b) => b.healthy && b.canChat);
        if (!healthy.length) return want;
        if (healthy.some((b) => b.tier === want)) return want;
        const w = TIER_RANK[want] ?? 1;
        let best = want;
        let bestScore = Infinity;
        for (const b of healthy) {
            const r = TIER_RANK[b.tier] ?? 0;
            const score = r >= w ? r - w : 10 + (w - r);
            if (score < bestScore) {
                bestScore = score;
                best = b.tier;
            }
        }
        return best;
    }

    /** 디버그용: 해결 풀 한 줄 설명 */
    solvePoolLabel() {
        const rows = this.backends.filter((b) => b.canChat);
        if (!rows.length) {
            const all = this.backends
                .map(
                    (b) =>
                        `${b.tier}${b.healthy ? "" : "/비정상"}(solve=${b.solveEnabled ? "on" : "off"})`,
                )
                .join(", ");
            return all ? `해결 꺼짐 [${all}]` : "등록된 서버 없음";
        }
        return rows
            .map(
                (b) =>
                    `${b.tier}${b.healthy ? "" : "/비정상"}:${b.alias || b.url}`,
            )
            .join(", ");
    }

    _missingBackendError(
        preferredTier,
        allowOtherTiers,
        { stream = false } = {},
    ) {
        const want = preferredTier || "임의";
        const lock = allowOtherTiers ? "" : ", 다른 티어 금지";
        const head = stream
            ? "스트리밍 가능한 백엔드를 찾지 못했습니다"
            : "요청을 처리할 백엔드를 찾지 못했습니다";
        return new Error(
            `${head} (요청 티어: ${want}${lock}; 해결 풀: ${this.solvePoolLabel()})`,
        );
    }

    pick(
        exclude = new Set(),
        preferredTier = null,
        allowOtherTiers = true,
        preferredDevice = null,
        preferredSkill = null,
        preferVision = false,
    ) {
        const healthyChat = this.backends.filter(
            (b) => b.healthy && b.canChat && !exclude.has(b.url),
        );
        // 특기 요청: solve 꺼진 역할 전용 서버도 포함
        const healthySkill = this.backends.filter(
            (b) => b.healthy && b.canServeSkill && !exclude.has(b.url),
        );

        // 1) 역할(특기) 먼저 — 맞으면 그 서버로
        const bySkill = this._pickBySkill(healthySkill, {
            preferredSkill,
            preferredTier,
            preferredDevice,
            preferVision,
        });
        if (bySkill) return bySkill;

        // 2) 일반 해결 풀 (solve 켠 서버만)
        return this._pickByTier(healthyChat, {
            preferredTier,
            allowOtherTiers,
            preferredDevice,
            preferVision,
        });
    }

    /**
     * 키워드로 등록된 특기 이름 찾기 (예: 인사 → "간단한 인사").
     * healthy·canChat 백엔드에 실제로 배정된 특기만.
     */
    matchSkillByKeywords(keywords = []) {
        const keys = (Array.isArray(keywords) ? keywords : [keywords])
            .map((k) => String(k ?? "").trim())
            .filter(Boolean);
        if (!keys.length) return null;
        const opts = this.skillOptions();
        for (const o of opts) {
            const name = o.skill;
            if (
                keys.some(
                    (k) => name.includes(k) || new RegExp(k, "i").test(name),
                )
            ) {
                return name;
            }
        }
        return null;
    }

    /** 특기가 올라간 백엔드들의 대표 티어 (가장 가벼운 티어 우선) */
    tierForSkill(skill) {
        if (!skill) return null;
        const ranks = this.backends
            .filter(
                (b) => b.healthy && b.canServeSkill && b.skills.includes(skill),
            )
            .map((b) => b.tier);
        if (!ranks.length) return null;
        return ranks.sort(
            (a, b) => (TIER_RANK[a] ?? 9) - (TIER_RANK[b] ?? 9),
        )[0];
    }

    /** 특기가 해당 티어 백엔드를 갖는지 (solve 꺼진 역할 전용 포함) */
    skillHasTier(skill, tier) {
        if (!skill || !tier) return false;
        return this.backends.some(
            (b) =>
                b.healthy &&
                b.canServeSkill &&
                b.skills.includes(skill) &&
                b.tier === tier,
        );
    }

    async chat(params = {}) {
        const { onQueue, preview, ...rest } = params;
        return this.withChatSlot(
            "chat",
            onQueue,
            () => this._chatDispatch({ ...rest, preview }),
            preview,
        );
    }

    /**
     * 모델 스트레스: Express 요청은 1회, 내부에서 모델 호출을 count 회.
     * 기본 parallel = Promise.all 로 llama --parallel 슬롯을 실제로 밀어본다.
     * 전역 채팅 슬롯(acquireChatSlot)은 잡지 않는다 — 하위 N회가 각자
     * _chatDispatch 의 백엔드 슬롯 세마포어를 거치므로 그것으로 동시성이 충분히
     * 제한된다. 전역 슬롯을 배치째 점유하면, 그 사이 들어온 일반 대화가 전역
     * 게이트에서 "배치(32건)가 다 끝날 때까지" 막힌다(관측된 버그).
     * 각 호출마다 load-aware 로 티어를 다시 본다 (슬롯 포화 시 medium 강등).
     */
    async stressChat(params = {}) {
        const {
            count = 1,
            mode = "parallel",
            onQueue: _onQueue, // 전역 게이트 미사용 — 큐 위치 콜백 없음
            preview = "",
            loadAwareBody = null,
            loadAwareRoute = null,
            maxTokensByTier = null,
            onResult = null,
            pendingIds: preRegisteredPendingIds = null,
            ...rest
        } = params;
        const n = Math.min(32, Math.max(1, Math.floor(Number(count) || 1)));
        const serial = String(mode).toLowerCase() === "serial";
        const label = String(preview || "").slice(0, 120);

        // 전역 채팅 슬롯을 잡지 않고 바로 실행 (하위 N건은 백엔드 세마포어로 제어)
        {
            const wall0 = Date.now();
            const { applyLoadAwareRoute } = await import("./loadAwareRoute.js");

            const resolveRoute = () => {
                const base = loadAwareRoute || {
                    tier: rest.preferredTier || "medium",
                    reason: "stress",
                    difficulty: 50,
                    device: rest.preferredDevice || null,
                    skill: rest.preferredSkill || null,
                };
                if (!config.loadAware || !loadAwareRoute) {
                    return {
                        tier: base.tier,
                        reason: base.reason,
                        loadDemoted: false,
                        preferredTier: base.tier,
                    };
                }
                // 호출 시점 슬롯 스냅샷으로 강등 (이전 동시 호출의 inFlight 반영)
                // 스트레스는 용량·분산 검증이 목적 → 난이도 상한을 100 으로 (일반 채팅은 LOAD_DEMOTE_MAX_DIFFICULTY)
                return applyLoadAwareRoute({ ...base }, loadAwareBody || {}, {
                    maxDemoteDifficulty: 100,
                });
            };

            const runOne = async (i) => {
                const t0 = Date.now();
                let row;
                try {
                    const routed = resolveRoute();
                    const tier = routed.tier || rest.preferredTier || "medium";
                    let maxTokens = rest.maxTokens;
                    if (
                        maxTokensByTier &&
                        Number.isFinite(Number(maxTokensByTier[tier]))
                    ) {
                        maxTokens = Number(maxTokensByTier[tier]);
                    } else if (
                        tier !== "large" &&
                        rest.maxTokensSmall != null
                    ) {
                        maxTokens = rest.maxTokensSmall;
                    }
                    const out = await this._chatDispatch({
                        ...rest,
                        preferredTier: tier,
                        maxTokens,
                        preview: label
                            ? `[stress #${i}/${n}] ${label}`
                            : `stress #${i}/${n}`,
                        _kind: "stress",
                    });
                    row = {
                        i,
                        ok: true,
                        ms: Date.now() - t0,
                        tier: out.tier,
                        preferredTier: tier,
                        loadDemoted: Boolean(routed.loadDemoted),
                        loadPromoted: Boolean(routed.loadPromoted),
                        routeReason: routed.reason || null,
                        device: out.device,
                        alias: out.alias || null,
                        backend: out.backendUrl,
                        answerLen: (out.result?.content || "").length,
                        model: out.result?.raw?.model ?? null,
                    };
                } catch (e) {
                    row = {
                        i,
                        ok: false,
                        ms: Date.now() - t0,
                        error: e.message || String(e),
                    };
                }
                if (typeof onResult === "function") {
                    try {
                        onResult(row);
                    } catch (e) {
                        logger.warn(`stress onResult 실패: ${e.message}`);
                    }
                }
                return row;
            };

            logger.info(
                `모델 스트레스 시작: ${n}회 ${serial ? "순차" : "동시"} ` +
                    `(preferred=${rest.preferredTier ?? "auto"}, loadAware=${config.loadAware ? "on" : "off"})`,
            );

            let results;
            if (serial) {
                // 순차 모드는 대기 마커를 쓰지 않으므로 미리 등록분은 즉시 해제
                if (Array.isArray(preRegisteredPendingIds)) {
                    this.releaseStressBatch(preRegisteredPendingIds);
                }
                results = [];
                for (let i = 1; i <= n; i++) results.push(await runOne(i));
            } else {
                // 슬롯 합만큼만 동시에 시작 → 한 건 끝날 때마다 다음 건이
                // resolveRoute 를 다시 봄 (large 비면 다시 large)
                const slotCap = Math.max(1, this.chatMaxInFlight() || 1);
                const concurrency = Math.min(n, slotCap);
                logger.info(
                    `모델 스트레스 동시성 ${concurrency} (슬롯합 ${slotCap}) — 완료 시 재라우팅`,
                );

                // 통계 보드용: 아직 안 쏜 N건을 대기로 등록 (시작 시 해제).
                // 서버가 요청 수신 즉시 미리 등록해 넘겼으면(preRegistered) 그걸
                // 그대로 쓴다 → 라우팅(createPlan) 지연과 무관하게 대기가 바로 뜬다.
                const pendingIds =
                    Array.isArray(preRegisteredPendingIds) &&
                    preRegisteredPendingIds.length === n
                        ? preRegisteredPendingIds
                        : (() => {
                              const ids = [];
                              for (let i = 1; i <= n; i++) {
                                  ids.push(
                                      this._trackStressPending({
                                          i,
                                          preview: label
                                              ? `[대기 #${i}/${n}] ${label}`
                                              : `stress 대기 #${i}/${n}`,
                                      }),
                                  );
                              }
                              return ids;
                          })();

                results = new Array(n);
                let next = 0;
                const worker = async () => {
                    while (true) {
                        const idx = next++;
                        if (idx >= n) return;
                        this._untrackStressPending(pendingIds[idx]);
                        results[idx] = await runOne(idx + 1);
                    }
                };
                try {
                    await Promise.all(
                        Array.from({ length: concurrency }, () => worker()),
                    );
                } finally {
                    for (const id of pendingIds) this._untrackStressPending(id);
                }
            }

            const wallMs = Date.now() - wall0;
            const oks = results.filter((r) => r.ok);
            const fails = results.filter((r) => !r.ok);
            const times = results.map((r) => r.ms).sort((a, b) => a - b);
            const sum = times.reduce((a, b) => a + b, 0);
            const byTier = {};
            let demoted = 0;
            let promoted = 0;
            for (const r of oks) {
                const t = r.tier || "?";
                byTier[t] = (byTier[t] || 0) + 1;
                if (r.loadDemoted) demoted++;
                if (r.loadPromoted) promoted++;
            }
            const summary = {
                ok: oks.length,
                fail: fails.length,
                wallMs,
                minMs: times[0] ?? 0,
                avgMs: times.length ? Math.round(sum / times.length) : 0,
                maxMs: times[times.length - 1] ?? 0,
                byTier,
                loadDemoted: demoted,
                loadPromoted: promoted,
                concurrency: serial
                    ? 1
                    : Math.min(n, Math.max(1, this.chatMaxInFlight() || 1)),
                slotCap: Math.max(1, this.chatMaxInFlight() || 1),
            };
            logger.info(
                `모델 스트레스 완료: 성공 ${summary.ok}/${n} 실패 ${summary.fail} ` +
                    `벽시계 ${wallMs}ms min/avg/max ${summary.minMs}/${summary.avgMs}/${summary.maxMs}ms ` +
                    `티어 ${JSON.stringify(byTier)} demote=${demoted} promote=${promoted}`,
            );
            return {
                count: n,
                mode: serial ? "serial" : "parallel",
                results,
                summary,
            };
        }
    }

    async _chatDispatch(params = {}) {
        const {
            preferredTier = null,
            allowOtherTiers = config.escalateTier,
            preferredDevice = null,
            preferredSkill = null,
            preferFixedRole = null,
            preview = "",
            _kind = "chat",
            ...rest
        } = params;
        const jobId = this._trackModelJob({
            preview,
            kind: _kind,
        });
        const tried = new Set();
        const maxAttempts = Math.max(this.backends.length, 1);
        let lastErr = null;
        let jobOk = false;
        const useFixed =
            Boolean(preferFixedRole) && this.hasActiveRole(preferFixedRole);
        const needVision = messagesHaveImages(rest.messages);

        // 후보 백엔드 선택기(라우팅·failover 반영). 슬롯 세마포어가 이 함수로
        // 빈 슬롯 있는 백엔드를 고르고, 없으면 릴리스될 때까지 대기시킨다.
        const pickBackend = (skip = new Set()) => {
            const excl = this._mergeExclude(tried, skip);
            let b = useFixed ? this.pickFixed(preferFixedRole, excl) : null;
            if (!b) {
                b = this.pick(
                    excl,
                    preferredTier,
                    allowOtherTiers,
                    preferredDevice,
                    preferredSkill,
                    needVision,
                );
            }
            return b;
        };

        try {
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                // 슬롯 세마포어: 빈 슬롯 생길 때까지 대기 후 inFlight++ 된 백엔드 획득.
                // 빈 슬롯이 나면 스트레스(priority 0)보다 대화(10)에 먼저 넘긴다 →
                // 스트레스 백로그에 밀려 "다 끝나야 답 오는" 문제 해소.
                const backend = await this.acquireBackendSlot(pickBackend, {
                    priority:
                        _kind === "stress" ? SLOT_PRI_STRESS : SLOT_PRI_CHAT,
                });
                if (!backend) break;
                tried.add(backend.url);

                this._updateModelJob(jobId, {
                    tier: backend.tier,
                    alias: backend.alias || null,
                    backendUrl: backend.url,
                });

                backend.totalRequests++;
                backend.chatRequests++;
                const started = Date.now();
                try {
                    const fitted = fitMessagesForBackend(
                        rest.messages,
                        backend,
                        rest.maxTokens,
                    );
                    if (fitted.notes?.length) {
                        logger.warn(
                            `프롬프트 맞춤 @ ${backend.alias || backend.url} ctx=${fitted.ctx} est=${fitted.est}/${fitted.budget}: ${fitted.notes.join("; ")}`,
                        );
                    }
                    const result = await chatCompletion({
                        baseUrl: backend.url,
                        ...rest,
                        messages: fitted.messages,
                    });
                    backend.lastLatencyMs = Date.now() - started;
                    backend.totalLatencyMs += backend.lastLatencyMs;
                    recordChat({
                        tier: backend.tier,
                        usage: result.raw?.usage ?? null,
                        ms: backend.lastLatencyMs,
                    });
                    jobOk = true;
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
                    this._emitError("solve", backend, err);
                    if (!err.retryable) throw err;
                    // 연결 실패(backendDown)일 때만 즉시 unhealthy 처리.
                    // 500·타임아웃은 요청/과부하 문제라 페일오버만 하고 상태는
                    // 헬스체크에 맡긴다(부하 중 모델 깜빡임 방지).
                    if (err.backendDown) backend.healthy = false;
                    logger.warn(
                        `백엔드 실패 → 페일오버 시도 (${backend.url}): ${err.message}`,
                    );
                } finally {
                    this.releaseBackendSlot(backend);
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
            throw (
                lastErr ??
                this._missingBackendError(preferredTier, allowOtherTiers)
            );
        } finally {
            this._finishModelJob(jobId, {
                ok: jobOk,
                error: lastErr?.message || null,
            });
        }
    }

    async chatStream(params = {}) {
        const { onQueue, ...rest } = params;
        return this.withChatSlot("chatStream", onQueue, () =>
            this._chatStreamDispatch(rest),
        );
    }

    async _chatStreamDispatch(params = {}) {
        const {
            preferredTier = null,
            allowOtherTiers = config.escalateTier,
            preferredDevice = null,
            preferredSkill = null,
            preferFixedRole = null,
            onToken,
            onMeta,
            preview = "",
            _kind = "chatStream",
            ...rest
        } = params;
        const jobId = this._trackModelJob({
            preview:
                preview ||
                (() => {
                    const msgs = rest.messages || [];
                    for (let i = msgs.length - 1; i >= 0; i--) {
                        const m = msgs[i];
                        if (m?.role !== "user") continue;
                        const c = m.content;
                        if (typeof c === "string") return c.slice(0, 120);
                        if (Array.isArray(c)) {
                            const t = c.find((p) => p?.type === "text")?.text;
                            if (t) return String(t).slice(0, 120);
                        }
                    }
                    return "";
                })(),
            kind: _kind,
        });
        const tried = new Set();
        const maxAttempts = Math.max(this.backends.length, 1);
        let lastErr = null;
        let jobOk = false;
        const useFixed =
            Boolean(preferFixedRole) && this.hasActiveRole(preferFixedRole);
        const needVision = messagesHaveImages(rest.messages);

        // 후보 백엔드 선택기(라우팅·failover 반영). 슬롯 세마포어용.
        const pickBackend = (skip = new Set()) => {
            const excl = this._mergeExclude(tried, skip);
            let b = useFixed ? this.pickFixed(preferFixedRole, excl) : null;
            if (!b) {
                b = this.pick(
                    excl,
                    preferredTier,
                    allowOtherTiers,
                    preferredDevice,
                    preferredSkill,
                    needVision,
                );
            }
            return b;
        };

        try {
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                // 슬롯 세마포어: 빈 슬롯 생길 때까지 대기 후 inFlight++ 된 백엔드 획득.
                // 빈 슬롯이 나면 스트레스(priority 0)보다 대화(10)에 먼저 넘긴다 →
                // 스트레스 백로그에 밀려 "다 끝나야 답 오는" 문제 해소.
                const backend = await this.acquireBackendSlot(pickBackend, {
                    priority:
                        _kind === "stress" ? SLOT_PRI_STRESS : SLOT_PRI_CHAT,
                });
                if (!backend) break;
                tried.add(backend.url);

                this._updateModelJob(jobId, {
                    tier: backend.tier,
                    alias: backend.alias || null,
                    backendUrl: backend.url,
                });

                backend.totalRequests++;
                backend.chatRequests++;
                const started = Date.now();
                let gotToken = false;
                try {
                    const fitted = fitMessagesForBackend(
                        rest.messages,
                        backend,
                        rest.maxTokens,
                    );
                    if (fitted.notes?.length) {
                        logger.warn(
                            `프롬프트 맞춤 @ ${backend.alias || backend.url} ctx=${fitted.ctx} est=${fitted.est}/${fitted.budget}: ${fitted.notes.join("; ")}`,
                        );
                    }
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
                        messages: fitted.messages,
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
                    jobOk = true;
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
                    this._emitError("solve", backend, err);
                    if (gotToken || !err.retryable) throw err;
                    // 연결 실패(backendDown)일 때만 즉시 unhealthy 처리.
                    // 500·타임아웃은 요청/과부하 문제라 페일오버만 하고 상태는
                    // 헬스체크에 맡긴다(부하 중 모델 깜빡임 방지).
                    if (err.backendDown) backend.healthy = false;
                    logger.warn(
                        `스트리밍 백엔드 실패 → 페일오버 시도 (${backend.url}): ${err.message}`,
                    );
                } finally {
                    this.releaseBackendSlot(backend);
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
            throw (
                lastErr ??
                this._missingBackendError(preferredTier, allowOtherTiers, {
                    stream: true,
                })
            );
        } finally {
            this._finishModelJob(jobId, {
                ok: jobOk,
                error: lastErr?.message || null,
            });
        }
    }

    /**
     * 임베딩 역할 백엔드로 벡터 생성.
     * @returns {Promise<{ vectors: number[][], backendUrl: string, model?: string }|null>}
     */
    async embed(input) {
        const texts = Array.isArray(input) ? input : [input];
        if (!texts.length || !this.hasActiveRole("embedding")) return null;
        const hasFree = this.backends.some(
            (b) =>
                b.embeddingEnabled && b.healthy && this._backendHasFreeSlot(b),
        );
        if (!hasFree && this._interactive.size > 0) {
            logger.info(
                "임베딩 생략(실시간 대화 · 슬롯 없음) → 키워드 회상 폴백",
            );
            return null;
        }
        const tried = new Set();
        let lastErr = null;
        for (let i = 0; i < this.backends.length; i++) {
            const backend = await this.acquireBackendSlot(
                (skip = new Set()) =>
                    this.pickFixed(
                        "embedding",
                        this._mergeExclude(tried, skip),
                    ),
                { priority: SLOT_PRI_INFRA },
            );
            if (!backend) break;
            tried.add(backend.url);
            backend.totalRequests++;
            const jobId = this._trackModelJob({
                preview: "임베딩",
                kind: "embed",
                tier: backend.tier,
                alias: backend.alias || null,
                backendUrl: backend.url,
            });
            const started = Date.now();
            let jobOk = false;
            try {
                const out = await createEmbeddings({
                    baseUrl: backend.url,
                    input: texts,
                });
                backend.lastLatencyMs = Date.now() - started;
                backend.totalLatencyMs += backend.lastLatencyMs;
                jobOk = true;
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
                this._emitError("embed", backend, err);
                // --embeddings 미기동 등: 임베딩만 끄고 채팅 health 는 유지
                if (err.notSupported || err.status === 501) {
                    backend.embeddingEnabled = false;
                    logger.warn(
                        `임베딩 미지원 → 해당 백엔드 임베딩 비활성 (${backend.url}): ${err.message}`,
                    );
                    continue;
                }
                if (!err.retryable) break;
                // 연결 실패(backendDown)일 때만 즉시 unhealthy 처리.
                // 500·타임아웃은 요청/과부하 문제라 페일오버만 하고 상태는
                // 헬스체크에 맡긴다(부하 중 모델 깜빡임 방지).
                if (err.backendDown) backend.healthy = false;
                logger.warn(
                    `임베딩 실패 → 페일오버 (${backend.url}): ${err.message}`,
                );
            } finally {
                this.releaseBackendSlot(backend);
                this._finishModelJob(jobId, {
                    ok: jobOk,
                    error: lastErr?.message || null,
                });
            }
        }
        // 임베딩 실패해도 RAG 키워드 검색으로 넘어갈 수 있게 null 반환 (chat health 유지)
        if (lastErr) {
            logger.warn(`임베딩 사용 불가: ${lastErr.message}`);
        }
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
        const snippet = String(text ?? "").slice(
            0,
            config.security.inputMaxChars,
        );
        // 검토 대상은 답변 초안만 (질문·정책 문구를 quote 로 쓰면 허위차단 남발)
        const draftOnly = (() => {
            const m = snippet.match(
                /【최종 직전 답변\(검토 대상\)】\s*([\s\S]*)/,
            );
            return (m ? m[1] : snippet).trim();
        })();
        const tried = new Set();
        let lastErr = null;
        let sawEmptyPolicy = false;

        for (let i = 0; i < this.backends.length; i++) {
            const backend = await this.acquireBackendSlot(
                (skip = new Set()) =>
                    this.pickFixed("security", this._mergeExclude(tried, skip)),
                { priority: SLOT_PRI_INFRA },
            );
            if (!backend) break;
            tried.add(backend.url);
            const policy = String(backend.securityPolicy || "").trim();
            if (!policy) {
                this.releaseBackendSlot(backend);
                sawEmptyPolicy = true;
                continue;
            }
            const system = `You are a narrow security gate. Output ONE JSON object only.
Default is ALLOW. Block ONLY when the DRAFT clearly breaks POLICY.

If allowed:
{"allow":true,"reason":"ok"}

If blocked (rare):
{"allow":false,"reason":"profanity","quote":"씨발"}
("quote" = the exact swear/hate span from DRAFT, 2-24 chars. Never invent.)

ALWAYS allow: summaries, business email, meeting notes, docs, coding, Q&A, greetings.
Do NOT block because of words like 분석/요약/확인/개선.
Do NOT copy placeholder reasons. If unsure → {"allow":true,"reason":"ok"}.
Judge ONLY 【최종 직전 답변(검토 대상)】.

POLICY:
${policy.slice(0, config.security.policyBodyMaxChars)}`;
            backend.totalRequests++;
            backend.securityRequests++;
            const started = Date.now();
            try {
                const result = await chatCompletion({
                    baseUrl: backend.url,
                    messages: [
                        { role: "system", content: system },
                        { role: "user", content: snippet || "(empty)" },
                    ],
                    temperature: 0,
                    maxTokens: config.security.judgeMaxTokens,
                    enableThinking: false,
                });
                backend.lastLatencyMs = Date.now() - started;
                backend.totalLatencyMs += backend.lastLatencyMs;
                const raw = String(result.content || result.reasoning || "");
                const parsed = parseSecurityVerdict(raw, policy, draftOnly);
                if (parsed.ambiguous) {
                    logger.warn(
                        `보안검증 모호 → 허용 @ ${backend.alias || backend.url}: ${String(raw).replace(/\s+/g, " ").slice(0, 120)}`,
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
                this._emitError("security", backend, err);
                if (!err.retryable) break;
                // 연결 실패(backendDown)일 때만 즉시 unhealthy 처리.
                // 500·타임아웃은 요청/과부하 문제라 페일오버만 하고 상태는
                // 헬스체크에 맡긴다(부하 중 모델 깜빡임 방지).
                if (err.backendDown) backend.healthy = false;
            } finally {
                this.releaseBackendSlot(backend);
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
            // 답변 풀 포함 = solve 켜짐. 라우터/설계/보안 겸해도 solve 면 active.
            if (b.roles?.solve ?? b.roles?.chat) {
                t.active++;
            }
        }
        const now = Date.now();
        this.completed = this.completed.filter(
            (t) => now - t < config.poolStatsWindowMs,
        );
        return {
            totalBackends: backends.length,
            healthyBackends: backends.filter((b) => {
                const r = b.roles || {};
                return (
                    b.healthy && (r.solve ?? r.chat) && CHAT_TIERS.has(b.tier)
                );
            }).length,
            totalInFlight: backends.reduce((s, b) => s + b.inFlight, 0),
            totalRequests: backends.reduce((s, b) => s + b.totalRequests, 0),
            totalErrors: backends.reduce((s, b) => s + b.totalErrors, 0),
            requestsLastMin: this.completed.length,
            tiers,
            backends,
            routing: this.getRoutingSummary(),
            queue: this.queueSnapshot(),
            load: this.loadBoard(),
            loadAware: { ...this._loadStats },
            slots: this.slotSnapshot(),
        };
    }

    /**
     * 부하 스냅샷 세션용 원시 누적 카운터.
     * status() 의 파생값(avgLatencyMs 등)이 아니라 delta 계산에 필요한
     * 원시 누적합(totalLatencyMs 포함)을 그대로 노출한다. url 을 키로 매칭.
     */
    loadCounters() {
        return {
            ts: Date.now(),
            backends: this.backends.map((b) => ({
                url: b.url,
                alias: b.alias,
                tier: b.tier,
                device: b.device,
                model: b.model,
                totalRequests: b.totalRequests,
                chatRequests: b.chatRequests,
                routerRequests: b.routerRequests,
                plannerRequests: b.plannerRequests,
                securityRequests: b.securityRequests,
                totalErrors: b.totalErrors,
                totalLatencyMs: b.totalLatencyMs,
                inFlight: b.inFlight,
            })),
            queue: { ...this._queueStats },
            loadAware: { ...this._loadStats },
        };
    }
}

// 부모(serve)는 순수 컨트롤 플레인 — 자기 servers.json 을 풀에 싣지 않는다.
// 모든 백엔드는 하위 관리서버(agent)가 register 할 때 추가된다.
export const pool = new Pool([]);
