/**
 * 앱 로그: 인메모리(최근 N) + 일별 JSONL 파일(재시작 후에도 이어짐).
 *  - data/logs/all-<scope>-YYYY-MM-DD.jsonl   … 전체
 *  - data/logs/error-<scope>-YYYY-MM-DD.jsonl … error 만
 * scope 기본 express. agent 는 setLogScope("agent-<id>") 로 분리.
 * 날짜는 로컬 타임존 기준. id 는 당일 파일의 max(id) 다음부터 이어감.
 */
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    closeSync,
    fstatSync,
    readSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX = 1000;
const buffer = [];
let seq = 0;
let seqReady = false;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APP_LOG_DIR = path.resolve(
    process.env.APP_LOG_DIR || path.join(ROOT, "data", "logs"),
);

function sanitizeScope(s) {
    return (
        String(s || "express")
            .replace(/[^a-zA-Z0-9._-]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 80) || "express"
    );
}

/** express | agent-<id> 등 — 파일명에 들어가 프로세스별 분리 */
export let APP_LOG_SCOPE = sanitizeScope(
    process.env.APP_LOG_SCOPE || "express",
);

export function setLogScope(scope) {
    APP_LOG_SCOPE = sanitizeScope(scope);
    // 스코프가 바뀌면 해당 파일 기준으로 id/버퍼를 다시 맞춤
    seqReady = false;
    buffer.length = 0;
    seq = 0;
    void ensureSeqFromFileSync();
}

/** @returns {string} YYYY-MM-DD (로컬) */
export function logDayKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function ensureLogDir() {
    mkdirSync(APP_LOG_DIR, { recursive: true });
}

export function logFilePaths(day = logDayKey(), scope = APP_LOG_SCOPE) {
    const sc = sanitizeScope(scope);
    return {
        all: path.join(APP_LOG_DIR, `all-${sc}-${day}.jsonl`),
        error: path.join(APP_LOG_DIR, `error-${sc}-${day}.jsonl`),
    };
}

function appendJsonl(file, entry) {
    ensureLogDir();
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * 당일 all 파일에서 max(id) 를 구해 seq 를 이어가고,
 * 최근 MAX 건을 메모리 버퍼에 올려 재시작 직후에도 이어진 로그를 보이게 한다.
 */
function ensureSeqFromFileSync() {
    if (seqReady) return;
    seqReady = true;
    const file = logFilePaths(logDayKey()).all;
    if (!existsSync(file)) {
        seq = 0;
        return;
    }
    let maxId = 0;
    const recent = [];
    try {
        // 큰 파일은 끝부분만 읽어 최근 버퍼를 채우고, id 는 가능하면 전체에서 max
        const st = (() => {
            const fd = openSync(file, "r");
            try {
                return fstatSync(fd);
            } finally {
                closeSync(fd);
            }
        })();
        const SCAN_ALL_MAX = 8 * 1024 * 1024; // 8MB 이하면 전체 스캔
        if (st.size <= SCAN_ALL_MAX) {
            const fd = openSync(file, "r");
            try {
                const buf = Buffer.alloc(st.size);
                readSync(fd, buf, 0, st.size, 0);
                for (const line of buf.toString("utf8").split(/\r?\n/)) {
                    if (!line.trim()) continue;
                    try {
                        const o = JSON.parse(line);
                        if (!o || typeof o !== "object") continue;
                        if (typeof o.id === "number" && o.id > maxId) maxId = o.id;
                        recent.push(o);
                        if (recent.length > MAX) recent.shift();
                    } catch {
                        /* skip */
                    }
                }
            } finally {
                closeSync(fd);
            }
        } else {
            // 대용량: 꼬리에서 최근 항목 + id. 꼬리에 리셋된 낮은 id 만 있으면
            // 파일 앞쪽도 한 번 더 훑어 maxId 보정
            const tail = readJsonlTail(file, {
                limit: MAX,
                maxBytes: 2 * 1024 * 1024,
            });
            for (const o of tail) {
                if (typeof o.id === "number" && o.id > maxId) maxId = o.id;
                recent.push(o);
            }
            const head = readJsonlHead(file, { maxBytes: 512 * 1024 });
            for (const o of head) {
                if (typeof o.id === "number" && o.id > maxId) maxId = o.id;
            }
        }
    } catch (e) {
        console.error(`[logger] 기존 로그 로드 실패: ${e.message}`);
    }
    seq = maxId;
    buffer.length = 0;
    buffer.push(...recent);
}

function readJsonlHead(file, { maxBytes = 512 * 1024 } = {}) {
    if (!existsSync(file)) return [];
    let fd;
    try {
        fd = openSync(file, "r");
        const st = fstatSync(fd);
        const len = Math.min(st.size, maxBytes);
        if (len <= 0) return [];
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, 0);
        let text = buf.toString("utf8");
        if (st.size > maxBytes) {
            const nl = text.lastIndexOf("\n");
            if (nl >= 0) text = text.slice(0, nl);
        }
        const out = [];
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const o = JSON.parse(line);
                if (o && typeof o === "object") out.push(o);
            } catch {
                /* skip */
            }
        }
        return out;
    } catch {
        return [];
    } finally {
        if (fd != null) {
            try {
                closeSync(fd);
            } catch {
                /* ignore */
            }
        }
    }
}

