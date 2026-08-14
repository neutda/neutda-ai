/**
 * 외부 API 키별 사용 통계·에러 집계 (data/keyStats.json).
 * - 시간별 버킷(요청·토큰·에러)으로 추이 그래프를 그린다 (최근 14일 바운드).
 * - 에러는 코드별 카운트 + 최근 샘플을 보관한다.
 * 실제 대화 원문은 history.js(channel=ask:<keyId>)에 있으므로 여기선 수치만.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "keyStats.json");

const HOUR_MS = 3600 * 1000;
const KEEP_HOURS = 24 * 14; // 최근 14일치 시간 버킷만 유지
const RECENT_ERRORS = 20;
const TIERS = ["small", "medium", "large"];

let store = null; // { keys: { [keyId]: {...} } }
let saveTimer = null;

function load() {
    if (store) return store;
    let parsed = { keys: {} };
    if (existsSync(FILE)) {
        try {
            const raw = JSON.parse(readFileSync(FILE, "utf-8"));
            if (raw && typeof raw.keys === "object") parsed = raw;
        } catch {
            parsed = { keys: {} };
        }
    }
    store = parsed;
    return store;
}

function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveNow().catch(() => {});
    }, 2000);
    if (saveTimer.unref) saveTimer.unref();
}

async function saveNow() {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(FILE, JSON.stringify(store ?? { keys: {} }), "utf-8");
}

function emptyRec() {
    return {
        totals: { requests: 0, tokens: 0, errors: 0 },
        byTier: {},
        errorsByCode: {},
        recentErrors: [],
        hourly: {}, // epochHour -> { req, tok, err }
    };
}

function pruneHourly(rec, nowHour) {
    const cutoff = nowHour - KEEP_HOURS;
    for (const h of Object.keys(rec.hourly)) {
        if (Number(h) < cutoff) delete rec.hourly[h];
    }
}

/**
 * 요청 1건 결과 기록.
 * @param {string} keyId
 * @param {{ ok:boolean, tokens?:number, tier?:string, code?:number|string }} r
 */
export function recordKeyStat(keyId, r = {}) {
    if (!keyId) return;
    load();
    const rec = (store.keys[keyId] ||= emptyRec());
    const nowHour = Math.floor(Date.now() / HOUR_MS);
    const bucket = (rec.hourly[nowHour] ||= { req: 0, tok: 0, err: 0 });

    rec.totals.requests++;
    bucket.req++;

    const tok = Number(r.tokens);
    if (Number.isFinite(tok) && tok > 0) {
        rec.totals.tokens += tok;
        bucket.tok += tok;
    }

    if (r.tier && TIERS.includes(r.tier)) {
        const t = (rec.byTier[r.tier] ||= { requests: 0, tokens: 0 });
        t.requests++;
        if (Number.isFinite(tok) && tok > 0) t.tokens += tok;
    }

    if (!r.ok) {
        rec.totals.errors++;
        bucket.err++;
        const code = String(r.code ?? "error");
        rec.errorsByCode[code] = (rec.errorsByCode[code] || 0) + 1;
        rec.recentErrors.unshift({
            ts: new Date().toISOString(),
            code,
        });
        if (rec.recentErrors.length > RECENT_ERRORS)
            rec.recentErrors.length = RECENT_ERRORS;
    }

    pruneHourly(rec, nowHour);
    scheduleSave();
}

/** 시간별 버킷을 시각 오름차순 배열로. */
function hourlySeries(rec) {
    return Object.keys(rec.hourly)
        .map(Number)
        .sort((a, b) => a - b)
        .map((h) => ({
            hour: new Date(h * HOUR_MS).toISOString(),
            req: rec.hourly[h].req,
            tok: rec.hourly[h].tok,
            err: rec.hourly[h].err,
        }));
}

/** 일자별 집계(로컬 날짜 키). */
function dailySeries(series) {
    const byDay = new Map();
    for (const s of series) {
        const day = new Date(s.hour).toLocaleDateString("en-CA"); // YYYY-MM-DD
        const d = byDay.get(day) || { day, req: 0, tok: 0, err: 0 };
        d.req += s.req;
        d.tok += s.tok;
        d.err += s.err;
        byDay.set(day, d);
    }
    return [...byDay.values()];
}

export function getKeyStats(keyId) {
    load();
    const rec = store.keys[keyId];
    if (!rec) {
        return {
            totals: { requests: 0, tokens: 0, errors: 0 },
            byTier: {},
            errorsByCode: {},
            recentErrors: [],
            hourly: [],
            daily: [],
        };
    }
    const hourly = hourlySeries(rec);
    return {
        totals: rec.totals,
        byTier: rec.byTier,
        errorsByCode: rec.errorsByCode,
        recentErrors: rec.recentErrors,
        hourly,
        daily: dailySeries(hourly),
    };
}

export function clearKeyStats(keyId) {
    load();
    if (store.keys[keyId]) {
        delete store.keys[keyId];
        scheduleSave();
    }
}
