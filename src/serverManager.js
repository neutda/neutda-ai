// llama-server 프로세스 제어 (OS=WINDOW | LINUX).
// servers.json 정의를 읽어 개별 모델 서버를 기동/종료한다.
// 종료 시 프로세스를 실제로 내려 VRAM/CPU 메모리가 해제된다.
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync, openSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, normalizeSkill, normalizeSkills } from "./config.js";
import { readGgufBlockCount } from "./ggufReader.js";
import { serverUrl, isLocalDef } from "./serverUrl.js";
import {
    isWindows,
    execOpts,
    llamaServerBinaryNames,
    llamaProcessNameHint,
} from "./platform.js";
import {
    loadRolesSync,
    normalizeRoleIds,
    resolveServerRoles,
    rolesById,
} from "./roles.js";
import {
    loadSecurityPoliciesSync,
    normalizeSecurityIds,
    resolveServerSecurity,
    securityPoliciesById,
} from "./securityPolicies.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SERVERS_FILE = path.join(ROOT, "servers.json");
const MODEL_CONFIG_FILE = path.join(ROOT, "modelconfig.json");
const LOG_DIR = path.join(ROOT, "llama", "logs");
const STATUS_FILE = path.join(ROOT, "data", "server-status.json");

const TIER_RANK = { large: 0, medium: 1, small: 2 };

/**
 * 티어별 사용 가능 모델 목록 (modelconfig.json).
 * UI 에서 티어 선택 → 모델 선택에 사용.
 */
export async function loadModelConfig() {
    const raw = await readFile(MODEL_CONFIG_FILE, "utf-8");
    const cfg = JSON.parse(raw);
    const tiers = cfg?.tiers && typeof cfg.tiers === "object" ? cfg.tiers : {};
    const out = {};
    for (const tier of ["small", "medium", "large"]) {
        const t = tiers[tier] || {};
        const defaults = t.defaults && typeof t.defaults === "object" ? t.defaults : {};
        const models = [];
        for (const m of Array.isArray(t.models) ? t.models : []) {
            if (!m?.path) continue;
            const entry = {
                id: m.id || m.path,
                label: m.label || m.id || path.basename(m.path),
                path: String(m.path),
                // 이 모델로 서버를 추가할 때 자동으로 붙는 기본 특기
                defaultSkill: normalizeSkill(m.defaultSkill) ?? undefined,
                mmproj: m.mmproj ? String(m.mmproj) : undefined,
                layers:
                    Number.isFinite(Number(m.layers)) && Number(m.layers) > 0
                        ? Number(m.layers)
                        : undefined,
                ctx: Number.isFinite(Number(m.ctx))
                    ? Number(m.ctx)
                    : Number(defaults.ctx) || config.llamaDefaultCtx,
                ngl: Number.isFinite(Number(m.ngl))
                    ? Number(m.ngl)
                    : Number.isFinite(Number(defaults.ngl))
                      ? Number(defaults.ngl)
                      : 0,
                gpu:
                    m.gpu !== undefined && m.gpu !== null
                        ? String(m.gpu)
                        : defaults.gpu !== undefined
                          ? String(defaults.gpu)
                          : "",
                exists: existsSync(path.join(ROOT, m.path)),
            };
            if (entry.exists) {
                try {
                    const est = await estimateVram({
                        name: entry.id,
                        model: entry.path,
                        mmproj: entry.mmproj,
                        ngl: entry.ngl,
                        ctx: entry.ctx,
                        layers: entry.layers,
                    });
                    entry.vramEstimateMb = est.requiredMb;
                    entry.vramDetail = est.detail;
                    if (!entry.layers && est.detail?.layers) {
                        entry.layers = est.detail.layers;
                    }
                } catch {
                    entry.vramEstimateMb = null;
                }
            }
            models.push(entry);
        }
        out[tier] = { defaults, models };
    }
    return { tiers: out };
}

/** path 또는 id 로 모델 엔트리 찾기 */
export async function findModelEntry(tier, { modelId, modelPath } = {}) {
    const cfg = await loadModelConfig();
    const models = cfg.tiers[tier]?.models ?? [];
    if (modelId) {
        const byId = models.find((m) => m.id === modelId);
        if (byId) return byId;
    }
    if (modelPath) {
        const p = String(modelPath).replace(/\\/g, "/");
        return models.find((m) => m.path.replace(/\\/g, "/") === p) ?? null;
    }
    return null;
}

/** large → medium → small, 같은 티어에선 GPU(ngl>0) 우선 */
export function sortDefsByPriority(defs) {
    return [...defs].sort((a, b) => {
        const ta = TIER_RANK[String(a.tier).toLowerCase()] ?? 9;
        const tb = TIER_RANK[String(b.tier).toLowerCase()] ?? 9;
        if (ta !== tb) return ta - tb;
        const ga = Number(a.ngl) > 0 ? 0 : 1;
        const gb = Number(b.ngl) > 0 ? 0 : 1;
        if (ga !== gb) return ga - gb;
        return Number(a.port) - Number(b.port);
    });
}

/** 기동 실패 사유 (name → { error, at }) */
async function loadStatusMap() {
    try {
        const raw = await readFile(STATUS_FILE, "utf-8");
        const data = JSON.parse(raw);
        return data && typeof data === "object" ? data : {};
    } catch {
        return {};
    }
}

async function saveStatusMap(map) {
    await mkdir(path.dirname(STATUS_FILE), { recursive: true });
    await writeFile(STATUS_FILE, JSON.stringify(map, null, 2) + "\n", "utf-8");
}

export async function setStartError(name, error) {
    const map = await loadStatusMap();
    const prev = map[name] && typeof map[name] === "object" ? map[name] : {};
    map[name] = {
        ...prev,
        error: String(error || "기동 실패"),
        at: new Date().toISOString(),
    };
    await saveStatusMap(map);
}

