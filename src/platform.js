/**
 * 호스트 OS 모드 (serve / agent 공용).
 * .env: OS=LINUX | WINDOW | WINDOWS | auto
 * - WINDOW / WINDOWS → Windows 프로세스 명령 (netstat/taskkill 등)
 * - LINUX → Linux (ss/lsof, SIGTERM 등)
 * - auto(기본·미지정) → process.platform
 */
import "dotenv/config";

function resolveOsMode() {
  const raw = String(process.env.OS || "auto")
    .trim()
    .toUpperCase();
  if (raw === "LINUX" || raw === "LIN") return "LINUX";
  if (raw === "WINDOW" || raw === "WINDOWS" || raw === "WIN") return "WINDOW";
  // auto
  return process.platform === "win32" ? "WINDOW" : "LINUX";
}

export const osMode = resolveOsMode();
export const isWindows = osMode === "WINDOW";
export const isLinux = osMode === "LINUX";

/** child_process 공통 옵션 */
export function execOpts(extra = {}) {
  return {
    windowsHide: isWindows,
    ...extra,
  };
}

/** llama-server 실행 파일 후보 (프로젝트 llama/ 아래) */
export function llamaServerBinaryNames() {
  if (isWindows) return ["llama-server.exe", "llama-server"];
  return ["llama-server", "llama-server.exe"];
}

export function llamaProcessNameHint() {
  return isWindows ? "llama-server.exe" : "llama-server";
}
