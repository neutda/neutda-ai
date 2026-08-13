#!/usr/bin/env node
/**
 * OS 공통 제어: stop | down | restart | up
 * .env OS=LINUX|WINDOW|auto 에 따라 serverManager/platform 분기 사용.
 *
 * Windows 전용 레거시: scripts/*.ps1 (llama/cluster 다운로드 등) 은 os-run.js 참고.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import {
  findPidByPort,
  loadServerDefs,
  startServer,
  stopServer,
} from "../src/serverManager.js";
import { execOpts, isWindows, llamaProcessNameHint, osMode } from "../src/platform.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const LOG_DIR = path.join(ROOT, "llama", "logs");

const cmd = (process.argv[2] || "").toLowerCase();
const port = Number(process.env.PORT) || config.port || 3000;
const agentPort = Number(process.env.AGENT_PORT) || config.agent?.port || 4100;

function log(msg) {
  console.log(msg);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** node src/(server|agent|solo).js 프로세스 PID 목록 */
async function findNodeAppPids() {
  const pids = new Set();
  if (isWindows) {
    try {
      const { stdout } = await execFileAsync(
        "wmic",
        ["process", "where", "name='node.exe'", "get", "ProcessId,CommandLine", "/FORMAT:CSV"],
        execOpts({ maxBuffer: 8 * 1024 * 1024 }),
      );
      for (const line of stdout.split(/\r?\n/)) {
        if (!/src[\\/]+(server|agent|solo)\.js/i.test(line)) continue;
        const m = line.match(/,(\d+)\s*$/);
        if (m) pids.add(Number(m[1]));
      }
    } catch {
      // wmic 실패 시 포트 폴백만
    }
  } else {
    try {
      const { stdout } = await execFileAsync(
        "ps",
        ["-eo", "pid,args"],
        execOpts({ maxBuffer: 8 * 1024 * 1024 }),
      );
      for (const line of stdout.split(/\n/)) {
        if (!/node\s+.*src\/(server|agent|solo)\.js/.test(line)) continue;
        const m = line.trim().match(/^(\d+)\s/);
        if (m) pids.add(Number(m[1]));
      }
    } catch {
      // ignore
    }
  }
  for (const p of [port, agentPort]) {
    const pid = await findPidByPort(p);
    if (!pid) continue;
    // 포트 점유가 node 인 경우만
    try {
      if (isWindows) {
        const { stdout } = await execFileAsync(
          "tasklist",
          ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
          execOpts(),
        );
        if (/node/i.test(stdout)) pids.add(pid);
      } else {
        const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="], execOpts());
        if (/^node/.test(String(stdout).trim())) pids.add(pid);
      }
    } catch {
      // skip
    }
  }
  return [...pids];
}

async function killPid(pid, why) {
  try {
    if (isWindows) {
      await execFileAsync("taskkill", ["/PID", String(pid), "/F"], execOpts());
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch (e) {
        if (e?.code === "ESRCH") return;
        throw e;
      }
      await sleep(200);
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    log(`[stop] 종료 PID=${pid} — ${why}`);
  } catch (e) {
    log(`[stop] PID=${pid} 종료 실패: ${e.message}`);
  }
}

async function cmdStop() {
  const pids = await findNodeAppPids();
  if (!pids.length) {
    log("[stop] 실행 중인 serve/agent/solo 없음");
    return;
  }
  for (const pid of pids) await killPid(pid, "serve/agent/solo");
  log(`[stop] 완료 (${pids.length}개 프로세스)`);
}

async function findLlamaPids() {
  const pids = new Set();
  const hint = llamaProcessNameHint().replace(/\.exe$/i, "");
  if (isWindows) {
    try {
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FI", `IMAGENAME eq ${hint}.exe`, "/FO", "CSV", "/NH"],
        execOpts(),
      );
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^"[^"]+","(\d+)"/);
        if (m) pids.add(Number(m[1]));
      }
    } catch {
      // ignore
    }
  } else {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-f", hint], execOpts());
      for (const line of stdout.split(/\n/)) {
        const n = Number(line.trim());
        if (n > 0) pids.add(n);
      }
    } catch {
      // pgrep 없으면 servers.json 포트로
    }
  }
  try {
    const defs = await loadServerDefs();
    for (const d of defs) {
      const pid = await findPidByPort(d.port);
      if (pid) pids.add(pid);
    }
  } catch {
    // ignore
  }
  return [...pids];
}

