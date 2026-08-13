// 하위 관리서버(child agent).
//
// 한 물리 머신에서 실행되어:
//   1) 자기 servers.json 의 llama 서버들을 관리(기동/종료/헬스)한다.
//   2) 부모 관리서버(Express)에 자신을 register 한다 (host + llama 서버 목록).
//   3) 부모가 폴링할 수 있도록 /agent/health · /agent/metrics 를 노출한다.
//   4) 주기적으로 재등록(heartbeat)하여 부모 재시작·서버 목록 변경을 반영한다.
//
// 실행:  npm run agent
// 환경변수:
//   PARENT_URL           부모 관리서버 URL (기본 http://127.0.0.1:3000)
//   AGENT_ID             이 에이전트 식별자 (기본 hostname)
//   AGENT_PORT           이 에이전트가 listen 할 포트 (기본 4100)
//   AGENT_HOST           부모가 이 머신에 접속할 주소
//                        미지정 시: 부모가 localhost 이면 127.0.0.1,
//                        원격이면 LAN IP 자동 감지
//   AGENT_HEARTBEAT_MS   재등록 주기 (기본 5000)
//   AGENT_AUTOSTART      부팅 시 로컬 llama 서버 자동 기동 (기본 false)
//   LLAMA_BIND_HOST      llama 바인드 — 원격 부모/LAN host 면 0.0.0.0 으로 자동 전환
import express from "express";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    addServerDef,
    assertGpuCapacityForUpdate,
    estimateVram,
    ensureRunningBaselines,
    getGpuFreeMb,
    loadModelConfig,
    enrichMetricsWithServers,
    loadServerDefs,
    persistFixedRole,
    persistSecurityPolicy,
    removeServerDef,
    serverStatus,
    setPendingRestart,
    sortDefsByPriority,
    startServer,
    restartServer,
    stopServer,
    updateServerDef,
} from "./serverManager.js";
import { getMetrics } from "./metrics.js";
import { logger, getLogs, listLogDates, logDayKey, logFileStats, setLogScope } from "./logger.js";
import { config } from "./config.js";
import { execOpts } from "./platform.js";
import {
    listLocalLlamaLogSources,
    readLlamaLogs,
} from "./llamaLogs.js";

/** 부모가 접속 가능한 첫 비내부 IPv4 (없으면 127.0.0.1) */
function detectLanIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const ni of ifaces[name] || []) {
            if (ni.family === "IPv4" && !ni.internal) return ni.address;
        }
    }
    return "127.0.0.1";
}

const LOCAL_PARENT_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** 부모가 같은 머신(loopback)인가 — serve+agent 를 한 머신에서 띄운 경우 */
function isLocalParent(parentUrl) {
    try {
        return LOCAL_PARENT_HOSTS.has(
            new URL(parentUrl).hostname.toLowerCase(),
        );
    } catch {
        return false;
    }
}

/**
 * 부모가 llama·agent 에 접속할 때 쓸 host.
 * - AGENT_HOST 명시 → 그대로
 * - 부모가 localhost → 127.0.0.1 (llama 기본 bind 와 맞춤 — LAN IP 등록 시 헬스 실패하던 원인)
 * - 원격 부모 → LAN IP (이 경우 LLAMA_BIND_HOST=0.0.0.0 필요)
 */
function resolveAgentHost(parentUrl) {
    const explicit = (config.agent.host || "").trim();
    if (explicit) return explicit;
    if (isLocalParent(parentUrl)) return "127.0.0.1";
    return detectLanIp();
}

// 모든 설정은 .env(→ config.agent)에서 온다. 소스에 host/port 를 박지 않는다.
const PARENT_URL = config.agent.parentUrl;
const AGENT_ID = config.agent.id;
const AGENT_PORT = config.agent.port;
const AGENT_HOST = resolveAgentHost(PARENT_URL);
const AGENT_URL = `http://${AGENT_HOST}:${AGENT_PORT}`;
const HEARTBEAT_MS = config.agent.heartbeatMs;
const AUTOSTART = config.agent.autostart;
// 부모(express) 일별 로그와 파일이 섞이지 않도록 스코프 분리
setLogScope(`agent-${AGENT_ID}`);

