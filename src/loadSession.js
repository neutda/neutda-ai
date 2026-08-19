// 부하 스냅샷 세션 (Load Snapshot Session) — 튜닝 계측.
// 설계: docs/부하-스냅샷-세션.md
//
// Phase 0 (이 파일): 세션 저장소 + 누적 카운터 delta + 설정 스탬프 + 설정 잠금 판정.
//   - start: 베이스라인(누적 카운터) 캡처 + 활성 config 스탬프 → recording.
//   - stop : final 캡처 → delta 계산 → data/loadsessions/<id>.json 저장.
//   - recording 중에는 active() 가 세션을 반환하므로, server.js 의 잠금
//     미들웨어가 설정 변경 API 를 전부 409 로 막는다.
//
// Phase 1(시계열 샘플러)·Phase 2(요청 이벤트 sink)는 후속. 인터페이스만 열어둔다.
//
// 저장소는 인메모리 활성 세션 1개 + JSON 파일 영속. 나중 TSDB 로 교체 가능하게
// start/stop/active/list/get/remove 만 공개한다.

import { pool } from "./pool.js";
import { getStats } from "./stats.js";
import { loadServerDefs } from "./serverManager.js";
import { getMetrics } from "./metrics.js";
import { keyedDocStore } from "./storage/index.js";

// 영속: id 로 키된 다중 문서(세션당 파일). 파일→DB 이행은 storage 계층에서 처리.
const store = keyedDocStore("loadsessions");

/** @type {null | object} 현재 recording 중인 세션 (동시 1개) */
let current = null;

function nowIso() {
    return new Date().toISOString();
}

