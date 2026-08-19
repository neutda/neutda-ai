// 티어 라우팅 효과 집계.
// 채팅 요청을 티어별로 누적하고, "전부 large 로 처리했다면" 대비 절감된
// 연산량(모델 파라미터 수 비례 근사)을 계산한다. data/stats.json 에 영속.
import { docStore } from "./storage/index.js";

// 영속: 단일 문서 저장소 (파일→DB 이행은 storage 계층에서 처리)
const backing = docStore("stats.json", { debounceMs: 3000 });

// 티어별 상대 연산 비용 (large 27B = 1 기준, 파라미터 수 비례 근사)
// small 0.5B, medium 3B, large 27B
export const TIER_WEIGHTS = { small: 0.5 / 27, medium: 3 / 27, large: 1 };

const emptyTiers = () => ({
    small: { requests: 0, tokens: 0, totalMs: 0 },
    medium: { requests: 0, tokens: 0, totalMs: 0 },
    large: { requests: 0, tokens: 0, totalMs: 0 },
});

let byTier = emptyTiers();
let since = new Date().toISOString();
let loaded = false;

export async function loadStats() {
    if (loaded) return;
    loaded = true;
    const raw = await backing.read();
    if (raw?.byTier) {
        const base = emptyTiers();
        for (const t of Object.keys(base)) {
            if (raw.byTier[t]) Object.assign(base[t], raw.byTier[t]);
        }
        byTier = base;
    }
    if (typeof raw?.since === "string") since = raw.since;
}

function scheduleSave() {
    backing.save({ since, byTier });
}

/** 채팅 1건 완료 기록 (라우터 분류 호출은 집계하지 않음) */
export function recordChat({ tier, usage, ms }) {
    const t = byTier[tier];
    if (!t) return;
    t.requests++;
    const tok = Number(usage?.total_tokens);
    if (Number.isFinite(tok) && tok > 0) t.tokens += tok;
    if (Number.isFinite(ms) && ms > 0) t.totalMs += ms;
    scheduleSave();
}

export function getStats() {
    const tiers = {};
    let totalReq = 0;
    let totalTok = 0;
    let costTok = 0;
    let costReq = 0;
    for (const [tier, t] of Object.entries(byTier)) {
        tiers[tier] = { ...t, weight: Number(TIER_WEIGHTS[tier].toFixed(4)) };
        totalReq += t.requests;
        totalTok += t.tokens;
        costTok += t.tokens * TIER_WEIGHTS[tier];
        costReq += t.requests * TIER_WEIGHTS[tier];
    }
    return {
        since,
        tiers,
        totals: { requests: totalReq, tokens: totalTok },
        savings: {
            basis: "large 단독 처리 대비 연산량(모델 파라미터 수 비례 근사)",
            // 토큰 가중 절감률(토큰 usage 가 집계된 요청 기준)
            savedPctTokens:
                totalTok > 0
                    ? Math.round((1 - costTok / totalTok) * 100)
                    : null,
            // 요청 수 기준 절감률(토큰 정보가 없어도 계산 가능)
            savedPctRequests:
                totalReq > 0
                    ? Math.round((1 - costReq / totalReq) * 100)
                    : null,
            largeEquivalentTokens: Math.round(costTok),
        },
    };
}
