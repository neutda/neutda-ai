// llama-server 파일 로그(tail) 읽기.
// 기동 시 stdout/stderr → llama/logs/server-<port>.log[.err]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerDefs } from "./serverManager.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LLAMA_LOG_DIR = path.join(ROOT, "llama", "logs");

function logPaths(port) {
    const base = path.join(LLAMA_LOG_DIR, `server-${port}`);
    return { out: `${base}.log`, err: `${base}.log.err` };
}

/** 파일 끝에서 최대 maxBytes 읽어 줄 단위로 반환 (최신 쪽 유지) + mtime */
async function readTailLines(file, maxBytes = 256 * 1024, maxLines = 500) {
    let st;
    try {
        st = await fs.stat(file);
    } catch {
        return { lines: [], mtimeMs: 0 };
    }
    if (!st.size) return { lines: [], mtimeMs: st.mtimeMs || 0 };
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const fh = await fs.open(file, "r");
    try {
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        let text = buf.toString("utf8");
        if (start > 0) {
            const nl = text.indexOf("\n");
            if (nl >= 0) text = text.slice(nl + 1);
        }
        const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
        return {
            lines: lines.length > maxLines ? lines.slice(-maxLines) : lines,
            mtimeMs: st.mtimeMs || Date.now(),
        };
    } finally {
        await fh.close();
    }
}

function guessLevel(line) {
    const s = line.toLowerCase();
    if (/\berror\b|\bfatal\b|\bcrit/.test(s)) return "error";
    if (/\bwarn(ing)?\b/.test(s)) return "warn";
    if (/\bdebug\b/.test(s)) return "debug";
    return "info";
}

/** ISO 비슷하거나 llama 타임스탬프가 있으면 추출, 없으면 null */
function guessTs(line) {
    const iso = line.match(
        /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/,
    );
    if (iso) {
        const d = new Date(iso[0]);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return null;
}

/**
 * 포트의 llama stdout/stderr 로그를 통합 엔트리로.
 * llama 는 보통 stderr 에 info 를 남기고, 줄에 ISO 시각이 없는 경우가 많다.
 * → 파싱 실패 시 파일 mtime 을 써서 날짜 필터/정렬이 깨지지 않게 한다.
 * @returns {Promise<Array<{id,ts,level,message,stream}>>}
 */
export async function readLlamaLogs(port, { limit = 400, stream = "both" } = {}) {
    const p = Number(port);
    if (!Number.isFinite(p) || p <= 0) return [];
    const paths = logPaths(p);
    const wantOut = stream === "both" || stream === "out";
    const wantErr = stream === "both" || stream === "err";
    const chunks = [];

    async function pushFile(file, streamName) {
        const { lines, mtimeMs } = await readTailLines(file);
        const fallbackTs = new Date(mtimeMs || Date.now()).toISOString();
        lines.forEach((line, i) => {
            const parsed = guessTs(line);
            chunks.push({
                id: `llama:${p}:${streamName}:${i}`,
                ts: parsed || fallbackTs,
                tsGuessed: !parsed,
                level: guessLevel(line),
                message: line,
                stream: streamName,
            });
        });
    }

    if (wantOut) await pushFile(paths.out, "out");
    if (wantErr) await pushFile(paths.err, "err");

    // 파일 내 순서 유지용. 같은 fallback ts 면 _ord 로 안정 정렬
    chunks.forEach((c, i) => {
        c._ord = i;
    });
    chunks.sort((a, b) => {
        const ta = new Date(a.ts).getTime();
        const tb = new Date(b.ts).getTime();
        if (ta !== tb) return ta - tb;
        return a._ord - b._ord;
    });
    const out = limit && chunks.length > limit ? chunks.slice(-limit) : chunks;
    return out.map(({ _ord, ...rest }) => rest);
}

/** 이 머신 servers.json 기준 llama 로그 소스 목록 */
export async function listLocalLlamaLogSources() {
    const defs = await loadServerDefs();
    const out = [];
    for (const d of defs) {
        const port = Number(d.port);
        if (!Number.isFinite(port)) continue;
        const paths = logPaths(port);
        let hasOut = false;
        let hasErr = false;
        try {
            await fs.access(paths.out);
            hasOut = true;
        } catch {}
        try {
            await fs.access(paths.err);
            hasErr = true;
        } catch {}
        out.push({
            kind: "llama",
            port,
            name: d.name,
            alias: d.alias || d.name,
            tier: d.tier,
            hasOut,
            hasErr,
            label: `${d.alias || d.name} :${port}`,
        });
    }
    return out;
}