// 부모가 원격(또는 AGENT_HOST 가 LAN)인데 llama 가 loopback 만 들으면
// 헬스/채팅이 전부 실패한다 → 0.0.0.0 으로 올려 외부 접속을 연다.
{
    const hostIsRemote = !LOCAL_PARENT_HOSTS.has(AGENT_HOST.toLowerCase());
    if (hostIsRemote && config.llamaBindHost === "127.0.0.1") {
        config.llamaBindHost = "0.0.0.0";
        logger.warn(
            `[agent] AGENT_HOST=${AGENT_HOST} — LLAMA_BIND_HOST 를 0.0.0.0 으로 전환 (부모가 llama 에 접속하려면 필요). 이미 기동 중인 llama 는 재시작해야 새 bind 가 적용됩니다.`,
        );
    }
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// 부모 폴링용: 생사 + 관리 중인 llama 서버 상태
app.get("/agent/health", async (_req, res) => {
    try {
        const defs = sortDefsByPriority(await loadServerDefs());
        const list = await serverStatus(defs);
        res.json({
            ok: true,
            id: AGENT_ID,
            host: AGENT_HOST,
            servers: list.map((s) => ({
                name: s.name,
                tier: s.tier,
                port: s.port,
                running: s.pid != null,
                device: s.device,
            })),
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// 부모 폴링용: 이 머신의 GPU/CPU/RAM (+ 모델별 VRAM)
app.get("/agent/metrics", async (_req, res) => {
    try {
        const m = await enrichMetricsWithServers(await getMetrics());
        res.json({ id: AGENT_ID, host: AGENT_HOST, ...m });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== 로그 (agent 프로세스 + 로컬 llama 파일) =====

app.get("/agent/logs/sources", async (_req, res) => {
    try {
        const llamas = await listLocalLlamaLogSources();
        res.json({
            agentId: AGENT_ID,
            sources: [
                {
                    kind: "agent",
                    id: `agent:${AGENT_ID}`,
                    agentId: AGENT_ID,
                    label: `하위 관리서버 ${AGENT_ID}`,
                },
                ...llamas.map((l) => ({
                    kind: "llama",
                    id: `llama:${AGENT_ID}:${l.port}`,
                    agentId: AGENT_ID,
                    port: l.port,
                    name: l.name,
                    alias: l.alias,
                    tier: l.tier,
                    hasOut: l.hasOut,
                    hasErr: l.hasErr,
                    label: l.label,
                })),
            ],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// agent 프로세스 일별 파일 로그
app.get("/agent/logs", (req, res) => {
    const level = String(req.query.level || "all");
    const limit = Number(req.query.limit);
    const sinceId = Number(req.query.sinceId);
    const dateRaw = String(req.query.date || "").trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : logDayKey();
    const items = getLogs({
        level,
        limit: Number.isFinite(limit) ? limit : 300,
        sinceId: Number.isFinite(sinceId) ? sinceId : 0,
        date,
    }).map((e) => ({
        ...e,
        source: {
            kind: "agent",
            id: `agent:${AGENT_ID}`,
            label: `하위 관리서버 ${AGENT_ID}`,
            agentId: AGENT_ID,
        },
    }));
    res.json({
        agentId: AGENT_ID,
        date,
        today: logDayKey(),
        files: logFileStats(date),
        items,
    });
});

app.get("/agent/logs/dates", (_req, res) => {
    res.json({
        agentId: AGENT_ID,
        today: logDayKey(),
        dates: listLogDates(),
        files: logFileStats(logDayKey()),
    });
});

// llama-server 파일 로그 (포트 기준)
app.get("/agent/logs/llama/:port", async (req, res) => {
    try {
        const port = Number(req.params.port);
        const limit = Number(req.query.limit);
        const stream = String(req.query.stream || "both");
        const level = String(req.query.level || "all");
        const dateRaw = String(req.query.date || "").trim();
        const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;
        let items = await readLlamaLogs(port, {
            limit: Number.isFinite(limit) ? limit : 400,
            stream: ["out", "err", "both"].includes(stream) ? stream : "both",
        });
        if (level && level !== "all") {
            items = items.filter((e) => e.level === level);
        }
        if (date) {
            items = items.filter((e) => {
                if (!e?.ts) return true;
                const t = new Date(e.ts).getTime();
                if (!Number.isFinite(t) || t <= 0) return true;
                return logDayKey(new Date(e.ts)) === date;
            });
        }
        const defs = await loadServerDefs();
        const def = defs.find((d) => Number(d.port) === port);
        const label = def
            ? `${def.alias || def.name} :${port}`
            : `llama :${port}`;
        items = items.map((e) => ({
            ...e,
            source: {
                kind: "llama",
                id: `llama:${AGENT_ID}:${port}`,
                label,
                agentId: AGENT_ID,
                port,
                name: def?.name,
                stream: e.stream,
            },
        }));
        res.json({ agentId: AGENT_ID, port, items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 부모 → agent 원격 제어. 전부 로컬 프로세스/파일 제어(모델·GPU 가 이 머신에 있음).
async function findDef(name) {
    const defs = await loadServerDefs();
    return defs.find((d) => d.name === name) ?? null;
}

// 관리 중인 llama 서버 목록 + 실행 상태
app.get("/agent/servers", async (_req, res) => {
    try {
        const defs = sortDefsByPriority(await loadServerDefs());
        res.json({ servers: await serverStatus(defs) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 이 머신의 티어별 모델 카탈로그 (add 폼용) — 로컬 파일 존재·VRAM 추정 포함
app.get("/agent/modelconfig", async (_req, res) => {
    try {
        res.json(await loadModelConfig());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 이 머신 기준 VRAM 필요량·가용량 (배치 판단용)
app.post("/agent/servers/estimate-vram", async (req, res) => {
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

// llama 서버 추가. body.start !== false 이면 즉시 기동(기본). start:false 면 정의만 저장.
app.post("/agent/servers", async (req, res) => {
    try {
        const tier = String(req.body?.tier ?? "").toLowerCase();
        if (!["small", "medium", "large"].includes(tier)) {
            return res
                .status(400)
                .json({ error: '"tier" 는 small|medium|large 여야 합니다.' });
        }
        const shouldStart = req.body?.start !== false;
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
        if (shouldStart) {
            try {
                await startServer(def);
            } catch (e) {
                // 기동 실패(모델 없음/VRAM 부족 등) → 정의 롤백
                await removeServerDef(def.name).catch(() => {});
                throw e;
            }
            logger.info(`[agent] llama 추가+기동 ➕ ${def.name} [${def.tier}] :${def.port}`);
        } else {
            logger.info(`[agent] llama 정의 추가 ➕ ${def.name} [${def.tier}] :${def.port} (미기동)`);
        }
        await register().catch(() => {}); // 부모 풀에 새 백엔드 즉시 반영
        res.json({ ok: true, server: def, started: shouldStart });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/agent/servers/:name/start", async (req, res) => {
    try {
        const def = await findDef(req.params.name);
        if (!def) return res.status(404).json({ error: "서버 정의 없음" });
        const r = await startServer(def);
        logger.info(`[agent] 기동 ▶ ${def.name} :${def.port} PID ${r.pid ?? "?"}`);
        res.json({ ok: true, name: def.name, ...r });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/agent/servers/:name/stop", async (req, res) => {
    try {
        const def = await findDef(req.params.name);
        if (!def) return res.status(404).json({ error: "서버 정의 없음" });
        const r = await stopServer(def);
        logger.info(`[agent] 종료 ⏻ ${def.name} :${def.port}`);
        res.json({ ok: true, name: def.name, ...r });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// llama 서버 재시작 (stop → start). 자기 VRAM 회수를 반영해 용량 검사.
app.post("/agent/servers/:name/restart", async (req, res) => {
    try {
        const def = await findDef(req.params.name);
        if (!def) return res.status(404).json({ error: "서버 정의 없음" });
        const r = await restartServer(def);
        logger.info(`[agent] 재시작 ↻ ${def.name} :${def.port} PID ${r.pid ?? "?"}`);
        res.json({ ok: true, name: def.name, ...r });
    } catch (err) {
        const status = /GPU 메모리/.test(err.message) ? 400 : 500;
        res.status(status).json({ error: err.message });
    }
});

// llama 서버 삭제 (프로세스 종료 + 정의 제거 → 부모 재등록)
app.delete("/agent/servers/:name", async (req, res) => {
    try {
        const def = await findDef(req.params.name);
        if (!def) return res.status(404).json({ error: "서버 정의 없음" });
        await stopServer(def).catch(() => {});
        await removeServerDef(def.name);
        logger.warn(`[agent] llama 삭제 🗑 ${def.name} :${def.port}`);
        await register().catch(() => {});
        res.json({ ok: true, removed: def.name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// llama 서버 설정 변경 (별칭·역할·ngl·ctx·gpu 등).
// servers.json 에 저장 후 부모 재등록. ngl/ctx/gpu 는 재시작 후 프로세스에 반영.
app.patch("/agent/servers/:name", async (req, res) => {
    try {
        const patch = {};
        const has = (k) => Object.prototype.hasOwnProperty.call(req.body ?? {}, k);
        if (has("alias")) patch.alias = req.body.alias;
        if (has("roleIds")) patch.roleIds = req.body.roleIds;
        if (has("skills")) patch.skills = req.body.skills;
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
        const oldDef = await findDef(req.params.name);
        if (!oldDef) return res.status(404).json({ error: "서버 정의 없음" });
        const runKeys = ["ngl", "ctx", "parallel", "gpu"].filter((k) => has(k));
        if (runKeys.length) {
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
        if (!def) return res.status(404).json({ error: "서버 정의 없음" });
        if (runKeys.length) {
            await setPendingRestart(def.name, true);
        }
        logger.info(
            `[agent] 설정 변경 ✎ ${def.name}` +
                (runKeys.length ? ` (${runKeys.join(",")})` : ""),
        );
        await register().catch(() => {});
        const st = (await serverStatus([def]))[0];
        res.json({
            ok: true,
            server: def,
            needsRestart: st?.needsRestart ?? runKeys.length > 0,
        });
    } catch (err) {
        const status = /보안검증 기능이 꺼져|ngl|ctx|parallel|GPU 메모리/.test(err.message)
            ? 400
            : 500;
        res.status(status).json({ error: err.message });
    }
});

// llama 서버 고정 역할 토글 (solve/router/planner/embedding/security)
app.post("/agent/servers/:name/role", async (req, res) => {
    try {
        const def = await findDef(req.params.name);
        if (!def) return res.status(404).json({ error: "서버 정의 없음" });
        const role = String(req.body?.role ?? "").toLowerCase();
        const enabled = req.body?.enabled;
        if (typeof enabled !== "boolean") {
            return res.status(400).json({ error: '"enabled"(boolean) 필요' });
        }
        await persistFixedRole(def.port, role, enabled);
        logger.info(`[agent] 고정역할 ${role} ${enabled ? "ON" : "OFF"} @ ${def.name}`);
        await register().catch(() => {});
        res.json({ ok: true, name: def.name, role, enabled });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// llama 서버 보안검증 정책 텍스트 저장
app.post("/agent/servers/:name/security-policy", async (req, res) => {
    try {
        const def = await findDef(req.params.name);
        if (!def) return res.status(404).json({ error: "서버 정의 없음" });
        const policy =
            typeof req.body?.policy === "string" ? req.body.policy : "";
        await persistSecurityPolicy(def.port, policy);
        await register().catch(() => {});
        res.json({ ok: true, name: def.name });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// agent(관리서버) 자체 재시작 — 자기 자신을 detached 로 재기동 후 종료.
// 관리 중인 llama 프로세스는 detached 라 이 재기동에 영향받지 않는다.
const AGENT_ENTRY = fileURLToPath(import.meta.url);
app.post("/agent/restart", (_req, res) => {
    // 단일 서버 모드에선 프로세스를 내리면 부모까지 죽으므로 재등록만 한다.
    if (config.agent.solo) {
        logger.warn(`[agent] (solo) 재시작 요청 — 재등록으로 대체`);
        register().catch(() => {});
        return res.json({ ok: true, restarting: false, solo: true, id: AGENT_ID });
    }
    logger.warn(`[agent] 자체 재시작 요청 — 재기동 후 종료`);
    res.json({ ok: true, restarting: true, id: AGENT_ID });
    setTimeout(() => {
        try {
            const child = spawn(process.execPath, [AGENT_ENTRY], {
                detached: true,
                stdio: "ignore",
                env: process.env,
                ...execOpts(),
            });
            child.unref();
        } catch (e) {
            logger.error(`[agent] 재기동 실패: ${e.message}`);
        }
        process.exit(0);
    }, 300);
});

/** 부모에 register (부팅 + 하트비트). servers 는 상태(needsRestart 등) 포함 */
async function register() {
    const defs = await loadServerDefs();
    const list = await serverStatus(defs);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
        const res = await fetch(`${PARENT_URL}/api/agents/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: AGENT_ID,
                agentUrl: AGENT_URL,
                host: AGENT_HOST,
                // 풀 등록용 정의 + UI용 실행상태
                servers: list.map((s) => {
                    const def = defs.find((d) => d.name === s.name) || {};
                    return {
                        ...def,
                        name: s.name,
                        alias: s.alias,
                        tier: s.tier,
                        port: s.port,
                        ctx: s.ctx,
                        ngl: s.ngl,
                        gpu: s.gpu,
                        device: s.device,
                        pid: s.pid,
                        needsRestart: s.needsRestart,
                        runningConfig: s.runningConfig,
                    };
                }),
            }),
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function deregister() {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        await fetch(
            `${PARENT_URL}/api/agents/${encodeURIComponent(AGENT_ID)}`,
            { method: "DELETE", signal: ctrl.signal },
        ).finally(() => clearTimeout(timer));
    } catch {
        // 종료 중 실패는 무시
    }
}

let heartbeatTimer = null;
let registeredOnce = false;

async function heartbeat() {
    try {
        const r = await register();
        if (!registeredOnce) {
            registeredOnce = true;
            logger.info(
                `[agent] 부모 등록 성공 → ${PARENT_URL} (llama ${r.backends ?? "?"}개)`,
            );
        }
    } catch (e) {
        logger.warn(`[agent] 부모 등록 실패 (재시도 예정): ${e.message}`);
    }
}

async function boot() {
    logger.info(
        `[agent] "${AGENT_ID}" 실행 :${AGENT_PORT} (OS=${config.osMode}, host=${AGENT_HOST}, 부모=${PARENT_URL})`,
    );
    console.log(`[neutda-ai:agent] ${AGENT_ID} @ ${AGENT_URL} → 부모 ${PARENT_URL} (OS=${config.osMode})`);

    if (AUTOSTART) {
        const defs = sortDefsByPriority(await loadServerDefs());
        for (const def of defs) {
            try {
                const r = await startServer(def);
                logger.info(
                    `[agent] 자동 기동 ▶ ${def.name} :${def.port} PID ${r.pid ?? "?"}`,
                );
            } catch (e) {
                logger.warn(`[agent] 자동 기동 실패 ${def.name}: ${e.message}`);
            }
        }
    }

    // 이미 떠 있는 llama 에 running 기록이 없으면 현재 정의를 기준으로 맞춤
    try {
        await ensureRunningBaselines(await loadServerDefs());
    } catch (e) {
        logger.warn(`[agent] running 베이스라인: ${e.message}`);
    }

    await heartbeat();
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
}

// 자체 재시작 직후엔 이전 프로세스가 포트를 놓기 전일 수 있어 재시도한다.
function listenWithRetry(attempt = 0) {
    const server = app.listen(AGENT_PORT, boot);
    server.on("error", (e) => {
        if (e.code === "EADDRINUSE" && attempt < 10) {
            logger.warn(
                `[agent] 포트 ${AGENT_PORT} 사용 중 — 재시도 ${attempt + 1}/10`,
            );
            setTimeout(() => listenWithRetry(attempt + 1), 700);
        } else {
            logger.error(`[agent] listen 실패: ${e.message}`);
            process.exit(1);
        }
    });
}

listenWithRetry();

async function shutdown() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    logger.info(`[agent] 종료 — 부모에 등록 해제`);
    await deregister();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