export async function clearStartError(name) {
    const map = await loadStatusMap();
    const prev = map[name];
    if (!prev || typeof prev !== "object") return;
    if (prev.error == null && prev.at == null) return;
    const next = { ...prev };
    delete next.error;
    delete next.at;
    if (next.running || next.pendingRestart) map[name] = next;
    else delete map[name];
    await saveStatusMap(map);
}

/** 기동 성공 시 실제 프로세스에 올린 ngl/ctx/gpu/parallel 기록 (+ 재시작 대기 해제) */
export async function setRunningConfig(name, def) {
    const map = await loadStatusMap();
    const prev = map[name] && typeof map[name] === "object" ? map[name] : {};
    map[name] = {
        ...prev,
        running: {
            ngl: Number(def?.ngl) || 0,
            ctx: Number(def?.ctx) > 0 ? Number(def.ctx) : config.llamaDefaultCtx,
            parallel: resolveParallel(def),
            gpu: String(def?.gpu ?? "").trim(),
            at: new Date().toISOString(),
        },
    };
    delete map[name].error;
    delete map[name].at;
    delete map[name].pendingRestart;
    await saveStatusMap(map);
}

/** ngl/ctx/gpu 적용만 하고 재시작 전인 상태 */
export async function setPendingRestart(name, pending = true) {
    const map = await loadStatusMap();
    const prev = map[name] && typeof map[name] === "object" ? map[name] : {};
    if (pending) {
        map[name] = { ...prev, pendingRestart: true };
    } else if (prev.pendingRestart) {
        const next = { ...prev };
        delete next.pendingRestart;
        if (next.running || next.error) map[name] = next;
        else delete map[name];
    } else {
        return;
    }
    await saveStatusMap(map);
}

function configSig(c) {
    const par =
        Number(c?.parallel) > 0
            ? Math.floor(Number(c.parallel))
            : "";
    return `${Number(c?.ngl) || 0}|${Number(c?.ctx) || 0}|${par}|${String(c?.gpu ?? "").trim()}`;
}

/**
 * 재시작 필요 여부.
 * - 실행 중 + pendingRestart(적용만 함) → true
 * - 실행 중 + running 기록과 정의 불일치 → true
 * - 실행 중 + 기록 없음 → null(미확인)
 */
export function computeNeedsRestart(def, pid, statusRec) {
    if (pid && statusRec?.pendingRestart) return true;
    if (!pid) return false;
    const running = statusRec?.running;
    if (!running) return null;
    return configSig(running) !== configSig(def);
}

/** 이미 떠 있는데 running 기록이 없으면 현재 정의를 베이스라인으로 기록 */
export async function ensureRunningBaselines(defs) {
    const map = await loadStatusMap();
    let changed = false;
    for (const d of defs) {
        const pid = await findPidByPort(d.port);
        if (!pid) continue;
        const rec = map[d.name];
        if (rec?.running || rec?.pendingRestart) continue;
        map[d.name] = {
            ...(rec && typeof rec === "object" ? rec : {}),
            running: {
                ngl: Number(d.ngl) || 0,
                ctx: Number(d.ctx) > 0 ? Number(d.ctx) : config.llamaDefaultCtx,
                parallel: resolveParallel(d),
                gpu: String(d.gpu ?? "").trim(),
                at: new Date().toISOString(),
            },
        };
        changed = true;
    }
    if (changed) await saveStatusMap(map);
}

/** servers.json 의 LLM 서버 정의 목록 */
export async function loadServerDefs() {
    const raw = await readFile(SERVERS_FILE, "utf-8");
    const cfg = JSON.parse(raw);
    return Array.isArray(cfg.llmServers) ? cfg.llmServers : [];
}

async function saveServerDefs(defs) {
    await writeFile(
        SERVERS_FILE,
        JSON.stringify({ llmServers: defs }, null, 4) + "\n",
        "utf-8",
    );
}

/** 정의 목록·실제 LISTENING 포트를 피해서 빈 포트 선택 */
async function pickFreePort(defs) {
    const used = new Set(defs.map((d) => Number(d.port)));
    for (let p = config.serverManager.portScanStart; p < config.serverManager.portScanEnd; p++) {
        if (used.has(p)) continue;
        if (await findPidByPort(p)) continue;
        return p;
    }
    throw new Error(
        `사용 가능한 포트(${config.serverManager.portScanStart}~${config.serverManager.portScanEnd - 1})를 찾지 못했습니다.`,
    );
}

function pickName(defs, tier) {
    const names = new Set(defs.map((d) => d.name));
    for (let n = 1; n < 100; n++) {
        const name = `${tier}-${n}`;
        if (!names.has(name)) return name;
    }
    throw new Error("서버 이름을 생성하지 못했습니다.");
}

/**
 * 새 서버 정의를 servers.json 에 추가한다.
 * 이름·포트는 자동 할당.
 * model / modelId 가 modelconfig.json 에 있으면 그 기본값·mmproj 를 사용한다.
 */
