/**
 * API 법칙 스토어 (data/rules.json).
 * 키워드로 발동하고, 응답을 JSON 스키마로 강제한다.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { schemaKeys } from "./jsonRule.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "rules.json");
const NAME_MAX = 60;
const INST_MAX = 400;
const INTENT_MAX = 400;

let rules = null;
let saveTimer = null;

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

function load() {
    if (rules) return rules;
    let parsed = [];
    if (existsSync(FILE)) {
        try {
            const raw = JSON.parse(readFileSync(FILE, "utf-8"));
            if (Array.isArray(raw?.rules)) parsed = raw.rules;
        } catch {
            parsed = [];
        }
    }
    rules = parsed.map(sanitize).filter(Boolean);
    return rules;
}

function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveNow().catch(() => {});
    }, 1000);
    if (saveTimer.unref) saveTimer.unref();
}

async function saveNow() {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(
        FILE,
        JSON.stringify({ rules: rules ?? [] }, null, 2),
        "utf-8",
    );
}

export function listRules() {
    return load()
        .map((r) => ({ ...r }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getRule(id) {
    return load().find((r) => r.id === id) || null;
}

export function filterExistingRules(ids) {
    if (!Array.isArray(ids)) return [];
    const set = new Set(load().map((r) => r.id));
    return ids.filter((id) => set.has(id));
}

export function rulesByIds(ids) {
    return filterExistingRules(ids)
        .map((id) => getRule(id))
        .filter(Boolean);
}

export function createRule(input = {}) {
    load();
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
    rules.push(rec);
    scheduleSave();
    return { ...rec };
}

export function updateRule(id, patch = {}) {
    load();
    const rec = rules.find((r) => r.id === id);
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
    scheduleSave();
    return { ...rec };
}

export function deleteRule(id) {
    load();
    const i = rules.findIndex((r) => r.id === id);
    if (i === -1) return false;
    rules.splice(i, 1);
    scheduleSave();
    return true;
}