export function addLog(level, message, meta = null) {
    ensureSeqFromFileSync();
    const entry = {
        id: ++seq,
        ts: new Date().toISOString(),
        level,
        message: String(message),
        meta: meta ?? null,
    };
    buffer.push(entry);
    if (buffer.length > MAX) buffer.shift();

    try {
        const files = logFilePaths(logDayKey());
        appendJsonl(files.all, entry);
        if (level === "error") appendJsonl(files.error, entry);
    } catch (e) {
        console.error(`[logger] 파일 기록 실패: ${e.message}`);
    }

    const line = `[${entry.ts}] ${level.toUpperCase()} ${entry.message}`;
    try {
        if (level === "error") console.error(line);
        else if (level === "warn") console.warn(line);
        else console.log(line);
    } catch {
        // 터미널 파이프가 깨져도 파일 로그는 남긴다 (EPIPE 로 프로세스 종료 방지)
    }

    return entry;
}

export const logger = {
    debug: (m, meta) => addLog("debug", m, meta),
    info: (m, meta) => addLog("info", m, meta),
    warn: (m, meta) => addLog("warn", m, meta),
    error: (m, meta) => addLog("error", m, meta),
};

/**
 * JSONL 파일 끝에서 최대 maxBytes 읽고 줄 단위 파싱.
 * @returns {object[]}
 */
function readJsonlTail(file, { limit = 1000, maxBytes = 2 * 1024 * 1024 } = {}) {
    if (!existsSync(file)) return [];
    let fd;
    try {
        fd = openSync(file, "r");
        const st = fstatSync(fd);
        const size = st.size;
        if (size <= 0) return [];
        const start = Math.max(0, size - maxBytes);
        const len = size - start;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, start);
        let text = buf.toString("utf8");
        if (start > 0) {
            const nl = text.indexOf("\n");
            if (nl >= 0) text = text.slice(nl + 1);
        }
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        const slice =
            limit && lines.length > limit ? lines.slice(-limit) : lines;
        const out = [];
        for (const line of slice) {
            try {
                const o = JSON.parse(line);
                if (o && typeof o === "object") out.push(o);
            } catch {
                /* skip bad line */
            }
        }
        return out;
    } catch {
        return [];
    } finally {
        if (fd != null) {
            try {
                closeSync(fd);
            } catch {
                /* ignore */
            }
        }
    }
}

/**
 * 존재하는 로그 날짜 목록 (최신 먼저). 오늘 날짜는 파일이 없어도 포함.
 */
export function listLogDates() {
    const days = new Set([logDayKey()]);
    try {
        ensureLogDir();
        for (const name of readdirSync(APP_LOG_DIR)) {
            let m = /^(?:all|error)-(.+)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(
                name,
            );
            if (m) {
                days.add(m[2]);
                continue;
            }
            m = /^(?:all|error)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
            if (m) days.add(m[1]);
        }
    } catch {
        /* empty dir ok */
    }
    return [...days].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/**
 * 일별 파일에서 로그 조회.
 * level=error 이면 error-*.jsonl, 그 외(all/info/warn…)는 all-*.jsonl 후 필터.
 */
export function getLogsFromFile(
    date,
    { level = "all", limit = 1000, sinceId = 0, scope = APP_LOG_SCOPE } = {},
) {
    const day =
        typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
            ? date
            : logDayKey();
    const files = logFilePaths(day, scope);
    const legacy = {
        all: path.join(APP_LOG_DIR, `all-${day}.jsonl`),
        error: path.join(APP_LOG_DIR, `error-${day}.jsonl`),
    };
    const preferError = level === "error";
    const pick = (primary, fallback) =>
        existsSync(primary) ? primary : fallback;

    let items = readJsonlTail(
        pick(
            preferError ? files.error : files.all,
            preferError ? legacy.error : legacy.all,
        ),
        { limit: Math.max(limit * 2, limit) },
    );
    if (preferError && items.length === 0) {
        items = readJsonlTail(pick(files.all, legacy.all), {
            limit: Math.max(limit * 3, limit),
        });
        items = items.filter((e) => e.level === "error");
    } else if (level && level !== "all" && !preferError) {
        items = items.filter((e) => e.level === level);
    }
    if (sinceId) {
        items = items.filter(
            (e) => typeof e.id === "number" && e.id > sinceId,
        );
    }
    if (limit && items.length > limit) items = items.slice(-limit);
    return items;
}

/**
 * 로그 조회 — 항상 일별 파일 기준(재시작 후에도 이어짐).
 * date 생략 시 오늘.
 */
export function getLogs({
    level = "all",
    limit = 300,
    sinceId = 0,
    date = null,
} = {}) {
    ensureSeqFromFileSync();
    return getLogsFromFile(date || logDayKey(), { level, limit, sinceId });
}

/** 파일이 실제로 있는지 (UI 표시용) */
export function logFileStats(day = logDayKey()) {
    const files = logFilePaths(day);
    const byteSize = (p) => {
        try {
            if (!existsSync(p)) return 0;
            const fd = openSync(p, "r");
            try {
                return fstatSync(fd).size;
            } finally {
                closeSync(fd);
            }
        } catch {
            return 0;
        }
    };
    return {
        date: day,
        allPath: files.all,
        errorPath: files.error,
        allBytes: byteSize(files.all),
        errorBytes: byteSize(files.error),
        hasAll: existsSync(files.all),
        hasError: existsSync(files.error),
    };
}

// 모듈 로드 시 오늘 파일에서 id/버퍼 복원 (express 기본 스코프).
// agent 는 setLogScope 후 다시 복원한다.
ensureSeqFromFileSync();