export async function addServerDef({
    tier,
    model,
    modelId,
    ctx,
    ngl,
    parallel,
    gpu,
    alias,
    skill,
    skills,
    roleIds,
    mmproj,
}) {
    const defs = await loadServerDefs();
    const template = defs.find((d) => d.tier === tier);
    const entry = await findModelEntry(tier, {
        modelId,
        modelPath: model,
    });
    const cfg = await loadModelConfig();
    const defaults = cfg.tiers[tier]?.defaults ?? {};

    const name = pickName(defs, tier);
    const modelPath =
        (model && String(model).trim()) ||
        entry?.path ||
        template?.model ||
        cfg.tiers[tier]?.models?.[0]?.path;

    const pickNum = (...vals) => {
        for (const v of vals) {
            if (Number.isFinite(Number(v)) && Number(v) >= 0) return Number(v);
        }
        return undefined;
    };

    const def = {
        name,
        alias:
            alias !== undefined && alias !== null && String(alias).trim()
                ? String(alias).trim()
                : entry?.label || name,
        tier,
        port: await pickFreePort(defs),
        model: modelPath,
        ctx:
            Number.isFinite(Number(ctx)) && Number(ctx) > 0
                ? Number(ctx)
                : (pickNum(entry?.ctx, defaults.ctx, template?.ctx) ?? config.llamaDefaultCtx),
        ngl:
            Number.isFinite(Number(ngl)) && Number(ngl) >= 0
                ? Number(ngl)
                : (pickNum(entry?.ngl, defaults.ngl, template?.ngl) ?? 0),
        parallel: (() => {
            const p = Number(parallel);
            if (Number.isFinite(p) && p >= 1) return Math.floor(p);
            const fromTpl = Number(template?.parallel);
            if (Number.isFinite(fromTpl) && fromTpl >= 1) return Math.floor(fromTpl);
            // large 는 기본 config.serverManager.largeTierParallel, 그 외는 .env LLAMA_PARALLEL
            if (tier === "large") return config.serverManager.largeTierParallel;
            return Math.max(1, Number(config.llamaParallel) || 4);
        })(),
        gpu:
            gpu !== undefined && gpu !== null
                ? String(gpu)
                : (entry?.gpu ??
                  (defaults.gpu !== undefined
                      ? String(defaults.gpu)
                      : (template?.gpu ?? ""))),
    };

    // 공통 역할 + 커스텀 역할
    const roleMap = rolesById(loadRolesSync());
    const ids = normalizeRoleIds(roleIds, roleMap);
    if (ids.length) def.roleIds = ids;
    const sks = normalizeSkills(
        skills ?? skill ?? entry?.defaultSkill ?? entry?.defaultSkills,
    );
    if (sks.length) def.skills = sks;

    const mm =
        (mmproj && String(mmproj).trim()) ||
        entry?.mmproj ||
        template?.mmproj;
    if (mm) def.mmproj = mm;
    if (entry?.layers) def.layers = entry.layers;

    if (!def.model) {
        throw new Error(
            `"${tier}" 티어에 등록된 모델이 없습니다. modelconfig.json 에 모델을 추가하세요.`,
        );
    }
    if (!existsSync(path.join(ROOT, def.model))) {
        throw new Error(`모델 파일 없음: ${def.model}`);
    }

    defs.push(def);
    await saveServerDefs(defs);
    return def;
}

/**
 * 서버 정의 일부 갱신 (alias, roleIds, skills/커스텀, router, ngl, ctx, gpu).
 * 변경된 정의를 반환. 없으면 null.
 */
export async function updateServerDef(name, patch = {}) {
    const defs = await loadServerDefs();
    const idx = defs.findIndex((d) => d.name === name);
    if (idx < 0) return null;
    const def = { ...defs[idx] };
    if (Object.prototype.hasOwnProperty.call(patch, "alias")) {
        const a = patch.alias;
        def.alias =
            a === undefined || a === null || String(a).trim() === ""
                ? def.name
                : String(a).trim();
    }
    if (Object.prototype.hasOwnProperty.call(patch, "roleIds")) {
        const list = normalizeRoleIds(patch.roleIds, rolesById(loadRolesSync()));
        if (list.length) def.roleIds = list;
        else delete def.roleIds;
    }
    const hasSkills = Object.prototype.hasOwnProperty.call(patch, "skills");
    const hasSkill = Object.prototype.hasOwnProperty.call(patch, "skill");
    if (hasSkills || hasSkill) {
        const list = normalizeSkills(
            hasSkills ? patch.skills : patch.skill,
        );
        if (list.length) def.skills = list;
        else delete def.skills;
        delete def.skill;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "router")) {
        def.router = Boolean(patch.router);
        if (!def.router) delete def.router;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "securityPolicy")) {
        const text = String(patch.securityPolicy ?? "").trim();
        if (text) def.securityPolicy = text;
        else delete def.securityPolicy;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "securityIds")) {
        // 보안검증 기능이 꺼진 서버에는 배정 불가
        if (!def.security && Array.isArray(patch.securityIds) && patch.securityIds.length) {
            throw new Error(
                `"${def.name}" 은(는) 보안검증 기능이 꺼져 있어 보안 정책을 입힐 수 없습니다. 서버/모델관리에서 보안검증을 먼저 켜세요.`,
            );
        }
        const list = normalizeSecurityIds(
            patch.securityIds,
            securityPoliciesById(loadSecurityPoliciesSync()),
        );
        if (list.length) def.securityIds = list;
        else delete def.securityIds;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "ngl")) {
        const n = Number(patch.ngl);
        if (!Number.isFinite(n) || n < 0) {
            throw new Error("ngl 은 0 이상 숫자여야 합니다.");
        }
        def.ngl = Math.floor(n);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "ctx")) {
        const c = Number(patch.ctx);
        if (!Number.isFinite(c) || c < config.llamaCtxMin) {
            throw new Error(`ctx 는 ${config.llamaCtxMin} 이상 숫자여야 합니다.`);
        }
        def.ctx = Math.floor(c);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "parallel")) {
        const p = Number(patch.parallel);
        if (!Number.isFinite(p) || p < 1) {
            throw new Error("parallel 은 1 이상 숫자여야 합니다.");
        }
        def.parallel = Math.min(config.llamaParallelCap, Math.floor(p));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "gpu")) {
        def.gpu = String(patch.gpu ?? "").trim();
    }
    defs[idx] = def;
    await saveServerDefs(defs);
    return def;
}