async function cmdDown() {
  await cmdStop();
  const defs = await loadServerDefs().catch(() => []);
  for (const d of defs) {
    try {
      await stopServer(d);
      log(`[down] ${d.name} 종료`);
    } catch {
      // 이미 없음 / 원격
    }
  }
  // 남은 llama 강제
  for (const pid of await findLlamaPids()) {
    await killPid(pid, llamaProcessNameHint());
  }
  log("[down] 완료");
}

async function spawnDetachedNode(entryRel, logBase) {
  await mkdir(LOG_DIR, { recursive: true });
  const outFd = openSync(path.join(LOG_DIR, `${logBase}.log`), "a");
  const errFd = openSync(path.join(LOG_DIR, `${logBase}.log.err`), "a");
  const child = spawn(process.execPath, [path.join(ROOT, entryRel)], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", outFd, errFd],
    env: { ...process.env, PORT: String(port) },
    ...execOpts(),
  });
  child.unref();
  try {
    closeSync(outFd);
    closeSync(errFd);
  } catch {
    // ignore
  }
  return child.pid;
}

async function waitHealth(portNum, sec) {
  const url = `http://127.0.0.1:${portNum}/health`;
  const deadline = Date.now() + sec * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {
      // retry
    }
    await sleep(2000);
  }
  return false;
}

async function cmdRestart() {
  const pid = await findPidByPort(port);
  if (pid) await killPid(pid, `Express :${port}`);
  else log("[restart] 실행 중인 Express 없음 → 새로 기동");
  await sleep(600);
  await spawnDetachedNode("src/server.js", "express");
  await sleep(1500);
  log(`[restart] Express 재시작 완료 (모델 서버 유지)  http://localhost:${port}/`);
}

async function cmdUp() {
  const waitSec = Number(process.env.UP_WAIT_SEC) || 180;
  const defs = await loadServerDefs();
  const tierRank = { large: 0, medium: 1, small: 2 };
  const servers = [...defs].sort((a, b) => {
    const ta = tierRank[a.tier] ?? 9;
    const tb = tierRank[b.tier] ?? 9;
    if (ta !== tb) return ta - tb;
    const ga = Number(a.ngl) > 0 ? 0 : 1;
    const gb = Number(b.ngl) > 0 ? 0 : 1;
    if (ga !== gb) return ga - gb;
    return Number(a.port) - Number(b.port);
  });

  log(`[up] OS=${osMode} 기동 순서: ${servers.map((s) => s.name).join(" → ")}`);

  let ok = 0;
  let fail = 0;
  for (const def of servers) {
    const existing = await findPidByPort(def.port);
    if (existing) {
      log(`[up] ${def.name} (:${def.port}) 이미 실행 중 → 건너뜀`);
      ok++;
      continue;
    }
    const modelPath = path.join(ROOT, def.model);
    if (!existsSync(modelPath)) {
      log(`[up] ✗ ${def.name} — 모델 파일 없음: ${def.model}`);
      fail++;
      continue;
    }
    try {
      await startServer(def);
      const isGpu = Number(def.ngl) > 0;
      const wait = isGpu ? waitSec : Math.min(45, waitSec);
      if (await waitHealth(def.port, wait)) {
        log(`[up] ✓ ${def.name} 헬스 OK`);
        ok++;
      } else {
        log(`[up] ✗ ${def.name} — 헬스 응답 없음 (최대 ${wait}s)`);
        fail++;
      }
    } catch (e) {
      log(`[up] ✗ ${def.name} — ${e.message}`);
      fail++;
    }
  }

  log(`[up] 성공 ${ok} / 실패 ${fail} (전체 ${servers.length})`);

  const expressPid = await findPidByPort(port);
  if (expressPid) await killPid(expressPid, `Express :${port}`);
  await spawnDetachedNode("src/server.js", "express");
  await sleep(1500);
  log(`[up] 완료!  http://localhost:${port}/`);
  log("     종료: npm run down");
}

async function main() {
  log(`[ctl] OS=${osMode}`);
  if (cmd === "stop") return cmdStop();
  if (cmd === "down") return cmdDown();
  if (cmd === "restart") return cmdRestart();
  if (cmd === "up") return cmdUp();
  console.error("사용: node scripts/ctl.mjs <stop|down|restart|up>");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
