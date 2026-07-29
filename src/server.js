import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { toImageUrl } from "./image.js";
import { pool } from "./pool.js";
import { chooseRoute } from "./router.js";
import {
    createPlan,
    runWorkflow,
    hasSecurityWorkflow,
    runSecurityPreFinal,
    isTrivialQuestion,
} from "./workflow.js";
import { needsLongPipeline, runLongContent, chunkText } from "./longContent.js";
import { appendHistory, readHistory, clearHistory } from "./history.js";
import { getMetrics } from "./metrics.js";
import { logger, getLogs } from "./logger.js";
import * as rag from "./rag.js";
import { describeImageForRag } from "./ragVision.js";
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
    stripRoleIdFromServers,
    stripSecurityIdFromServers,
    enrichServerWithRoles,
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
    createSecurityPolicy,
    updateSecurityPolicy,
    deleteSecurityPolicy,
    resolveServerSecurity,
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
    if (!hasSecurityWorkflow() || isTrivialQuestion({ ROLE_USER: q })) {
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

/** 서버 정의 → 풀 역할 반영 */
function syncPoolRoles(def) {
    const resolved = resolveServerRoles(def, rolesById(loadRolesSync()));
    const url = `http://127.0.0.1:${def.port}`;
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
        const url = `http://127.0.0.1:${def.port}`;
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
app.use(
    express.static(path.join(__dirname, "..", "public"), {
        etag: false,
        lastModified: false,
        cacheControl: false,
        maxAge: 0,
    }),
);

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
 * }
 */
async function buildMessages(body, promptCharBudget = Infinity) {
    const system = body.ROLE_SYSTEM;
    const user = body.ROLE_USER;
    const content = body.content;
    const history = Array.isArray(body.HISTORY) ? body.HISTORY : [];

    if (typeof user !== "string" || user.trim() === "") {
        throw new Error(
            '"ROLE_USER" 는 필수이며 비어있지 않은 문자열이어야 합니다.',
        );
    }

    const messages = [];
    const sysText =
        typeof system === "string" && system.trim() !== "" ? system : "";
    // 사용자 시스템 지시 + 언어 정책(중국어 드리프트 방지)을 합쳐 시스템 메시지 구성
    const sysParts = [];
    if (sysText) sysParts.push(sysText);
    if (config.enforceLanguage) sysParts.push(config.langDirective);
    if (sysParts.length) {
        messages.push({ role: "system", content: sysParts.join("\n\n") });
    }

    // 이전 대화(메모리)를 컨텍스트 초과가 나지 않도록 최신 순으로 예산만큼만 삽입한다.
    const valid = history.filter(
        (t) =>
            t &&
            (t.role === "user" || t.role === "assistant") &&
            typeof t.content === "string" &&
            t.content !== "",
    );
    let remaining = promptCharBudget - sysText.length - user.length;
    const kept = [];
    for (let i = valid.length - 1; i >= 0 && remaining > 0; i--) {
        const turn = valid[i];
        if (turn.content.length > remaining) break; // 더 오래된 것은 버림
        remaining -= turn.content.length;
        kept.push(turn);
    }
    kept.reverse();
    for (const turn of kept) {
        messages.push({ role: turn.role, content: turn.content });
    }

    // 약한 모델(0.5B/3B)은 시스템 지시만으론 언어가 흔들리므로,
    // 질문이 한국어면 사용자 메시지 끝에 한국어 강제 문구를 덧붙인다(생성 직전 recency).
    const userText = user + koreanReminder(user);

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

// 한국어 질문이면 답변 언어를 못박는 짧은 리마인더 (약한 모델의 중국어 드리프트 방지)
function koreanReminder(text) {
    if (!config.enforceLanguage) return "";
    return /[가-힣]/.test(String(text ?? ""))
        ? "\n\n(답변은 반드시 한국어로만 작성하고, 중국어를 섞지 마세요.)"
        : "";
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
            reason: `긴 입력 ${base.inputChars}자 > ${config.longTriggerChars}자 → ${chunks.length}청크 맵리듀스`,
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
        const url = `http://127.0.0.1:${def.port}`;
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
        const policies = await loadSecurityPolicies();
        res.json({ policies });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
            layers: req.body?.layers,
            gpu: req.body?.gpu,
        });
        const freeMb = await getGpuFreeMb(req.body?.gpu);
        res.json({ ...est, freeMb });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// servers.json 정의 + 실행 상태(PID/健康) 목록
app.get("/api/servers", async (_req, res) => {
    try {
        const defs = sortDefsByPriority(await loadServerDefs());
        const list = await serverStatus(defs);
        const byUrl = new Map(pool.backends.map((b) => [b.url, b]));
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

// 모델 서버 추가: servers.json 에 영속 + 풀 등록 + 즉시 기동.
// 이름·포트 자동 할당, 미지정 값은 같은 티어 정의를 템플릿으로 사용.
app.post("/api/servers", async (req, res) => {
    try {
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
            gpu: req.body?.gpu,
            alias: req.body?.alias,
            skill: req.body?.skill,
            skills: req.body?.skills,
            roleIds: req.body?.roleIds,
            mmproj: req.body?.mmproj,
        });
        const url = `http://127.0.0.1:${def.port}`;
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
            },
        );
        let r;
        try {
            r = await startServer(def);
        } catch (e) {
            // 기동 실패(GPU 부족 등) 시 정의·풀 등록 롤백
            await removeServerDef(def.name).catch(() => {});
            pool.removeBackend(url);
            throw e;
        }
        logger.info(
            `모델 서버 추가 ➕ ${def.name} [${def.tier}] :${def.port} (model=${def.model}, ngl=${def.ngl}, PID ${r.pid ?? "?"})`,
        );
        res.json({ ok: true, server: def });
    } catch (err) {
        logger.error(`모델 서버 추가 실패: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

// 모델 서버 정의 수정 (별칭·공통역할·커스텀역할) — servers.json 영속
app.patch("/api/servers/:name", async (req, res) => {
    try {
        const patch = {};
        const has = (k) =>
            Object.prototype.hasOwnProperty.call(req.body ?? {}, k);
        if (has("alias")) patch.alias = req.body.alias;
        if (has("roleIds")) patch.roleIds = req.body.roleIds;
        if (has("skills")) patch.skills = req.body.skills; // 커스텀 역할
        else if (has("skill")) patch.skill = req.body.skill;
        if (has("securityIds")) patch.securityIds = req.body.securityIds;
        if (!Object.keys(patch).length) {
            return res.status(400).json({
                error: "수정할 필드가 없습니다. (alias, roleIds, skills, securityIds)",
            });
        }
        const def = await updateServerDef(req.params.name, patch);
        if (!def) {
            return res.status(404).json({
                error: `servers.json 에 "${req.params.name}" 정의가 없습니다.`,
            });
        }
        const url = `http://127.0.0.1:${def.port}`;
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
        res.json({ ok: true, server });
    } catch (err) {
        logger.error(`모델 서버 수정 실패 (${req.params.name}): ${err.message}`);
        const status = /보안검증 기능이 꺼져/.test(err.message) ? 400 : 500;
        res.status(status).json({ error: err.message });
    }
});

// 모델 서버 삭제: 프로세스 종료 + servers.json 정의 제거 + 풀에서 제외
app.delete("/api/servers/:name", async (req, res) => {
    try {
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
        pool.removeBackend(`http://127.0.0.1:${def.port}`);
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

// 모델 서버 기동 (servers.json 정의대로 llama-server 실행)
app.post("/api/servers/:name/start", async (req, res) => {
    try {
        const def = await findServerDef(req.params.name);
        if (!def) {
            return res
                .status(404)
                .json({ error: `servers.json 에 "${req.params.name}" 정의가 없습니다.` });
        }
        const r = await startServer(def);
        // 기동 후에도 servers.json 의 router 플래그 복원 (풀 상태 동기화)
        if (def.router === true) {
            pool.setRoleEnabled(`http://127.0.0.1:${def.port}`, "router", true);
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
// 모두 servers.json 에 저장 ("chat"→solve, "pipeline"→planner 별칭)
app.post("/api/backends/role", async (req, res) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    const role = String(req.body?.role ?? "").toLowerCase();
    const enabled = req.body?.enabled;
    if (!url || !isFixedRole(role) || typeof enabled !== "boolean") {
        return res.status(400).json({
            error: `"url"(string), "role"(${FIXED_ROLES.map((r) => `"${r}"`).join("|")}|\"chat\"), "enabled"(boolean) 이 필요합니다.`,
        });
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

// 시스템 자원(GPU/CPU/RAM) 실시간 지표
app.get("/api/metrics", async (_req, res) => {
    try {
        res.json(await getMetrics());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 로그 조회 (level=all|info|warn|error)
app.get("/api/logs", (req, res) => {
    const level = String(req.query.level || "all");
    const limit = Number(req.query.limit);
    const sinceId = Number(req.query.sinceId);
    res.json({
        items: getLogs({
            level,
            limit: Number.isFinite(limit) ? limit : 300,
            sinceId: Number.isFinite(sinceId) ? sinceId : 0,
        }),
    });
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

// 외부 API: 백그라운드에서 답변을 생성해 결과 JSON 파일에 기록한다.
async function processAsk(id, body, ref) {
    const started = Date.now();
    try {
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
            elapsedMs: Date.now() - started,
            finishedAt: new Date().toISOString(),
        };
        await writeResult(id, data);
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

        // 긴 입력(컨텍스트 초과) → 청크 맵리듀스 파이프라인으로 처리
        if (needsLongPipeline(body)) {
            logger.info(
                `긴 입력 감지 [chat/stream] ${q.length}자 → 맵리듀스 파이프라인`,
            );
            const holdFinal =
                hasSecurityWorkflow() && !isTrivialQuestion({ ROLE_USER: q });
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
                    else if (ev.type === "token" && !holdFinal)
                        send("token", { text: ev.text });
                },
            });

            const sec = await withSecurityPreFinal(q, out.answer, {
                onEvent: securityEventBridge(send),
                stepIndex: Array.isArray(out.steps) ? out.steps.length : 0,
            });
            const answer = sec.answer;
            if (holdFinal) send("token", { text: answer });
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

            logger.info(
                `chat(stream/long) ${out.trace.filter((n) => n.kind === "model").length}단계 ${Date.now() - started}ms`,
            );
            return res.end();
        }

        const plan = await createPlan(body);
        const useWorkflow = plan.mode === "workflow" && plan.steps?.length > 1;

        send("meta", {
            mode: useWorkflow ? "workflow" : "direct",
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
                    else if (ev.type === "step_start") send("step", { ...ev, status: "start" });
                    else if (ev.type === "step_done") send("step", { ...ev, status: "done" });
                    else if (ev.type === "step_meta") send("meta", ev);
                    else if (ev.type === "token") send("token", { text: ev.text });
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
            }).catch((e) => logger.error(`history 저장 실패: ${e.message}`));

            logger.info(
                `chat(stream/workflow) ${plan.steps.map((s) => s.tier).join("→")} ${Date.now() - started}ms`,
            );
            return res.end();
        }

        // ---- 단일 모델 (direct) ----
        const isLarge = plan.tier === "large";
        const promptCharBudget = isLarge
            ? config.maxPromptCharsLarge
            : config.maxPromptCharsSmall;
        const maxTokens = isLarge
            ? config.defaultMaxTokens
            : config.maxTokensSmall;
        const holdFinal =
            hasSecurityWorkflow() && !isTrivialQuestion({ ROLE_USER: q });
        logger.info(
            `라우팅 [chat/stream] → tier=${plan.tier}${plan.skill ? ` skill="${plan.skill}"` : ""} device=${plan.device} 난이도=${plan.difficulty}${plan.routerBackend ? ` router@${plan.routerBackend}` : ""} (${plan.reason})`,
        );

        const messages = await buildMessages(body, promptCharBudget);

        let firstLogged = false;
        const out = await pool.chatStream({
            messages,
            temperature,
            maxTokens,
            enableThinking,
            preferredTier: plan.tier,
            preferredDevice: plan.device,
            preferredSkill: plan.skill ?? null,
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
                if (!holdFinal) send("token", { text: t });
            },
        });

        const sec = await withSecurityPreFinal(q, out.content, {
            onEvent: securityEventBridge(send),
            stepIndex: 1,
        });
        const answer = sec.answer;
        if (holdFinal) send("token", { text: answer });
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
        }).catch((e) => logger.error(`history 저장 실패: ${e.message}`));

        logger.info(
            `chat(stream) tier=${out.tier} device=${out.device ?? "-"} ttft=${out.ttftMs ?? "?"}ms tps=${tokensPerSec ?? "?"} ${out.totalMs}ms`,
        );
        res.end();
    } catch (err) {
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

        // 긴 입력(컨텍스트 초과) → 청크 맵리듀스 파이프라인
        if (needsLongPipeline(body)) {
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
            };
            appendHistory(entry).catch((e) =>
                logger.error(`history 저장 실패: ${e.message}`),
            );
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
            });
        }

        const { tier, reason, device, difficulty, deviceReason, routerBackend } =
            {
                tier: plan.tier,
                reason: plan.reason,
                device: plan.device,
                difficulty: plan.difficulty,
                deviceReason: plan.deviceReason,
                routerBackend: plan.routerBackend,
            };
        logger.info(
            `라우팅 [chat] → tier=${tier}${plan.skill ? ` skill="${plan.skill}"` : ""} device=${device} 난이도=${difficulty}${routerBackend ? ` router@${routerBackend}` : ""} (티어사유: ${reason} / 장치사유: ${deviceReason})`,
        );

        // 티어별 컨텍스트 예산/출력 토큰 (large 만 큰 ctx 가정)
        const isLarge = tier === "large";
        const promptCharBudget = isLarge
            ? config.maxPromptCharsLarge
            : config.maxPromptCharsSmall;
        const maxTokens = isLarge
            ? config.defaultMaxTokens
            : config.maxTokensSmall;

        const messages = await buildMessages(body, promptCharBudget);

        const {
            result,
            backendUrl,
            tier: usedTier,
            device: usedDevice,
            alias: usedAlias,
            skill: usedSkill,
        } = await pool.chat({
            messages,
            temperature,
            maxTokens,
            enableThinking,
            preferredTier: tier,
            preferredDevice: device,
            preferredSkill: plan.skill ?? null,
        });

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
        });
    } catch (err) {
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

function ragSystemPrompt(strict, withVision, userSystem) {
    const vision =
        withVision
            ? " 참고 문서에 첨부된 이미지가 있으면 이미지 속 글자와 시각적 내용 모두를 근거로 사용하라."
            : "";
    let base;
    if (strict) {
        base =
            "너는 제공된 '참고 문서'만 근거로 한국어로 답하는 어시스턴트다." +
            vision +
            " 문서에 없는 내용은 절대 추측하지 말고 정확히 '문서 내용에 없습니다.'라고만 답하라. " +
            "답변에 [출처 N] 같은 출처 표기는 넣지 말고 내용만 자연스럽게 답하라.";
    } else {
        base =
            "너는 한국어로 답하는 어시스턴트다. '참고 문서'를 우선 근거로 사용하되," +
            vision +
            " 문서에 없으면 너의 일반 지식으로 보완해 답하라. " +
            "답변에 [출처 N] 같은 출처 표기는 넣지 말고 내용만 자연스럽게 답하라.";
    }
    // 사용자가 ROLE_SYSTEM 으로 보낸 지시(페르소나·출력형식 등)를 함께 적용
    const extra =
        typeof userSystem === "string" && userSystem.trim()
            ? ` 추가 지시사항: ${userSystem.trim()}`
            : "";
    return base + extra;
}

async function buildRagUserContent(q, context, hits, questionContent) {
    const text = context
        ? `참고 문서:\n${context}\n\n질문: ${q}`
        : q;

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

async function buildRagMessages({ q, hits, strict, questionContent, system }) {
    const context =
        hits?.length > 0
            ? hits
                  .map(
                      (h, i) =>
                          `[출처 ${i + 1}] (${h.docName} #${h.idx})\n${h.text}`,
                  )
                  .join("\n\n")
            : "";

    const hasVision =
        (hits || []).some((h) => h.imageFile) ||
        (questionContent !== undefined &&
            questionContent !== null &&
            questionContent !== "");

    const userContent = await buildRagUserContent(
        q,
        context,
        hits,
        questionContent,
    );

    return [
        { role: "system", content: ragSystemPrompt(strict, hasVision, system) },
        { role: "user", content: userContent },
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

async function ragChat({ q, hits, strict, questionContent, system, temperature = 0.3, route }) {
    const messages = await buildRagMessages({ q, hits, strict, questionContent, system });
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
    return hits.map((h, i) => ({
        n: i + 1,
        docName: h.docName,
        idx: h.idx,
        score: h.score,
        kind: h.kind,
        preview: h.text.slice(0, 200),
        imageUrl: h.imageFile ? `/api/rag/images/${h.docId}` : null,
    }));
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

        const hits = await rag.retrieveAsync(q, topK);
        logger.info(
            `RAG 질문 "${q.slice(0, 50)}" (strict=${strict}) → 관련 청크 ${hits.length}개 검색`,
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
        });

        logger.info(
            `RAG 답변 완료 tier=${tier} device=${device ?? "-"} ${Date.now() - started}ms`,
        );
        const payload = {
            answer: result.content,
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

        const hits = await rag.retrieveAsync(q, topK);
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
            onToken: (t) => send("token", { text: t }),
        });

        const payload = {
            answer: out.content,
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
rag.setEmbedder(async (texts) => {
    const out = await pool.embed(texts);
    return out?.vectors ?? null;
});

app.listen(config.port, () => {
    const routers = pool.backends.filter((b) => b.routerEnabled);
    const routerLabel = routers.length
        ? routers.map((b) => `${b.alias || b.tier}@${b.url}`).join(", ")
        : "없음";
    logger.info(
        `Express 서버 시작 (port ${config.port}, 백엔드 ${config.backends.length}개, ROUTING_MODE=${config.routingMode}, routers=${routerLabel})`,
    );
    console.log(
        `[neutda-ai] Express 서버 실행: http://localhost:${config.port}`,
    );
    console.log(`[neutda-ai] 테스트 페이지: http://localhost:${config.port}/`);
    console.log(
        `[neutda-ai] 모델 관리: http://localhost:${config.port}/models.html`,
    );
    console.log(
        `[neutda-ai] 서버 모니터링: http://localhost:${config.port}/monitor.html`,
    );
    console.log(
        `[neutda-ai] LLM 백엔드 ${config.backends.length}개: ${config.backends.map((b) => `${b.tier}@${b.url}`).join(", ")}`,
    );
    console.log(
        `[neutda-ai] 라우터: ${routers.length ? routerLabel : "없음 (servers.json 에 router:true 또는 모델 관리에서 켜세요)"}`,
    );
    console.log(
        `[neutda-ai] POST /api/chat 로 ROLE_SYSTEM/ROLE_USER/TEMPERATURE/content 전송`,
    );
});
