/**
 * 외부 API 키 관리 스토어 (data/apiKeys.json).
 * 키별로 사용 여부·허용 티어(모델)·토큰 한도(무한대 가능)·누적 사용량을 관리한다.
 * roles.js 와 동일하게 파일에 영속하며, 잦은 usage 누적은 디바운스 저장한다.
 */
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { collectionStore } from "./storage/index.js";

export const TIERS = ["small", "medium", "large"];
const NAME_MAX = 40;

// 영속: 레코드 컬렉션 저장소 (파일→DB 이행은 storage 계층에서 처리).
// 로드 시 sanitizeKey 로 디스크 방어. (sanitizeKey 는 함수 선언이라 호이스팅됨)
const repo = collectionStore("apiKeys.json", {
    rootKey: "keys",
    idField: "id",
    sanitize: sanitizeKey,
    pretty: true,
    debounceMs: 1500,
});
let seededOnce = false;

function newId() {
    return "k_" + Date.now().toString(36) + randomBytes(3).toString("hex");
}

/** 새 시크릿 키 값 (외부 배포용) */
export function generateSecret() {
    return "tw-" + randomBytes(18).toString("hex");
}

function normalizeName(value) {
    const t = String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    return t ? t.slice(0, NAME_MAX) : "";
}

/** 허용 티어 정규화 — TIERS 부분집합. 비었으면 전체 허용으로 간주. */
function normalizeTiers(value) {
    if (!Array.isArray(value)) return [...TIERS];
    const set = value
        .map((t) => String(t ?? "").toLowerCase())
        .filter((t) => TIERS.includes(t));
    const uniq = TIERS.filter((t) => set.includes(t)); // 정렬·중복 제거
    return uniq.length ? uniq : [...TIERS];
}

/** 토큰 한도 정규화 — null(무한대) 또는 양의 정수. */
function normalizeTokenLimit(value) {
    if (value == null || value === "" || value === "unlimited") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
}

const KNOWLEDGE_MODES = ["strict", "augment"];

/** 기초지식 바인딩 정규화 — { collectionIds:[], mode:"strict"|"augment", topK:1~8 } */
function normalizeKnowledge(value) {
    const v = value && typeof value === "object" ? value : {};
    const collectionIds = Array.isArray(v.collectionIds)
        ? [
              ...new Set(
                  v.collectionIds
                      .map((s) => String(s ?? "").trim())
                      .filter(Boolean),
              ),
          ]
        : [];
    const mode = KNOWLEDGE_MODES.includes(v.mode) ? v.mode : "strict";
    const rawTopK = Number(v.topK);
    const topK = Number.isFinite(rawTopK)
        ? Math.max(1, Math.min(8, Math.floor(rawTopK)))
        : 4;
    return { collectionIds, mode, topK };
}

// ===== 토큰 한도 자동 초기화 스케줄 =====
const RESET_UNITS = ["hour", "day", "month"];
const EVERY_MAX = { hour: 8760, day: 365, month: 60 };

/** 기준 시각(ms)에서 unit·every 만큼 더한 시각(ms) */
function addInterval(ms, unit, every) {
    const d = new Date(ms);
    if (unit === "hour") d.setHours(d.getHours() + every);
    else if (unit === "day") d.setDate(d.getDate() + every);
    else d.setMonth(d.getMonth() + every); // month
    return d.getTime();
}

/** now 이후로 가장 가까운 다음 초기화 시각(ISO) */
function computeNextReset(fromMs, unit, every, now = Date.now()) {
    let t = addInterval(fromMs, unit, every);
    let guard = 0;
    while (t <= now && guard++ < 100000) t = addInterval(t, unit, every);
    return new Date(t).toISOString();
}

