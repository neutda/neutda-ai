import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { replyLanguageReminder } from "./replyLanguage.js";
import { toImageUrl } from "./image.js";
import { pool } from "./pool.js";
import { serverUrl } from "./serverUrl.js";
import {
    registerAgent,
    deregisterAgent,
    listAgents,
    getAgent,
    startAgentPolling,
    findAgentByBackendUrl,
    findAgentByServerName,
    soleAgentId,
} from "./agentRegistry.js";
import { chooseRoute } from "./router.js";
import {
    createPlan,
    runWorkflow,
    hasSecurityWorkflow,
    runSecurityPreFinal,
    isBlankAsk,
} from "./workflow.js";
import {
    needsLongPipeline,
    runLongContent,
    chunkText,
    estimateTokens,
    isContextOverflowError,
} from "./longContent.js";
import { appendHistory, readHistory, clearHistory } from "./history.js";
import { selectHistoryTurns, formatHistorySnippet } from "./historyContext.js";
import { getMetrics } from "./metrics.js";
import { logger, getLogs, listLogDates, logDayKey, logFileStats } from "./logger.js";
import { readLlamaLogs } from "./llamaLogs.js";
import { isLocalDef } from "./serverUrl.js";
import * as rag from "./rag.js";
import * as sessionMemory from "./sessionMemory.js";
import * as memoryStore from "./memoryStore.js";
import * as loadSession from "./loadSession.js";
import { describeImageForRag } from "./ragVision.js";
import {
    isRagRequest,
    formatRagContext,
    ragSources as buildRagSources,
    ragSystemAddon,
    loadRagForRequest,
    ragRetrieveQuery,
} from "./ragContext.js";
import { extractText } from "./extract.js";
import { loadStats, getStats } from "./stats.js";
import { parseRouterJson } from "./llmRouter.js";
import {
    loadServerDefs,
    loadModelConfig,
    serverStatus,
    startServer,
    stopServer,
    addServerDef,
    removeServerDef,
    updateServerDef,
    persistFixedRole,
    persistSecurityPolicy,
    sortDefsByPriority,
    estimateVram,
    getGpuFreeMb,
    assertGpuCapacityForUpdate,
    setPendingRestart,
    stripRoleIdFromServers,
    stripSecurityIdFromServers,
    enrichServerWithRoles,
    enrichMetricsWithServers,
} from "./serverManager.js";
import {
    loadRoles,
    createRole,
    updateRole,
    deleteRole,
    resolveServerRoles,
    rolesById,
    loadRolesSync,
} from "./roles.js";
import {
    loadSecurityPolicies,
    loadSecurityConfigSync,
    createSecurityPolicy,
    updateSecurityPolicy,
    deleteSecurityPolicy,
    resolveServerSecurity,
    setSecurityEnabled,
    isSecurityEnabledSync,
} from "./securityPolicies.js";
import { FIXED_ROLES, isFixedRole } from "./fixedRoles.js";
import multer from "multer";

/** 보안 게이트 이벤트 (파이프라인 step 과 분리) */
function securityEventBridge(send) {
    return (ev) => {
        if (ev.type === "security_start" || ev.type === "security_done") {
            send("security", ev);
        } else if (ev.type === "token") {
            send("token", { text: ev.text });
        }
    };
}

/**
 * 최종 답변 보안 게이트. 파이프라인 steps 에 넣지 않는다.
 * @returns {{ answer, traceExtra, allow, skipped }}
 */
async function withSecurityPreFinal(q, draft, opts = {}) {
    if (!hasSecurityWorkflow() || isBlankAsk({ ROLE_USER: q })) {
        return {
            answer: draft,
            traceExtra: [],
            allow: true,
            skipped: true,
        };
    }
    const sec = await runSecurityPreFinal({
        userQ: q,
        draft,
        onEvent: opts.onEvent,
        stepIndex: opts.stepIndex ?? 0,
    });
    return {
        answer: sec.answer,
        traceExtra: sec.stepRec ? [sec.stepRec] : [],
        allow: sec.allow,
        skipped: Boolean(sec.skipped),
    };
}

/** 파이프라인 steps 에서 보안 노드 제외 (배지·통계용) */
function pipelineStepsOnly(steps) {
    return (Array.isArray(steps) ? steps : []).filter(
        (s) => s && s.role !== "security" && s.tier !== "security",
    );
}

/** chat body 에 RAG 검색 결과 부착. strict·0건이면 emptyStrict. */
/** U_ID / S_ID 정규화 (옵션 문자열). 없으면 null → 기억 비활성 */
function memoryIds(body) {
    const rawUid =
        typeof body?.U_ID === "string"
            ? body.U_ID
            : typeof body?.u_id === "string"
              ? body.u_id
              : "";
    const rawSid =
        typeof body?.S_ID === "string"
            ? body.S_ID
            : typeof body?.s_id === "string"
              ? body.s_id
              : "";
    const uid = rawUid.trim();
    const sid = rawSid.trim();
    return { uid: uid || null, sid: sid || null };
}

/** body 에 정규화된 U_ID/S_ID 를 다시 써 둔다 (하위 경로·되쓰기용) */
function normalizeMemoryIds(body) {
    if (!body || typeof body !== "object") return { uid: null, sid: null };
    const { uid, sid } = memoryIds(body);
    if (uid) body.U_ID = uid;
    else {
        delete body.U_ID;
        delete body.u_id;
    }
    if (sid) body.S_ID = sid;
    else {
        delete body.S_ID;
        delete body.s_id;
    }
    return { uid, sid };
}

/** S_ID 있으면 서버 세션 turns 로 HISTORY 교체 (클라이언트 HISTORY 무시) */
function hydrateSessionHistory(body) {
    const { sid } = normalizeMemoryIds(body);
    if (!sid) return;
    body.HISTORY = sessionMemory.get(sid);
}

/** U_ID 있으면 개인 기억 회상 → body._memory (문서 RAG 와 별도) */
async function prepareUserMemory(body) {
    const { uid } = normalizeMemoryIds(body);
    if (!uid) {
        delete body._memory;
        return;
    }
    const q = String(
        typeof body.ROLE_USER === "string"
            ? body.ROLE_USER
            : typeof body.q === "string"
              ? body.q
              : "",
    ).trim();
    const hits = q ? await memoryStore.recall(uid, q, 4) : [];
    const context = memoryStore.formatMemoryContext(hits);
    body._memory = { hits, context };
    if (hits.length) {
        logger.info(`개인기억 회상 U_ID=${uid} → ${hits.length}건`);
    }
}

/** 채팅 진입: ID 정규화 + 세션 hydrate + 개인 회상 */
async function prepareChatMemory(body) {
    normalizeMemoryIds(body);
    hydrateSessionHistory(body);
    await prepareUserMemory(body);
}

/**
 * 답변 완료 후 단기/장기 되쓰기.
 * appendHistory(감사로그) 와 별개 — 그 옆에서 호출.
 * 장기: 사용자 발화만 저장(모델 답변 노이즈 제외). 증류는 Phase 3 후속.
 */
async function persistChatMemory(body, question, answer) {
    const { uid, sid } = memoryIds(body);
    const q = String(question ?? "").trim();
    const a = String(answer ?? "");
    if (!q && !a) return;
    if (sid) {
        if (q) sessionMemory.append(sid, { role: "user", content: q });
        if (a) sessionMemory.append(sid, { role: "assistant", content: a });
    }
    if (uid && q && shouldRememberUserUtterance(q)) {
        try {
            await memoryStore.remember(uid, q, { source: "user" });
        } catch (e) {
            logger.error(`개인기억 저장 실패: ${e.message}`);
        }
    }
}

/** 인사·단답 등 장기기억 가치가 낮은 발화는 skip */
function shouldRememberUserUtterance(text) {
    const t = String(text || "").trim();
    if (t.length < 4) return false;
    // 순수 인사/감사만이면 저장하지 않음
    if (
        /^(안녕|안녕하세요|하이|헬로|hello|hi|ㅎㅎ+|ㅋ+|네|아니요|ㅇㅇ|ㄱㅅ|고마워|감사)[\s!.~]*$/i.test(
            t,
        )
    ) {
        return false;
    }
    return true;
}

async function prepareChatRag(body, { onStatus } = {}) {
    if (!isRagRequest(body)) return { active: false };
    onStatus?.({ phase: "retrieve", message: "문서 검색 중…" });
    const pack = await loadRagForRequest(body);
    body._rag = {
        hits: pack.hits,
        context: pack.context,
        sources: pack.sources,
        strict: pack.strict,
        topK: pack.topK,
    };
                logger.info(
                    `RAG(chat) 검색 → ${pack.hits.length}건 strict=${pack.strict}` +
                        (pack.reused ? " (재사용)" : "") +
                        (pack.retrieveQuery &&
                        pack.retrieveQuery !==
                            (typeof body.ROLE_USER === "string"
                                ? body.ROLE_USER
                                : "")
                            ? ` q="…${String(pack.retrieveQuery).slice(-60)}"`
                            : ""),
                );
    return {
        active: true,
        emptyStrict: Boolean(pack.emptyStrict),
        pack,
        answer: pack.emptyStrict ? "문서 내용에 없습니다." : null,
    };
}

function ragResponseFields(body, extra = {}) {
    if (!body?._rag && !extra.sources) return {};
    return {
        rag: true,
        strict: extra.strict ?? body?._rag?.strict,
        sources: extra.sources ?? body?._rag?.sources ?? [],
    };
}

/** 서버 정의 → 풀 역할 반영 */
function syncPoolRoles(def) {
    const resolved = resolveServerRoles(def, rolesById(loadRolesSync()));
    const url = serverUrl(def);
    pool.setRoleAssignment(url, {
        roleIds: resolved.roleIds,
        customSkills: resolved.customSkills,
        commonSkills: resolved.commonSkills,
        skills: resolved.skills,
    });
    return enrichServerWithRoles(def);
}

/** roles.json 변경 후 전체 서버 풀 재동기화 */
async function resyncAllPoolRoles() {
    const defs = await loadServerDefs();
    const map = rolesById(loadRolesSync());
    for (const def of defs) {
        const resolved = resolveServerRoles(def, map);
        const url = serverUrl(def);
        pool.setRoleAssignment(url, {
            roleIds: resolved.roleIds,
            customSkills: resolved.customSkills,
            commonSkills: resolved.commonSkills,
            skills: resolved.skills,
        });
    }
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024 },
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 외부 API 비동기 결과 JSON 저장 폴더 (정적 제공: /results/<id>.json)
const RESULTS_DIR = path.join(__dirname, "..", "public", "results");
fs.mkdir(RESULTS_DIR, { recursive: true }).catch(() => {});

async function writeResult(id, data) {
    await fs.writeFile(
        path.join(RESULTS_DIR, `${id}.json`),
        JSON.stringify(data, null, 2),
        "utf-8",
    );
}

const app = express();
app.use(express.json({ limit: "25mb" }));
// 첫 화면(루트)은 서버 모니터링으로. 테스트 콘솔은 /index.html 로 접근.
app.get("/", (_req, res) => res.redirect(302, "/monitor.html"));
app.use(
    express.static(path.join(__dirname, "..", "public"), {
        etag: false,
        lastModified: false,
        cacheControl: false,
        maxAge: 0,
    }),
);

// ===== 부하 스냅샷 세션 설정 잠금 ====================================
// recording 중에는 모델/서버/역할/보안 "변경" API 를 전부 409 로 막는다.
// 세션 = 튜닝 로그이므로 측정 구간 내내 설정이 불변이어야 delta 가 유효.
// 읽기(GET)·채팅·스냅샷 stop 은 대상 아님. 오직 설정을 바꾸는 쓰기만.
// (설계: docs/부하-스냅샷-세션.md §2)
const CONFIG_LOCK_RULES = [
    ["POST", /^\/api\/servers$/],
    ["PATCH", /^\/api\/servers\/[^/]+$/],
    ["DELETE", /^\/api\/servers\/[^/]+$/],
    ["POST", /^\/api\/servers\/[^/]+\/(start|stop)$/],
    ["POST", /^\/api\/backends\/(role|security-policy)$/],
    ["PUT", /^\/api\/security\/enabled$/],
    ["POST", /^\/api\/roles$/],
    ["PATCH", /^\/api\/roles\/[^/]+$/],
    ["DELETE", /^\/api\/roles\/[^/]+$/],
    ["POST", /^\/api\/security-policies$/],
    ["PATCH", /^\/api\/security-policies\/[^/]+$/],
    ["DELETE", /^\/api\/security-policies\/[^/]+$/],
    ["POST", /^\/api\/agents\/[^/]+\/restart$/],
    ["POST", /^\/api\/agents\/[^/]+\/servers$/],
    [
        "POST",
        /^\/api\/agents\/[^/]+\/servers\/[^/]+\/(start|stop|restart|role|security-policy)$/,
    ],
    ["PATCH", /^\/api\/agents\/[^/]+\/servers\/[^/]+$/],
    ["DELETE", /^\/api\/agents\/[^/]+\/servers\/[^/]+$/],
];
app.use((req, res, next) => {
    const sess = loadSession.active();
    if (!sess) return next();
    const p = req.path;
    const locked = CONFIG_LOCK_RULES.some(
        ([m, re]) => m === req.method && re.test(p),
    );
    if (!locked) return next();
    return res.status(409).json({
        error: "session-locked",
        sessionId: sess.id,
        message:
            "부하 스냅샷 세션 진행 중에는 설정을 변경할 수 없습니다. 세션을 종료한 뒤 변경하세요.",
    });
});

/**
 * 요청 body -> OpenAI 형식 messages 로 변환한다.
 *
 * 입력(flat):
 * {
 *   "ROLE_SYSTEM": "시스템 지시문",      // optional
 *   "ROLE_USER": "사용자 질문",          // required
 *   "TEMPERATURE": 0.7,                   // optional
 *   "content": "이미지 URL/경로/dataURI", // optional (단일 또는 배열)
 *   "HISTORY": [{ role, content }]        // optional (이전 대화 기억용)
 *   "U_ID": "user-id"                     // optional (장기 개인기억)
 *   "S_ID": "session-id"                  // optional (단기 세션기억)
 * }
 */
async function buildMessages(body, promptCharBudget = Infinity) {
    const system = body.ROLE_SYSTEM;
    const user = body.ROLE_USER;
    const content = body.content;
    const history = Array.isArray(body.HISTORY) ? body.HISTORY : [];
    const memoryCtx =
        typeof body?._memory?.context === "string" ? body._memory.context : "";

    if (typeof user !== "string" || user.trim() === "") {
        throw new Error(
            '"ROLE_USER" 는 필수이며 비어있지 않은 문자열이어야 합니다.',
        );
    }

    const messages = [];
    const sysText =
        typeof system === "string" && system.trim() !== "" ? system : "";
    const sysParts = [];
    if (sysText) sysParts.push(sysText);
    if (config.assistantIdentity) sysParts.push(config.assistantIdentity);
    if (config.enforceLanguage) sysParts.push(config.langDirective);
    sysParts.push(
        "Never repeat or paraphrase the user's message as your entire reply. " +
            "Respond as a helpful chat assistant with an original reply in the user's language.",
    );
    if (Array.isArray(history) && history.length > 0) {
        sysParts.push(
            "Prior conversation turns are included in this request. " +
                "Use them as context. Do NOT say you cannot remember previous messages or ask the user to paste them again.",
        );
    }
    if (memoryCtx) {
        sysParts.push(
            "The following '개인 기억' block contains facts recalled about this user from past sessions. " +
                "Use them when relevant. Do not invent memories that are not listed.",
        );
        sysParts.push(memoryCtx);
    }
    if (sysParts.length) {
        messages.push({ role: "system", content: sysParts.join("\n\n") });
    }

    // 이전 대화: 긴 턴은 truncate 해서라도 넣고, break로 통째 버리지 않음
    const histBudget = Math.max(
        0,
        Math.min(
            promptCharBudget - sysText.length - user.length,
            Math.floor(promptCharBudget * 0.55),
        ),
    );
    const { turns: kept } = selectHistoryTurns(history, histBudget, {
        perTurnMax: 800,
        maxTurns: 12,
    });
    for (const turn of kept) {
        messages.push({ role: turn.role, content: turn.content });
    }

    // 약한 모델(0.5B/3B)은 시스템 지시만으론 언어가 흔들리므로,
    // 질문이 한국어면 사용자 메시지 끝에 한국어 강제 문구를 덧붙인다(생성 직전 recency).
    const userText =
        user +
        koreanReminder(user) +
        "\n\n(Do not copy or repeat the user's text. Give your own helpful reply.)";

    const hasImage =
        content !== undefined && content !== null && content !== "";
    if (hasImage) {
        const images = Array.isArray(content) ? content : [content];
        const parts = [{ type: "text", text: userText }];
        for (const img of images) {
            parts.push({
                type: "image_url",
                image_url: { url: await toImageUrl(img) },
            });
        }
        messages.push({ role: "user", content: parts });
    } else {
        messages.push({ role: "user", content: userText });
    }

    return messages;
}