/** 역할이 삭제됐을 때 모든 서버의 roleIds 에서 제거 */
export async function stripRoleIdFromServers(roleId) {
    const defs = await loadServerDefs();
    let changed = false;
    for (const d of defs) {
        if (!Array.isArray(d.roleIds) || !d.roleIds.includes(roleId)) continue;
        d.roleIds = d.roleIds.filter((id) => id !== roleId);
        if (!d.roleIds.length) delete d.roleIds;
        changed = true;
    }
    if (changed) await saveServerDefs(defs);
    return changed;
}

/** 보안 정책 삭제 시 모든 서버의 securityIds 에서 제거 */
export async function stripSecurityIdFromServers(policyId) {
    const defs = await loadServerDefs();
    let changed = false;
    for (const d of defs) {
        if (!Array.isArray(d.securityIds) || !d.securityIds.includes(policyId))
            continue;
        d.securityIds = d.securityIds.filter((id) => id !== policyId);
        if (!d.securityIds.length) delete d.securityIds;
        changed = true;
    }
    if (changed) await saveServerDefs(defs);
    return changed;
}

/** 서버 상태 API 용: 공통/커스텀 역할 + 보안 정책 해석 */
export function enrichServerWithRoles(def) {
    const resolved = resolveServerRoles(def, rolesById(loadRolesSync()));
    const sec = resolveServerSecurity(
        def,
        securityPoliciesById(loadSecurityPoliciesSync()),
    );
    return {
        ...def,
        roleIds: resolved.roleIds,
        commonRoles: resolved.commonRoles,
        commonSkills: resolved.commonSkills,
        customSkills: resolved.customSkills,
        skills: resolved.skills,
        skill: resolved.skills[0] ?? null,
        securityIds: sec.securityIds,
        securityPolicies: sec.policies,
        securityPolicyText: sec.securityPolicyText,
        security: def.security === true,
    };
}

/**
 * 포트/URL 기준 고정 역할 저장 (solve/router/planner/embedding/security).
 * role "chat"→solve, "pipeline"→planner 별칭.
 */
export async function persistFixedRole(urlOrPort, role, enabled) {
    let key = String(role || "").toLowerCase();
    if (key === "chat") key = "solve";
    if (key === "pipeline" || key === "design") key = "planner";
    if (key === "보안검증" || key === "seccheck") key = "security";
    const allowed = new Set([
        "solve",
        "router",
        "planner",
        "embedding",
        "security",
    ]);
    if (!allowed.has(key)) {
        throw new Error(`알 수 없는 고정 역할: ${role}`);
    }
    const raw = String(urlOrPort ?? "");
    const port =
        typeof urlOrPort === "number"
            ? urlOrPort
            : Number(raw.match(/:(\d+)(?:\/|$)/)?.[1] ?? raw.match(/^\d+$/)?.[0]);
    if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`${key} 저장 실패: 포트를 파싱할 수 없음 (${raw})`);
    }

    const defs = await loadServerDefs();
    let found = false;
    for (const d of defs) {
        if (Number(d.port) !== port) continue;
        found = true;
        // 구형 guardrail 필드 정리
        delete d.guardrail;
        if (key === "solve") {
            delete d.chat; // 구형 필드 정리
            if (enabled) delete d.solve; // 기본 ON
            else d.solve = false;
        } else if (enabled) {
            d[key] = true;
        } else {
            delete d[key];
            // 보안검증 OFF 시 배정된 보안 정책도 해제
            if (key === "security") {
                delete d.securityIds;
                delete d.securityPolicy;
            }
        }
    }
    if (!found) {
        throw new Error(`${key} 저장 실패: port ${port} 서버 정의 없음`);
    }
    await saveServerDefs(defs);
    return true;
}

/** 보안검증 정책 텍스트 저장 (servers.json securityPolicy) */
export async function persistSecurityPolicy(urlOrPort, policy) {
    const raw = String(urlOrPort ?? "");
    const port =
        typeof urlOrPort === "number"
            ? urlOrPort
            : Number(raw.match(/:(\d+)(?:\/|$)/)?.[1] ?? raw.match(/^\d+$/)?.[0]);
    if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`보안 정책 저장 실패: 포트를 파싱할 수 없음 (${raw})`);
    }
    const defs = await loadServerDefs();
    let found = false;
    const text = String(policy ?? "").trim();
    for (const d of defs) {
        if (Number(d.port) !== port) continue;
        found = true;
        if (text) d.securityPolicy = text;
        else delete d.securityPolicy;
    }
    if (!found) {
        throw new Error(`보안 정책 저장 실패: port ${port} 서버 정의 없음`);
    }
    await saveServerDefs(defs);
    return true;
}

/** @deprecated persistFixedRole(url, "router", enabled) */
export async function persistRouterRole(urlOrPort, enabled) {
    return persistFixedRole(urlOrPort, "router", enabled);
}

/** 현재 router:true 인 서버 정의 (없으면 null) */
export async function getRouterServerDef() {
    const defs = await loadServerDefs();
    return defs.find((d) => d.router === true) ?? null;
}

/** 서버 정의를 servers.json 에서 제거한다 (없으면 null) */
export async function removeServerDef(name) {
    const defs = await loadServerDefs();
    const idx = defs.findIndex((d) => d.name === name);
    if (idx < 0) return null;
    const [def] = defs.splice(idx, 1);
    await saveServerDefs(defs);
    return def;
}