/** 저장값 로드용 — 스케줄 필드(lastResetAt/nextResetAt)를 그대로 보존한다. */
function sanitizeReset(raw) {
    const v = raw && typeof raw === "object" ? raw : {};
    const mode = v.mode === "auto" ? "auto" : "manual";
    const unit = RESET_UNITS.includes(v.unit) ? v.unit : "day";
    let every = Number(v.every);
    every = Number.isFinite(every) && every >= 1 ? Math.floor(every) : 1;
    every = Math.min(every, EVERY_MAX[unit]);
    return {
        mode,
        unit,
        every,
        lastResetAt: v.lastResetAt || null,
        nextResetAt: v.nextResetAt || null,
    };
}

/** 생성·수정 시 — 자동이면 지금부터 다음 초기화 시각을 (재)계산한다. */
function buildReset(input, existing) {
    const base = sanitizeReset({ ...(existing || {}), ...(input || {}) });
    if (base.mode !== "auto") {
        // 수동: 스케줄 해제(lastResetAt 은 유지)
        return { ...base, nextResetAt: null };
    }
    const now = Date.now();
    return {
        ...base,
        lastResetAt: new Date(now).toISOString(),
        nextResetAt: computeNextReset(now, base.unit, base.every, now),
    };
}

/** 예정 시각이 지났으면 사용량을 0으로 초기화하고 다음 시각을 잡는다. */
function applyDueReset(rec, now = Date.now()) {
    const r = rec.reset;
    if (!r || r.mode !== "auto" || !r.nextResetAt) return false;
    if (new Date(r.nextResetAt).getTime() > now) return false;
    rec.tokenUsed = 0;
    r.lastResetAt = new Date(now).toISOString();
    r.nextResetAt = computeNextReset(now, r.unit, r.every, now);
    rec.updatedAt = r.lastResetAt;
    return true;
}

/**
 * 요청 한도·쿼터 정규화.
 * { rpm, rpd, concurrency, maxTokens: null|양의정수, overAction: "reject"|"downgrade" }
 */
function normalizeLimits(value) {
    const v = value && typeof value === "object" ? value : {};
    const posOrNull = (x, max) => {
        const n = Number(x);
        return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : null;
    };
    return {
        rpm: posOrNull(v.rpm, 100000),
        rpd: posOrNull(v.rpd, 10000000),
        concurrency: posOrNull(v.concurrency, 1000),
        maxTokens: posOrNull(v.maxTokens, 131072),
        overAction: v.overAction === "downgrade" ? "downgrade" : "reject",
    };
}

/** 법칙 바인딩 정규화 — { ruleIds:[], allowCustom:boolean } */
function normalizeRules(value) {
    const v = value && typeof value === "object" ? value : {};
    const ruleIds = Array.isArray(v.ruleIds)
        ? [
              ...new Set(
                  v.ruleIds.map((s) => String(s ?? "").trim()).filter(Boolean),
              ),
          ]
        : [];
    return { ruleIds, allowCustom: v.allowCustom === true };
}

function sanitizeKey(raw) {
    if (!raw || typeof raw !== "object") return null;
    const secret =
        typeof raw.key === "string" && raw.key.trim()
            ? raw.key.trim()
            : generateSecret();
    return {
        id:
            typeof raw.id === "string" && raw.id.trim()
                ? raw.id.trim().slice(0, 40)
                : newId(),
        key: secret,
        name: normalizeName(raw.name),
        enabled: raw.enabled !== false,
        allowedTiers: normalizeTiers(raw.allowedTiers),
        tokenLimit: normalizeTokenLimit(raw.tokenLimit),
        tokenUsed: Number.isFinite(Number(raw.tokenUsed))
            ? Math.max(0, Math.floor(Number(raw.tokenUsed)))
            : 0,
        knowledge: normalizeKnowledge(raw.knowledge),
        rules: normalizeRules(raw.rules),
        limits: normalizeLimits(raw.limits),
        reset: sanitizeReset(raw.reset),
        createdAt: raw.createdAt || new Date().toISOString(),
        updatedAt: raw.updatedAt || null,
        lastUsedAt: raw.lastUsedAt || null,
    };
}

