/**
 * 한국어 상대 날짜 → YYYY-MM-DD (Asia/Seoul).
 * 스키마 키가 날짜처럼 보이면(startDt, dueDate 등) 상대 날짜를 YYYY-MM-DD 로 채운다.
 * 특정 업무(일정 등)에 묶이지 않는다.
 */

const WD = { 일: 6, 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5 };
const WD_RE = "월|화|수|목|금|토|일";

export function seoulToday(now = new Date()) {
    const ymd = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(now);
    const wd = new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        weekday: "short",
    }).format(now);
    return { ymd, wd: String(wd).replace("요일", ""), parts: parseYmd(ymd) };
}

function parseYmd(s) {
    const [y, m, d] = String(s)
        .split("-")
        .map((n) => Number(n));
    return { y, m, d };
}

function fmtYmd({ y, m, d }) {
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDays(p, n) {
    const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return {
        y: dt.getUTCFullYear(),
        m: dt.getUTCMonth() + 1,
        d: dt.getUTCDate(),
    };
}

/** 월=0 … 일=6 */
function mon0(p) {
    const js = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
    return js === 0 ? 6 : js - 1;
}

function thisMonday(today) {
    return addDays(today, -mon0(today));
}

function weekMonday(today, weekOffset) {
    return addDays(thisMonday(today), weekOffset * 7);
}

function onWeekday(monday, wdMon0) {
    return addDays(monday, wdMon0);
}

export function isDateKey(key) {
    return /^(start|end|from|to|begin|date|dt|day|when)/i.test(String(key)) ||
        /(Dt|Date|Day|_dt|_date)$/.test(String(key));
}

export function isStartKey(key) {
    return /^(start|from|begin)/i.test(String(key));
}

export function isEndKey(key) {
    return /^(end|to|until|finish)/i.test(String(key));
}

/**
 * @returns {{ start: string, end: string } | null} YYYY-MM-DD
 */
export function resolveKoreanDateRange(text, now = new Date()) {
    const q = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!q) return null;
    const today = seoulToday(now).parts;

    const abs = [...q.matchAll(
        /(\d{4})[./-](\d{1,2})[./-](\d{1,2})/g,
    )];
    if (abs.length >= 2) {
        const a = ymdFromNums(abs[0][1], abs[0][2], abs[0][3]);
        const b = ymdFromNums(abs[1][1], abs[1][2], abs[1][3]);
        return order(a, b);
    }
    if (abs.length === 1) {
        const a = ymdFromNums(abs[0][1], abs[0][2], abs[0][3]);
        return { start: a, end: a };
    }

    const md = [...q.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)];
    if (md.length >= 1) {
        const dates = md.map((m) => monthDay(today, Number(m[1]), Number(m[2])));
        if (dates.length >= 2) return order(dates[0], dates[1]);
        return { start: dates[0], end: dates[0] };
    }

    const relOne = oneDayOffset(q);
    if (relOne != null) {
        const d = fmtYmd(addDays(today, relOne));
        return { start: d, end: d };
    }

    const weekOffset = /다다음\s*주/.test(q)
        ? 2
        : /다음\s*주/.test(q)
          ? 1
          : /이번\s*주/.test(q)
            ? 0
            : null;

    const days = [...q.matchAll(new RegExp(`(${WD_RE})(?:요일)?`, "g"))]
        .map((m) => WD[m[1]])
        .filter((n) => n != null);

    if (weekOffset != null) {
        const monday = weekMonday(today, weekOffset);
        if (days.length >= 2) {
            const a = fmtYmd(onWeekday(monday, days[0]));
            const b = fmtYmd(onWeekday(monday, days[1]));
            return order(a, b);
        }
        if (days.length === 1) {
            const d = fmtYmd(onWeekday(monday, days[0]));
            return { start: d, end: d };
        }
        const start = fmtYmd(monday);
        const end = fmtYmd(addDays(monday, 4));
        return { start, end };
    }

    if (days.length >= 1) {
        const target = days[0];
        let d = onWeekday(thisMonday(today), target);
        if (mon0(today) > target) d = addDays(d, 7);
        const start = fmtYmd(d);
        if (days.length >= 2) {
            let e = onWeekday(thisMonday(today), days[1]);
            if (fmtYmd(e) < start) e = addDays(e, 7);
            return { start, end: fmtYmd(e) };
        }
        return { start, end: start };
    }

    return null;
}

function ymdFromNums(y, m, d) {
    return fmtYmd({ y: Number(y), m: Number(m), d: Number(d) });
}

function monthDay(today, month, day) {
    let y = today.y;
    if (month < today.m || (month === today.m && day < today.d)) y += 1;
    return fmtYmd({ y, m: month, d: day });
}

function oneDayOffset(q) {
    if (/(그제|그저께)/.test(q)) return -2;
    if (/어제/.test(q)) return -1;
    if (/오늘/.test(q)) return 0;
    if (/내일/.test(q)) return 1;
    if (/모레/.test(q)) return 2;
    if (/글피/.test(q)) return 3;
    const n = q.match(/(\d+)\s*일\s*(후|뒤)/);
    if (n) return Number(n[1]);
    return null;
}

function order(a, b) {
    return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** 스키마의 날짜 필드가 비었으면 질문에서 환산해 채운다. */
export function fillDateFields(data, question, schema, now = new Date()) {
    const out = data && typeof data === "object" ? { ...data } : {};
    const keys = Object.keys(out).filter(isDateKey);
    if (!keys.length) return out;
    const missing = keys.filter((k) => !String(out[k] ?? "").trim());
    if (!missing.length) return out;
    const range = resolveKoreanDateRange(question, now);
    if (!range) return out;
    for (const k of missing) {
        if (isEndKey(k)) out[k] = range.end;
        else out[k] = range.start;
    }
    return out;
}