/** 해당 포트를 LISTENING 중인 PID (없으면 null) */
export async function findPidByPort(port) {
    const p = Number(port);
    if (!Number.isFinite(p) || p <= 0) return null;

    if (isWindows) {
        try {
            const { stdout } = await execFileAsync(
                "netstat",
                ["-ano", "-p", "TCP"],
                execOpts({ maxBuffer: 4 * 1024 * 1024 }),
            );
            for (const line of stdout.split(/\r?\n/)) {
                const m = line
                    .trim()
                    .match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
                if (m && Number(m[1]) === p) return Number(m[2]);
            }
        } catch {
            // netstat 실패
        }
        return null;
    }

    // Linux: ss → lsof → /proc/net/tcp 폴백
    try {
        const { stdout } = await execFileAsync(
            "ss",
            ["-ltnpH", `sport = :${p}`],
            execOpts({ maxBuffer: 2 * 1024 * 1024 }),
        );
        const m = stdout.match(/pid=(\d+)/i);
        if (m) return Number(m[1]);
    } catch {
        // ss 없거나 권한 부족
    }
    try {
        const { stdout } = await execFileAsync(
            "lsof",
            ["-nP", `-iTCP:${p}`, "-sTCP:LISTEN", "-t"],
            execOpts({ maxBuffer: 1024 * 1024 }),
        );
        const pid = Number(String(stdout).trim().split(/\r?\n/)[0]);
        if (Number.isFinite(pid) && pid > 0) return pid;
    } catch {
        // lsof 실패
    }
    return null;
}

/**
 * metrics.gpus[].processes 에 로컬 모델 서버 이름/별칭·점유(MB)를 붙인다.
 * Windows WDDM 에서는 nvidia-smi 가 프로세스 VRAM 을 [N/A] 로내므로
 * 실행 중 서버는 estimateVram 으로 보강하고, 합이 실측 used 를 넘으면 비례 축소한다.
 */
export async function enrichMetricsWithServers(metrics) {
    if (!metrics?.gpus?.length) return metrics;
    const defs = (await loadServerDefs()).filter((d) => isLocalDef(d));
    if (!defs.length) return metrics;

    const servers = (
        await Promise.all(
            defs.map(async (d) => {
                const pid = await findPidByPort(d.port);
                if (!pid) return null;
                const { requiredMb } = await estimateVram(d);
                const gpuRaw = String(d.gpu ?? "").trim();
                const gpuIndex = gpuRaw === "" ? 0 : Number(gpuRaw.split(",")[0]) || 0;
                return {
                    pid,
                    serverName: d.name,
                    serverAlias: d.alias || d.name,
                    port: d.port,
                    ngl: Number(d.ngl) || 0,
                    gpuIndex,
                    estimatedMb: Math.max(0, Number(requiredMb) || 0),
                };
            }),
        )
    ).filter(Boolean);

    const byPid = new Map(servers.map((s) => [s.pid, s]));
    const multiGpu = metrics.gpus.length > 1;

    for (const g of metrics.gpus) {
        const raw = Array.isArray(g.processes) ? g.processes : [];
        const pidsOnGpu = new Set(raw.map((p) => p.pid));
        const hasRealMem = raw.some((p) => (Number(p.memUsedMb) || 0) > 0);

        for (const p of raw) {
            const hit = byPid.get(p.pid);
            if (!hit) continue;
            p.serverName = hit.serverName;
            p.serverAlias = hit.serverAlias;
            p.port = hit.port;
            if (!(Number(p.memUsedMb) > 0) && hit.estimatedMb > 0) {
                p.memUsedMb = hit.estimatedMb;
                p.estimated = true;
            }
        }

        if (hasRealMem) {
            // 실측 있는 환경: 서버 매칭·양의 메모리만 남김
            g.processes = raw.filter(
                (p) =>
                    byPid.has(p.pid) ||
                    (Number(p.memUsedMb) || 0) > 0,
            );
            continue;
        }

        // WDDM 등: 이 GPU 위 실행 서버(또는 단일 GPU면 전체) 추정 분해
        let list = servers.filter((s) => {
            if (s.estimatedMb <= 0) return false;
            if (pidsOnGpu.has(s.pid)) return true;
            if (!multiGpu) return s.gpuIndex === g.index || s.gpuIndex === 0;
            return s.gpuIndex === g.index;
        });
        // pid 가 이 GPU 프로세스 목록에 있으면 그쪽을 우선
        const onThis = list.filter((s) => pidsOnGpu.has(s.pid));
        if (onThis.length) list = onThis;

        const used = Number(g.memUsedMb) || 0;
        const sumEst = list.reduce((a, s) => a + s.estimatedMb, 0);
        const scale = sumEst > used && used > 0 ? used / sumEst : 1;

        g.processes = list.map((s) => ({
            pid: s.pid,
            processName: llamaProcessNameHint(),
            memUsedMb: Math.max(1, Math.round(s.estimatedMb * scale)),
            estimated: true,
            serverName: s.serverName,
            serverAlias: s.serverAlias,
            port: s.port,
        }));
        g.processesEstimated = true;
    }
    return metrics;
}

/** PID 의 프로세스 이미지 이름 (소문자, 없으면 null) */
async function processName(pid) {
    if (isWindows) {
        try {
            const { stdout } = await execFileAsync(
                "tasklist",
                ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
                execOpts(),
            );
            const m = stdout.match(/^"([^"]+)"/m);
            return m ? m[1].toLowerCase() : null;
        } catch {
            return null;
        }
    }
    try {
        const { stdout } = await execFileAsync(
            "ps",
            ["-p", String(pid), "-o", "comm="],
            execOpts(),
        );
        const name = String(stdout).trim().toLowerCase();
        return name || null;
    } catch {
        try {
            const cmd = await readFile(`/proc/${pid}/comm`, "utf8");
            return cmd.trim().toLowerCase() || null;
        } catch {
            return null;
        }
    }
}