/**
 * 키 목록을 로드해 반환한다. 최초 1회 로드 시점에 스토어가 비어 있으면
 * 레거시 단일 키(config.apiKey)를 무한대·전체티어로 시드한다.
 * (원 구현과 동일하게 프로세스당 최초 로드에서만 시드 — 이후 전부 삭제해도 재시드 안 함)
 */
function load() {
    const arr = repo.all();
    if (!seededOnce) {
        seededOnce = true;
        if (!arr.length && config.apiKey) {
            repo.upsert(
                sanitizeKey({
                    key: config.apiKey,
                    name: "기본 키 (레거시)",
                    enabled: true,
                    allowedTiers: [...TIERS],
                    tokenLimit: null,
                }),
            );
        }
    }
    return repo.all();
}

/** 외부 노출용 뷰 — 시크릿은 마스킹된 프리뷰도 함께 제공(원본도 포함: 내부 관리용). */
function publicView(k) {
    const s = k.key || "";
    const masked =
        s.length > 12 ? `${s.slice(0, 7)}…${s.slice(-4)}` : s.slice(0, 4) + "…";
    return {
        id: k.id,
        key: k.key,
        keyMasked: masked,
        name: k.name,
        enabled: k.enabled,
        allowedTiers: k.allowedTiers,
        tokenLimit: k.tokenLimit,
        tokenUsed: k.tokenUsed,
        knowledge: k.knowledge,
        rules: k.rules,
        limits: k.limits,
        reset: k.reset,
        createdAt: k.createdAt,
        updatedAt: k.updatedAt,
        lastUsedAt: k.lastUsedAt,
    };
}

/** 관리 UI용 전체 목록 (조회 시점에 예정된 자동 초기화를 먼저 적용) */
export function listKeys() {
    const keys = load();
    let changed = false;
    for (const rec of keys) if (applyDueReset(rec)) changed = true;
    if (changed) repo.persist();
    return keys.map(publicView);
}

/** 시크릿 값으로 원본 키 레코드 조회 (없으면 null). 조회 시 자동 초기화 반영. */
export function findBySecret(secret) {
    if (typeof secret !== "string" || !secret) return null;
    const rec = load().find((k) => k.key === secret) || null;
    if (rec && applyDueReset(rec)) repo.persist();
    return rec;
}

/** 모든 키의 예정된 자동 초기화를 적용한다(주기 스윕용). 초기화된 키 수 반환. */
export function sweepResets() {
    const keys = load();
    let n = 0;
    for (const rec of keys) if (applyDueReset(rec)) n++;
    if (n) repo.persist();
    return n;
}

export function createKey(input = {}) {
    const keys = load();
    const rec = sanitizeKey({
        key: input.key, // 없으면 sanitizeKey 가 자동발급
        name: input.name,
        enabled: input.enabled,
        allowedTiers: input.allowedTiers,
        tokenLimit: input.tokenLimit,
        knowledge: input.knowledge,
        rules: input.rules,
        limits: input.limits,
        tokenUsed: 0,
    });
    // 자동 초기화면 생성 시점 기준으로 다음 초기화 시각 계산
    rec.reset = buildReset(input.reset, rec.reset);
    if (keys.some((k) => k.key === rec.key)) {
        throw new Error("이미 존재하는 키 값입니다.");
    }
    repo.upsert(rec);
    return publicView(rec);
}

export function updateKey(id, patch = {}) {
    load();
    const rec = repo.get(id);
    if (!rec) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    if (has("name")) rec.name = normalizeName(patch.name);
    if (has("enabled")) rec.enabled = patch.enabled !== false;
    if (has("allowedTiers")) rec.allowedTiers = normalizeTiers(patch.allowedTiers);
    if (has("tokenLimit")) rec.tokenLimit = normalizeTokenLimit(patch.tokenLimit);
    if (has("knowledge")) rec.knowledge = normalizeKnowledge(patch.knowledge);
    if (has("rules")) rec.rules = normalizeRules({ ...rec.rules, ...patch.rules });
    if (has("limits")) rec.limits = normalizeLimits({ ...rec.limits, ...patch.limits });
    if (has("reset")) rec.reset = buildReset(patch.reset, rec.reset);
    rec.updatedAt = new Date().toISOString();
    repo.upsert(rec);
    return publicView(rec);
}

