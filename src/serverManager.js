// llama-server 프로세스 제어 (Windows).
// servers.json 정의를 읽어 개별 모델 서버를 기동/종료한다.
// 종료 시 프로세스를 실제로 내려 VRAM/CPU 메모리가 해제된다.
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync, openSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SERVERS_FILE = path.join(ROOT, "servers.json");
const LOG_DIR = path.join(ROOT, "llama", "logs");

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
    for (let p = 8080; p < 8200; p++) {
        if (used.has(p)) continue;
        if (await findPidByPort(p)) continue;
        return p;
    }
    throw new Error("사용 가능한 포트(8080~8199)를 찾지 못했습니다.");
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
 * 이름·포트는 자동 할당, 미지정 값은 같은 티어의 첫 정의(템플릿)에서 가져온다.
 */
export async function addServerDef({ tier, model, ctx, ngl, gpu }) {
    const defs = await loadServerDefs();
    const template = defs.find((d) => d.tier === tier);

    const def = {
        name: pickName(defs, tier),
        tier,
        port: await pickFreePort(defs),
        model: (model && String(model).trim()) || template?.model,
        ctx:
            Number.isFinite(Number(ctx)) && Number(ctx) > 0
                ? Number(ctx)
                : (template?.ctx ?? 4096),
        ngl:
            Number.isFinite(Number(ngl)) && Number(ngl) >= 0
                ? Number(ngl)
                : (template?.ngl ?? 0),
        gpu:
            gpu !== undefined && gpu !== null
                ? String(gpu)
                : (template?.gpu ?? ""),
    };
    if (template?.mmproj) def.mmproj = template.mmproj;

    if (!def.model) {
        throw new Error(
            `"${tier}" 티어의 기존 정의가 없어 기본 모델을 정할 수 없습니다. model 을 직접 지정하세요.`,
        );
    }
    if (!existsSync(path.join(ROOT, def.model))) {
        throw new Error(`모델 파일 없음: ${def.model}`);
    }

    defs.push(def);
    await saveServerDefs(defs);
    return def;
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
    try {
        const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], {
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
        });
        for (const line of stdout.split(/\r?\n/)) {
            const m = line
                .trim()
                .match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
            if (m && Number(m[1]) === Number(port)) return Number(m[2]);
        }
    } catch {
        // netstat 실패 시 미확인 → null
    }
    return null;
}

/** PID 의 프로세스 이미지 이름 (소문자, 없으면 null) */
async function processName(pid) {
    try {
        const { stdout } = await execFileAsync(
            "tasklist",
            ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
            { windowsHide: true },
        );
        const m = stdout.match(/^"([^"]+)"/m);
        return m ? m[1].toLowerCase() : null;
    } catch {
        return null;
    }
}

/**
 * 모델 서버 종료. 포트 점유 프로세스가 llama-server 일 때만 강제 종료한다.
 * (무관한 프로세스를 죽이지 않도록 이미지 이름 확인)
 */
export async function stopServer(def) {
    const pid = await findPidByPort(def.port);
    if (!pid) return { ok: true, alreadyStopped: true };

    const name = await processName(pid);
    if (!name || !name.includes("llama-server")) {
        throw new Error(
            `포트 ${def.port} 점유 프로세스(${name ?? `PID ${pid}`})가 llama-server 가 아니어서 종료하지 않습니다.`,
        );
    }
    await execFileAsync("taskkill", ["/PID", String(pid), "/F"], {
        windowsHide: true,
    });
    return { ok: true, pid };
}

// ---- GPU 메모리 사전 점검 ------------------------------------------------

/**
 * 기동에 필요한 VRAM 추정(MB). 모델 파일 크기(+mmproj) + 512MB(KV·버퍼 여유).
 * ngl=0(CPU 전용)이면 0.
 */
async function estimateVramMb(def) {
    if (!Number(def.ngl)) return 0;
    let bytes = 0;
    try {
        bytes += (await stat(path.join(ROOT, def.model))).size;
    } catch {
        return 0; // 파일 확인 불가 시 점검 생략 (기동 단계에서 별도 검증)
    }
    if (def.mmproj) {
        try {
            bytes += (await stat(path.join(ROOT, def.mmproj))).size;
        } catch {}
    }
    return Math.round(bytes / 1024 / 1024 + 512);
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
            { windowsHide: true, timeout: 4000 },
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

/**
 * GPU 기동 시 가용 VRAM 이 부족하면 예외를 던진다 (시스템 전체 슬로다운 방지).
 */
export async function assertGpuCapacity(def) {
    const requiredMb = await estimateVramMb(def);
    if (requiredMb <= 0) return;
    const freeMb = await gpuFreeMb(def.gpu);
    if (freeMb == null) return; // GPU 조회 불가 → 차단하지 않음
    if (freeMb < requiredMb) {
        const gb = (mb) => (mb / 1024).toFixed(1);
        throw new Error(
            `GPU 메모리 부족: "${def.name}" 기동에 약 ${gb(requiredMb)}GB 가 필요하지만 가용 VRAM 은 ${gb(freeMb)}GB 입니다. ` +
                `다른 모델 서버를 내리거나, GPU 레이어(ngl)를 0(CPU)으로 설정하세요.`,
        );
    }
}

/**
 * 모델 서버 기동. servers.json 정의(모델/ctx/ngl/mmproj/gpu)대로
 * llama-server 를 백그라운드로 띄운다. 로그: llama/logs/server-<port>.log
 * GPU 모델은 기동 전 가용 VRAM 을 점검해 부족하면 차단한다.
 */
export async function startServer(def) {
    const existing = await findPidByPort(def.port);
    if (existing) return { ok: true, alreadyRunning: true, pid: existing };

    await assertGpuCapacity(def);

    let exe = path.join(ROOT, "llama", "llama-server.exe");
    if (!existsSync(exe)) exe = "llama-server"; // PATH 폴백

    const modelPath = path.join(ROOT, def.model);
    if (!existsSync(modelPath)) {
        throw new Error(`모델 파일 없음: ${modelPath}`);
    }

    const args = [
        "-m", modelPath,
        "--host", "127.0.0.1",
        "--port", String(def.port),
        "-c", String(def.ctx ?? 4096),
        "-ngl", String(def.ngl ?? 0),
    ];
    if (def.mmproj) {
        const mmproj = path.join(ROOT, def.mmproj);
        if (existsSync(mmproj)) args.push("--mmproj", mmproj);
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
        windowsHide: true,
    });
    child.unref();
    return { ok: true, pid: child.pid };
}

/** 정의 목록 + 실행 상태(PID) 병합 */
export async function serverStatus(defs) {
    return Promise.all(
        defs.map(async (d) => ({
            name: d.name,
            tier: d.tier,
            port: d.port,
            url: `http://127.0.0.1:${d.port}`,
            model: d.model,
            ctx: d.ctx ?? null,
            ngl: d.ngl,
            gpu: d.gpu ?? "",
            device: Number(d.ngl) > 0 ? "gpu" : "cpu",
            pid: await findPidByPort(d.port),
        })),
    );
}