/** llama-server 프로세스만 종료 */
async function killLlamaPid(pid) {
    if (isWindows) {
        await execFileAsync("taskkill", ["/PID", String(pid), "/F"], execOpts());
        return;
    }
    try {
        process.kill(pid, "SIGTERM");
    } catch (e) {
        if (e?.code === "ESRCH") return;
        throw e;
    }
    for (let i = 0; i < 20; i++) {
        try {
            process.kill(pid, 0);
        } catch {
            return; // 이미 종료
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch (e) {
        if (e?.code !== "ESRCH") throw e;
    }
}

/**
 * 모델 서버 종료. 포트 점유 프로세스가 llama-server 일 때만 강제 종료한다.
 * (무관한 프로세스를 죽이지 않도록 이미지 이름 확인)
 */
export async function stopServer(def) {
    if (!isLocalDef(def)) {
        throw new Error(
            `원격 서버(${def.host})는 부모에서 직접 종료할 수 없습니다 — 하위 관리서버(agent)가 제어합니다.`,
        );
    }
    const pid = await findPidByPort(def.port);
    if (!pid) {
        // 의도적 OFF — 이전 기동 실패 사유는 유지(모니터에 남김)
        return { ok: true, alreadyStopped: true };
    }

    const name = await processName(pid);
    if (!name || !name.includes("llama-server")) {
        throw new Error(
            `포트 ${def.port} 점유 프로세스(${name ?? `PID ${pid}`})가 llama-server 가 아니어서 종료하지 않습니다.`,
        );
    }
    await killLlamaPid(pid);
    // 정상 종료는 실패가 아님 → 사유 클리어 후 "OFF" 만 표시
    await clearStartError(def.name).catch(() => {});
    return { ok: true, pid };
}

// ---- GPU 메모리 사전 점검 ------------------------------------------------
// GGUF 메타(레이어 수) 리더는 src/ggufReader.js 로 분리 (readGgufBlockCount import).

/**
 * GPU 오프로드 비율 (0~1).
 * ngl=0 → 0, ngl≥레이어수 또는 ngl≥99 → 1, 그 외 ngl/layers.
 */
export function gpuOffloadFraction(ngl, layerCount) {
    const n = Number(ngl) || 0;
    if (n <= 0) return 0;
    const layers =
        Number.isFinite(Number(layerCount)) && Number(layerCount) > 0
            ? Number(layerCount)
            : 99;
    if (n >= 99 || n >= layers) return 1;
    return Math.min(1, n / layers);
}

/**
 * 기동에 필요한 VRAM 추정(MB).
 * - ngl=0 → 0 (CPU 전용)
 * - 가중치: 모델파일크기 × (ngl/레이어 비율)
 * - mmproj: GPU 사용 시 전부 전체
 * - KV/버퍼: ctx·오프로드 비율에 비례한 여유
 *
 * @returns {Promise<{ requiredMb: number, detail: object }>}
 */
/** 동시 처리 슬롯 수(continuous batching). def.parallel 우선, 없으면 config 기본. 최소 1. */
export function resolveParallel(def) {
    const p = Number(def?.parallel);
    return Number.isFinite(p) && p >= 1
        ? Math.min(config.llamaParallelCap, Math.floor(p))
        : Math.max(1, Number(config.llamaParallel) || 4);
}

export async function estimateVram(def) {
    const ngl = Number(def.ngl) || 0;
    if (ngl <= 0) {
        return {
            requiredMb: 0,
            detail: { ngl, fraction: 0, reason: "CPU 전용 (ngl=0)" },
        };
    }

    const modelAbs = path.join(ROOT, def.model);
    let modelBytes = 0;
    try {
        modelBytes = (await stat(modelAbs)).size;
    } catch {
        return {
            requiredMb: 0,
            detail: { ngl, reason: "모델 파일 확인 불가 — 점검 생략" },
        };
    }

    let layers =
        Number.isFinite(Number(def.layers)) && Number(def.layers) > 0
            ? Number(def.layers)
            : readGgufBlockCount(modelAbs);
    if (!layers || layers <= 0) layers = 99; // ngl=99 = 전체 오프로드 관례

    const fraction = gpuOffloadFraction(ngl, layers);
    const weightMb = (modelBytes / 1024 / 1024) * fraction;

    let mmprojMb = 0;
    if (def.mmproj) {
        try {
            mmprojMb = (await stat(path.join(ROOT, def.mmproj))).size / 1024 / 1024;
        } catch {}
    }

    const perReqCtx = Number(def.ctx) > 0 ? Number(def.ctx) : 4096;
    const parallel = resolveParallel(def);
    const ctx = perReqCtx * parallel; // 총 컨텍스트 = 요청당 ctx × 슬롯 수
    // KV·스크래치 대략: 기본 384MB + (총)ctx 2k 당 128MB × 오프로드 비율
    const kvMb = (384 + (ctx / 2048) * 128) * Math.max(fraction, 0.15);

    const requiredMb = Math.round(weightMb + mmprojMb + kvMb);
    return {
        requiredMb,
        detail: {
            ngl,
            layers,
            fraction: Math.round(fraction * 1000) / 1000,
            weightMb: Math.round(weightMb),
            mmprojMb: Math.round(mmprojMb),
            kvMb: Math.round(kvMb),
            ctx: perReqCtx,
            parallel,
            totalCtx: ctx,
        },
    };
}

/** @deprecated 호환용 — MB 숫자만 필요할 때 */
export async function estimateVramMb(def) {
    return (await estimateVram(def)).requiredMb;
}

/**
 * 대상 GPU 의 가용 VRAM(MB). gpuId 지정 시 해당 GPU, 아니면 가장 여유 있는 GPU.
 * nvidia-smi 가 없으면 null (점검 생략).
 */
async function gpuFreeMb(gpuId) {
    try {
        const { stdout } = await execFileAsync(
            "nvidia-smi",
            ["--query-gpu=index,memory.free", "--format=csv,noheader,nounits"],
            execOpts({ timeout: config.nvidiaSmiTimeoutMs }),
        );
        const rows = stdout
            .trim()
            .split(/\r?\n/)
            .map((l) => l.split(",").map((s) => s.trim()))
            .filter((p) => p.length >= 2)
            .map(([i, f]) => ({ index: Number(i), freeMb: Number(f) }));
        if (!rows.length) return null;
        if (gpuId !== undefined && gpuId !== null && String(gpuId).trim() !== "") {
            const first = Number(String(gpuId).split(",")[0]);
            const target = rows.find((r) => r.index === first);
            return target ? target.freeMb : null;
        }
        return Math.max(...rows.map((r) => r.freeMb));
    } catch {
        return null;
    }
}

export async function getGpuFreeMb(gpuId) {
    return gpuFreeMb(gpuId);
}

/** nvidia-smi 기준 특정 PID 의 GPU 사용량(MB). 없으면 null */
async function gpuMemUsedByPid(pid) {
    if (!pid) return null;
    try {
        const { stdout } = await execFileAsync(
            "nvidia-smi",
            ["--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"],
            execOpts({ timeout: config.nvidiaSmiTimeoutMs }),
        );
        let total = 0;
        let found = false;
        for (const line of stdout.trim().split(/\r?\n/).filter(Boolean)) {
            const parts = line.split(",").map((s) => s.trim());
            if (parts.length < 2) continue;
            if (Number(parts[0]) !== Number(pid)) continue;
            found = true;
            total += Number(parts[1]) || 0;
        }
        return found ? total : null;
    } catch {
        return null;
    }
}

function sameGpuId(a, b) {
    const ga = String(a ?? "").trim();
    const gb = String(b ?? "").trim();
    if (ga === gb) return true;
    if (!ga && !gb) return true;
    return ga.split(",")[0] === gb.split(",")[0];
}

/**
 * GPU 기동 시 가용 VRAM 이 부족하면 예외를 던진다 (시스템 전체 슬로다운 방지).
 * bonusFreeMb: 곧 해제될(또는 방금 kill 후 아직 안 풀린) 자기 VRAM 보정.
 */
export async function assertGpuCapacity(def, { bonusFreeMb = 0 } = {}) {
    const { requiredMb, detail } = await estimateVram(def);
    if (requiredMb <= 0) return;
    const freeMb = await gpuFreeMb(def.gpu);
    if (freeMb == null) return; // GPU 조회 불가 → 차단하지 않음
    const availableMb = freeMb + Math.max(0, Number(bonusFreeMb) || 0);
    if (availableMb < requiredMb) {
        const gb = (mb) => (mb / 1024).toFixed(1);
        const pct = Math.round((detail.fraction ?? 1) * 100);
        throw new Error(
            `GPU 메모리 부족: "${def.name}" 기동에 약 ${gb(requiredMb)}GB 필요 ` +
                `(ngl=${detail.ngl}/${detail.layers ?? "?"}층 ≈${pct}%, ctx=${detail.ctx})` +
                ` / 가용 ${gb(availableMb)}GB` +
                (bonusFreeMb
                    ? ` (여유 ${gb(freeMb)} + 회수보정 ~${gb(bonusFreeMb)})`
                    : "") +
                `. 다른 GPU 모델을 내리거나 ngl 을 낮추거나 0(CPU)으로 설정하세요.`,
        );
    }
}

/**
 * ngl/ctx/gpu 변경 시 VRAM 예상치 검사.
 * 같은 GPU 에서 재시작·축소면 자기 점유분(실측 우선)을 가용량에 더한다.
 */
export async function assertGpuCapacityForUpdate(oldDef, newDef) {
    const { requiredMb, detail } = await estimateVram(newDef);
    if (requiredMb <= 0) return { requiredMb: 0, freeMb: null, ok: true };
    let freeMb = await gpuFreeMb(newDef.gpu);
    if (freeMb == null) return { requiredMb, freeMb: null, ok: true };

    const sameGpu = sameGpuId(oldDef?.gpu, newDef?.gpu);
    let reclaimMb = 0;
    let oldEst = 0;
    if (sameGpu && Number(oldDef?.ngl) > 0) {
        oldEst = (await estimateVram(oldDef)).requiredMb || 0;
        reclaimMb = oldEst;
        // 동일·축소 재시작은 자기 자리 다시 쓰는 것이므로 통과
        if (oldEst > 0 && requiredMb <= oldEst * 1.02) {
            return { requiredMb, freeMb, reclaimMb, ok: true };
        }
        const pid = oldDef?.port != null ? await findPidByPort(oldDef.port) : null;
        if (pid) {
            const used = await gpuMemUsedByPid(pid);
            if (used != null) reclaimMb = Math.max(reclaimMb, used);
        }
    }
    const availableMb = freeMb + reclaimMb;
    if (availableMb < requiredMb) {
        const gb = (mb) => (mb / 1024).toFixed(1);
        const pct = Math.round((detail.fraction ?? 1) * 100);
        throw new Error(
            `GPU 메모리 부족: "${newDef.name}" 설정에 약 ${gb(requiredMb)}GB 필요 ` +
                `(ngl=${detail.ngl}/${detail.layers ?? "?"}층 ≈${pct}%, ctx=${detail.ctx})` +
                ` / 예상 가용 ${gb(availableMb)}GB` +
                (reclaimMb ? ` (여유 ${gb(freeMb)} + 재시작 회수 ~${gb(reclaimMb)})` : "") +
                `. ngl·ctx를 낮추거나 다른 GPU를 선택하세요.`,
        );
    }
    return { requiredMb, freeMb: availableMb, reclaimMb, ok: true };
}

/**
 * 모델 서버 기동. servers.json 정의(모델/ctx/ngl/mmproj/gpu)대로
 * llama-server 를 백그라운드로 띄운다. 로그: llama/logs/server-<port>.log
 * GPU 모델은 기동 전 가용 VRAM 을 점검해 부족하면 차단한다.
 * 실패 시 data/server-status.json 에 사유를 남겨 모니터에 표시한다.
 * @param {{ bonusFreeMb?: number }} [opts]
 */
export async function startServer(def, opts = {}) {
    try {
        if (!isLocalDef(def)) {
            throw new Error(
                `원격 서버(${def.host})는 부모에서 직접 기동할 수 없습니다 — 하위 관리서버(agent)가 제어합니다.`,
            );
        }
        const existing = await findPidByPort(def.port);
        if (existing) {
            await clearStartError(def.name);
            return { ok: true, alreadyRunning: true, pid: existing };
        }

        await assertGpuCapacity(def, { bonusFreeMb: opts.bonusFreeMb || 0 });

        let exe = null;
        for (const name of llamaServerBinaryNames()) {
            const cand = path.join(ROOT, "llama", name);
            if (existsSync(cand)) {
                exe = cand;
                break;
            }
        }
        if (!exe) exe = "llama-server"; // PATH 폴백

        const modelPath = path.join(ROOT, def.model);
        if (!existsSync(modelPath)) {
            throw new Error(`모델 파일 없음: ${modelPath}`);
        }

        const slots = resolveParallel(def);
        const perReqCtx = Number(def.ctx) > 0 ? Number(def.ctx) : config.llamaDefaultCtx;
        const args = [
            "-m", modelPath,
            "--host", config.llamaBindHost,
            "--port", String(def.port),
            // 요청당 컨텍스트(perReqCtx)를 슬롯 수만큼 확보 → 총 컨텍스트 = perReqCtx × slots.
            // 동시 요청은 continuous batching 으로 병렬 처리(외부 API 동시 호출 대응).
            "-c", String(perReqCtx * slots),
            "--parallel", String(slots),
            "-ngl", String(def.ngl ?? 0),
        ];
        if (def.mmproj) {
            const mmproj = path.join(ROOT, def.mmproj);
            if (existsSync(mmproj)) args.push("--mmproj", mmproj);
        }
        // RAG 임베딩: --embeddings + OAI 호환 pooling (없으면 501 / pooling none 400)
        if (def.embedding === true) {
            args.push("--embeddings", "--pooling", "mean");
        }

        await mkdir(LOG_DIR, { recursive: true });
        const out = openSync(path.join(LOG_DIR, `server-${def.port}.log`), "a");
        const err = openSync(path.join(LOG_DIR, `server-${def.port}.log.err`), "a");

        const env = { ...process.env };
        if (def.gpu !== undefined && def.gpu !== null && def.gpu !== "") {
            env.CUDA_VISIBLE_DEVICES = String(def.gpu);
        }

        const child = spawn(exe, args, {
            detached: true,
            stdio: ["ignore", out, err],
            env,
            ...execOpts(),
        });
        child.unref();
        await setRunningConfig(def.name, def);
        return { ok: true, pid: child.pid };
    } catch (e) {
        await setStartError(def.name, e.message).catch(() => {});
        throw e;
    }
}

/**
 * 종료 후 재기동. 자기 VRAM 이 아직 안 풀린 경우를 bonusFreeMb 로 보정한다.
 */
export async function restartServer(def) {
    const pid = await findPidByPort(def.port);
    const freeBefore = (await gpuFreeMb(def.gpu)) ?? 0;
    const usedMb = pid ? await gpuMemUsedByPid(pid) : null;
    const estMb =
        Number(def.ngl) > 0 ? (await estimateVram(def)).requiredMb || 0 : 0;
    const expectReclaim = Math.max(usedMb ?? 0, estMb);

    await stopServer(def).catch(() => {});

    for (let i = 0; i < 25; i++) {
        if (!(await findPidByPort(def.port))) break;
        await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 600));

    let stillHeld = 0;
    if (expectReclaim > 0) {
        for (let i = 0; i < 12; i++) {
            const freeAfter = (await gpuFreeMb(def.gpu)) ?? freeBefore;
            const released = Math.max(0, freeAfter - freeBefore);
            stillHeld = Math.max(0, expectReclaim - released);
            if (stillHeld <= expectReclaim * 0.12) {
                stillHeld = 0;
                break;
            }
            await new Promise((r) => setTimeout(r, 350));
        }
    }

    return startServer(def, { bonusFreeMb: stillHeld });
}

/** 정의 목록 + 실행 상태(PID) + 최근 기동 실패 사유 병합 */
export async function serverStatus(defs) {
    const errors = await loadStatusMap();
    const policyMap = securityPoliciesById(loadSecurityPoliciesSync());
    return Promise.all(
        defs.map(async (d) => {
            const pid = await findPidByPort(d.port);
            const errRec = errors[d.name];
            const r = resolveServerRoles(d, rolesById(loadRolesSync()));
            const sec = resolveServerSecurity(d, policyMap);
            return {
                name: d.name,
                alias: d.alias || d.name,
                roleIds: r.roleIds,
                commonRoles: r.commonRoles,
                commonSkills: r.commonSkills,
                customSkills: r.customSkills,
                skills: r.skills,
                skill: r.skills[0] ?? null,
                security: d.security === true,
                securityIds: sec.securityIds,
                securityPolicies: sec.policies,
                securityPolicyText: sec.securityPolicyText,
                router: d.router === true,
                planner: d.planner === true,
                embedding: d.embedding === true,
                tier: d.tier,
                port: d.port,
                host: d.host || null,
                url: serverUrl(d),
                model: d.model,
                ctx: d.ctx ?? null,
                parallel: resolveParallel(d),
                ngl: d.ngl,
                gpu: d.gpu ?? "",
                device: Number(d.ngl) > 0 ? "gpu" : "cpu",
                pid,
                runningConfig: errRec?.running ?? null,
                needsRestart: computeNeedsRestart(d, pid, errRec),
                startError: pid ? null : (errRec?.error ?? null),
                startErrorAt: pid ? null : (errRec?.at ?? null),
            };
        }),
    );
}