/** 사용자 발화를 그대로/거의 그대로 따라친 답인지 */
function isNearEcho(userQ, answer) {
    const norm = (s) =>
        String(s ?? "")
            .normalize("NFC")
            .replace(/\s+/g, "")
            .replace(/[.?？!！~…。．，,“”"'‘’·\-_]/g, "")
            .toLowerCase();
    const u = norm(userQ);
    const a = norm(answer);
    if (u.length < 2 || a.length < 2) return false;
    if (a === u) return true;
    // 길이가 비슷할 때만 포함 관계로 에코 판정 (인사가 길어지는 정상 답은 제외)
    const similarLen =
        Math.abs(a.length - u.length) <= Math.max(4, Math.floor(u.length * 0.35));
    if (!similarLen) return false;
    if (u.length >= 4 && a.includes(u)) return true;
    if (a.length >= 4 && u.includes(a)) return true;
    return false;
}

/**
 * 에코면 medium 으로 1회 재생성.
 */
async function chatWithEchoGuard({
    body,
    messages,
    temperature,
    maxTokens,
    enableThinking,
    preferredTier,
    preferredDevice,
    preferredSkill,
    allowOtherTiers,
    onMeta,
}) {
    const tier = preferredTier;

    const run = (msgs, t) =>
        pool.chat({
            messages: msgs,
            temperature,
            maxTokens,
            enableThinking,
            preferredTier: t,
            preferredDevice,
            preferredSkill: t === preferredTier ? preferredSkill : null,
            allowOtherTiers,
            onMeta,
            preview:
                typeof body?.ROLE_USER === "string"
                    ? body.ROLE_USER.slice(0, 120)
                    : "",
        });

    let out = await run(messages, tier);
    const q = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
    if (isNearEcho(q, out.result?.content) && tier !== "large") {
        logger.warn(
            `에코 감지 → medium 재시도: "${String(out.result.content).slice(0, 40)}"`,
        );
        const retryMessages = [
            {
                role: "system",
                content:
                    "CRITICAL: Do not echo the user. Give an original helpful reply in the same language.",
            },
            ...messages,
        ];
        const retry = await run(retryMessages, "medium");
        if (!isNearEcho(q, retry.result?.content)) {
            return {
                content: retry.result.content,
                reasoning: retry.result.reasoning,
                tier: retry.tier,
                device: retry.device,
                alias: retry.alias,
                backendUrl: retry.backendUrl,
                model: retry.model,
                usage: retry.result.usage,
                ttftMs: retry.result.ttftMs,
                echoed: true,
            };
        }
        out = retry;
    }

    return {
        content: out.result.content,
        reasoning: out.result.reasoning,
        tier: out.tier,
        device: out.device,
        alias: out.alias,
        backendUrl: out.backendUrl,
        model: out.model,
        usage: out.result.usage,
        ttftMs: out.result.ttftMs,
        echoed: false,
    };
}

// 한국어 질문이면 답변 언어를 못박는 짧은 리마인더 (약한 모델의 중국어 드리프트 방지)
function koreanReminder(text) {
    return replyLanguageReminder(text);
}

app.get("/health", (_req, res) => {
    const s = pool.status();
    res.json({
        status: "ok",
        healthyBackends: s.healthyBackends,
        totalBackends: s.totalBackends,
    });
});

// 풀/백엔드 모니터링 상태
app.get("/api/status", (_req, res) => {
    res.json({
        osMode: config.osMode,
        ...pool.status(),
        routing: {
            ...pool.getRoutingSummary(),
            configMode: config.routingMode,
        },
        stats: getStats(),
    });
});

// 티어 라우팅 절감 통계
app.get("/api/stats", (_req, res) => {
    res.json(getStats());
});

// ===== 부하 스냅샷 세션 (튜닝 계측) =================================
// 설계: docs/부하-스냅샷-세션.md — Phase 0(delta + 설정 잠금)
app.post("/api/loadsession/start", async (req, res) => {
    try {
        const out = await loadSession.start({
            label: req.body?.label,
            note: req.body?.note,
            force: req.body?.force === true || req.query?.force === "1",
        });
        res.status(201).json(out);
    } catch (err) {
        const status = err.code === "session-active" ? 409 : 500;
        res.status(status).json({ error: err.message, code: err.code, activeId: err.activeId });
    }
});

app.post("/api/loadsession/stop", async (_req, res) => {
    try {
        const report = await loadSession.stop();
        res.json(report);
    } catch (err) {
        const status = err.code === "no-active-session" ? 409 : 500;
        res.status(status).json({ error: err.message, code: err.code });
    }
});

app.get("/api/loadsession/active", (_req, res) => {
    res.json(loadSession.active());
});

app.get("/api/loadsession", async (_req, res) => {
    res.json(await loadSession.list());
});

app.get("/api/loadsession/:id", async (req, res) => {
    const s = await loadSession.get(req.params.id);
    if (!s) return res.status(404).json({ error: "세션을 찾을 수 없습니다." });
    res.json(s);
});

app.delete("/api/loadsession/:id", async (req, res) => {
    try {
        const out = await loadSession.remove(req.params.id);
        if (!out.ok) return res.status(404).json({ error: "세션을 찾을 수 없습니다." });
        res.json(out);
    } catch (err) {
        const status = err.code === "session-active" ? 409 : 500;
        res.status(status).json({ error: err.message, code: err.code });
    }
});

// ===== 하위 관리서버(agent) =========================================

// 하위 관리서버 등록/재등록(하트비트). host + 관리 중인 llama 서버 목록 수신.
app.post("/api/agents/register", (req, res) => {
    try {
        const out = registerAgent({
            id: req.body?.id,
            agentUrl: req.body?.agentUrl,
            host: req.body?.host,
            servers: req.body?.servers,
        });
        res.json(out);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// 하위 관리서버 등록 해제(정상 종료) → 관리하던 백엔드도 풀에서 제거
app.delete("/api/agents/:id", (req, res) => {
    const ok = deregisterAgent(req.params.id);
    if (!ok) return res.status(404).json({ error: "등록된 agent 가 아닙니다." });
    res.json({ ok: true, removed: req.params.id });
});

// 등록된 하위 관리서버 목록 + 상태 + 최근 메트릭
app.get("/api/agents", (_req, res) => {
    res.json({ agents: listAgents() });
});

/**
 * 부모 → 특정 agent 로 제어 명령 위임(프록시).
 * agent 는 자기 머신의 llama 프로세스/파일을 제어한 뒤 결과를 돌려준다.
 * 서버 목록이 바뀌는 명령(추가/삭제)은 agent 가 곧바로 부모에 재등록해 풀을 갱신한다.
 */
async function proxyToAgent(id, method, subPath, body) {
    const agent = getAgent(id);
    if (!agent) {
        return { status: 404, json: { error: `등록된 agent 가 아닙니다: ${id}` } };
    }
    const ctrl = new AbortController();
    // 제어 명령은 모델 로딩·재시작을 포함할 수 있어 폴링보다 넉넉히
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
        const res = await fetch(`${agent.agentUrl}${subPath}`, {
            method,
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: ctrl.signal,
        });
        const text = await res.text();
        let json;
        try {
            json = text ? JSON.parse(text) : {};
        } catch {
            json = { raw: text };
        }
        return { status: res.status, json };
    } catch (err) {
        return {
            status: 502,
            json: { error: `agent(${id}) 연결 실패: ${err.message}` },
        };
    } finally {
        clearTimeout(timer);
    }
}

function sendProxy(res, out) {
    res.status(out.status).json(out.json);
}

// agent 자체 재시작
app.post("/api/agents/:id/restart", async (req, res) => {
    logger.warn(`하위 관리서버 재시작 요청 ↻ ${req.params.id}`);
    sendProxy(res, await proxyToAgent(req.params.id, "POST", "/agent/restart"));
});

// agent 의 모델 카탈로그 (add 폼용)
app.get("/api/agents/:id/modelconfig", async (req, res) => {
    sendProxy(res, await proxyToAgent(req.params.id, "GET", "/agent/modelconfig"));
});

// agent 의 관리 llama 서버 목록 + 실행 상태
app.get("/api/agents/:id/servers", async (req, res) => {
    sendProxy(res, await proxyToAgent(req.params.id, "GET", "/agent/servers"));
});

// agent 머신 기준 VRAM 추정 (배치 판단)
app.post("/api/agents/:id/servers/estimate-vram", async (req, res) => {
    sendProxy(
        res,
        await proxyToAgent(req.params.id, "POST", "/agent/servers/estimate-vram", req.body),
    );
});

// agent 에 llama 서버 추가
app.post("/api/agents/:id/servers", async (req, res) => {
    logger.info(`하위 관리서버 llama 추가 요청 ➕ ${req.params.id} [${req.body?.tier}]`);
    sendProxy(res, await proxyToAgent(req.params.id, "POST", "/agent/servers", req.body));
});

// agent 의 특정 llama 서버 기동
app.post("/api/agents/:id/servers/:name/start", async (req, res) => {
    sendProxy(
        res,
        await proxyToAgent(req.params.id, "POST", `/agent/servers/${encodeURIComponent(req.params.name)}/start`),
    );
});

// agent 의 특정 llama 서버 종료
app.post("/api/agents/:id/servers/:name/stop", async (req, res) => {
    sendProxy(
        res,
        await proxyToAgent(req.params.id, "POST", `/agent/servers/${encodeURIComponent(req.params.name)}/stop`),
    );
});

// agent 의 특정 llama 서버 재시작
app.post("/api/agents/:id/servers/:name/restart", async (req, res) => {
    logger.info(`하위 관리서버 llama 재시작 요청 ↻ ${req.params.id}/${req.params.name}`);
    sendProxy(
        res,
        await proxyToAgent(req.params.id, "POST", `/agent/servers/${encodeURIComponent(req.params.name)}/restart`),
    );
});

// agent 의 특정 llama 서버 삭제
app.delete("/api/agents/:id/servers/:name", async (req, res) => {
    sendProxy(
        res,
        await proxyToAgent(req.params.id, "DELETE", `/agent/servers/${encodeURIComponent(req.params.name)}`),
    );
});

// agent 의 특정 llama 서버 역할 변경 (공통역할·커스텀·보안·별칭)
app.patch("/api/agents/:id/servers/:name", async (req, res) => {
    sendProxy(
        res,
        await proxyToAgent(req.params.id, "PATCH", `/agent/servers/${encodeURIComponent(req.params.name)}`, req.body),
    );
});

// agent 의 특정 llama 서버 고정 역할 토글
app.post("/api/agents/:id/servers/:name/role", async (req, res) => {
    sendProxy(
        res,
        await proxyToAgent(req.params.id, "POST", `/agent/servers/${encodeURIComponent(req.params.name)}/role`, req.body),
    );
});

// agent 의 특정 llama 서버 보안 정책 텍스트 저장
app.post("/api/agents/:id/servers/:name/security-policy", async (req, res) => {
    sendProxy(
        res,
        await proxyToAgent(req.params.id, "POST", `/agent/servers/${encodeURIComponent(req.params.name)}/security-policy`, req.body),
    );
});

// ===== 파이프라인(멀티모델 워크플로우) ================================

const TIERS = ["small", "medium", "large"];

/** 긴 입력 맵리듀스 실행인지 (일반 파이프라인과 구분) */
function isLongRun(entry) {
    return String(entry?.routeReason ?? "").startsWith("긴 입력");
}

function planRouterMeta(plan) {
    return {
        backend: plan.routerBackend || null,
        tier: plan.routerTier || null,
        alias: plan.routerAlias || null,
        device: plan.routerDevice || null,
        model: plan.routerModel || null,
    };
}

function planPlannerMeta(plan) {
    return {
        role: plan.plannerRole || null,
        backend: plan.plannerBackend || null,
        tier: plan.plannerTier || null,
        alias: plan.plannerAlias || null,
        device: plan.plannerDevice || null,
        model: plan.plannerModel || null,
    };
}

/**
 * 답변을 생성하지 않고 라우터 분류 + 파이프라인 설계만 확인한다.
 */
app.post("/api/workflow/plan", async (req, res) => {
    const q = typeof req.body?.ROLE_USER === "string" ? req.body.ROLE_USER : "";
    if (!q.trim()) {
        return res.status(400).json({ error: "ROLE_USER(질문)을 입력하세요." });
    }
    const body = {
        ROLE_USER: q,
        ROLE_SYSTEM:
            typeof req.body?.ROLE_SYSTEM === "string" ? req.body.ROLE_SYSTEM : "",
        THINKING: req.body?.THINKING === true,
    };
    const wanted = String(req.body?.WORKFLOW ?? "").toLowerCase();
    if (wanted === "on" || wanted === "off") body.WORKFLOW = wanted;
    const tier = String(req.body?.MODEL_TIER ?? "").toLowerCase();
    if (TIERS.includes(tier)) body.MODEL_TIER = tier;

    const base = {
        requestedMode: wanted || "auto(config)",
        configMode: config.workflowMode,
        routerActive: pool.hasActiveRouter(),
        plannerActive: pool.hasActivePlanner(),
        inputChars: q.length + body.ROLE_SYSTEM.length,
        skillOptions: pool.skillOptions(),
    };

    // 실제 요청은 createPlan 앞에서 긴 입력 파이프라인으로 갈라진다 — 미리보기도 동일하게.
    if (needsLongPipeline(body)) {
        const chunks = chunkText(q);
        const steps = [
            ...chunks.map((_, i) => ({
                tier: config.longMapTier,
                role: "extract",
                instruction: `조각 ${i + 1}/${chunks.length} 핵심 추출`,
            })),
            {
                tier: config.longReduceTier,
                role: "synthesize",
                instruction: "부분 결과 종합 → 최종 답",
            },
        ];
        return res.json({
            ...base,
            ms: 0,
            pipeline: "long",
            mode: "workflow",
            tier: config.longReduceTier,
            difficulty: 100,
            reason: `긴 입력 ${base.inputChars}자/~${estimateTokens(q)}tok (한도 ${config.longTriggerChars}자/${config.longTriggerTokens}tok) → ${chunks.length}청크 맵리듀스`,
            router: null,
            long: {
                chunks: chunks.length,
                chunkChars: config.longChunkChars,
                overlap: config.longChunkOverlap,
                mapTier: config.longMapTier,
                reduceTier: config.longReduceTier,
                mapConcurrency: config.longMapConcurrency,
            },
            steps,
        });
    }

    const started = Date.now();
    try {
        const plan = await createPlan(body);
        res.json({
            ...base,
            ms: Date.now() - started,
            pipeline: plan.mode === "workflow" ? "workflow" : "direct",
            mode: plan.mode,
            tier: plan.tier,
            skill: plan.skill ?? null,
            difficulty: plan.difficulty,
            device: plan.device,
            deviceReason: plan.deviceReason,
            reason: plan.reason,
            router: planRouterMeta(plan),
            planner: planPlannerMeta(plan),
            steps: plan.steps ?? [],
        });
    } catch (err) {
        logger.warn(`플랜 미리보기 실패: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/** 평균값 계산용 누산기 */
function bucket(map, key) {
    let b = map.get(key);
    if (!b) {
        b = { key, runs: 0, steps: 0, totalMs: 0, skipped: 0 };
        map.set(key, b);
    }
    return b;
}

function avg(b) {
    return b.steps ? Math.round(b.totalMs / b.steps) : null;
}

/**
 * 티어 흐름 라벨. 긴 입력은 같은 티어가 수십 번 반복되므로 연속 구간을 접는다.
 * ["medium" x62, "large"] → "medium ×62 → large"
 */
function flowLabel(steps) {
    const out = [];
    for (const s of steps) {
        const tier = s?.tier || "?";
        const last = out[out.length - 1];
        if (last?.tier === tier) last.n++;
        else out.push({ tier, n: 1 });
    }
    return out.map((g) => (g.n > 1 ? `${g.tier} ×${g.n}` : g.tier)).join(" → ");
}

function meanOf(runs, pick) {
    if (!runs.length) return null;
    return runs.reduce((a, r) => a + pick(r), 0) / runs.length;
}

/**
 * history.jsonl 의 파이프라인 실행을 집계한다.
 * 단계별 지연은 workflowSteps[].ms 기준 (direct 실행은 소요시간을 저장하지 않아 건수만 비교).
 * 단계 순번·흐름 통계는 긴 입력 맵리듀스(청크 수만큼 단계가 늘어남)와 분리해 계산한다.
 */
function summarizeWorkflowRuns(items) {
    const byIndex = new Map();
    const byTier = new Map();
    const byRole = new Map();
    const flows = new Map();
    const runs = [];
    let direct = 0;

    for (const it of items) {
        const steps = Array.isArray(it.workflowSteps) ? it.workflowSteps : null;
        if (it.mode !== "workflow" || !steps?.length) {
            direct++;
            continue;
        }
        const longRun = isLongRun(it);

        let totalMs = 0;
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            const ms = Number(s?.ms) || 0;
            totalMs += ms;
            const targets = [
                bucket(byTier, s?.tier || "unknown"),
                bucket(byRole, s?.role || "step"),
            ];
            // 순번별 지연은 일반 파이프라인만 (긴 입력의 순번 = 청크 번호)
            if (!longRun) targets.push(bucket(byIndex, i + 1));
            for (const b of targets) {
                b.steps++;
                b.totalMs += ms;
                if (ms === 0) b.skipped++;
            }
        }

        const flow = flowLabel(steps);
        if (!longRun) {
            const f = bucket(flows, flow);
            f.runs++;
            f.totalMs += totalMs;
            f.steps += steps.length;
        }

        runs.push({
            id: it.id,
            ts: it.ts,
            kind: longRun ? "long" : "workflow",
            question: String(it.user ?? "").slice(0, 120),
            questionChars: String(it.user ?? "").length,
            flow,
            stepCount: steps.length,
            totalMs,
            difficulty: it.difficulty ?? null,
            routerAlias: it.routerAlias || it.routerTier || null,
            reason: it.routeReason || null,
        });
    }

    const wf = runs.filter((r) => r.kind === "workflow");
    const lg = runs.filter((r) => r.kind === "long");
    const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
    const roundMs = (n) => (n == null ? null : Math.round(n));

    return {
        window: {
            entries: items.length,
            since: items[0]?.ts ?? null,
            until: items[items.length - 1]?.ts ?? null,
        },
        counts: {
            direct,
            workflow: wf.length,
            long: lg.length,
            pipelineRuns: runs.length,
            pipelinePct:
                direct + runs.length > 0
                    ? Math.round((runs.length / (direct + runs.length)) * 100)
                    : null,
        },
        averages: {
            workflow: {
                steps: round1(meanOf(wf, (r) => r.stepCount)),
                totalMs: roundMs(meanOf(wf, (r) => r.totalMs)),
            },
            long: {
                steps: round1(meanOf(lg, (r) => r.stepCount)),
                totalMs: roundMs(meanOf(lg, (r) => r.totalMs)),
            },
        },
        byIndex: [...byIndex.values()]
            .map((b) => ({ ...b, avgMs: avg(b) }))
            .sort((a, b) => a.key - b.key),
        byTier: TIERS.map((t) => {
            const b = byTier.get(t) ?? {
                key: t,
                runs: 0,
                steps: 0,
                totalMs: 0,
                skipped: 0,
            };
            return { ...b, avgMs: avg(b) };
        }),
        byRole: [...byRole.values()]
            .map((b) => ({ ...b, avgMs: avg(b) }))
            .sort((a, b) => b.steps - a.steps),
        flows: [...flows.values()]
            .map((b) => ({
                flow: b.key,
                runs: b.runs,
                avgMs: b.runs ? Math.round(b.totalMs / b.runs) : null,
            }))
            .sort((a, b) => b.runs - a.runs)
            .slice(0, 8),
        runs: runs.reverse(),
    };
}

// 파이프라인 실행 통계 (history.jsonl 집계)
app.get("/api/workflow/stats", async (req, res) => {
    try {
        const limit = Number(req.query.limit);
        const items = await readHistory(
            Number.isFinite(limit) && limit > 0 ? limit : 300,
        );
        res.json({
            configMode: config.workflowMode,
            routerActive: pool.hasActiveRouter(),
            ...summarizeWorkflowRuns(items),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 파이프라인 실행 1건 상세 (라우터 계획 + 단계별 입출력)
app.get("/api/workflow/runs/:id", async (req, res) => {
    try {
        const items = await readHistory();
        const it = items.find((x) => x.id === req.params.id);
        if (!it) return res.status(404).json({ error: "실행 기록이 없습니다." });
        res.json({
            id: it.id,
            ts: it.ts,
            kind: isLongRun(it) ? "long" : "workflow",
            mode: it.mode,
            question: it.user ?? "",
            system: it.system ?? "",
            answer: it.answer ?? "",
            difficulty: it.difficulty ?? null,
            reason: it.routeReason ?? null,
            router: {
                backend: it.routerBackend ?? null,
                tier: it.routerTier ?? null,
                alias: it.routerAlias ?? null,
                device: it.routerDevice ?? null,
                model: it.routerModel ?? null,
            },
            trace: Array.isArray(it.workflowTrace) ? it.workflowTrace : [],
            steps: Array.isArray(it.workflowSteps) ? it.workflowSteps : [],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== 공통 역할 카탈로그 (roles.json) ================================

app.get("/api/roles", async (_req, res) => {
    try {
        const roles = await loadRoles();
        res.json({ roles });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/roles", async (req, res) => {
    try {
        const role = await createRole({
            name: req.body?.name,
            description: req.body?.description,
        });
        logger.info(`공통 역할 추가 ＋ "${role.name}" (${role.id})`);
        res.json({ ok: true, role });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.patch("/api/roles/:id", async (req, res) => {
    try {
        const patch = {};
        const has = (k) =>
            Object.prototype.hasOwnProperty.call(req.body ?? {}, k);
        if (has("name")) patch.name = req.body.name;
        if (has("description")) patch.description = req.body.description;
        if (!Object.keys(patch).length) {
            return res
                .status(400)
                .json({ error: "수정할 필드가 없습니다. (name, description)" });
        }
        const role = await updateRole(req.params.id, patch);
        if (!role) {
            return res.status(404).json({ error: "역할을 찾을 수 없습니다." });
        }
        await resyncAllPoolRoles();
        logger.info(`공통 역할 수정 ✎ "${role.name}" (${role.id})`);
        res.json({ ok: true, role });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete("/api/roles/:id", async (req, res) => {
    try {
        const ok = await deleteRole(req.params.id);
        if (!ok) {
            return res.status(404).json({ error: "역할을 찾을 수 없습니다." });
        }
        await stripRoleIdFromServers(req.params.id);
        await resyncAllPoolRoles();
        logger.info(`공통 역할 삭제 － ${req.params.id}`);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== 보안 정책 카탈로그 (security.json) ==============================

async function resyncAllPoolSecurity() {
    const defs = await loadServerDefs();
    for (const def of defs) {
        const url = serverUrl(def);
        const sec = resolveServerSecurity(def);
        pool.setSecurityAssignment(url, {
            securityIds: sec.securityIds,
            securityPolicy: sec.securityPolicyText,
        });
        if (def.security === true) {
            pool.setRoleEnabled(url, "security", true);
        }
    }
}

app.get("/api/security-policies", async (_req, res) => {
    try {
        const cfg = loadSecurityConfigSync();
        res.json({
            enabled: cfg.enabled,
            policies: cfg.policies,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** 보안검증 전역 ON/OFF (정책·모델 배정은 유지, 게이트만 끔) */
app.put("/api/security/enabled", async (req, res) => {
    try {
        const raw = req.body?.enabled;
        if (typeof raw !== "boolean") {
            return res
                .status(400)
                .json({ error: "enabled (boolean) 이 필요합니다." });
        }
        const enabled = await setSecurityEnabled(raw);
        logger.info(`보안검증 전역 ${enabled ? "ON" : "OFF"}`);
        res.json({ ok: true, enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/security/enabled", (_req, res) => {
    res.json({ enabled: isSecurityEnabledSync() });
});

app.post("/api/security-policies", async (req, res) => {
    try {
        const policy = await createSecurityPolicy({
            name: req.body?.name,
            description: req.body?.description,
            body: req.body?.body ?? req.body?.policy,
        });
        logger.info(`보안 정책 추가 ＋ "${policy.name}" (${policy.id})`);
        res.json({ ok: true, policy });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.patch("/api/security-policies/:id", async (req, res) => {
    try {
        const patch = {};
        const has = (k) =>
            Object.prototype.hasOwnProperty.call(req.body ?? {}, k);
        if (has("name")) patch.name = req.body.name;
        if (has("description")) patch.description = req.body.description;
        if (has("body")) patch.body = req.body.body;
        else if (has("policy")) patch.body = req.body.policy;
        if (!Object.keys(patch).length) {
            return res.status(400).json({
                error: "수정할 필드가 없습니다. (name, description, body)",
            });
        }
        const policy = await updateSecurityPolicy(req.params.id, patch);
        if (!policy) {
            return res
                .status(404)
                .json({ error: "보안 정책을 찾을 수 없습니다." });
        }
        await resyncAllPoolSecurity();
        logger.info(`보안 정책 수정 ✎ "${policy.name}" (${policy.id})`);
        res.json({ ok: true, policy });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete("/api/security-policies/:id", async (req, res) => {
    try {
        const ok = await deleteSecurityPolicy(req.params.id);
        if (!ok) {
            return res
                .status(404)
                .json({ error: "보안 정책을 찾을 수 없습니다." });
        }
        await stripSecurityIdFromServers(req.params.id);
        await resyncAllPoolSecurity();
        logger.info(`보안 정책 삭제 － ${req.params.id}`);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== 모델 서버(llama-server) 프로세스 제어 ==========================

// 티어별 모델 카탈로그 (modelconfig.json)
app.get("/api/modelconfig", async (_req, res) => {
    try {
        res.json(await loadModelConfig());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// VRAM 필요량 추정 (ngl·ctx 반영) — 추가 폼 미리보기용
app.post("/api/servers/estimate-vram", async (req, res) => {
    try {
        const est = await estimateVram({
            name: req.body?.name || "preview",
            model: req.body?.model,
            mmproj: req.body?.mmproj,
            ngl: req.body?.ngl,
            ctx: req.body?.ctx,
            parallel: req.body?.parallel,
            layers: req.body?.layers,
            gpu: req.body?.gpu,
        });
        const freeMb = await getGpuFreeMb(req.body?.gpu);
        res.json({ ...est, freeMb });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// servers.json 정의 + 실행 상태(PID/健康) 목록.
// agent 가 등록돼 있으면 모든 노드의 서버를 모아 반환(역할·모니터·채팅과 동일 풀 URL).
// agent 미등록(부팅 직후)일 때만 로컬 servers.json 폴백.
app.get("/api/servers", async (_req, res) => {
    try {
        const byUrl = new Map(pool.backends.map((b) => [b.url, b]));
        const agentList = listAgents();
        if (agentList.length) {
            const chunks = await Promise.all(
                agentList.map(async (a) => {
                    const out = await proxyToAgent(a.id, "GET", "/agent/servers");
                    if (out.status !== 200) {
                        return (a.servers || []).map((s) => ({
                            ...s,
                            agentId: a.id,
                            running: false,
                            pid: null,
                            healthy: byUrl.get(s.url)?.healthy ?? false,
                            inPool: byUrl.has(s.url),
                        }));
                    }
                    return (out.json.servers || []).map((s) => {
                        const url = serverUrl({ port: s.port, host: a.host });
                        return {
                            ...s,
                            host: a.host,
                            url,
                            agentId: a.id,
                            running: s.pid != null,
                            healthy: byUrl.get(url)?.healthy ?? false,
                            inPool: byUrl.has(url),
                        };
                    });
                }),
            );
            return res.json({ servers: chunks.flat() });
        }

        const defs = sortDefsByPriority(await loadServerDefs());
        const list = await serverStatus(defs);
        res.json({
            servers: list.map((s) => ({
                ...s,
                running: s.pid != null,
                healthy: byUrl.get(s.url)?.healthy ?? false,
                inPool: byUrl.has(s.url),
            })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function findServerDef(name) {
    const defs = await loadServerDefs();
    return defs.find((d) => d.name === name) ?? null;
}

/** 서버 제어·역할 변경: 소유 agent 가 있으면 그쪽으로 위임 */
async function proxyServerIfOwned(res, name, method, suffix = "", body) {
    const agent = findAgentByServerName(name);
    if (!agent) return false;
    sendProxy(
        res,
        await proxyToAgent(
            agent.id,
            method,
            `/agent/servers/${encodeURIComponent(name)}${suffix}`,
            body,
        ),
    );
    return true;
}

// 모델 서버 추가: agent 등록 시 해당 노드로 위임(단일 노드면 agentId 생략 가능).
// agent 없으면 로컬 servers.json + 풀 등록(레거시/부팅 전).
app.post("/api/servers", async (req, res) => {
    try {
        const agents = listAgents();
        if (agents.length) {
            const id =
                (typeof req.body?.agentId === "string" && req.body.agentId.trim()) ||
                soleAgentId();
            if (!id) {
                return res.status(400).json({
                    error: '여러 노드가 등록돼 있습니다. "agentId" 를 지정하세요.',
                });
            }
            logger.info(`하위 관리서버 llama 추가 요청 ➕ ${id} [${req.body?.tier}]`);
            return sendProxy(
                res,
                await proxyToAgent(id, "POST", "/agent/servers", req.body),
            );
        }

        const tier = String(req.body?.tier ?? "").toLowerCase();
        if (!["small", "medium", "large"].includes(tier)) {
            return res.status(400).json({
                error: '"tier" 는 small|medium|large 중 하나여야 합니다.',
            });
        }
        const def = await addServerDef({
            tier,
            model: req.body?.model,
            modelId: req.body?.modelId,
            ctx: req.body?.ctx,
            ngl: req.body?.ngl,
            parallel: req.body?.parallel,
            gpu: req.body?.gpu,
            alias: req.body?.alias,
            skill: req.body?.skill,
            skills: req.body?.skills,
            roleIds: req.body?.roleIds,
            mmproj: req.body?.mmproj,
        });
        const url = serverUrl(def);
        const resolved = resolveServerRoles(def, rolesById(loadRolesSync()));
        const secAssign = resolveServerSecurity(def);
        pool.addBackend(
            url,
            def.tier,
            Number(def.ngl) > 0 ? "gpu" : "cpu",
            def.alias,
            def.router === true,
            resolved.skills,
            resolved.roleIds,
            resolved.customSkills,
            {
                solve: def.solve !== false && def.chat !== false,
                router: def.router === true,
                planner: def.planner === true,
                embedding: def.embedding === true,
                security: def.security === true,
                securityIds: secAssign.securityIds,
                securityPolicy: secAssign.securityPolicyText,
                ctx: Number(def.ctx) > 0 ? Number(def.ctx) : 4096,
                parallel: Number(def.parallel) > 0 ? Number(def.parallel) : undefined,
                vision: Boolean(def.mmproj && String(def.mmproj).trim()),
            },
        );
        const shouldStart = req.body?.start !== false;
        let r = null;
        if (shouldStart) {
            try {
                r = await startServer(def);
            } catch (e) {
                // 기동 실패(GPU 부족 등) 시 정의·풀 등록 롤백
                await removeServerDef(def.name).catch(() => {});
                pool.removeBackend(url);
                throw e;
            }
            logger.info(
                `모델 서버 추가+기동 ➕ ${def.name} [${def.tier}] :${def.port} (model=${def.model}, ngl=${def.ngl}, PID ${r.pid ?? "?"})`,
            );
        } else {
            logger.info(
                `모델 서버 정의 추가 ➕ ${def.name} [${def.tier}] :${def.port} (미기동)`,
            );
        }
        res.json({ ok: true, server: def, started: shouldStart });
    } catch (err) {
        logger.error(`모델 서버 추가 실패: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

// 모델 서버 정의 수정 (별칭·공통역할·커스텀역할) — 소유 agent 또는 로컬 servers.json
app.patch("/api/servers/:name", async (req, res) => {
    try {
        if (await proxyServerIfOwned(res, req.params.name, "PATCH", "", req.body)) {
            return;
        }
        const patch = {};
        const has = (k) =>
            Object.prototype.hasOwnProperty.call(req.body ?? {}, k);
        if (has("alias")) patch.alias = req.body.alias;
        if (has("roleIds")) patch.roleIds = req.body.roleIds;
        if (has("skills")) patch.skills = req.body.skills; // 커스텀 역할
        else if (has("skill")) patch.skill = req.body.skill;
        if (has("securityIds")) patch.securityIds = req.body.securityIds;
        if (has("ngl")) patch.ngl = req.body.ngl;
        if (has("ctx")) patch.ctx = req.body.ctx;
        if (has("parallel")) patch.parallel = req.body.parallel;
        if (has("gpu")) patch.gpu = req.body.gpu;
        if (!Object.keys(patch).length) {
            return res.status(400).json({
                error: "수정할 필드가 없습니다. (alias, roleIds, skills, securityIds, ngl, ctx, parallel, gpu)",
            });
        }
        const runKeys = ["ngl", "ctx", "parallel", "gpu"].filter((k) => has(k));
        if (runKeys.length) {
            const defs = await loadServerDefs();
            const oldDef = defs.find((d) => d.name === req.params.name);
            if (!oldDef) {
                return res.status(404).json({
                    error: `servers.json 에 "${req.params.name}" 정의가 없습니다.`,
                });
            }
            const next = { ...oldDef };
            if (has("ngl")) {
                const n = Number(req.body.ngl);
                if (!Number.isFinite(n) || n < 0) {
                    return res.status(400).json({ error: "ngl 은 0 이상 숫자여야 합니다." });
                }
                next.ngl = Math.floor(n);
            }
            if (has("ctx")) {
                const c = Number(req.body.ctx);
                if (!Number.isFinite(c) || c < 512) {
                    return res.status(400).json({ error: "ctx 는 512 이상 숫자여야 합니다." });
                }
                next.ctx = Math.floor(c);
            }
            if (has("parallel")) {
                const p = Number(req.body.parallel);
                if (!Number.isFinite(p) || p < 1) {
                    return res.status(400).json({ error: "parallel 은 1 이상 숫자여야 합니다." });
                }
                next.parallel = Math.min(32, Math.floor(p));
            }
            if (has("gpu")) next.gpu = String(req.body.gpu ?? "").trim();
            await assertGpuCapacityForUpdate(oldDef, next);
        }
        const def = await updateServerDef(req.params.name, patch);
        if (!def) {
            return res.status(404).json({
                error: `servers.json 에 "${req.params.name}" 정의가 없습니다.`,
            });
        }
        if (runKeys.length) {
            await setPendingRestart(def.name, true);
        }
        const url = serverUrl(def);
        if (has("alias")) {
            pool.setAlias(url, def.alias);
            logger.info(`모델 서버 별칭 변경 ✎ ${def.name} → "${def.alias}"`);
        }
        let server = enrichServerWithRoles(def);
        if (has("roleIds") || has("skills") || has("skill")) {
            server = syncPoolRoles(def);
            logger.info(
                `모델 서버 역할 변경 ✎ ${def.name} · 공통 ${server.roleIds.length} · 커스텀 ${server.customSkills.length}`,
            );
        }
        if (has("securityIds")) {
            const sec = resolveServerSecurity(def);
            pool.setSecurityAssignment(url, {
                securityIds: sec.securityIds,
                securityPolicy: sec.securityPolicyText,
            });
            server = enrichServerWithRoles(def);
            logger.info(
                `모델 서버 보안 정책 배정 ✎ ${def.name} · ${sec.securityIds.length}개`,
            );
        }
        if (runKeys.length) {
            const b = pool.backends.find((x) => x.url === url);
            if (b && has("ngl")) b.device = Number(def.ngl) > 0 ? "gpu" : "cpu";
            if (b && has("ctx")) b.ctx = Number(def.ctx) > 0 ? Number(def.ctx) : 4096;
            if (b && has("parallel")) {
                b.parallel =
                    Number(def.parallel) > 0
                        ? Math.min(32, Math.floor(Number(def.parallel)))
                        : b.parallel;
            }
            server = enrichServerWithRoles(def);
            logger.info(
                `모델 서버 실행설정 ✎ ${def.name} ngl=${def.ngl} ctx=${def.ctx} parallel=${def.parallel ?? "-"} gpu=${def.gpu || "-"} (재시작 후 반영)`,
            );
        }
        res.json({ ok: true, server, needsRestart: runKeys.length > 0 });
    } catch (err) {
        logger.error(`모델 서버 수정 실패 (${req.params.name}): ${err.message}`);
        const status = /보안검증 기능이 꺼져|ngl|ctx|parallel|GPU 메모리/.test(err.message)
            ? 400
            : 500;
        res.status(status).json({ error: err.message });
    }
});

// 모델 서버 삭제: 소유 agent 위임 또는 로컬 종료+정의 제거
app.delete("/api/servers/:name", async (req, res) => {
    try {
        if (await proxyServerIfOwned(res, req.params.name, "DELETE")) return;
        const def = await findServerDef(req.params.name);
        if (!def) {
            return res.status(404).json({
                error: `servers.json 에 "${req.params.name}" 정의가 없습니다.`,
            });
        }
        try {
            await stopServer(def);
        } catch (e) {
            logger.warn(`서버 삭제 중 종료 실패(${def.name}): ${e.message}`);
        }
        await removeServerDef(def.name);
        pool.removeBackend(serverUrl(def));
        logger.warn(`모델 서버 삭제 🗑 ${def.name} [${def.tier}] :${def.port}`);
        res.json({ ok: true, removed: def.name });
    } catch (err) {
        logger.error(`모델 서버 삭제 실패 (${req.params.name}): ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// 모델 서버 종료 (프로세스 kill → VRAM/메모리 해제)
app.post("/api/servers/:name/stop", async (req, res) => {
    try {
        if (await proxyServerIfOwned(res, req.params.name, "POST", "/stop")) return;
        const def = await findServerDef(req.params.name);
        if (!def) {
            return res
                .status(404)
                .json({ error: `servers.json 에 "${req.params.name}" 정의가 없습니다.` });
        }
        const r = await stopServer(def);
        logger.warn(
            `모델 서버 종료 ⏻ ${def.name} [${def.tier}] :${def.port}${r.alreadyStopped ? " (이미 정지 상태)" : ` (PID ${r.pid})`}`,
        );
        pool.checkAll(); // 헬스 상태 즉시 갱신 (best-effort)
        res.json({ ok: true, name: def.name, ...r });
    } catch (err) {
        logger.error(`모델 서버 종료 실패 (${req.params.name}): ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// 모델 서버 기동 — 소유 agent 가 있으면 그 머신에서 spawn (부모가 직접 띄우지 않음)
app.post("/api/servers/:name/start", async (req, res) => {
    try {
        if (await proxyServerIfOwned(res, req.params.name, "POST", "/start")) return;
        const def = await findServerDef(req.params.name);
        if (!def) {
            return res
                .status(404)
                .json({ error: `servers.json 에 "${req.params.name}" 정의가 없습니다.` });
        }
        const r = await startServer(def);
        // 기동 후에도 servers.json 의 router 플래그 복원 (풀 상태 동기화)
        if (def.router === true) {
            pool.setRoleEnabled(serverUrl(def), "router", true);
        }
        logger.info(
            `모델 서버 기동 ▶ ${def.name} [${def.tier}] :${def.port}${r.alreadyRunning ? " (이미 실행 중)" : ` (PID ${r.pid}, 모델 로딩 중)`}${def.router ? " [router]" : ""}`,
        );
        res.json({ ok: true, name: def.name, ...r });
    } catch (err) {
        logger.error(`모델 서버 기동 실패 (${req.params.name}): ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// 백엔드 고정 역할 개별 on·off (해결·라우터·파이프라인설계·임베딩·보안검증)
// agent 소유 URL 이면 해당 노드 servers.json 에 저장 → 재등록으로 풀 동기화
app.post("/api/backends/role", async (req, res) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    const role = String(req.body?.role ?? "").toLowerCase();
    const enabled = req.body?.enabled;
    if (!url || !isFixedRole(role) || typeof enabled !== "boolean") {
        return res.status(400).json({
            error: `"url"(string), "role"(${FIXED_ROLES.map((r) => `"${r}"`).join("|")}|\"chat\"), "enabled"(boolean) 이 필요합니다.`,
        });
    }
    const owner = findAgentByBackendUrl(url);
    if (owner) {
        const def = owner.servers.find((s) => serverUrl(s) === url);
        if (!def) {
            return res.status(404).json({ error: "해당 URL 의 백엔드를 찾을 수 없습니다." });
        }
        const out = await proxyToAgent(
            owner.id,
            "POST",
            `/agent/servers/${encodeURIComponent(def.name)}/role`,
            { role, enabled },
        );
        if (out.status >= 400) return sendProxy(res, out);
        if (String(role).toLowerCase() === "security" || role === "보안검증") {
            await resyncAllPoolSecurity();
        }
        return res.json({ ok: true, ...pool.status() });
    }
    if (!pool.setRoleEnabled(url, role, enabled)) {
        return res.status(404).json({ error: "해당 URL 의 백엔드를 찾을 수 없습니다." });
    }
    try {
        await persistFixedRole(url, role, enabled);
        // 보안검증 토글 후 배정 정책 본문 동기화
        if (String(role).toLowerCase() === "security" || role === "보안검증") {
            await resyncAllPoolSecurity();
        }
        logger.info(
            `고정 역할 ${role === "chat" ? "solve" : role} servers.json 저장 ✓ ${enabled ? "ON" : "OFF"} @ ${url}`,
        );
    } catch (e) {
        logger.error(`고정 역할 저장 실패 (${role}): ${e.message}`);
        return res.status(500).json({
            error: `역할은 반영됐지만 저장 실패(재시작 시 풀릴 수 있음): ${e.message}`,
            ...pool.status(),
        });
    }
    res.json({ ok: true, ...pool.status() });
});

// 보안검증 정책 텍스트 저장
app.post("/api/backends/security-policy", async (req, res) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    const policy =
        typeof req.body?.policy === "string"
            ? req.body.policy
            : typeof req.body?.securityPolicy === "string"
              ? req.body.securityPolicy
              : null;
    if (!url || policy === null) {
        return res.status(400).json({
            error: `"url"(string), "policy"(string) 이 필요합니다.`,
        });
    }
    const owner = findAgentByBackendUrl(url);
    if (owner) {
        const def = owner.servers.find((s) => serverUrl(s) === url);
        if (!def) {
            return res
                .status(404)
                .json({ error: "해당 URL 의 백엔드를 찾을 수 없습니다." });
        }
        const out = await proxyToAgent(
            owner.id,
            "POST",
            `/agent/servers/${encodeURIComponent(def.name)}/security-policy`,
            { policy },
        );
        if (out.status >= 400) return sendProxy(res, out);
        return res.json({ ok: true, ...pool.status() });
    }
    if (!pool.setSecurityPolicy(url, policy)) {
        return res
            .status(404)
            .json({ error: "해당 URL 의 백엔드를 찾을 수 없습니다." });
    }
    try {
        await persistSecurityPolicy(url, policy);
        logger.info(
            `보안 정책 저장 ✓ (${String(policy).trim().length}자) @ ${url}`,
        );
    } catch (e) {
        logger.error(`보안 정책 저장 실패: ${e.message}`);
        return res.status(500).json({
            error: `메모리에는 반영됐지만 저장 실패: ${e.message}`,
            ...pool.status(),
        });
    }
    res.json({ ok: true, ...pool.status() });
});

// 시스템 자원(GPU/CPU/RAM) 실시간 지표 (+ 모델별 VRAM)
app.get("/api/metrics", async (_req, res) => {
    try {
        res.json(await enrichMetricsWithServers(await getMetrics()));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== 로그 (관리서버 Express + 하위 agent + llama 파일) ==============

function tagExpressLogs(items) {
    return items.map((e) => ({
        ...e,
        source: {
            kind: "express",
            id: "express",
            label: "관리서버 (Express)",
        },
    }));
}

function sortLogItems(items) {
    return [...items].sort((a, b) => {
        const ta = new Date(a.ts || 0).getTime();
        const tb = new Date(b.ts || 0).getTime();
        if (ta !== tb) return ta - tb;
        const ia = typeof a.id === "number" ? a.id : 0;
        const ib = typeof b.id === "number" ? b.id : 0;
        return ia - ib;
    });
}

function takeLast(items, limit) {
    if (!limit || items.length <= limit) return items;
    return items.slice(-limit);
}

/** YYYY-MM-DD 또는 null */
function parseLogDate(raw) {
    const d = String(raw || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** 로컬 날짜 키로 항목 필터 (llama 등 파일에 day 분할이 없을 때) */
function filterItemsByDay(items, day) {
    if (!day) return items;
    return items.filter((e) => {
        if (!e?.ts) return true;
        const t = new Date(e.ts).getTime();
        // epoch/무효 시각(구버전 플레이스홀더) → 살아 있는 파일 로그로 간주하고 포함
        if (!Number.isFinite(t) || t <= 0) return true;
        return logDayKey(new Date(e.ts)) === day;
    });
}

/** 사용 가능한 일별 로그 날짜 */
app.get("/api/logs/dates", (_req, res) => {
    try {
        const today = logDayKey();
        const dates = listLogDates();
        res.json({
            today,
            dates,
            dir: "data/logs",
            files: logFileStats(today),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** 클러스터 전체 로그 소스 목록 — 등록된 agent 레지스트리 기준(항상 표시) */
app.get("/api/logs/sources", async (_req, res) => {
    try {
        const sources = [
            {
                kind: "express",
                id: "express",
                label: "관리서버 (Express)",
            },
        ];
        // solo: agent 메모리는 Express 와 동일 버퍼 → 중복 제외
        const skipAgentMem = config.agent.solo;
        const agents = listAgents();

        for (const a of agents) {
            if (!skipAgentMem) {
                sources.push({
                    kind: "agent",
                    id: `agent:${a.id}`,
                    agentId: a.id,
                    host: a.host,
                    status: a.status,
                    label: `하위 관리서버 ${a.id}`,
                });
            }
            for (const s of a.servers || []) {
                sources.push({
                    kind: "llama",
                    id: `llama:${a.id}:${s.port}`,
                    agentId: a.id,
                    port: s.port,
                    name: s.name,
                    alias: s.alias,
                    tier: s.tier,
                    label: `${s.alias || s.name} :${s.port}`,
                });
            }
        }

        // agent 가 새 API 를 지원하면 hasOut/hasErr 보강 (실패해도 목록은 유지)
        await Promise.all(
            agents.map(async (a) => {
                const out = await proxyToAgent(a.id, "GET", "/agent/logs/sources");
                if (out.status !== 200) return;
                for (const s of out.json.sources || []) {
                    if (s.kind !== "llama") continue;
                    const hit = sources.find((x) => x.id === s.id);
                    if (hit) {
                        hit.hasOut = s.hasOut;
                        hit.hasErr = s.hasErr;
                    }
                }
            }),
        );

        res.json({
            sources,
            solo: !!config.agent.solo,
            agentCount: agents.length,
            today: logDayKey(),
            logDates: listLogDates(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * llama 로그: agent 프록시 → 실패 시 로컬 호스트면 부모에서 파일 직접 읽기
 */
async function fetchLlamaLogItems(agentId, port, { level, limit, stream, date }) {
    const q = new URLSearchParams({
        level: String(level || "all"),
        limit: String(limit || 400),
        stream: String(stream || "both"),
    });
    if (date) q.set("date", date);
    const out = await proxyToAgent(
        agentId,
        "GET",
        `/agent/logs/llama/${encodeURIComponent(port)}?${q}`,
    );
    if (out.status === 200) return out.json.items || [];

    const agent = getAgent(agentId);
    if (agent && isLocalDef({ host: agent.host })) {
        let items = await readLlamaLogs(port, {
            limit,
            stream: ["out", "err", "both"].includes(stream) ? stream : "both",
        });
        if (level && level !== "all") {
            items = items.filter((e) => e.level === level);
        }
        items = filterItemsByDay(items, date);
        const def = (agent.servers || []).find(
            (s) => Number(s.port) === Number(port),
        );
        const label = def
            ? `${def.alias || def.name} :${port}`
            : `llama :${port}`;
        return items.map((e) => ({
            ...e,
            source: {
                kind: "llama",
                id: `llama:${agentId}:${port}`,
                label,
                agentId,
                port: Number(port),
                name: def?.name,
                stream: e.stream,
                via: "parent-local",
            },
        }));
    }
    const err = out.json?.error || `agent 로그 조회 실패 HTTP ${out.status}`;
    throw Object.assign(new Error(err), { status: out.status });
}

/**
 * 로그 조회.
 * source=express | agent:<id> | llama:<agentId>:<port> | all
 * date=YYYY-MM-DD → 일별 파일(관리서버/agent). 없으면 오늘 파일.
 */
app.get("/api/logs", async (req, res) => {
    try {
        const level = String(req.query.level || "all");
        const limit = Number.isFinite(Number(req.query.limit))
            ? Number(req.query.limit)
            : 400;
        const sinceId = Number(req.query.sinceId);
        const source = String(req.query.source || "express").trim();
        const date = parseLogDate(req.query.date) || logDayKey();
        const today = logDayKey();
        const fileOpts = {
            level,
            limit,
            sinceId: Number.isFinite(sinceId) ? sinceId : 0,
            date,
        };

        if (source === "express" || source === "") {
            return res.json({
                source,
                date,
                today,
                files: logFileStats(date),
                items: tagExpressLogs(getLogs(fileOpts)),
            });
        }

        if (source.startsWith("agent:")) {
            const agentId = source.slice("agent:".length);
            const agent = getAgent(agentId);
            if (!agent) {
                return res.status(404).json({
                    error: `등록된 하위 관리서버가 없습니다: ${agentId}`,
                });
            }
            const q = new URLSearchParams({
                level,
                limit: String(limit),
                date,
            });
            const out = await proxyToAgent(
                agentId,
                "GET",
                `/agent/logs?${q}`,
            );
            if (out.status !== 200) {
                return res.status(out.status).json({
                    error:
                        out.json?.error ||
                        `하위 관리서버(${agentId}) 로그 API 없음 — agent 를 최신 코드로 재시작하세요`,
                    items: [],
                    date,
                    today,
                });
            }
            return res.json({
                source,
                date,
                today,
                items: out.json.items || [],
            });
        }

        if (source.startsWith("llama:")) {
            const rest = source.slice("llama:".length);
            const colon = rest.lastIndexOf(":");
            if (colon < 0) {
                return res.status(400).json({
                    error: "source 형식: llama:<agentId>:<port>",
                });
            }
            const agentId = rest.slice(0, colon);
            const port = rest.slice(colon + 1);
            const stream = String(req.query.stream || "both");
            try {
                const items = await fetchLlamaLogItems(agentId, port, {
                    level,
                    limit,
                    stream,
                    date,
                });
                return res.json({ source, date, today, items });
            } catch (e) {
                return res.status(e.status || 502).json({
                    error: e.message,
                    items: [],
                    date,
                    today,
                });
            }
        }

        if (source === "all") {
            const bags = [];
            const skipAgentMem = config.agent.solo;
            const agents = listAgents();
            // 관리서버 Express (일별 파일)
            bags.push(tagExpressLogs(getLogs({
                level,
                limit: Math.min(limit, 400),
                sinceId: 0,
                date,
            })));
            // 하위 관리서버 프로세스 + 각 노드의 llama 파일 로그
            await Promise.all(
                agents.map(async (a) => {
                    if (!skipAgentMem) {
                        const q = new URLSearchParams({
                            level,
                            limit: String(Math.min(limit, 300)),
                            date,
                        });
                        const mem = await proxyToAgent(
                            a.id,
                            "GET",
                            `/agent/logs?${q}`,
                        );
                        if (mem.status === 200) {
                            bags.push(mem.json.items || []);
                        }
                    }
                    await Promise.all(
                        (a.servers || []).map(async (s) => {
                            try {
                                const items = await fetchLlamaLogItems(
                                    a.id,
                                    s.port,
                                    {
                                        level,
                                        limit: Math.min(limit, 200),
                                        stream: "both",
                                        date,
                                    },
                                );
                                bags.push(items);
                            } catch {
                                // 개별 실패는 전체 병합에서 건너뜀
                            }
                        }),
                    );
                }),
            );
            const flat = bags.flat();
            const merged = takeLast(sortLogItems(flat), limit);
            return res.json({
                source: "all",
                date,
                today,
                files: logFileStats(date),
                items: merged,
                meta: {
                    express: bags[0]?.length ?? 0,
                    parts: bags.length,
                    total: flat.length,
                    returned: merged.length,
                    agents: agents.length,
                    models: agents.reduce(
                        (n, a) => n + (a.servers || []).length,
                        0,
                    ),
                },
            });
        }

        res.status(400).json({
            error: "source 는 express | agent:<id> | llama:<agentId>:<port> | all",
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// agent 로그 프록시 (직접 접근용)
app.get("/api/agents/:id/logs", async (req, res) => {
    const q = new URLSearchParams();
    if (req.query.level) q.set("level", String(req.query.level));
    if (req.query.limit) q.set("limit", String(req.query.limit));
    if (req.query.date) q.set("date", String(req.query.date));
    const qs = q.toString();
    sendProxy(
        res,
        await proxyToAgent(
            req.params.id,
            "GET",
            `/agent/logs${qs ? `?${qs}` : ""}`,
        ),
    );
});

app.get("/api/agents/:id/logs/llama/:port", async (req, res) => {
    const q = new URLSearchParams();
    if (req.query.level) q.set("level", String(req.query.level));
    if (req.query.limit) q.set("limit", String(req.query.limit));
    if (req.query.stream) q.set("stream", String(req.query.stream));
    const qs = q.toString();
    sendProxy(
        res,
        await proxyToAgent(
            req.params.id,
            "GET",
            `/agent/logs/llama/${encodeURIComponent(req.params.port)}${qs ? `?${qs}` : ""}`,
        ),
    );
});

/**
 * 특정 백엔드(모델)에 실제 오류를 강제로 유발한다.
 * 시나리오는 모두 llama-server 가 비정상 응답(4xx/5xx)을 내도록 만든다.
 */
async function induceError(backend, scenario) {
    const url = backend.url;
    if (scenario === "context_overflow") {
        const huge = "오류 유발용 초과 입력 토큰 ".repeat(4000); // 모델 컨텍스트를 크게 초과
        const r = await fetch(`${url}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: config.modelName,
                messages: [{ role: "user", content: huge }],
                max_tokens: 50,
            }),
        });
        return {
            cause: `의도적으로 모델 컨텍스트 한도를 초과하는 대용량 프롬프트(약 ${huge.length.toLocaleString()}자) 전송`,
            status: r.status,
            serverMessage: (await r.text()).slice(0, 400),
        };
    }
    if (scenario === "bad_endpoint") {
        const r = await fetch(`${url}/v1/chat/completions/__force_error__`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
        return {
            cause: "존재하지 않는 엔드포인트 경로 호출(라우팅 실패 유발)",
            status: r.status,
            serverMessage: (await r.text()).slice(0, 400),
        };
    }
    // malformed_json
    const r = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"model": "x", "messages": [ {invalid json',
    });
    return {
        cause: "문법이 깨진 JSON 본문 전송(파싱 실패 유발)",
        status: r.status,
        serverMessage: (await r.text()).slice(0, 400),
    };
}

// 오류 테스트: 무작위 모델을 골라 실제 오류를 강제 유발하고 원인/이유를 로그로 남긴다.
app.post("/api/logs/test-error", async (req, res) => {
    const healthy = pool.backends.filter((b) => b.healthy && b.canChat);
    const pickFrom = healthy.length ? healthy : pool.backends.filter((b) => b.canChat);
    if (!pickFrom.length) {
        logger.error("강제 오류 테스트 실패: 사용 가능한 백엔드가 없습니다.");
        return res
            .status(503)
            .json({ error: "사용 가능한 백엔드가 없습니다." });
    }

    const backend = pickFrom[Math.floor(Math.random() * pickFrom.length)];
    const scenarios = ["context_overflow", "bad_endpoint", "malformed_json"];
    const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
    const modelName = backend.model || "(미확인)";

    let detail;
    try {
        detail = await induceError(backend, scenario);
    } catch (e) {
        detail = {
            cause: "백엔드 연결 자체가 실패",
            status: 0,
            serverMessage: e.message,
        };
    }

    // 통계에도 오류 1건 반영(모니터 오류 카운트 증가)
    backend.totalErrors++;
    backend.lastError = `[강제 테스트:${scenario}] ${detail.serverMessage}`;

    logger.error(
        `강제 오류 유발 [${scenario}] → 모델="${modelName}" (${backend.tier}/${backend.device ?? "-"}) @ ${backend.url}\n` +
            `   · 원인: ${detail.cause}\n` +
            `   · 결과: HTTP ${detail.status} | 서버응답: ${detail.serverMessage}`,
        {
            scenario,
            model: modelName,
            tier: backend.tier,
            device: backend.device,
            backend: backend.url,
            status: detail.status,
        },
    );

    res.status(502).json({
        error: `모델 "${modelName}" 에 강제 오류 유발 완료`,
        scenario,
        model: modelName,
        tier: backend.tier,
        device: backend.device,
        backend: backend.url,
        cause: detail.cause,
        status: detail.status,
        serverMessage: detail.serverMessage,
    });
});

// 저장된 대화 내역 조회
app.get("/api/history", async (req, res) => {
    try {
        const limit = Number(req.query.limit);
        const items = await readHistory(
            Number.isFinite(limit) ? limit : undefined,
        );
        res.json({ items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 대화 내역 전체 삭제
app.delete("/api/history", async (_req, res) => {
    try {
        await clearHistory();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 서버측 기억 삭제.
 * body/query: U_ID(장기), S_ID(단기). 둘 다 없으면 400.
 */
app.delete("/api/memory", async (req, res) => {
    try {
        const body = req.body ?? {};
        const uid =
            typeof body.U_ID === "string"
                ? body.U_ID.trim()
                : typeof req.query.U_ID === "string"
                  ? req.query.U_ID.trim()
                  : typeof req.query.u_id === "string"
                    ? req.query.u_id.trim()
                    : "";
        const sid =
            typeof body.S_ID === "string"
                ? body.S_ID.trim()
                : typeof req.query.S_ID === "string"
                  ? req.query.S_ID.trim()
                  : typeof req.query.s_id === "string"
                    ? req.query.s_id.trim()
                    : "";
        if (!uid && !sid) {
            return res.status(400).json({
                error: "U_ID 또는 S_ID 가 필요합니다.",
            });
        }
        const out = { ok: true };
        if (sid) {
            sessionMemory.clear(sid);
            out.sessionCleared = true;
            out.S_ID = sid;
        }
        if (uid) {
            const r = await memoryStore.forget(uid);
            out.userCleared = true;
            out.userRemoved = r.removed;
            out.U_ID = uid;
        }
        res.json(out);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 외부 API: 백그라운드에서 답변을 생성해 결과 JSON 파일에 기록한다.
async function processAsk(id, body, ref) {
    const started = Date.now();
    try {
        await prepareChatMemory(body);
        const route = await chooseRoute(body);
        logger.info(
            `라우팅 [ask #${id}] → tier=${route.tier} device=${route.device} 난이도=${route.difficulty}${route.routerBackend ? ` router@${route.routerBackend}` : ""} (${route.reason})`,
        );
        const isLarge = route.tier === "large";
        const promptCharBudget = isLarge
            ? config.maxPromptCharsLarge
            : config.maxPromptCharsSmall;
        const maxTokens = isLarge
            ? config.defaultMaxTokens
            : config.maxTokensSmall;
        const messages = await buildMessages(body, promptCharBudget);

        const rawTemp = Number(body?.TEMPERATURE);
        const temperature = Number.isFinite(rawTemp)
            ? rawTemp
            : config.defaultTemperature;

        const {
            result,
            backendUrl,
            tier: usedTier,
            device: usedDevice,
        } = await pool.chat({
            messages,
            temperature,
            maxTokens,
            enableThinking: config.enableThinking,
            preferredTier: route.tier,
            preferredDevice: route.device,
        });

        const { uid, sid } = memoryIds(body);
        const data = {
            status: "done",
            id,
            ref,
            question: body.ROLE_USER,
            answer: result.content,
            reasoning: result.reasoning || undefined,
            model: result.raw?.model ?? config.modelName,
            tier: usedTier,
            device: usedDevice,
            backend: backendUrl,
            U_ID: uid || undefined,
            S_ID: sid || undefined,
            elapsedMs: Date.now() - started,
            finishedAt: new Date().toISOString(),
        };
        await writeResult(id, data);
        await persistChatMemory(body, body.ROLE_USER, result.content);
        logger.info(
            `ask 완료 #${id} tier=${usedTier} device=${usedDevice ?? "-"} ${Date.now() - started}ms`,
        );
        return data;
    } catch (err) {
        const data = {
            status: "error",
            id,
            ref,
            question: body.ROLE_USER,
            error: err.message,
            finishedAt: new Date().toISOString(),
        };
        await writeResult(id, data).catch(() => {});
        logger.error(`ask 실패 #${id}: ${err.message}`);
        return data;
    }
}

// 외부 API (GET): key + q 를 받아 즉시 "생성중" + 결과 URL 을 반환하고, 답변은 비동기로 파일에 기록한다.
app.get("/api/ask", async (req, res) => {
    const key = req.query.key || req.headers["x-api-key"];
    if (key !== config.apiKey) {
        return res.status(401).json({ error: "유효하지 않은 API KEY 입니다." });
    }

    const q = req.query.q ?? req.query.content ?? req.query.ROLE_USER;
    if (typeof q !== "string" || q.trim() === "") {
        return res
            .status(400)
            .json({ error: "q (질문) 파라미터가 필요합니다." });
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    // 호출자가 보낸 식별용 key(ref). 어떤 요청에 대한 답변인지 매칭하기 위해 응답에 그대로 echo 한다.
    const ref =
        typeof req.query.ref === "string"
            ? req.query.ref
            : typeof req.query.reqKey === "string"
              ? req.query.reqKey
              : undefined;
    const body = {
        ROLE_USER: q,
        ROLE_SYSTEM:
            typeof req.query.system === "string" ? req.query.system : undefined,
        TEMPERATURE: req.query.temperature,
        MODEL_TIER:
            typeof req.query.tier === "string" ? req.query.tier : undefined,
        U_ID:
            typeof req.query.U_ID === "string"
                ? req.query.U_ID
                : typeof req.query.u_id === "string"
                  ? req.query.u_id
                  : undefined,
        S_ID:
            typeof req.query.S_ID === "string"
                ? req.query.S_ID
                : typeof req.query.s_id === "string"
                  ? req.query.s_id
                  : undefined,
    };

    await writeResult(id, {
        status: "generating",
        id,
        ref,
        question: q,
        createdAt: new Date().toISOString(),
    });

    const wait = String(req.query.WAIT ?? req.query.wait ?? "N").toUpperCase() === "Y";
    const resultUrl = `/results/${id}.json`;

    // WAIT=Y: 완료까지 기다렸다가 결과를 바로 반환
    if (wait) {
        logger.info(`ask 접수 #${id} ref=${ref ?? "-"} (WAIT=Y, 동기 대기): "${q.slice(0, 50)}"`);
        const data = await processAsk(id, body, ref);
        return res.status(data.status === "error" ? 502 : 200).json({ ...data, resultUrl });
    }

    // WAIT=N(기본): 즉시 "생성중" 응답 + 결과 URL, 답변은 백그라운드로 파일에 기록
    logger.info(`ask 접수 #${id} ref=${ref ?? "-"} (WAIT=N, 비동기): "${q.slice(0, 50)}"`);
    processAsk(id, body, ref);
    res.json({
        status: "generating",
        message: "답변을 생성중입니다",
        id,
        ref,
        resultUrl,
    });
});

// 스트리밍(SSE) 채팅: 토큰을 실시간 전송하고, 마지막에 TTFT/tokens-per-sec 지표를 보낸다.
// WORKFLOW_MODE=auto/on 이면 라우터가 파이프라인을 짜고 모델끼리 결과를 넘긴다.
app.post("/api/chat/stream", async (req, res) => {
    const started = Date.now();
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (event, data) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
        const body = req.body ?? {};
        const q = typeof body.ROLE_USER === "string" ? body.ROLE_USER : "";
        logger.info(
            `요청 수신 [chat/stream] "${q.slice(0, 60)}" (len=${q.length}, memory=${Array.isArray(body.HISTORY) ? body.HISTORY.length : 0}턴)`,
        );
        const rawTemp = Number(body.TEMPERATURE);
        const temperature = Number.isFinite(rawTemp)
            ? rawTemp
            : config.defaultTemperature;
        const enableThinking =
            body.THINKING === undefined
                ? config.enableThinking
                : Boolean(body.THINKING);

        await prepareChatMemory(body);

        // RAG: 문서 검색 후 파이프라인/단일에 컨텍스트 주입 (긴입력 맵리듀스와 분리)
        const ragPrep = await prepareChatRag(body, {
            onStatus: (s) => send("status", s),
        });
        if (ragPrep.emptyStrict) {
            const payload = {
                answer: ragPrep.answer,
                model: config.modelName,
                mode: "direct",
                totalMs: Date.now() - started,
                ...ragResponseFields(body),
            };
            send("meta", { rag: true, sources: [], strict: true });
            send("done", payload);
            appendHistory({
                id:
                    Date.now().toString(36) +
                    Math.random().toString(36).slice(2, 8),
                ts: new Date().toISOString(),
                user: q,
                answer: payload.answer,
                model: payload.model,
                mode: "direct",
                ...ragResponseFields(body),
            }).catch((e) => logger.error(`history 저장 실패: ${e.message}`));
            persistChatMemory(body, q, payload.answer);
            return res.end();
        }
        if (ragPrep.active) {
            send("meta", {
                rag: true,
                sources: body._rag.sources,
                strict: body._rag.strict,
                hits: body._rag.hits.length,
            });
        }

        // 긴 입력(컨텍스트 초과) → 청크 맵리듀스 (RAG 요청은 검색 컨텍스트만 쓰므로 스킵)
        if (!ragPrep.active && needsLongPipeline(body)) {
            logger.info(
                `긴 입력 감지 [chat/stream] ${q.length}자 → 맵리듀스 파이프라인`,
            );
            const out = await runLongContent({
                body,
                temperature,
                onEvent: (ev) => {
                    if (ev.type === "plan") {
                        send("meta", {
                            mode: "workflow",
                            reason: ev.reason,
                            workflow: ev.steps,
                        });
                        send("workflow", ev);
                    } else if (ev.type === "step_start")
                        send("step", { ...ev, status: "start" });
                    else if (ev.type === "step_done")
                        send("step", { ...ev, status: "done" });
                    else if (ev.type === "step_meta") send("meta", ev);
                    else if (ev.type === "token")
                        send("token", { text: ev.text });
                },
            });

            const sec = await withSecurityPreFinal(q, out.answer, {
                onEvent: securityEventBridge(send),
                stepIndex: Array.isArray(out.steps) ? out.steps.length : 0,
            });
            const answer = sec.answer;
            const workflowSteps = pipelineStepsOnly(out.steps);
            const workflowTrace = [
                ...(out.trace || []),
                ...sec.traceExtra,
            ];

            const genMs =
                out.ttftMs != null
                    ? Math.max((out.totalMs ?? 0) - out.ttftMs, 1)
                    : out.totalMs;
            const tokens = out.tokens;
            const tokensPerSec =
                tokens && genMs
                    ? Number((tokens / (genMs / 1000)).toFixed(1))
                    : null;

            send("done", {
                answer,
                reasoning: out.reasoning || undefined,
                model: out.model ?? config.modelName,
                tier: out.tier,
                device: out.device,
                alias: out.alias || undefined,
                difficulty: 100,
                backend: out.backend,
                ttftMs: out.ttftMs,
                totalMs: Date.now() - started,
                tokens,
                tokensPerSec,
                usage: out.usage ?? null,
                mode: "workflow",
                routeReason: out.plan.reason,
                workflowSteps,
                workflowTrace,
            });

            appendHistory({
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
                ts: new Date().toISOString(),
                system: typeof body.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "",
                user: body.ROLE_USER,
                hasImage: false,
                temperature,
                thinking: enableThinking,
                tier: out.tier,
                routedTier: out.tier,
                routeReason: out.plan.reason,
                device: out.device,
                alias: out.alias || null,
                difficulty: 100,
                backend: out.backend,
                model: out.model ?? config.modelName,
                answer,
                reasoning: out.reasoning || "",
                usage: out.usage ?? null,
                mode: "workflow",
                workflowSteps,
                workflowTrace,
            }).catch((e) => logger.error(`history 저장 실패: ${e.message}`));
            persistChatMemory(body, body.ROLE_USER, answer);

            logger.info(
                `chat(stream/long) ${out.trace.filter((n) => n.kind === "model").length}단계 ${Date.now() - started}ms`,
            );
            return res.end();
        }

        const plan = await createPlan(body);
        const useWorkflow = plan.mode === "workflow" && plan.steps?.length > 1;
        // 보안 게이트가 켜져 있으면 검사 통과 전까지 답을 감춘다(작성 중/점검 중만 표시)
        const securityHold =
            hasSecurityWorkflow() && !isBlankAsk({ ROLE_USER: q });

        send("meta", {
            mode: useWorkflow ? "workflow" : "direct",
            securityHold,
            routedTier: plan.tier,
            routedDevice: plan.device,
            difficulty: plan.difficulty,
            reason: plan.reason,
            deviceReason: plan.deviceReason,
            routerBackend: plan.routerBackend || null,
            routerTier: plan.routerTier || null,
            routerAlias: plan.routerAlias || null,
            routerDevice: plan.routerDevice || null,
            routerModel: plan.routerModel || null,
            workflow: useWorkflow
                ? plan.steps.map((s, i) => ({
                      i,
                      tier: s.tier,
                      role: s.role,
                      instruction: s.instruction,
                  }))
                : undefined,
        });

        if (useWorkflow) {
            logger.info(
                `워크플로우 [chat/stream] → ${plan.steps.map((s) => s.tier).join("→")} (${plan.reason})`,
            );
            const out = await runWorkflow({
                plan,
                body,
                temperature,
                enableThinking,
                onEvent: (ev) => {
                    if (ev.type === "plan") send("workflow", ev);
                    else if (ev.type === "rag")
                        send("meta", {
                            rag: true,
                            sources: ev.sources,
                            hits: ev.hits,
                            strict: ev.strict,
                        });
                    else if (ev.type === "step_start") send("step", { ...ev, status: "start" });
                    else if (ev.type === "step_done") send("step", { ...ev, status: "done" });
                    else if (ev.type === "step_meta") send("meta", ev);
                    else if (ev.type === "token") send("token", { text: ev.text });
                    else if (ev.type === "security_start" || ev.type === "security_done")
                        send("security", ev);
                },
            });

            const genMs =
                out.ttftMs != null
                    ? Math.max((out.totalMs ?? 0) - out.ttftMs, 1)
                    : out.totalMs;
            const tokens = out.tokens;
            const tokensPerSec =
                tokens && genMs
                    ? Number((tokens / (genMs / 1000)).toFixed(1))
                    : null;

            send("done", {
                answer: out.answer,
                reasoning: out.reasoning || undefined,
                model: out.model ?? config.modelName,
                tier: out.tier,
                device: out.device,
                alias: out.alias || undefined,
                difficulty: plan.difficulty,
                backend: out.backend,
                ttftMs: out.ttftMs,
                totalMs: Date.now() - started,
                tokens,
                tokensPerSec,
                usage: out.usage ?? null,
                mode: "workflow",
                routeReason: plan.reason,
                routerBackend: plan.routerBackend || null,
                routerTier: plan.routerTier || null,
                routerAlias: plan.routerAlias || null,
                routerDevice: plan.routerDevice || null,
                routerModel: plan.routerModel || null,
                workflowSteps: pipelineStepsOnly(out.steps),
                workflowTrace: out.trace,
                ...ragResponseFields(body, {
                    sources: out.sources,
                    strict: out.strict,
                }),
            });

            appendHistory({
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
                ts: new Date().toISOString(),
                system: typeof body.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "",
                user: body.ROLE_USER,
                hasImage: !!(body.content !== undefined && body.content !== null && body.content !== ""),
                temperature,
                thinking: enableThinking,
                tier: out.tier,
                routedTier: plan.tier,
                routeReason: plan.reason,
                device: out.device,
                alias: out.alias || null,
                difficulty: plan.difficulty,
                backend: out.backend,
                model: out.model ?? config.modelName,
                answer: out.answer,
                reasoning: out.reasoning || "",
                usage: out.usage ?? null,
                mode: "workflow",
                routerBackend: plan.routerBackend || null,
                routerTier: plan.routerTier || null,
                routerAlias: plan.routerAlias || null,
                routerDevice: plan.routerDevice || null,
                routerModel: plan.routerModel || null,
                workflowSteps: pipelineStepsOnly(out.steps),
                workflowTrace: out.trace,
                ...ragResponseFields(body, {
                    sources: out.sources,
                    strict: out.strict,
                }),
            }).catch((e) => logger.error(`history 저장 실패: ${e.message}`));
            persistChatMemory(body, body.ROLE_USER, out.answer);

            logger.info(
                `chat(stream/workflow) ${plan.steps.map((s) => s.tier).join("→")} ${Date.now() - started}ms`,
            );
            return res.end();
        }

        // ---- 단일 모델 (direct) ----
        let directTier = plan.tier;
        let directDevice = plan.device;
        let directAllowOther = config.escalateTier;
        let messages;
        if (ragPrep.active) {
            const ragRoute = await chooseRagRoute({
                q,
                hits: body._rag.hits,
                questionContent: body.content,
                body,
            });
            // 이미지 등은 RAG 라우팅 우선, 그 외는 플랜 티어와 병합(더 큰 쪽)
            const rank = { small: 0, medium: 1, large: 2 };
            const pick =
                (rank[ragRoute.tier] ?? 0) >= (rank[plan.tier] ?? 0)
                    ? ragRoute.tier
                    : plan.tier;
            directTier = pick;
            directDevice = ragRoute.device ?? plan.device;
            directAllowOther = ragRoute.allowOtherTiers ?? config.escalateTier;
            messages = await buildRagMessages({
                q,
                hits: body._rag.hits,
                strict: body._rag.strict,
                questionContent: body.content,
                system:
                    typeof body.ROLE_SYSTEM === "string"
                        ? body.ROLE_SYSTEM
                        : undefined,
                history: body.HISTORY,
                memoryContext: body._memory?.context,
            });
            logger.info(
                `라우팅 [chat/stream/rag] → tier=${directTier} (${ragRoute.reason}; plan=${plan.tier})`,
            );
        } else {
            const isLarge = plan.tier === "large";
            const promptCharBudget = isLarge
                ? config.maxPromptCharsLarge
                : config.maxPromptCharsSmall;
            messages = await buildMessages(body, promptCharBudget);
            logger.info(
                `라우팅 [chat/stream] → tier=${plan.tier}${plan.skill ? ` skill="${plan.skill}"` : ""} device=${plan.device} 난이도=${plan.difficulty}${plan.routerBackend ? ` router@${plan.routerBackend}` : ""} (${plan.reason})`,
            );
        }
        // 인사 패턴으로 small 을 막지 않음 — 라우터 티어를 존중. 에코만 사후 보정.
        const isLarge = directTier === "large";
        const maxTokens = isLarge
            ? config.defaultMaxTokens
            : config.maxTokensSmall;

        // 짧은 대화는 스트리밍 대신 에코 가드 채팅
        const useEchoGuard = !ragPrep.active && String(q).length <= 240;

        let out;
        if (useEchoGuard) {
            const guarded = await chatWithEchoGuard({
                body,
                messages,
                temperature,
                maxTokens,
                enableThinking,
                preferredTier: directTier,
                preferredDevice: directDevice,
                preferredSkill: plan.skill ?? null,
                allowOtherTiers: directAllowOther,
                onMeta: (m) => {
                    send("meta", m);
                    logger.info(
                        `백엔드 선택 [chat/stream/guard] → ${m.tier}/${m.device ?? "-"} @ ${m.backend}`,
                    );
                },
            });
            if (guarded.content && !securityHold)
                send("token", { text: guarded.content });
            out = {
                content: guarded.content,
                reasoning: guarded.reasoning,
                tier: guarded.tier,
                device: guarded.device,
                alias: guarded.alias,
                backendUrl: guarded.backendUrl,
                model: guarded.model,
                usage: guarded.usage,
                ttftMs: guarded.ttftMs,
            };
        } else {
            let firstLogged = false;
            out = await pool.chatStream({
                messages,
                temperature,
                maxTokens,
                enableThinking: ragPrep.active ? false : enableThinking,
                preferredTier: directTier,
                preferredDevice: directDevice,
                preferredSkill: plan.skill ?? null,
                allowOtherTiers: directAllowOther,
                onQueue: (qInfo) => {
                    send("status", {
                        phase: "queue",
                        message: `대기열 ${qInfo.position}번째 (실행 ${qInfo.running}/${qInfo.maxInFlight})`,
                        ...qInfo,
                    });
                },
                onMeta: (m) => {
                    send("meta", m);
                    logger.info(
                        `백엔드 선택 [chat/stream] → ${m.tier}/${m.device ?? "-"} @ ${m.backend} (model=${m.model ?? "?"})`,
                    );
                },
                onToken: (t) => {
                    if (!firstLogged) {
                        firstLogged = true;
                        logger.debug(
                            `첫 토큰 수신 [chat/stream] (${Date.now() - started}ms)`,
                        );
                    }
                    // 보안 게이트 대기 중이면 토큰을 감춘다(통과 후 done 에서 공개)
                    if (!securityHold) send("token", { text: t });
                },
            });
            // 스트리밍 후에도 에코면 medium 재생성으로 교체
            if (isNearEcho(q, out.content) && directTier !== "large") {
                logger.warn("stream 에코 → medium 재생성으로 교체");
                const guarded = await chatWithEchoGuard({
                    body,
                    messages,
                    temperature,
                    maxTokens,
                    enableThinking: false,
                    preferredTier: "medium",
                    preferredDevice: directDevice,
                    preferredSkill: null,
                    allowOtherTiers: true,
                });
                out = {
                    ...out,
                    content: guarded.content,
                    reasoning: guarded.reasoning,
                    tier: guarded.tier,
                    device: guarded.device,
                    alias: guarded.alias,
                    backendUrl: guarded.backendUrl,
                    model: guarded.model,
                    usage: guarded.usage,
                };
            }
        }

        const sec = await withSecurityPreFinal(q, out.content, {
            onEvent: securityEventBridge(send),
            stepIndex: 1,
        });
        const answer = sec.answer;
        // 보안은 파이프라인 steps 에 넣지 않음 — trace 에만 기록
        const workflowTrace = [
            {
                kind: "model",
                i: 1,
                role: "answer",
                tier: out.tier,
                device: out.device,
                alias: out.alias || null,
                backend: out.backendUrl,
                model: out.model,
                output: out.content,
                isLast: true,
            },
            ...sec.traceExtra,
        ];

        const genMs =
            out.ttftMs != null
                ? Math.max(out.totalMs - out.ttftMs, 1)
                : out.totalMs;
        const tokens = out.usage?.completion_tokens ?? out.tokenCount;
        const tokensPerSec =
            tokens && genMs
                ? Number((tokens / (genMs / 1000)).toFixed(1))
                : null;

        send("done", {
            answer,
            reasoning: out.reasoning || undefined,
            model: out.model ?? config.modelName,
            tier: out.tier,
            device: out.device,
            alias: out.alias || undefined,
            difficulty: plan.difficulty,
            backend: out.backendUrl,
            ttftMs: out.ttftMs,
            totalMs: out.totalMs,
            tokens,
            tokensPerSec,
            usage: out.usage ?? null,
            mode: "direct",
            routeReason: plan.reason,
            routerBackend: plan.routerBackend || null,
            routerTier: plan.routerTier || null,
            routerAlias: plan.routerAlias || null,
            routerDevice: plan.routerDevice || null,
            routerModel: plan.routerModel || null,
            workflowTrace,
            ...ragResponseFields(body),
        });

        appendHistory({
            id:
                Date.now().toString(36) +
                Math.random().toString(36).slice(2, 8),
            ts: new Date().toISOString(),
            system:
                typeof body.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "",
            user: body.ROLE_USER,
            hasImage: false,
            temperature,
            thinking: enableThinking,
            tier: out.tier,
            routedTier: plan.tier,
            device: out.device,
            alias: out.alias || null,
            backend: out.backendUrl,
            model: out.model ?? config.modelName,
            answer,
            reasoning: out.reasoning || "",
            usage: out.usage ?? null,
            mode: "direct",
            routeReason: plan.reason,
            routerBackend: plan.routerBackend || null,
            routerTier: plan.routerTier || null,
            routerAlias: plan.routerAlias || null,
            routerDevice: plan.routerDevice || null,
            routerModel: plan.routerModel || null,
            workflowTrace,
            ...ragResponseFields(body),
        }).catch((e) => logger.error(`history 저장 실패: ${e.message}`));
        persistChatMemory(body, body.ROLE_USER, answer);

        logger.info(
            `chat(stream) tier=${out.tier} device=${out.device ?? "-"} ttft=${out.ttftMs ?? "?"}ms tps=${tokensPerSec ?? "?"} ${out.totalMs}ms`,
        );
        res.end();
    } catch (err) {
        if (
            isContextOverflowError(err) &&
            !(req.body?.content !== undefined &&
                req.body?.content !== null &&
                req.body?.content !== "")
        ) {
            const body = req.body ?? {};
            // RAG: 맵리듀스(질문만 분할)는 문서를 잃어 오답을 냄 → 축소 재시도만
            if (isRagRequest(body) || body._rag) {
                try {
                    const q =
                        typeof body.ROLE_USER === "string"
                            ? body.ROLE_USER
                            : "";
                    const rawTemp = Number(body.TEMPERATURE);
                    const temperature = Number.isFinite(rawTemp)
                        ? rawTemp
                        : config.defaultTemperature;
                    const enableThinking =
                        body.THINKING === undefined
                            ? config.enableThinking
                            : Boolean(body.THINKING);
                    const { shrinkRagOnBody } = await import("./ragContext.js");
                    if (!body._rag) {
                        const pack = await loadRagForRequest(body);
                        body._rag = {
                            hits: pack.hits,
                            context: pack.context,
                            sources: pack.sources,
                            strict: pack.strict,
                            topK: pack.topK,
                        };
                    }
                    shrinkRagOnBody(body, 0.4);
                    logger.warn(
                        `chat(stream) RAG 컨텍스트 초과 → 문서 축소 후 파이프라인 재시도: ${err.message}`,
                    );
                    send("meta", {
                        mode: "workflow",
                        reason: "컨텍스트 초과 → RAG 문서 축소 재시도",
                        fallback: "rag-shrink",
                    });
                    const plan = await createPlan(body);
                    const useWorkflow =
                        plan.mode === "workflow" && plan.steps?.length > 1;
                    let out;
                    if (useWorkflow) {
                        out = await runWorkflow({
                            plan,
                            body,
                            temperature,
                            enableThinking,
                            onEvent: (ev) => {
                                if (ev.type === "plan") send("workflow", ev);
                                else if (ev.type === "rag")
                                    send("meta", {
                                        rag: true,
                                        sources: ev.sources,
                                        hits: ev.hits,
                                        strict: ev.strict,
                                    });
                                else if (ev.type === "step_start")
                                    send("step", { ...ev, status: "start" });
                                else if (ev.type === "step_done")
                                    send("step", { ...ev, status: "done" });
                                else if (ev.type === "token")
                                    send("token", { text: ev.text });
                            },
                        });
                    } else {
                        const messages = await buildRagMessages({
                            q,
                            hits: body._rag.hits,
                            strict: body._rag.strict,
                            questionContent: body.content,
                            system:
                                typeof body.ROLE_SYSTEM === "string"
                                    ? body.ROLE_SYSTEM
                                    : undefined,
                            history: body.HISTORY,
                            memoryContext: body._memory?.context,
                        });
                        const streamOut = await pool.chatStream({
                            messages,
                            temperature,
                            maxTokens: config.maxTokensSmall,
                            enableThinking: false,
                            preferredTier: plan.tier || "medium",
                            onToken: (t) => send("token", { text: t }),
                        });
                        out = {
                            answer: streamOut.content,
                            reasoning: streamOut.reasoning,
                            model: streamOut.model,
                            tier: streamOut.tier,
                            device: streamOut.device,
                            alias: streamOut.alias,
                            backend: streamOut.backendUrl,
                            usage: streamOut.usage,
                            ttftMs: streamOut.ttftMs,
                            totalMs: streamOut.totalMs,
                            tokens: streamOut.tokenCount,
                            steps: [],
                            trace: [],
                            sources: body._rag.sources,
                            strict: body._rag.strict,
                        };
                    }
                    const sec = await withSecurityPreFinal(q, out.answer, {
                        onEvent: securityEventBridge(send),
                        stepIndex: Array.isArray(out.steps)
                            ? out.steps.length
                            : 0,
                    });
                    send("done", {
                        answer: sec.answer,
                        reasoning: out.reasoning || undefined,
                        model: out.model ?? config.modelName,
                        tier: out.tier,
                        device: out.device,
                        alias: out.alias || undefined,
                        backend: out.backend,
                        totalMs: Date.now() - started,
                        mode: useWorkflow ? "workflow" : "direct",
                        routeReason: "RAG 컨텍스트 축소 재시도",
                        workflowSteps: pipelineStepsOnly(out.steps),
                        workflowTrace: [
                            ...(out.trace || []),
                            ...sec.traceExtra,
                        ],
                        ...ragResponseFields(body, {
                            sources: out.sources,
                            strict: out.strict,
                        }),
                    });
                    appendHistory({
                        id:
                            Date.now().toString(36) +
                            Math.random().toString(36).slice(2, 8),
                        ts: new Date().toISOString(),
                        user: q,
                        answer: sec.answer,
                        model: out.model ?? config.modelName,
                        tier: out.tier,
                        mode: useWorkflow ? "workflow" : "direct",
                        workflowSteps: pipelineStepsOnly(out.steps),
                        workflowTrace: out.trace,
                        ...ragResponseFields(body, {
                            sources: out.sources,
                            strict: out.strict,
                        }),
                    }).catch((e) =>
                        logger.error(`history 저장 실패: ${e.message}`),
                    );
                    persistChatMemory(body, q, sec.answer);
                    return res.end();
                } catch (err2) {
                    logger.error(
                        `chat(stream) RAG 축소 재시도 실패: ${err2.message}`,
                    );
                    send("error", {
                        error:
                            "문서+파이프라인 입력이 모델 컨텍스트를 초과했습니다. 질문을 짧게 하거나 문서만 답변(단일 RAG)을 사용해 주세요.",
                        detail: err2.message,
                        status: 413,
                    });
                    return res.end();
                }
            }
            try {
                const body = req.body ?? {};
                const q =
                    typeof body.ROLE_USER === "string" ? body.ROLE_USER : "";
                const rawTemp = Number(body.TEMPERATURE);
                const temperature = Number.isFinite(rawTemp)
                    ? rawTemp
                    : config.defaultTemperature;
                const enableThinking =
                    body.THINKING === undefined
                        ? config.enableThinking
                        : Boolean(body.THINKING);
                logger.warn(
                    `chat(stream) 컨텍스트 초과 → 맵리듀스 재시도: ${err.message}`,
                );
                send("meta", {
                    mode: "workflow",
                    reason: "컨텍스트 초과 → 청크 맵리듀스 자동 전환",
                    fallback: "long",
                });
                const out = await runLongContent({
                    body,
                    temperature,
                    onEvent: (ev) => {
                        if (ev.type === "plan") {
                            send("workflow", ev);
                        } else if (ev.type === "step_start")
                            send("step", { ...ev, status: "start" });
                        else if (ev.type === "step_done")
                            send("step", { ...ev, status: "done" });
                        else if (ev.type === "step_meta") send("meta", ev);
                        else if (ev.type === "token")
                            send("token", { text: ev.text });
                    },
                });
                const sec = await withSecurityPreFinal(q, out.answer, {
                    onEvent: securityEventBridge(send),
                    stepIndex: Array.isArray(out.steps) ? out.steps.length : 0,
                });
                const answer = sec.answer;
                const genMs =
                    out.ttftMs != null
                        ? Math.max((out.totalMs ?? 0) - out.ttftMs, 1)
                        : out.totalMs;
                const tokens = out.tokens;
                const tokensPerSec =
                    tokens && genMs
                        ? Number((tokens / (genMs / 1000)).toFixed(1))
                        : null;
                send("done", {
                    answer,
                    reasoning: out.reasoning || undefined,
                    model: out.model ?? config.modelName,
                    tier: out.tier,
                    device: out.device,
                    alias: out.alias || undefined,
                    difficulty: 100,
                    backend: out.backend,
                    ttftMs: out.ttftMs,
                    totalMs: Date.now() - started,
                    tokens,
                    tokensPerSec,
                    usage: out.usage ?? null,
                    mode: "workflow",
                    routeReason: out.plan?.reason || "컨텍스트 초과 맵리듀스",
                    workflowSteps: pipelineStepsOnly(out.steps),
                    workflowTrace: [
                        ...(out.trace || []),
                        ...sec.traceExtra,
                    ],
                });
                appendHistory({
                    id:
                        Date.now().toString(36) +
                        Math.random().toString(36).slice(2, 8),
                    ts: new Date().toISOString(),
                    system:
                        typeof body.ROLE_SYSTEM === "string"
                            ? body.ROLE_SYSTEM
                            : "",
                    user: body.ROLE_USER,
                    hasImage: false,
                    temperature,
                    thinking: enableThinking,
                    tier: out.tier,
                    routedTier: out.tier,
                    routeReason: out.plan?.reason || "컨텍스트 초과 맵리듀스",
                    device: out.device,
                    alias: out.alias || null,
                    difficulty: 100,
                    backend: out.backend,
                    model: out.model ?? config.modelName,
                    answer,
                    reasoning: out.reasoning || "",
                    usage: out.usage ?? null,
                    mode: "workflow",
                    workflowSteps: pipelineStepsOnly(out.steps),
                    workflowTrace: [
                        ...(out.trace || []),
                        ...sec.traceExtra,
                    ],
                }).catch((e) =>
                    logger.error(`history 저장 실패: ${e.message}`),
                );
                persistChatMemory(body, body.ROLE_USER, answer);
                logger.info(
                    `chat(stream/long-fallback) ${Date.now() - started}ms`,
                );
                return res.end();
            } catch (err2) {
                logger.error(
                    `chat(stream) 맵리듀스 재시도 실패: ${err2.message}`,
                );
                send("error", {
                    error:
                        "입력/대화가 모델 컨텍스트 한도를 초과했고, 분할 처리에도 실패했습니다.",
                    detail: err2.message,
                    status: 413,
                });
                return res.end();
            }
        }
        logger.error(
            `chat(stream) 실패 (${Date.now() - started}ms): ${err.message}`,
        );
        send("error", {
            error: err.message,
            status: err.status || 502,
            security: err.security || undefined,
        });
        res.end();
    }
});

/**
 * 모델 스트레스 테스트: HTTP 1회 → 서버에서 모델 호출 COUNT 회.
 * 기본 SSE 스트리밍: 건마다 event:result, 마지막 event:done
 * body.STREAM=false 이면 기존 JSON 일괄 응답
 */
app.post("/api/chat/stress", async (req, res) => {
    const started = Date.now();
    const body = req.body ?? {};
    const wantStream =
        body.STREAM !== false &&
        body.STREAM !== "false" &&
        body.STREAM !== 0 &&
        body.STREAM !== "0";

    const send = (event, data) => {
        if (!wantStream) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const q = typeof body.ROLE_USER === "string" ? body.ROLE_USER : "";
        if (!q.trim()) {
            if (wantStream) {
                res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders?.();
                send("error", { error: "ROLE_USER 는 필수입니다." });
                return res.end();
            }
            return res.status(400).json({ error: "ROLE_USER 는 필수입니다." });
        }
        const rawCount = Number(body.COUNT ?? body.STRESS_COUNT ?? 1);
        const count = Math.min(
            32,
            Math.max(1, Math.floor(Number.isFinite(rawCount) ? rawCount : 1)),
        );
        const mode =
            String(body.MODE || body.STRESS_MODE || "parallel").toLowerCase() ===
            "serial"
                ? "serial"
                : "parallel";

        const rawTemp = Number(body.TEMPERATURE);
        const temperature = Number.isFinite(rawTemp)
            ? rawTemp
            : config.defaultTemperature;
        const enableThinking =
            body.THINKING === undefined
                ? config.enableThinking
                : Boolean(body.THINKING);

        if (wantStream) {
            res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.flushHeaders?.();
        }

        logger.info(
            `요청 수신 [chat/stress] "${q.slice(0, 60)}" ×${count} (${mode}` +
                `${wantStream ? ", stream" : ""})`,
        );

        const plan = await createPlan(body);
        const tier = plan.tier;
        const isLarge = tier === "large";
        const promptCharBudget = isLarge
            ? config.maxPromptCharsLarge
            : config.maxPromptCharsSmall;
        const messages = await buildMessages(body, promptCharBudget);
        const maxTokensLarge = config.defaultMaxTokens;
        const maxTokensSmall = config.maxTokensSmall;

        send("meta", {
            mode: "stress",
            count,
            preferredTier: tier,
            difficulty: plan.difficulty ?? null,
            routeReason: plan.reason,
            loadDemoteMaxDifficulty: config.loadDemoteMaxDifficulty,
        });

        const out = await pool.stressChat({
            count,
            mode,
            messages,
            temperature,
            maxTokens: isLarge ? maxTokensLarge : maxTokensSmall,
            maxTokensSmall,
            maxTokensByTier: {
                large: maxTokensLarge,
                medium: maxTokensSmall,
                small: maxTokensSmall,
            },
            enableThinking,
            preferredTier: tier,
            preferredDevice: plan.device,
            preferredSkill: plan.skill ?? null,
            allowOtherTiers: config.escalateTier,
            preview: q.slice(0, 120),
            loadAwareBody: body,
            loadAwareRoute: {
                tier: plan.tier,
                reason: plan.reason,
                difficulty: plan.difficulty,
                device: plan.device,
                skill: plan.skill ?? null,
            },
            onResult: wantStream
                ? (row) => {
                      send("result", row);
                  }
                : null,
        });

        const ms = Date.now() - started;
        logger.info(
            `chat/stress 완료 ${count}회 ${ms}ms ` +
                `preferred=${tier} byTier=${JSON.stringify(out.summary?.byTier || {})} ` +
                `demote=${out.summary?.loadDemoted ?? 0}`,
        );
        const payload = {
            mode: "stress",
            stressMode: out.mode,
            count: out.count,
            routedTier: tier,
            preferredTier: tier,
            difficulty: plan.difficulty ?? null,
            routeReason: plan.reason,
            loadDemoteMaxDifficulty: config.loadDemoteMaxDifficulty,
            summary: out.summary,
            results: out.results,
            ms,
        };

        const byTier = out.summary?.byTier || {};
        const answerSummary =
            `스트레스 ${out.count}회 완료` +
            (byTier.large != null || byTier.medium != null
                ? ` · large ${byTier.large || 0} / medium ${byTier.medium || 0}`
                : "") +
            (out.summary?.loadDemoted
                ? ` · demote ${out.summary.loadDemoted}`
                : "") +
            (out.summary?.wallMs != null ? ` · ${out.summary.wallMs}ms` : "");

        appendHistory({
            id:
                Date.now().toString(36) +
                Math.random().toString(36).slice(2, 8),
            ts: new Date().toISOString(),
            user: q,
            answer: answerSummary,
            mode: "stress",
            stressMode: out.mode,
            count: out.count,
            preferredTier: tier,
            routedTier: tier,
            difficulty: plan.difficulty ?? null,
            routeReason: plan.reason,
            summary: out.summary,
            results: out.results,
            ms,
        }).catch((e) => logger.error(`stress history 저장 실패: ${e.message}`));

        if (wantStream) {
            send("done", payload);
            return res.end();
        }
        return res.json(payload);
    } catch (err) {
        logger.error(
            `chat/stress 실패 (${Date.now() - started}ms): ${err.message}`,
        );
        if (wantStream) {
            try {
                send("error", { error: err.message });
                return res.end();
            } catch {
                /* ignore */
            }
        }
        if (!res.headersSent) {
            res.status(err.status || 502).json({
                error: err.message,
                mode: "stress",
            });
        }
    }
});

app.post("/api/chat", async (req, res) => {
    const started = Date.now();
    try {
        const body = req.body ?? {};
        const q = typeof body.ROLE_USER === "string" ? body.ROLE_USER : "";
        logger.info(
            `요청 수신 [chat] "${q.slice(0, 60)}" (len=${q.length}, memory=${Array.isArray(body.HISTORY) ? body.HISTORY.length : 0}턴)`,
        );
        const rawTemp = Number(body.TEMPERATURE);
        const temperature = Number.isFinite(rawTemp)
            ? rawTemp
            : config.defaultTemperature;
        const enableThinking =
            body.THINKING === undefined
                ? config.enableThinking
                : Boolean(body.THINKING);

        await prepareChatMemory(body);

        const ragPrep = await prepareChatRag(body);
        if (ragPrep.emptyStrict) {
            const payload = {
                answer: ragPrep.answer,
                model: config.modelName,
                mode: "direct",
                ...ragResponseFields(body),
            };
            appendHistory({
                id:
                    Date.now().toString(36) +
                    Math.random().toString(36).slice(2, 8),
                ts: new Date().toISOString(),
                user: q,
                answer: payload.answer,
                model: payload.model,
                mode: "direct",
                ...ragResponseFields(body),
            }).catch((e) => logger.error(`history 저장 실패: ${e.message}`));
            persistChatMemory(body, q, payload.answer);
            return res.json(payload);
        }

        // 긴 입력(컨텍스트 초과) → 청크 맵리듀스 (RAG 는 검색 컨텍스트만 사용)
        if (!ragPrep.active && needsLongPipeline(body)) {
            logger.info(`긴 입력 감지 [chat] ${q.length}자 → 맵리듀스 파이프라인`);
            const out = await runLongContent({ body, temperature });
            const sec = await withSecurityPreFinal(q, out.answer, {
                stepIndex: Array.isArray(out.steps) ? out.steps.length : 0,
            });
            const workflowSteps = pipelineStepsOnly(out.steps);
            const workflowTrace = [
                ...(out.trace || []),
                ...sec.traceExtra,
            ];
            const entry = {
                id:
                    Date.now().toString(36) +
                    Math.random().toString(36).slice(2, 8),
                ts: new Date().toISOString(),
                system:
                    typeof body.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "",
                user: body.ROLE_USER,
                hasImage: false,
                temperature,
                thinking: enableThinking,
                tier: out.tier,
                routedTier: out.tier,
                routeReason: out.plan.reason,
                device: out.device,
                alias: out.alias || null,
                difficulty: 100,
                backend: out.backend,
                model: out.model ?? config.modelName,
                answer: sec.answer,
                reasoning: out.reasoning || "",
                usage: out.usage ?? null,
                mode: "workflow",
                workflowSteps,
                workflowTrace,
            };
            appendHistory(entry).catch((e) =>
                logger.error(`history 저장 실패: ${e.message}`),
            );
            persistChatMemory(body, body.ROLE_USER, sec.answer);
            logger.info(
                `chat(long) ${out.steps.length}단계 ${Date.now() - started}ms`,
            );
            return res.json({
                id: entry.id,
                ts: entry.ts,
                answer: sec.answer,
                reasoning: out.reasoning || undefined,
                model: entry.model,
                tier: out.tier,
                routedTier: out.tier,
                routeReason: out.plan.reason,
                device: out.device,
                alias: out.alias || undefined,
                difficulty: 100,
                backend: out.backend,
                usage: out.usage ?? null,
                mode: "workflow",
                workflowSteps,
                workflowTrace,
            });
        }

        const plan = await createPlan(body);
        const useWorkflow = plan.mode === "workflow" && plan.steps?.length > 1;

        if (useWorkflow) {
            logger.info(
                `워크플로우 [chat] → ${plan.steps.map((s) => s.tier).join("→")} (${plan.reason})`,
            );
            const out = await runWorkflow({
                plan,
                body,
                temperature,
                enableThinking,
            });
            const entry = {
                id:
                    Date.now().toString(36) +
                    Math.random().toString(36).slice(2, 8),
                ts: new Date().toISOString(),
                system:
                    typeof body.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "",
                user: body.ROLE_USER,
                hasImage: !!(
                    body.content !== undefined &&
                    body.content !== null &&
                    body.content !== ""
                ),
                temperature,
                thinking: enableThinking,
                tier: out.tier,
                routedTier: plan.tier,
                routeReason: plan.reason,
                device: out.device,
                alias: out.alias || null,
                difficulty: plan.difficulty,
                backend: out.backend,
                model: out.model ?? config.modelName,
                answer: out.answer,
                reasoning: out.reasoning || "",
                usage: out.usage ?? null,
                mode: "workflow",
                routeReason: plan.reason,
                routerBackend: plan.routerBackend || null,
                routerTier: plan.routerTier || null,
                routerAlias: plan.routerAlias || null,
                routerDevice: plan.routerDevice || null,
                routerModel: plan.routerModel || null,
                workflowSteps: pipelineStepsOnly(out.steps),
                workflowTrace: out.trace,
                ...ragResponseFields(body, {
                    sources: out.sources,
                    strict: out.strict,
                }),
            };
            appendHistory(entry).catch((e) =>
                logger.error(`history 저장 실패: ${e.message}`),
            );
            persistChatMemory(body, body.ROLE_USER, out.answer);
            logger.info(
                `chat(workflow) ${plan.steps.map((s) => s.tier).join("→")} ${Date.now() - started}ms`,
            );
            return res.json({
                id: entry.id,
                ts: entry.ts,
                answer: out.answer,
                reasoning: out.reasoning || undefined,
                model: entry.model,
                tier: out.tier,
                routedTier: plan.tier,
                routeReason: plan.reason,
                device: out.device,
                alias: out.alias || undefined,
                difficulty: plan.difficulty,
                backend: out.backend,
                usage: out.usage ?? null,
                mode: "workflow",
                routerBackend: plan.routerBackend || null,
                routerTier: plan.routerTier || null,
                routerAlias: plan.routerAlias || null,
                routerDevice: plan.routerDevice || null,
                routerModel: plan.routerModel || null,
                workflowSteps: pipelineStepsOnly(out.steps),
                workflowTrace: out.trace,
                ...ragResponseFields(body, {
                    sources: out.sources,
                    strict: out.strict,
                }),
            });
        }

        let tier = plan.tier;
        let reason = plan.reason;
        let device = plan.device;
        const difficulty = plan.difficulty;
        const deviceReason = plan.deviceReason;
        const routerBackend = plan.routerBackend;
        let allowOtherTiers = config.escalateTier;
        let messages;
        if (ragPrep.active) {
            const ragRoute = await chooseRagRoute({
                q,
                hits: body._rag.hits,
                questionContent: body.content,
                body,
            });
            const rank = { small: 0, medium: 1, large: 2 };
            tier =
                (rank[ragRoute.tier] ?? 0) >= (rank[plan.tier] ?? 0)
                    ? ragRoute.tier
                    : plan.tier;
            device = ragRoute.device ?? plan.device;
            allowOtherTiers =
                ragRoute.allowOtherTiers ?? config.escalateTier;
            reason = `${ragRoute.reason}; plan=${plan.reason}`;
            messages = await buildRagMessages({
                q,
                hits: body._rag.hits,
                strict: body._rag.strict,
                questionContent: body.content,
                system:
                    typeof body.ROLE_SYSTEM === "string"
                        ? body.ROLE_SYSTEM
                        : undefined,
                history: body.HISTORY,
                memoryContext: body._memory?.context,
            });
            logger.info(
                `라우팅 [chat/rag] → tier=${tier} (${reason})`,
            );
        } else {
            logger.info(
                `라우팅 [chat] → tier=${tier}${plan.skill ? ` skill="${plan.skill}"` : ""} device=${device} 난이도=${difficulty}${routerBackend ? ` router@${routerBackend}` : ""} (티어사유: ${reason} / 장치사유: ${deviceReason})`,
            );
            const isLarge = tier === "large";
            const promptCharBudget = isLarge
                ? config.maxPromptCharsLarge
                : config.maxPromptCharsSmall;
            messages = await buildMessages(body, promptCharBudget);
        }

        // 티어별 출력 토큰 (large 만 큰 ctx 가정)
        const isLarge = tier === "large";
        const maxTokens = isLarge
            ? config.defaultMaxTokens
            : config.maxTokensSmall;

        let usedTier;
        let usedDevice;
        let usedAlias;
        let usedSkill = plan.skill ?? null;
        let backendUrl;
        let result;
        if (!ragPrep.active) {
            const guarded = await chatWithEchoGuard({
                body,
                messages,
                temperature,
                maxTokens,
                enableThinking,
                preferredTier: tier,
                preferredDevice: device,
                preferredSkill: plan.skill ?? null,
                allowOtherTiers,
            });
            result = {
                content: guarded.content,
                reasoning: guarded.reasoning,
                usage: guarded.usage,
                ttftMs: guarded.ttftMs,
                raw: { model: guarded.model },
            };
            usedTier = guarded.tier;
            usedDevice = guarded.device;
            usedAlias = guarded.alias;
            backendUrl = guarded.backendUrl;
            usedSkill = plan.skill ?? null;
        } else {
            const chatOut = await pool.chat({
                messages,
                temperature,
                maxTokens,
                enableThinking: false,
                preferredTier: tier,
                preferredDevice: device,
                preferredSkill: plan.skill ?? null,
                allowOtherTiers,
            });
            result = chatOut.result;
            backendUrl = chatOut.backendUrl;
            usedTier = chatOut.tier;
            usedDevice = chatOut.device;
            usedAlias = chatOut.alias;
            usedSkill = chatOut.skill;
        }

        const sec = await withSecurityPreFinal(q, result.content, {
            stepIndex: 1,
        });
        const workflowTrace = [
            {
                kind: "model",
                i: 1,
                role: "answer",
                tier: usedTier,
                device: usedDevice,
                alias: usedAlias || null,
                backend: backendUrl,
                model: result.raw?.model,
                output: result.content,
                isLast: true,
            },
            ...sec.traceExtra,
        ];

        const entry = {
            id:
                Date.now().toString(36) +
                Math.random().toString(36).slice(2, 8),
            ts: new Date().toISOString(),
            system:
                typeof body.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "",
            user: body.ROLE_USER,
            hasImage: !!(
                body.content !== undefined &&
                body.content !== null &&
                body.content !== ""
            ),
            temperature,
            thinking: enableThinking,
            tier: usedTier,
            routedTier: tier,
            routeReason: reason,
            device: usedDevice,
            routedDevice: device,
            alias: usedAlias || null,
            skill: usedSkill || null,
            routedSkill: plan.skill ?? null,
            difficulty,
            deviceReason,
            backend: backendUrl,
            model: result.raw?.model ?? config.modelName,
            answer: sec.answer,
            reasoning: result.reasoning || "",
            usage: result.raw?.usage ?? null,
            mode: "direct",
            routerBackend: plan.routerBackend || routerBackend || null,
            routerTier: plan.routerTier || null,
            routerAlias: plan.routerAlias || null,
            routerDevice: plan.routerDevice || null,
            routerModel: plan.routerModel || null,
            workflowTrace,
            ...ragResponseFields(body),
        };
        logger.info(
            `chat 성공 tier=${usedTier} device=${usedDevice ?? "-"} diff=${difficulty} backend=${backendUrl} ${Date.now() - started}ms`,
            {
                tier: usedTier,
                device: usedDevice,
                backend: backendUrl,
                ms: Date.now() - started,
            },
        );

        // 저장 실패가 응답을 막지 않도록 best-effort
        appendHistory(entry).catch((e) =>
            logger.error(`history 저장 실패: ${e.message}`),
        );
        persistChatMemory(body, body.ROLE_USER, sec.answer);

        res.json({
            id: entry.id,
            ts: entry.ts,
            answer: sec.answer,
            reasoning: result.reasoning || undefined,
            model: entry.model,
            tier: usedTier,
            routedTier: tier,
            routeReason: reason,
            device: usedDevice,
            routedDevice: device,
            alias: usedAlias || undefined,
            skill: usedSkill || undefined,
            routedSkill: plan.skill ?? undefined,
            difficulty,
            deviceReason,
            backend: backendUrl,
            usage: result.raw?.usage ?? null,
            mode: "direct",
            routerBackend: plan.routerBackend || routerBackend || null,
            routerTier: plan.routerTier || null,
            routerAlias: plan.routerAlias || null,
            routerDevice: plan.routerDevice || null,
            routerModel: plan.routerModel || null,
            workflowTrace,
            ...ragResponseFields(body),
        });
    } catch (err) {
        if (
            isContextOverflowError(err) &&
            !(req.body?.content !== undefined &&
                req.body?.content !== null &&
                req.body?.content !== "")
        ) {
            const body0 = req.body ?? {};
            if (isRagRequest(body0) || body0._rag) {
                try {
                    const body = body0;
                    const q =
                        typeof body.ROLE_USER === "string"
                            ? body.ROLE_USER
                            : "";
                    const rawTemp = Number(body.TEMPERATURE);
                    const temperature = Number.isFinite(rawTemp)
                        ? rawTemp
                        : config.defaultTemperature;
                    const enableThinking =
                        body.THINKING === undefined
                            ? config.enableThinking
                            : Boolean(body.THINKING);
                    const { shrinkRagOnBody } = await import("./ragContext.js");
                    if (!body._rag) {
                        const pack = await loadRagForRequest(body);
                        body._rag = {
                            hits: pack.hits,
                            context: pack.context,
                            sources: pack.sources,
                            strict: pack.strict,
                            topK: pack.topK,
                        };
                    }
                    shrinkRagOnBody(body, 0.4);
                    logger.warn(
                        `chat RAG 컨텍스트 초과 → 문서 축소 재시도: ${err.message}`,
                    );
                    const plan = await createPlan(body);
                    const useWorkflow =
                        plan.mode === "workflow" && plan.steps?.length > 1;
                    let out;
                    if (useWorkflow) {
                        out = await runWorkflow({
                            plan,
                            body,
                            temperature,
                            enableThinking,
                        });
                    } else {
                        const messages = await buildRagMessages({
                            q,
                            hits: body._rag.hits,
                            strict: body._rag.strict,
                            questionContent: body.content,
                            system:
                                typeof body.ROLE_SYSTEM === "string"
                                    ? body.ROLE_SYSTEM
                                    : undefined,
                            history: body.HISTORY,
                            memoryContext: body._memory?.context,
                        });
                        const {
                            result,
                            backendUrl,
                            tier,
                            device,
                            alias,
                        } = await pool.chat({
                            messages,
                            temperature,
                            maxTokens: config.maxTokensSmall,
                            enableThinking: false,
                            preferredTier: plan.tier || "medium",
                        });
                        out = {
                            answer: result.content,
                            reasoning: result.reasoning,
                            model: result.raw?.model,
                            tier,
                            device,
                            alias,
                            backend: backendUrl,
                            usage: result.raw?.usage,
                            steps: [],
                            trace: [],
                            sources: body._rag.sources,
                            strict: body._rag.strict,
                        };
                    }
                    const sec = await withSecurityPreFinal(q, out.answer, {
                        stepIndex: Array.isArray(out.steps)
                            ? out.steps.length
                            : 0,
                    });
                    return res.json({
                        answer: sec.answer,
                        reasoning: out.reasoning || undefined,
                        model: out.model ?? config.modelName,
                        tier: out.tier,
                        device: out.device,
                        alias: out.alias || undefined,
                        backend: out.backend,
                        mode: useWorkflow ? "workflow" : "direct",
                        routeReason: "RAG 컨텍스트 축소 재시도",
                        workflowSteps: pipelineStepsOnly(out.steps),
                        workflowTrace: out.trace,
                        ...ragResponseFields(body, {
                            sources: out.sources,
                            strict: out.strict,
                        }),
                    });
                } catch (err2) {
                    return res.status(413).json({
                        error:
                            "문서+파이프라인 입력이 모델 컨텍스트를 초과했습니다. 질문을 짧게 하거나 단일 RAG를 사용해 주세요.",
                        detail: err2.message,
                    });
                }
            }
            try {
                const body = req.body ?? {};
                const q =
                    typeof body.ROLE_USER === "string" ? body.ROLE_USER : "";
                const rawTemp = Number(body.TEMPERATURE);
                const temperature = Number.isFinite(rawTemp)
                    ? rawTemp
                    : config.defaultTemperature;
                const enableThinking =
                    body.THINKING === undefined
                        ? config.enableThinking
                        : Boolean(body.THINKING);
                logger.warn(
                    `chat 컨텍스트 초과 → 맵리듀스 재시도: ${err.message}`,
                );
                const out = await runLongContent({ body, temperature });
                const sec = await withSecurityPreFinal(q, out.answer, {
                    stepIndex: Array.isArray(out.steps) ? out.steps.length : 0,
                });
                const workflowSteps = pipelineStepsOnly(out.steps);
                const workflowTrace = [
                    ...(out.trace || []),
                    ...sec.traceExtra,
                ];
                const entry = {
                    id:
                        Date.now().toString(36) +
                        Math.random().toString(36).slice(2, 8),
                    ts: new Date().toISOString(),
                    system:
                        typeof body.ROLE_SYSTEM === "string"
                            ? body.ROLE_SYSTEM
                            : "",
                    user: body.ROLE_USER,
                    hasImage: false,
                    temperature,
                    thinking: enableThinking,
                    tier: out.tier,
                    routedTier: out.tier,
                    routeReason:
                        out.plan?.reason || "컨텍스트 초과 맵리듀스",
                    device: out.device,
                    alias: out.alias || null,
                    difficulty: 100,
                    backend: out.backend,
                    model: out.model ?? config.modelName,
                    answer: sec.answer,
                    reasoning: out.reasoning || "",
                    usage: out.usage ?? null,
                    mode: "workflow",
                    workflowSteps,
                    workflowTrace,
                };
                appendHistory(entry).catch((e) =>
                    logger.error(`history 저장 실패: ${e.message}`),
                );
                persistChatMemory(body, body.ROLE_USER, sec.answer);
                logger.info(
                    `chat(long-fallback) ${out.steps.length}단계 ${Date.now() - started}ms`,
                );
                return res.json({
                    id: entry.id,
                    ts: entry.ts,
                    answer: sec.answer,
                    reasoning: out.reasoning || undefined,
                    model: entry.model,
                    tier: out.tier,
                    routedTier: out.tier,
                    routeReason: entry.routeReason,
                    device: out.device,
                    alias: out.alias || undefined,
                    difficulty: 100,
                    backend: out.backend,
                    usage: out.usage ?? null,
                    mode: "workflow",
                    workflowSteps,
                    workflowTrace,
                });
            } catch (err2) {
                logger.warn(
                    `chat 맵리듀스 재시도 실패: ${err2.message}`,
                );
                return res.status(413).json({
                    error:
                        "입력/대화가 모델 컨텍스트 한도를 초과했고, 분할 처리에도 실패했습니다. 질문을 줄여주세요.",
                    detail: err2.message,
                });
            }
        }
        if (/exceed_context_size|context size/.test(err.message)) {
            logger.warn(`chat 컨텍스트 초과: ${err.message}`);
            return res.status(413).json({
                error: "입력/대화가 모델 컨텍스트 한도를 초과했습니다. 대화를 초기화하거나 질문을 줄여주세요.",
                detail: err.message,
            });
        }
        if (err.status === 403) {
            return res.status(403).json({
                error: err.message,
                security: err.security || undefined,
            });
        }
        const isClientError =
            /필수|문자열|확장자|이미지/.test(err.message) && !err.retryable;
        logger.error(`chat 실패 (${Date.now() - started}ms): ${err.message}`);
        res.status(isClientError ? 400 : 502).json({ error: err.message });
    }
});

// ===== RAG: 문서 기반 질의응답 =====================================

const RAG_IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
};

function isRagImageFile(filename) {
    return rag.IMAGE_EXT.has(path.extname(String(filename)).toLowerCase());
}

function bufferToDataUrl(buffer, ext) {
    const mime = RAG_IMAGE_MIME[ext.toLowerCase()] || "image/jpeg";
    return `data:${mime};base64,${buffer.toString("base64")}`;
}

function ragSystemPrompt(strict, withVision, userSystem, question = "") {
    return ragSystemAddon(strict, withVision, question, userSystem);
}

async function buildRagUserContent(q, context, hits, questionContent, history, memoryContext) {
    let text = context
        ? `참고 문서:\n${context}\n\n질문: ${q}`
        : q;
    const mem =
        typeof memoryContext === "string" && memoryContext.trim()
            ? memoryContext.trim()
            : "";
    if (mem) {
        text = `${mem}\n\n${text}`;
    }
    if (Array.isArray(history) && history.length) {
        const hist = formatHistorySnippet(history, {
            maxTurns: 4,
            perTurnMax: 280,
        });
        if (hist) text = `최근 대화:\n${hist}\n\n${text}`;
    }

    const imageFiles = new Set();
    for (const h of hits || []) {
        if (h.imageFile) imageFiles.add(h.imageFile);
    }

    const hasQuestionImage =
        questionContent !== undefined &&
        questionContent !== null &&
        questionContent !== "";
    const hasDocImages = imageFiles.size > 0;

    if (!hasQuestionImage && !hasDocImages) return text;

    const parts = [{ type: "text", text }];
    for (const file of imageFiles) {
        parts.push({
            type: "image_url",
            image_url: { url: await rag.readImageDataUrl(file) },
        });
    }
    if (hasQuestionImage) {
        const imgs = Array.isArray(questionContent)
            ? questionContent
            : [questionContent];
        for (const img of imgs) {
            parts.push({
                type: "image_url",
                image_url: { url: await toImageUrl(img) },
            });
        }
    }
    return parts;
}

async function buildRagMessages({
    q,
    hits,
    strict,
    questionContent,
    system,
    history,
    memoryContext,
}) {
    const context =
        hits?.length > 0 ? formatRagContext(hits) : "";

    const hasVision =
        (hits || []).some((h) => h.imageFile) ||
        (questionContent !== undefined &&
            questionContent !== null &&
            questionContent !== "");

    const memCtx =
        typeof memoryContext === "string"
            ? memoryContext
            : "";

    const userContent = await buildRagUserContent(
        q,
        context,
        hits,
        questionContent,
        history,
        memCtx,
    );

    const sysBase = ragSystemPrompt(strict, hasVision, system, q);
    const sysExtra = memCtx
        ? "\n\n또한 '개인 기억' 블록에 과거 사용자 사실이 있으면 관련될 때 활용하라. 목록에 없는 기억을 지어내지 마라."
        : "";

    return [
        {
            role: "system",
            content: sysBase + sysExtra,
        },
        {
            role: "user",
            content:
                typeof userContent === "string"
                    ? userContent + replyLanguageReminder(q)
                    : userContent,
        },
    ];
}

// RAG 프롬프트 오버헤드(시스템 프롬프트 + 출처 헤더) 근사치
const RAG_PROMPT_OVERHEAD = 400;

/**
 * RAG 질의 티어 결정.
 * - 이미지(출처 문서 or 질문 첨부) → large 고정 (비전은 large 만 가능)
 * - 검색 결과 없음(일반 지식 답변) → 일반 라우팅 적용 (간단하면 small)
 * - 텍스트 출처만: 컨텍스트+질문이 medium 예산 이내면 medium, 초과면 large
 */
async function chooseRagRoute({ q, hits, questionContent, body }) {
    const hasImage =
        (hits || []).some((h) => h.imageFile) ||
        (questionContent !== undefined &&
            questionContent !== null &&
            questionContent !== "");
    if (hasImage) {
        return {
            tier: "large",
            device: null,
            allowOtherTiers: false,
            reason: "이미지 출처/첨부 → 비전 모델 필요",
        };
    }

    if (!hits?.length) {
        const route = await chooseRoute({ ...(body ?? {}), ROLE_USER: q, content: undefined });
        return {
            tier: route.tier,
            device: route.device,
            allowOtherTiers: config.escalateTier,
            reason: `검색 결과 없음 → 일반 라우팅 (${route.reason})`,
        };
    }

    const promptChars =
        hits.reduce((s, h) => s + h.text.length + 40, 0) +
        q.length +
        RAG_PROMPT_OVERHEAD;
    // 해결 풀에 GPU large 가 있으면 우선(CPU medium 대비 TTFT↑). 없으면 medium 폴백.
    const preferLarge = pool.backends.some(
        (b) => b.tier === "large" && b.healthy && b.canChat,
    );
    if (preferLarge) {
        return {
            tier: "large",
            device: null,
            allowOtherTiers: config.escalateTier,
            reason: `텍스트 출처 ${hits.length}개, 프롬프트 ${promptChars}자 → GPU large 우선(스트리밍)`,
        };
    }
    return {
        tier: "medium",
        device: null,
        allowOtherTiers: config.escalateTier,
        reason: `텍스트 출처 ${hits.length}개, 프롬프트 ${promptChars}자 → large 없음, medium`,
    };
}

async function ragChat({
    q,
    hits,
    strict,
    questionContent,
    system,
    temperature = 0.3,
    route,
    history,
}) {
    const messages = await buildRagMessages({
        q,
        hits,
        strict,
        questionContent,
        system,
        history,
    });
    const tier = route?.tier ?? "large";
    return pool.chat({
        messages,
        temperature,
        maxTokens:
            tier === "large" ? config.defaultMaxTokens : config.maxTokensSmall,
        enableThinking: false,
        preferredTier: tier,
        preferredDevice: route?.device ?? null,
        allowOtherTiers: route?.allowOtherTiers ?? false,
    });
}

function ragSources(hits) {
    return buildRagSources(hits);
}

// RAG 대화도 새로고침 후 복원되도록 히스토리에 저장한다 (best-effort).
function persistRagHistory(q, payload) {
    appendHistory({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        ts: new Date().toISOString(),
        rag: true,
        strict: payload.strict,
        user: q,
        answer: payload.answer,
        model: payload.model ?? null,
        tier: payload.tier ?? null,
        device: payload.device ?? null,
        alias: payload.alias ?? null,
        sources: payload.sources || [],
    }).catch((e) => logger.error(`history 저장 실패: ${e.message}`));
}

// ---- 문서 요약 + 예상 질문 자동 생성 (업로드 시 best-effort) ----------

const INSIGHT_MAX_CHARS = 2500;

/**
 * 문서 텍스트를 LLM에 보내 2문장 요약과 예상 질문 3개를 만든다.
 * medium 티어 선호(빠름), 실패 시 null (문서 추가 자체는 막지 않음).
 */
async function generateDocInsights(name, text) {
    try {
        const { result } = await pool.chat({
            messages: [
                {
                    role: "system",
                    content:
                        "너는 문서 색인 도우미다. 반드시 JSON 객체 하나만 출력하라. 다른 설명은 금지.",
                },
                {
                    role: "user",
                    content:
                        `다음 문서를 읽고 이 형식의 JSON 으로만 답하라:\n` +
                        `{"summary":"핵심 내용 1~2문장 한국어 요약","questions":["이 문서로 답할 수 있는 자연스러운 한국어 질문 3개"]}\n\n` +
                        `[문서: ${name}]\n${String(text).slice(0, INSIGHT_MAX_CHARS)}`,
                },
            ],
            temperature: 0.3,
            maxTokens: 400,
            enableThinking: false,
            preferredTier: "medium",
        });
        const parsed = parseRouterJson(result.content);
        if (!parsed) return null;
        const summary =
            typeof parsed.summary === "string" ? parsed.summary.trim() : "";
        const questions = Array.isArray(parsed.questions)
            ? parsed.questions
                  .filter((s) => typeof s === "string" && s.trim())
                  .map((s) => s.trim())
                  .slice(0, 3)
            : [];
        if (!summary && !questions.length) return null;
        return { summary, questions };
    } catch (err) {
        logger.warn(`문서 요약 생성 실패("${name}"): ${err.message}`);
        return null;
    }
}

/** 문서 추가 직후 요약·예상 질문을 생성해 저장하고, 생성물을 반환한다 */
async function attachDocInsights(docId, name, text) {
    const insights = await generateDocInsights(name, text);
    if (insights) {
        await rag.updateDocumentMeta(docId, insights).catch(() => {});
        logger.info(
            `RAG 문서 요약 생성: "${name}" (예상 질문 ${insights.questions.length}개)`,
        );
    }
    return insights;
}

// 문서 목록 + 통계
app.get("/api/rag/docs", async (_req, res) => {
    try {
        await rag.load();
        res.json({ docs: rag.listDocuments(), stats: rag.stats() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 파일 업로드로 문서 추가 (pdf/docx/hwpx/hwp/txt/이미지 ...): multipart, field name="file"
app.post("/api/rag/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "파일이 필요합니다." });
        }
        const original = Buffer.from(req.file.originalname, "latin1").toString(
            "utf8",
        );
        const name =
            (req.body?.name && String(req.body.name).trim()) ||
            original.replace(/\.[^.]+$/, "");

        if (isRagImageFile(original)) {
            const ext = path.extname(original).toLowerCase();
            const dataUrl = bufferToDataUrl(req.file.buffer, ext);
            logger.info(`RAG 이미지 분석 중: "${original}"`);
            const description = await describeImageForRag(dataUrl);
            const info = await rag.addImageDocument(
                name,
                req.file.buffer,
                ext,
                description,
            );
            logger.info(
                `RAG 이미지 추가: "${info.name}" (${original}, 추출 ${description.length}자)`,
            );
            const insights = await attachDocInsights(
                info.id,
                info.name,
                description,
            );
            return res.json({
                ok: true,
                ...info,
                ...(insights ?? {}),
                chars: description.length,
                stats: rag.stats(),
            });
        }

        const text = await extractText(original, req.file.buffer);
        if (!text || !text.trim()) {
            throw new Error(
                "문서에서 텍스트를 추출하지 못했습니다. (스캔 PDF는 이미지 파일로 업로드하세요)",
            );
        }
        const info = await rag.addDocument(name, text);
        logger.info(
            `RAG 업로드: "${info.name}" (${original}, ${text.length}자, 청크 ${info.chunkCount}개)`,
        );
        const insights = await attachDocInsights(info.id, info.name, text);
        res.json({
            ok: true,
            ...info,
            ...(insights ?? {}),
            chars: text.length,
            stats: rag.stats(),
        });
    } catch (err) {
        logger.warn(`RAG 업로드 실패: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

// RAG 이미지 문서 미리보기
app.get("/api/rag/images/:docId", async (req, res) => {
    try {
        await rag.load();
        const doc = rag.listDocuments().find((d) => d.id === req.params.docId);
        if (!doc?.imageFile) {
            return res.status(404).json({ error: "이미지 문서를 찾을 수 없습니다." });
        }
        const filePath = rag.imagePath(doc.imageFile);
        const ext = path.extname(doc.imageFile).toLowerCase();
        res.type(RAG_IMAGE_MIME[ext] || "application/octet-stream");
        res.sendFile(filePath);
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// 문서 추가 ({ name, text })
app.post("/api/rag/docs", async (req, res) => {
    try {
        const { name, text } = req.body ?? {};
        const info = await rag.addDocument(name, text);
        logger.info(
            `RAG 문서 추가: "${info.name}" (청크 ${info.chunkCount}개)`,
        );
        const insights = await attachDocInsights(info.id, info.name, text);
        res.json({ ok: true, ...info, ...(insights ?? {}), stats: rag.stats() });
    } catch (err) {
        logger.warn(`RAG 문서 추가 실패: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

// 문서 삭제
app.delete("/api/rag/docs/:id", async (req, res) => {
    try {
        const r = await rag.deleteDocument(req.params.id);
        logger.info(`RAG 문서 삭제: ${req.params.id}`);
        res.json({ ok: true, ...r, stats: rag.stats() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 문서 기반 질문: 관련 청크 검색 → 컨텍스트로 주입 → LLM 답변(+출처)
app.post("/api/rag/ask", async (req, res) => {
    const started = Date.now();
    try {
        await rag.load();
        const q =
            typeof req.body?.q === "string"
                ? req.body.q
                : typeof req.body?.ROLE_USER === "string"
                  ? req.body.ROLE_USER
                  : "";
        if (!q.trim()) {
            return res.status(400).json({ error: "q (질문) 가 필요합니다." });
        }
        const topK = Number.isFinite(Number(req.body?.topK))
            ? Math.max(1, Math.min(8, Number(req.body.topK)))
            : 4;
        // strict=true(문서만 답변): 문서 밖 내용은 "문서 내용에 없습니다"로 답한다.
        const strict = req.body?.strict !== false;
        const questionContent = req.body?.content;
        const system =
            typeof req.body?.ROLE_SYSTEM === "string"
                ? req.body.ROLE_SYSTEM
                : undefined;
        const persist = (payload) => persistRagHistory(q, payload);

        const retrieveQ = ragRetrieveQuery({
            ROLE_USER: q,
            HISTORY: req.body?.HISTORY,
        });
        const hits = await rag.retrieveAsync(retrieveQ, topK);
        logger.info(
            `RAG 질문 "${q.slice(0, 50)}" (strict=${strict}) → 관련 청크 ${hits.length}개 검색` +
                (retrieveQ !== q ? ` (검색질의 보강 ${retrieveQ.length}자)` : ""),
        );

        // 관련 문서가 없을 때
        if (!hits.length) {
            if (strict) {
                const payload = {
                    answer: "문서 내용에 없습니다.",
                    sources: [],
                    strict,
                    elapsedMs: Date.now() - started,
                };
                persist(payload);
                return res.json(payload);
            }
            const route = await chooseRagRoute({
                q,
                hits: [],
                questionContent,
                body: req.body,
            });
            logger.info(`RAG 라우팅 → tier=${route.tier} (${route.reason})`);
            const { result, backendUrl, tier, device, alias } = await ragChat({
                q,
                hits: [],
                strict: false,
                questionContent,
                system,
                temperature: 0.4,
                route,
                history: req.body?.HISTORY,
            });
            const payload = {
                answer: result.content,
                sources: [],
                strict,
                model: result.raw?.model ?? config.modelName,
                tier,
                device,
                alias: alias || undefined,
                backend: backendUrl,
                elapsedMs: Date.now() - started,
            };
            persist(payload);
            return res.json(payload);
        }

        const route = await chooseRagRoute({
            q,
            hits,
            questionContent,
            body: req.body,
        });
        logger.info(`RAG 라우팅 → tier=${route.tier} (${route.reason})`);
        const { result, backendUrl, tier, device, alias } = await ragChat({
            q,
            hits,
            strict,
            questionContent,
            system,
            temperature: strict ? 0.2 : 0.4,
            route,
            history: req.body?.HISTORY,
        });

        logger.info(
            `RAG 답변 완료 tier=${tier} device=${device ?? "-"} ${Date.now() - started}ms`,
        );
        // 최종 답 보안 게이트 (독립 RAG 엔드포인트도 우회 없이 검사)
        const sec = await withSecurityPreFinal(q, result.content, {});
        const payload = {
            answer: sec.answer,
            strict,
            sources: ragSources(hits),
            model: result.raw?.model ?? config.modelName,
            tier,
            device,
            alias: alias || undefined,
            backend: backendUrl,
            elapsedMs: Date.now() - started,
        };
        persist(payload);
        res.json(payload);
    } catch (err) {
        logger.error(`RAG 질문 실패 (${Date.now() - started}ms): ${err.message}`);
        res.status(502).json({ error: err.message });
    }
});

// 문서 기반 질문 (스트리밍 SSE): 출처를 먼저 보내고 토큰을 실시간 전송한다.
app.post("/api/rag/ask/stream", async (req, res) => {
    const started = Date.now();
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const send = (event, data) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
        // 검색·생성 전에 상태를 먼저 밀어 TTFT 체감 지연을 줄인다.
        send("status", { phase: "retrieve", message: "문서 검색 중…" });

        await rag.load();
        const q =
            typeof req.body?.q === "string"
                ? req.body.q
                : typeof req.body?.ROLE_USER === "string"
                  ? req.body.ROLE_USER
                  : "";
        if (!q.trim()) {
            send("error", { error: "q (질문) 가 필요합니다." });
            return res.end();
        }
        const topK = Number.isFinite(Number(req.body?.topK))
            ? Math.max(1, Math.min(8, Number(req.body.topK)))
            : 4;
        const strict = req.body?.strict !== false;
        const questionContent = req.body?.content;
        const system =
            typeof req.body?.ROLE_SYSTEM === "string"
                ? req.body.ROLE_SYSTEM
                : undefined;
        // 보안 게이트가 켜져 있으면 검사 통과 전까지 토큰을 감춘다
        const securityHold = hasSecurityWorkflow() && Boolean(q.trim());

        const hits = await rag.retrieveAsync(
            ragRetrieveQuery({ ROLE_USER: q, HISTORY: req.body?.HISTORY }),
            topK,
        );
        const sources = ragSources(hits);
        logger.info(
            `RAG 질문(stream) "${q.slice(0, 50)}" (strict=${strict}) → 관련 청크 ${hits.length}개 검색`,
        );

        // 검색된 출처를 생성 시작 전에 먼저 보여준다.
        send("meta", { strict, sources });
        send("status", { phase: "generate", message: "답변 생성 중…" });

        // strict 모드에서 관련 문서가 없으면 즉시 종료
        if (!hits.length && strict) {
            const payload = {
                answer: "문서 내용에 없습니다.",
                sources: [],
                strict,
                elapsedMs: Date.now() - started,
            };
            send("done", payload);
            persistRagHistory(q, payload);
            return res.end();
        }

        const route = await chooseRagRoute({
            q,
            hits,
            questionContent,
            body: req.body,
        });
        logger.info(
            `RAG 라우팅(stream) → tier=${route.tier} (${route.reason})`,
        );

        const messages = await buildRagMessages({
            q,
            hits,
            strict: hits.length ? strict : false,
            questionContent,
            system,
            history: req.body?.HISTORY,
        });
        const out = await pool.chatStream({
            messages,
            temperature: strict && hits.length ? 0.2 : 0.4,
            maxTokens:
                route.tier === "large"
                    ? config.defaultMaxTokens
                    : config.maxTokensSmall,
            // RAG 는 추론 토큰 대기 없이 바로 content 스트리밍
            enableThinking: false,
            preferredTier: route.tier,
            preferredDevice: route.device ?? null,
            allowOtherTiers: route.allowOtherTiers,
            onMeta: (m) => send("meta", m),
            onToken: (t) => {
                if (!securityHold) send("token", { text: t });
            },
        });

        // 최종 답 보안 게이트 (독립 RAG 엔드포인트도 우회 없이 검사)
        const sec = await withSecurityPreFinal(q, out.content, {
            onEvent: securityEventBridge(send),
            stepIndex: 1,
        });

        const payload = {
            answer: sec.answer,
            strict,
            sources,
            model: out.model ?? config.modelName,
            tier: out.tier,
            device: out.device,
            alias: out.alias || undefined,
            backend: out.backendUrl,
            ttftMs: out.ttftMs,
            totalMs: out.totalMs,
            elapsedMs: Date.now() - started,
        };
        send("done", payload);
        persistRagHistory(q, payload);
        logger.info(
            `RAG 답변 완료(stream) tier=${out.tier} device=${out.device ?? "-"} ${Date.now() - started}ms`,
        );
        res.end();
    } catch (err) {
        logger.error(
            `RAG 질문(stream) 실패 (${Date.now() - started}ms): ${err.message}`,
        );
        send("error", { error: err.message });
        res.end();
    }
});

app.use((_req, res) => res.status(404).json({ error: "Not Found" }));

loadStats();
pool.startHealthChecks();
startAgentPolling();
// 부하 스냅샷 세션이 dispatch 에러를 수집하도록 배선 (활성 세션 없으면 no-op)
pool.setErrorSink(loadSession.recordError);
rag.setEmbedder(async (texts) => {
    const out = await pool.embed(texts);
    return out?.vectors ?? null;
});
memoryStore.setEmbedder(async (texts) => {
    const out = await pool.embed(texts);
    return out?.vectors ?? null;
});

app.listen(config.port, () => {
    const routers = pool.backends.filter((b) => b.routerEnabled);
    const routerLabel = routers.length
        ? routers.map((b) => `${b.alias || b.tier}@${b.url}`).join(", ")
        : "없음";
    logger.info(
        `부모 관리서버 시작 (port ${config.port}, OS=${config.osMode}, ROUTING_MODE=${config.routingMode}) — 모델 백엔드는 하위 관리서버(agent) 등록으로 채워집니다`,
    );
    console.log(
        `[neutda-ai] 부모 관리서버 실행: http://localhost:${config.port} (OS=${config.osMode})`,
    );
    console.log(`[neutda-ai] 테스트 페이지: http://localhost:${config.port}/`);
    console.log(
        `[neutda-ai] 서버 모니터링: http://localhost:${config.port}/monitor.html`,
    );
    console.log(
        `[neutda-ai] 이 서버는 순수 컨트롤 플레인입니다. 모델은 각 머신에서 'npm run agent' 로 등록하세요.`,
    );
    console.log(
        `[neutda-ai] POST /api/chat 로 ROLE_SYSTEM/ROLE_USER/TEMPERATURE/content 전송`,
    );
});
