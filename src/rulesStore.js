/**
 * API 법칙 스토어 (data/rules.json).
 * 키워드로 발동하고, 응답을 JSON 스키마로 강제한다.
 */
import { randomBytes } from "node:crypto";
import { schemaKeys } from "./jsonRule.js";
import { collectionStore } from "./storage/index.js";

const NAME_MAX = 60;
const INST_MAX = 400;
const INTENT_MAX = 400;

// 영속: 레코드 컬렉션 저장소 (파일→DB 이행은 storage 계층에서 처리).
// 로드 시 sanitize 로 디스크 방어. (sanitize 는 함수 선언이라 호이스팅됨)
const repo = collectionStore("rules.json", {
    rootKey: "rules",
    idField: "id",
    sanitize,
    pretty: true,
    debounceMs: 1000,
});

function newId() {
    return "rl_" + Date.now().toString(36) + randomBytes(3).toString("hex");
}

function normalizeName(value) {
    const t = String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    return t ? t.slice(0, NAME_MAX) : "";
}

function normalizeKeywords(value) {
    const arr = Array.isArray(value)
        ? value
        : typeof value === "string"
          ? value.split(/[\n,]/)
          : [];
    const out = [];
    const seen = new Set();
    for (const raw of arr) {
        const k = String(raw ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 40);
        if (k.length < 2) continue;
        const key = k.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(k);
        if (out.length >= 20) break;
    }
    return out;
}

function normalizeSchema(value) {
    let obj = value;
    if (typeof value === "string") {
        try {
            obj = JSON.parse(value);
        } catch {
            obj = null;
        }
    }
    const keys = schemaKeys(obj);
    if (!keys.length) return {};
    const out = {};
    for (const k of keys) {
        const v = obj[k];
        out[k] = typeof v === "string" ? v.slice(0, 80) : "";
    }
    return out;
}

function sanitize(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = normalizeName(raw.name);
    if (!name) return null;
    return {
        id:
            typeof raw.id === "string" && raw.id.trim()
                ? raw.id.trim().slice(0, 40)
                : newId(),
        name,
        enabled: raw.enabled !== false,
        keywords: normalizeKeywords(raw.keywords),
        schema: normalizeSchema(raw.schema),
        intent: String(raw.intent ?? "")
            .trim()
            .slice(0, INTENT_MAX),
        instruction: String(raw.instruction ?? "")
            .trim()
            .slice(0, INST_MAX),
        skipRag: raw.skipRag !== false,
        createdAt: raw.createdAt || new Date().toISOString(),
        updatedAt: raw.updatedAt || null,
    };
}

export function listRules() {
    return repo
        .all()
        .map((r) => ({ ...r }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getRule(id) {
    return repo.get(id);
}

export function filterExistingRules(ids) {
    if (!Array.isArray(ids)) return [];
    const set = new Set(repo.all().map((r) => r.id));
    return ids.filter((id) => set.has(id));
}

export function rulesByIds(ids) {
    return filterExistingRules(ids)
        .map((id) => getRule(id))
        .filter(Boolean);
}

export function createRule(input = {}) {
    const rec = sanitize({
        name: input.name,
        enabled: input.enabled,
        keywords: input.keywords,
        schema: input.schema,
        intent: input.intent,
        instruction: input.instruction,
        skipRag: input.skipRag,
    });
    if (!rec) throw new Error("JSON 결과 이름은 필수입니다.");
    if (!Object.keys(rec.schema).length) {
        throw new Error("스키마에 필드가 최소 1개 필요합니다.");
    }
    repo.upsert(rec);
    return { ...rec };
}

export function updateRule(id, patch = {}) {
    const rec = repo.get(id);
    if (!rec) return null;
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    if (has("name")) {
        const name = normalizeName(patch.name);
        if (!name) throw new Error("JSON 결과 이름은 비울 수 없습니다.");
        rec.name = name;
    }
    if (has("enabled")) rec.enabled = patch.enabled !== false;
    if (has("keywords")) rec.keywords = normalizeKeywords(patch.keywords);
    if (has("schema")) {
        rec.schema = normalizeSchema(patch.schema);
        if (!Object.keys(rec.schema).length) {
            throw new Error("스키마에 필드가 최소 1개 필요합니다.");
        }
    }
    if (has("intent"))
        rec.intent = String(patch.intent ?? "")
            .trim()
            .slice(0, INTENT_MAX);
    if (has("instruction"))
        rec.instruction = String(patch.instruction ?? "")
            .trim()
            .slice(0, INST_MAX);
    if (has("skipRag")) rec.skipRag = patch.skipRag !== false;
    rec.updatedAt = new Date().toISOString();
    repo.upsert(rec);
    return { ...rec };
}

export function deleteRule(id) {
    return repo.remove(id);
}