export function deleteKey(id) {
    load();
    return repo.remove(id);
}

/** 완료된 요청의 토큰 사용량을 키에 누적 (id 기준). */
export function addUsage(id, tokens) {
    if (!id) return;
    const n = Number(tokens);
    if (!Number.isFinite(n) || n <= 0) return;
    load();
    const rec = repo.get(id);
    if (!rec) return;
    rec.tokenUsed += Math.floor(n);
    rec.lastUsedAt = new Date().toISOString();
    repo.upsert(rec);
}

/** 지식셋 삭제 시 모든 키 바인딩에서 해당 id 를 제거한다. */
export function unbindCollection(collectionId) {
    if (!collectionId) return 0;
    const keys = load();
    let n = 0;
    for (const rec of keys) {
        const ids = rec.knowledge?.collectionIds;
        if (!Array.isArray(ids) || !ids.includes(collectionId)) continue;
        rec.knowledge = normalizeKnowledge({
            ...rec.knowledge,
            collectionIds: ids.filter((id) => id !== collectionId),
        });
        rec.updatedAt = new Date().toISOString();
        n++;
    }
    if (n) repo.persist();
    return n;
}

/** 법칙 삭제 시 모든 키 바인딩에서 해당 id 를 제거한다. */
export function unbindRule(ruleId) {
    if (!ruleId) return 0;
    const keys = load();
    let n = 0;
    for (const rec of keys) {
        const ids = rec.rules?.ruleIds;
        if (!Array.isArray(ids) || !ids.includes(ruleId)) continue;
        rec.rules = normalizeRules({
            ...rec.rules,
            ruleIds: ids.filter((id) => id !== ruleId),
        });
        rec.updatedAt = new Date().toISOString();
        n++;
    }
    if (n) repo.persist();
    return n;
}

export function resetUsage(id) {
    load();
    const rec = repo.get(id);
    if (!rec) return null;
    rec.tokenUsed = 0;
    const nowIso = new Date().toISOString();
    rec.updatedAt = nowIso;
    // 자동 초기화 키는 수동 초기화 시점부터 다음 주기를 다시 잡는다
    if (rec.reset?.mode === "auto") {
        rec.reset.lastResetAt = nowIso;
        rec.reset.nextResetAt = computeNextReset(
            Date.now(),
            rec.reset.unit,
            rec.reset.every,
        );
    }
    repo.upsert(rec);
    return publicView(rec);
}

/** 토큰 한도 초과 여부 */
export function isOverLimit(rec) {
    return rec.tokenLimit != null && rec.tokenUsed >= rec.tokenLimit;
}

/**
 * 라우팅 티어를 허용 목록으로 클램프한다.
 * 허용에 있으면 그대로, 없으면 가장 가까운 하위 허용 티어로 강등,
 * 하위가 없으면 가장 낮은 허용 티어로.
 */
export function clampTier(tier, allowedTiers) {
    const allowed =
        Array.isArray(allowedTiers) && allowedTiers.length
            ? allowedTiers
            : [...TIERS];
    if (allowed.includes(tier)) return tier;
    const idx = TIERS.indexOf(tier);
    if (idx === -1) return allowed[0];
    for (let i = idx - 1; i >= 0; i--) {
        if (allowed.includes(TIERS[i])) return TIERS[i];
    }
    for (let i = idx + 1; i < TIERS.length; i++) {
        if (allowed.includes(TIERS[i])) return TIERS[i];
    }
    return allowed[0];
}