function genId(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return (
        `ls_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
        `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
}

async function writeSession(sess) {
    // keyedDocStore 가 디렉터리 생성·id 정규화(경로 이탈 차단)·원자적 쓰기를 담당
    await store.put(sess.id, sess);
}

// ---- 캡처 --------------------------------------------------------------

/**
 * 지금 실제로 서빙 중인 설정 스탬프.
 * - servers: 로컬 def (ngl/ctx/parallel/gpu 등 사용자가 튜닝하는 값)
 * - backends: 풀이 보는 실제 백엔드(원격 agent 포함, url/tier/parallel/ctx/roles)
 */
async function captureConfig() {
    let servers = [];
    try {
        const defs = await loadServerDefs();
        servers = (Array.isArray(defs) ? defs : []).map((d) => ({
            name: d.name ?? null,
            tier: d.tier ?? null,
            device: d.device ?? null,
            ngl: Number(d.ngl) || 0,
            ctx: Number(d.ctx) || 0,
            parallel: Number(d.parallel) || 0,
            gpu: d.gpu ?? null,
            model: d.model ?? d.modelPath ?? null,
            roleIds: Array.isArray(d.roleIds) ? [...d.roleIds] : [],
        }));
    } catch {
        servers = []; // 로컬 def 없음(순수 컨트롤플레인) — backends 로 충분
    }
    const st = pool.status();
    const backends = (st.backends || []).map((b) => ({
        url: b.url,
        alias: b.alias,
        tier: b.tier,
        device: b.device,
        parallel: b.parallel,
        ctx: b.ctx,
        model: b.model,
        vision: b.vision ?? null,
        roles: b.roles,
        healthy: b.healthy,
    }));
    return { servers, backends };
}

/** delta 원천이 되는 누적 카운터 + 티어 토큰 스냅 */
function captureCounters() {
    return {
        ts: Date.now(),
        pool: pool.loadCounters(), // backends[]·queue·loadAware
        stats: getStats(), // byTier {requests, tokens, totalMs}
    };
}

// ---- delta 집계 --------------------------------------------------------

const TIERS = ["small", "medium", "large"];

function diffTier(a = {}, b = {}) {
    return {
        requests: (b.requests || 0) - (a.requests || 0),
        tokens: (b.tokens || 0) - (a.tokens || 0),
        totalMs: (b.totalMs || 0) - (a.totalMs || 0),
    };
}

/**
 * 백엔드별 증분(요청/에러/지연). url 기준 매칭.
 * 세션 중 config 잠금이라 집합은 안정적이지만, agent 하트비트 재등록 등으로
 * 어긋날 수 있어 baseline/final 어느 한쪽에만 있는 백엔드는 partial 로 표시한다.
 */
function diffBackends(baseline, final) {
    const baseB = new Map(baseline.pool.backends.map((b) => [b.url, b]));
    const finB = new Map(final.pool.backends.map((b) => [b.url, b]));
    const byBackend = [];
    for (const [url, f] of finB) {
        const b0 = baseB.get(url);
        if (!b0) {
            byBackend.push({
                url,
                alias: f.alias,
                tier: f.tier,
                note: "세션 중 추가됨(baseline 없음)",
                partial: true,
            });
            continue;
        }
        const requests = f.totalRequests - b0.totalRequests;
        const errors = f.totalErrors - b0.totalErrors;
        const latencySumMs = f.totalLatencyMs - b0.totalLatencyMs;
        // 구간 완료 건수 ≈ 요청수(진행중은 근사)
        const done = Math.max(0, requests);
        byBackend.push({
            url,
            alias: f.alias,
            tier: f.tier,
            device: f.device,
            model: f.model ?? null,
            requests,
            chatRequests: f.chatRequests - b0.chatRequests,
            routerRequests: f.routerRequests - b0.routerRequests,
            plannerRequests: f.plannerRequests - b0.plannerRequests,
            securityRequests: f.securityRequests - b0.securityRequests,
            errors,
            errorRatePct: requests > 0 ? Math.round((errors / requests) * 100) : 0,
            latencySumMs,
            avgMs: done > 0 ? Math.round(latencySumMs / done) : null,
        });
    }
    // baseline 에만 있던(세션 중 제거된) 백엔드 표시
    for (const [url, b0] of baseB) {
        if (!finB.has(url)) {
            byBackend.push({
                url,
                alias: b0.alias,
                tier: b0.tier,
                note: "세션 중 제거됨(final 없음)",
                partial: true,
            });
        }
    }
    return byBackend;
}

/** 모델별 집계 (같은 모델을 여러 백엔드가 서빙하면 합산). partial 백엔드는 제외. */
function aggregateByModel(byBackend) {
    const modelMap = new Map();
    for (const b of byBackend) {
        if (b.partial) continue;
        const key = b.model || b.alias || b.url;
        const m = modelMap.get(key) || {
            model: key,
            tier: b.tier,
            backends: 0,
            requests: 0,
            chatRequests: 0,
            routerRequests: 0,
            plannerRequests: 0,
            securityRequests: 0,
            errors: 0,
            latencySumMs: 0,
        };
        m.backends++;
        m.requests += b.requests || 0;
        m.chatRequests += b.chatRequests || 0;
        m.routerRequests += b.routerRequests || 0;
        m.plannerRequests += b.plannerRequests || 0;
        m.securityRequests += b.securityRequests || 0;
        m.errors += b.errors || 0;
        m.latencySumMs += b.latencySumMs || 0;
        modelMap.set(key, m);
    }
    return [...modelMap.values()]
        .map((m) => ({
            ...m,
            errorRatePct:
                m.requests > 0 ? Math.round((m.errors / m.requests) * 100) : 0,
            avgMs: m.requests > 0 ? Math.round(m.latencySumMs / m.requests) : null,
        }))
        .sort((a, b) => b.requests - a.requests);
}

/** 티어별 요청/토큰 증분. */
function diffTiers(baseline, final) {
    const byTier = {};
    for (const t of TIERS) {
        byTier[t] = diffTier(baseline.stats.tiers?.[t], final.stats.tiers?.[t]);
    }
    return byTier;
}

/** 채팅 큐 증분 (거절/타임아웃 비율 = 용량 부족 신호). */
function diffQueue(baseline, final) {
    const q0 = baseline.pool.queue || {};
    const q1 = final.pool.queue || {};
    const qEnq = (q1.enqueued || 0) - (q0.enqueued || 0);
    const qRej = (q1.rejected || 0) - (q0.rejected || 0);
    const qTo = (q1.timedOut || 0) - (q0.timedOut || 0);
    return {
        enqueued: qEnq,
        started: (q1.started || 0) - (q0.started || 0),
        rejected: qRej,
        timedOut: qTo,
        // enqueue 대비 거절/타임아웃 비율 (용량 부족 신호)
        rejectRatePct: qEnq > 0 ? Math.round((qRej / qEnq) * 100) : 0,
        timeoutRatePct: qEnq > 0 ? Math.round((qTo / qEnq) * 100) : 0,
        // peakDepth 는 게이지(누적 아님) → 구간 피크는 Phase 1 샘플러 필요.
        peakDepthFinal: q1.peakDepth || 0,
        peakDepthNote:
            "구간 피크는 시계열 샘플러(Phase 1) 필요 — 여기선 프로세스 전체 피크",
    };
}

/** 슬롯 인지 라우팅(강등/승격) 판정 증분과 실행 비율. */
function diffLoadAware(baseline, final) {
    const l0 = baseline.pool.loadAware || {};
    const l1 = final.pool.loadAware || {};
    const demote = (l1.demoteLargeToMedium || 0) - (l0.demoteLargeToMedium || 0);
    const skHard = (l1.skippedHardLock || 0) - (l0.skippedHardLock || 0);
    const skFree = (l1.skippedFreeOk || 0) - (l0.skippedFreeOk || 0);
    const skDiff = (l1.skippedHighDiff || 0) - (l0.skippedHighDiff || 0);
    // large preferred 로 판정된 총 건수 ≈ 강등 + 유지(여유/고난이도/하드락)
    const largeDecisions = demote + skFree + skDiff + skHard;
    // 승격(medium→large): 유휴 large 활용
    const promote =
        (l1.promoteMediumToLarge || 0) - (l0.promoteMediumToLarge || 0);
    const skPromoLow =
        (l1.skippedPromoteLowDiff || 0) - (l0.skippedPromoteLowDiff || 0);
    const skPromoBusy =
        (l1.skippedPromoteBusy || 0) - (l0.skippedPromoteBusy || 0);
    // medium 포화로 승격 판정이 걸린 총 건수 ≈ 승격 + 보류(난이도)+ 불가(둘 다 포화)
    const mediumSaturatedDecisions = promote + skPromoLow + skPromoBusy;
    return {
        demoteLargeToMedium: demote,
        skippedHardLock: skHard, // 이미지/THINKING 등으로 강등 안 함
        skippedFreeOk: skFree, // large 여유 있어 유지
        skippedHighDiff: skDiff, // 고난이도라 품질 위해 large 유지
        largeDecisions,
        // large 판정 중 실제 강등된 비율 (large 용량 압박 지표)
        demoteRatePct:
            largeDecisions > 0 ? Math.round((demote / largeDecisions) * 100) : 0,
        // ── 승격(medium→large) ──
        promoteMediumToLarge: promote,
        skippedPromoteLowDiff: skPromoLow, // large 여유 있으나 난이도 낮아 보류
        skippedPromoteBusy: skPromoBusy, // medium·large 둘 다 포화
        mediumSaturatedDecisions,
        // medium 포화 판정 중 실제 승격된 비율 (유휴 large 회수율)
        promoteRatePct:
            mediumSaturatedDecisions > 0
                ? Math.round((promote / mediumSaturatedDecisions) * 100)
                : 0,
    };
}

/** 티어 증분 + 백엔드 에러로 전역 합계. */
function sumTotals(byTier, byBackend) {
    let reqSum = 0;
    let tokSum = 0;
    for (const t of TIERS) {
        reqSum += byTier[t].requests;
        tokSum += byTier[t].tokens;
    }
    const errSum = byBackend.reduce((s, b) => s + (b.errors || 0), 0);
    return {
        requests: reqSum,
        tokens: tokSum,
        errors: errSum,
        errorRatePct: reqSum > 0 ? Math.round((errSum / reqSum) * 100) : 0,
    };
}

/** baseline↔final 스냅샷 차이를 부하 리포트로 종합한다. */
function computeDelta(baseline, final) {
    const byBackend = diffBackends(baseline, final);
    const byModel = aggregateByModel(byBackend);
    const byTier = diffTiers(baseline, final);
    const queue = diffQueue(baseline, final);
    const loadAware = diffLoadAware(baseline, final);
    const totals = sumTotals(byTier, byBackend);
    return { totals, byTier, byBackend, byModel, queue, loadAware };
}

// ---- 에러 이벤트 수집 (증분 집계) -------------------------------------
//
// 일주일 세션에서 에러가 수만~수십만 건이 될 수 있다. 개별 이벤트를 전부
// 배열에 쌓으면 (1) 메모리 폭증, (2) 상한에서 잘리면 카운트가 틀린다.
// 그래서 들어오는 즉시 카운터만 갱신하고(총계·유형·모델·종류 = 정확·무한대
// 가능), 상세 조회용으로 최근 N건만 링버퍼에 둔다. 메모리는
// "distinct 유형 수(상한) + 샘플 N" 으로 바운드된다.

const ERR_SAMPLE_MAX = 200; // 상세 조회용 최근 샘플 링
const ERR_TYPE_MAX = 300; // distinct 유형 상한(초과분은 '기타' 버킷)
const ERR_OTHER = "기타(그 외 유형)";

/** 현재 세션의 에러 증분 집계 (파일에 직접 직렬화하지 않음 — Map 보유) */
let errAgg = null;

function newErrAgg() {
    return {
        total: 0,
        firstTs: null,
        lastTs: null,
        byType: new Map(),
        byModel: new Map(),
        byKind: new Map(),
        samples: [], // 최근 ERR_SAMPLE_MAX 건 (오래된 것부터 evict)
    };
}

/** 에러 메시지를 유형(시그니처)으로 정규화 — 숫자/URL 을 지워 같은 유형끼리 묶음 */
function errSignature(msg) {
    const s = String(msg || "")
        .replace(/https?:\/\/\S+/g, "<url>")
        .replace(/\b\d[\d.,:_-]*\b/g, "#")
        .replace(/\s+/g, " ")
        .trim();
    return s.slice(0, 140) || "(빈 메시지)";
}

/**
 * dispatch 에러 1건 수집. 활성 세션 없으면 no-op.
 * pool.setErrorSink(recordError) 로 배선된다.
 * O(1) 증분 — 총 에러 수와 무관하게 메모리·시간 바운드.
 */
export function recordError(e) {
    if (!current || !errAgg) return;
    const a = errAgg;
    const ts = e?.ts || Date.now();
    const status = e?.status ?? null;
    a.total++;
    a.lastTs = ts;
    if (a.firstTs == null) a.firstTs = ts;

    // 유형별 (distinct 상한 초과 시 '기타' 버킷으로 — 카운트는 계속 정확)
    const sig = errSignature(e?.message);
    let tt = a.byType.get(sig);
    if (!tt) {
        if (a.byType.size >= ERR_TYPE_MAX) {
            tt = a.byType.get(ERR_OTHER);
            if (!tt) {
                tt = { type: ERR_OTHER, count: 0, status: null, lastTs: ts };
                a.byType.set(ERR_OTHER, tt);
            }
        } else {
            tt = { type: sig, count: 0, status, lastTs: ts };
            a.byType.set(sig, tt);
        }
    }
    tt.count++;
    tt.lastTs = ts;
    if (tt.status == null && status != null) tt.status = status;

    // 모델별 (백엔드 수만큼 바운드)
    const mk = e?.model || e?.alias || e?.url || "(unknown)";
    let mm = a.byModel.get(mk);
    if (!mm) {
        mm = { model: mk, tier: e?.tier ?? null, count: 0 };
        a.byModel.set(mk, mm);
    }
    mm.count++;

    // 종류별 (solve/router/planner/embed/security)
    const kk = e?.kind || "(unknown)";
    a.byKind.set(kk, (a.byKind.get(kk) || 0) + 1);

    // 최근 샘플 링 (상세 조회용) — 초과분은 오래된 것부터 버림(카운트엔 영향 없음)
    a.samples.push({
        ts: new Date(ts).toISOString(),
        kind: e?.kind ?? null,
        tier: e?.tier ?? null,
        model: mk,
        status,
        retryable: Boolean(e?.retryable),
        message: String(e?.message || "").slice(0, 500),
    });
    if (a.samples.length > ERR_SAMPLE_MAX) a.samples.shift();
}

/** 증분 집계 → 최종 리포트 형태. 총계는 정확, 샘플은 최근분만. */
function finalizeErrors(a, durationMs) {
    if (!a || a.total === 0) {
        return { total: 0, byType: [], byModel: [], byKind: [], samples: [] };
    }
    const spanMs = a.firstTs && a.lastTs ? a.lastTs - a.firstTs : 0;
    const basisMs = spanMs || durationMs || 0;
    return {
        total: a.total,
        firstAt: a.firstTs ? new Date(a.firstTs).toISOString() : null,
        lastAt: a.lastTs ? new Date(a.lastTs).toISOString() : null,
        perHour:
            basisMs > 0 ? Math.round(a.total / (basisMs / 3600000)) : a.total,
        sampleShown: a.samples.length,
        sampleDropped: Math.max(0, a.total - a.samples.length),
        byType: [...a.byType.values()].sort((x, y) => y.count - x.count),
        byModel: [...a.byModel.values()].sort((x, y) => y.count - x.count),
        byKind: [...a.byKind.entries()]
            .map(([kind, count]) => ({ kind, count }))
            .sort((x, y) => y.count - x.count),
        samples: a.samples.slice().reverse(), // 최신순
    };
}

// ---- 시간축 샘플러 (Phase 1) ------------------------------------------
//
// recording 동안 순간값(GPU/CPU/RAM/큐/티어 압박)을 주기적으로 찍어 "언제
// 부하가 몰렸나"를 시간축으로 남긴다. 일주일을 5초로 찍으면 12만 점이라
// 무한 증가하므로 점 개수에 상한을 두고, 꽉 차면 인접 두 점을 avg/max 로
// 접으면서(피크 보존) 간격을 2배로 늘린다 → 기간과 무관하게 항상 상한 이하.

let SAMPLE_BASE_MS = 5000; // 시작 간격
let SAMPLE_MAX_MS = 300000; // 간격 상한(5분) — 이 이상은 안 늘림
let POINTS_MAX = 2000; // 저장 점 개수 상한

/** 샘플러 상태 (파일에 직렬화하지 않음) */
let series = null; // { points:[], intervalMs }
let sampleTimer = null;
let sampling = false;

/** 테스트/운영 튜닝용 — 샘플 간격·상한 조정 */
export function configureSampler({ baseMs, maxMs, maxPoints } = {}) {
    if (Number(baseMs) > 0) SAMPLE_BASE_MS = Number(baseMs);
    if (Number(maxMs) > 0) SAMPLE_MAX_MS = Number(maxMs);
    if (Number(maxPoints) > 0) POINTS_MAX = Math.floor(Number(maxPoints));
}

// 한 지표 = {avg, max}. 원본 샘플은 avg=max=순간값, n=1.
const st = (v) => {
    const n = Number(v);
    const x = Number.isFinite(n) ? n : 0;
    return { avg: x, max: x };
};
const mergeSt = (a, b, na, nb) => ({
    avg: (a.avg * na + b.avg * nb) / (na + nb),
    max: Math.max(a.max, b.max),
});

function mergePoint(a, b) {
    const na = a.n;
    const nb = b.n;
    const gpu = (a.gpu || []).map((g, i) => {
        const h = b.gpu?.[i];
        if (!h) return g;
        return {
            u: mergeSt(g.u, h.u, na, nb),
            mp: mergeSt(g.mp, h.mp, na, nb),
            temp: mergeSt(g.temp, h.temp, na, nb),
            pw: mergeSt(g.pw, h.pw, na, nb),
        };
    });
    const tier = {};
    for (const t of TIERS) {
        tier[t] = mergeSt(a.tier[t], b.tier[t], na, nb);
    }
    return {
        t: a.t, // 버킷 시작 시각
        n: na + nb,
        cpu: mergeSt(a.cpu, b.cpu, na, nb),
        ram: mergeSt(a.ram, b.ram, na, nb),
        q: mergeSt(a.q, b.q, na, nb),
        inf: mergeSt(a.inf, b.inf, na, nb),
        tier,
        gpu,
    };
}

/** 점이 상한에 차면 인접 2점씩 병합(길이 절반) + 간격 2배 */
function compactSeries() {
    const pts = series.points;
    const merged = [];
    for (let i = 0; i < pts.length; i += 2) {
        const a = pts[i];
        const b = pts[i + 1];
        merged.push(b ? mergePoint(a, b) : a);
    }
    series.points = merged;
    series.intervalMs = Math.min(series.intervalMs * 2, SAMPLE_MAX_MS);
}

async function takeSample() {
    const slot = pool.slotSnapshot();
    const q = pool.queueSnapshot();
    const m = await getMetrics(); // GPU/CPU/RAM (nvidia-smi)
    const byTier = slot.byTier || {};
    const inf = (slot.backends || []).reduce((s, b) => s + (b.inFlight || 0), 0);
    const tier = {};
    for (const t of TIERS) tier[t] = st(byTier[t]?.pressure || 0);
    return {
        t: Date.now(),
        n: 1,
        cpu: st(m.cpu?.usagePct || 0),
        ram: st(m.mem?.usagePct || 0),
        q: st(q.depth || 0),
        inf: st(inf),
        tier,
        gpu: (m.gpus || []).map((g) => ({
            u: st(g.utilPct || 0),
            mp: st(g.memUsagePct || 0),
            temp: st(g.tempC || 0),
            pw: st(g.powerW || 0),
        })),
    };
}

function scheduleSample() {
    sampleTimer = setTimeout(runSample, series.intervalMs);
    if (sampleTimer?.unref) sampleTimer.unref();
}

async function runSample() {
    if (!current || !series) return;
    if (sampling) {
        scheduleSample(); // 이전 샘플(느린 nvidia-smi)이 아직이면 이번은 건너뜀
        return;
    }
    sampling = true;
    try {
        const p = await takeSample();
        if (series) {
            series.points.push(p);
            if (series.points.length >= POINTS_MAX) compactSeries();
        }
    } catch {
        // 샘플 실패는 조용히 — 다음 주기 재시도
    } finally {
        sampling = false;
    }
    if (current && series) scheduleSample();
}

function startSampler() {
    stopSampler();
    series = { points: [], intervalMs: SAMPLE_BASE_MS };
    scheduleSample();
}

function stopSampler() {
    if (sampleTimer) {
        clearTimeout(sampleTimer);
        sampleTimer = null;
    }
}

/** 점 배열 → 차트용 압축 배열 + 판단용 요약(피크·평균·포화시간비율) */
function finalizeSeries(s) {
    if (!s || !s.points.length) {
        return { intervalMs: s?.intervalMs ?? SAMPLE_BASE_MS, points: [], summary: null };
    }
    const pts = s.points;
    let totalN = 0;
    for (const p of pts) totalN += p.n;

    // GPU 요약 (인덱스별)
    const gpuCount = pts[0].gpu?.length || 0;
    const gpu = [];
    for (let i = 0; i < gpuCount; i++) {
        let utilSum = 0;
        let utilPeak = 0;
        let utilPeakAt = null;
        let memPeak = 0;
        let tempPeak = 0;
        let powerPeak = 0;
        for (const p of pts) {
            const g = p.gpu[i];
            if (!g) continue;
            utilSum += g.u.avg * p.n;
            if (g.u.max > utilPeak) {
                utilPeak = g.u.max;
                utilPeakAt = p.t;
            }
            if (g.mp.max > memPeak) memPeak = g.mp.max;
            if (g.temp.max > tempPeak) tempPeak = g.temp.max;
            if (g.pw.max > powerPeak) powerPeak = g.pw.max;
        }
        gpu.push({
            index: i,
            utilAvg: Math.round(utilSum / totalN),
            utilPeak: Math.round(utilPeak),
            utilPeakAt: utilPeakAt ? new Date(utilPeakAt).toISOString() : null,
            memPeakPct: Math.round(memPeak),
            tempPeak: Math.round(tempPeak),
            powerPeakW: Math.round(powerPeak),
        });
    }

    // 티어 압박 요약 — satRatio = 압박≥0.9 였던 시간 비율
    const tierPressure = {};
    for (const t of TIERS) {
        let sum = 0;
        let peak = 0;
        let satN = 0;
        for (const p of pts) {
            sum += p.tier[t].avg * p.n;
            if (p.tier[t].max > peak) peak = p.tier[t].max;
            if (p.tier[t].avg >= 0.9) satN += p.n;
        }
        tierPressure[t] = {
            avg: Number((sum / totalN).toFixed(2)),
            peak: Number(peak.toFixed(2)),
            satRatioPct: Math.round((satN / totalN) * 100),
        };
    }

    // 큐 요약
    let qSum = 0;
    let qPeak = 0;
    for (const p of pts) {
        qSum += p.q.avg * p.n;
        if (p.q.max > qPeak) qPeak = p.q.max;
    }

    // 차트용 압축 점 (avg/max 만, 파일 경량화)
    const chart = pts.map((p) => ({
        t: p.t,
        cpu: Math.round(p.cpu.avg),
        ram: Math.round(p.ram.avg),
        q: Math.round(p.q.max),
        large: Number(p.tier.large.avg.toFixed(2)),
        medium: Number(p.tier.medium.avg.toFixed(2)),
        gpu0Util: p.gpu[0] ? Math.round(p.gpu[0].u.avg) : null,
        gpu0Mem: p.gpu[0] ? Math.round(p.gpu[0].mp.avg) : null,
        gpu0UtilMax: p.gpu[0] ? Math.round(p.gpu[0].u.max) : null,
    }));

    return {
        intervalMs: s.intervalMs,
        pointCount: pts.length,
        points: chart,
        summary: {
            gpu,
            tierPressure,
            queue: {
                depthAvg: Number((qSum / totalN).toFixed(1)),
                depthPeak: Math.round(qPeak),
            },
        },
    };
}

// ---- 주기 플러시 (크래시 복구) ----------------------------------------
//
// 일주일 세션은 stop 을 누르기 전에 프로세스가 죽을 수 있다. 주기적으로
// "지금까지의 delta + 에러 요약"을 recording 상태로 파일에 써 둔다.
// 총계는 baseline↔현재 카운터 차분이라 언제 찍어도 정확하다.

const FLUSH_MS = 60000; // 1분마다
let flushTimer = null;

async function flushCurrent() {
    if (!current) return;
    try {
        const nowCounters = captureCounters();
        const durationMs =
            Date.now() - new Date(current.startedAt).getTime();
        const partial = {
            ...current,
            state: "recording",
            flushedAt: nowIso(),
            durationMs,
            final: nowCounters,
            delta: computeDelta(current.baseline, nowCounters),
            errors: finalizeErrors(errAgg, durationMs),
            series: finalizeSeries(series),
        };
        await writeSession(partial);
    } catch {
        // best-effort — 플러시 실패는 다음 주기에 재시도
    }
}

function startFlush() {
    stopFlush();
    flushTimer = setInterval(() => {
        flushCurrent();
    }, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
}

function stopFlush() {
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
}

// ---- 공개 API ----------------------------------------------------------

/** 현재 recording 중인 세션(요약). 없으면 null. 잠금 미들웨어가 이걸 본다. */
export function active() {
    if (!current) return null;
    return {
        id: current.id,
        label: current.label,
        note: current.note,
        state: current.state,
        startedAt: current.startedAt,
        elapsedMs: Date.now() - new Date(current.startedAt).getTime(),
    };
}

/**
 * 세션 시작. 이미 recording 중이면 { force:true } 아니면 에러.
 * @returns {{id, state, startedAt}}
 */
export async function start({ label = "", note = "", force = false } = {}) {
    if (current) {
        if (!force) {
            const err = new Error(
                "이미 진행 중인 부하 스냅샷 세션이 있습니다. 먼저 종료하세요.",
            );
            err.code = "session-active";
            err.activeId = current.id;
            throw err;
        }
        await stop().catch(() => {}); // 강제: 기존 세션 마감 후 새로 시작
    }
    const startedAt = nowIso();
    const sess = {
        id: genId(),
        label: String(label || "").slice(0, 200),
        note: String(note || "").slice(0, 2000),
        state: "recording",
        startedAt,
        endedAt: null,
        durationMs: null,
        configLocked: true,
        configAtStart: await captureConfig(),
        baseline: captureCounters(),
        final: null,
        delta: null,
        errors: null,
        series: null,
    };
    current = sess;
    errAgg = newErrAgg();
    // 시작 시점에 파일로도 남겨 list/복구 가능하게(부분 저장)
    await writeSession(sess).catch(() => {});
    startSampler(); // 시간축 샘플링 시작
    // 주기 플러시: 일주일 세션이 크래시해도 마지막 플러시분은 복구 가능.
    startFlush();
    return { id: sess.id, state: sess.state, startedAt: sess.startedAt };
}

/**
 * 세션 종료 + delta 계산 + 저장. 활성 세션 없으면 에러.
 * @returns {object} 저장된 세션 리포트 전체
 */
export async function stop() {
    if (!current) {
        const err = new Error("진행 중인 부하 스냅샷 세션이 없습니다.");
        err.code = "no-active-session";
        throw err;
    }
    stopFlush();
    stopSampler();
    const sess = current;
    sess.final = captureCounters();
    sess.endedAt = nowIso();
    sess.durationMs =
        new Date(sess.endedAt).getTime() - new Date(sess.startedAt).getTime();
    sess.delta = computeDelta(sess.baseline, sess.final);
    sess.errors = finalizeErrors(errAgg, sess.durationMs);
    sess.series = finalizeSeries(series);
    delete sess.flushedAt;
    sess.state = "stopped";
    current = null;
    errAgg = null;
    series = null;
    await writeSession(sess);
    return sess;
}

/** 저장된 세션 목록(요약, 최신순). */
export async function list() {
    const sessions = await store.list();
    const out = sessions.map((s) => ({
        id: s.id,
        label: s.label,
        state: s.state,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.durationMs,
        totals: s.delta?.totals ?? null,
    }));
    out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return out;
}

/** 세션 리포트 전체. 없으면 null. */
export async function get(id) {
    // recording 중인 세션은 아직 파일에 delta 가 없으니 인메모리 우선
    if (current && current.id === id) return current;
    return store.get(id);
}

/** 세션 삭제. 활성 세션은 삭제 불가. */
export async function remove(id) {
    if (current && current.id === id) {
        const err = new Error(
            "진행 중인 세션은 삭제할 수 없습니다. 먼저 종료하세요.",
        );
        err.code = "session-active";
        throw err;
    }
    const ok = await store.remove(id);
    return ok ? { ok: true, removed: id } : { ok: false, removed: null };
}
