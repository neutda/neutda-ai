import os from "node:os";
import { exec } from "node:child_process";

/**
 * 시스템 자원 사용량(GPU/CPU/RAM)을 수집한다.
 * - GPU: nvidia-smi 질의 (없으면 빈 배열)
 * - CPU: os.cpus() 시간 델타로 사용률 계산
 * - RAM: os.totalmem/freemem
 */

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}

let prevCpu = cpuTimes();

function getCpu() {
  const cur = cpuTimes();
  const idleDelta = cur.idle - prevCpu.idle;
  const totalDelta = cur.total - prevCpu.total;
  prevCpu = cur;
  const usage = totalDelta > 0 ? 1 - idleDelta / totalDelta : 0;
  return {
    cores: os.cpus().length,
    usagePct: Math.round(Math.max(0, Math.min(1, usage)) * 100),
    model: os.cpus()[0]?.model?.trim() ?? "unknown",
  };
}

function getMem() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    totalMb: Math.round(total / 1024 / 1024),
    usedMb: Math.round(used / 1024 / 1024),
    freeMb: Math.round(free / 1024 / 1024),
    usagePct: Math.round((used / total) * 100),
  };
}

function getGpu() {
  return new Promise((resolve) => {
    const q = [
      "index",
      "name",
      "utilization.gpu",
      "memory.used",
      "memory.total",
      "temperature.gpu",
      "power.draw",
    ].join(",");
    const cmd = `nvidia-smi --query-gpu=${q} --format=csv,noheader,nounits`;
    exec(cmd, { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const gpus = stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split(",").map((s) => s.trim()))
        .filter((p) => p.length >= 5)
        .map((p) => {
          const usedMb = Number(p[3]);
          const totalMb = Number(p[4]);
          return {
            index: Number(p[0]),
            name: p[1],
            utilPct: Number(p[2]),
            memUsedMb: usedMb,
            memTotalMb: totalMb,
            memUsagePct: totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : null,
            tempC: p[5] !== undefined ? Number(p[5]) : null,
            powerW: p[6] !== undefined && p[6] !== "[N/A]" ? Number(p[6]) : null,
          };
        });
      resolve(gpus);
    });
  });
}

export async function getMetrics() {
  const gpus = await getGpu();
  return {
    ts: new Date().toISOString(),
    cpu: getCpu(),
    mem: getMem(),
    gpus,
  };
}
