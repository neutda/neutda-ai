// llama-server 프로세스 제어 (Windows).
// servers.json 정의를 읽어 개별 모델 서버를 기동/종료한다.
// 종료 시 프로세스를 실제로 내려 VRAM/CPU 메모리가 해제된다.
import { readFile, mkdir } from "node:fs/promises";
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

/**
 * 모델 서버 기동. servers.json 정의(모델/ctx/ngl/mmproj/gpu)대로
 * llama-server 를 백그라운드로 띄운다. 로그: llama/logs/server-<port>.log
 */
export async function startServer(def) {
    const existing = await findPidByPort(def.port);
    if (existing) return { ok: true, alreadyRunning: true, pid: existing };

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
            ngl: d.ngl,
            device: Number(d.ngl) > 0 ? "gpu" : "cpu",
            pid: await findPidByPort(d.port),
        })),
    );
}
