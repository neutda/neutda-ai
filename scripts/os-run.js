#!/usr/bin/env node
/**
 * OS 분기 실행기: WINDOW → PowerShell, LINUX → bash (또는 ctl.mjs 폴백)
 * 사용: node scripts/os-run.js <stop|down|up|restart|llama|cluster> [...args]
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { isWindows, osMode } from "../src/platform.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const name = (process.argv[2] || "").toLowerCase();
const extra = process.argv.slice(3);

const map = {
  stop: { ps1: "stop-serve-agent.ps1", sh: null, ctl: "stop" },
  down: { ps1: "stop-all.ps1", sh: null, ctl: "down" },
  up: { ps1: "start-all.ps1", sh: null, ctl: "up" },
  restart: { ps1: "restart-express.ps1", sh: null, ctl: "restart" },
  llama: { ps1: "run-llama-server.ps1", sh: "run-llama-server.sh" },
  cluster: { ps1: "run-llama-cluster.ps1", sh: "run-llama-cluster.sh" },
};

const entry = map[name];
if (!entry) {
  console.error("사용: node scripts/os-run.js <stop|down|up|restart|llama|cluster>");
  process.exit(1);
}

function run(cmd, args, shell = false) {
  console.log(`[os-run] OS=${osMode} → ${cmd} ${args.join(" ")}`);
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell,
    windowsHide: isWindows,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

if (isWindows && entry.ps1) {
  const file = path.join(__dirname, entry.ps1);
  run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...extra]);
} else if (entry.sh && existsSync(path.join(__dirname, entry.sh))) {
  run("bash", [path.join(__dirname, entry.sh), ...extra]);
} else if (entry.ctl) {
  run(process.execPath, [path.join(__dirname, "ctl.mjs"), entry.ctl, ...extra]);
} else {
  console.error(`[os-run] Linux 용 스크립트 없음: ${name} — ctl.mjs 또는 .sh 를 추가하세요.`);
  process.exit(1);
}
