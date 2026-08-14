/**
 * 기초지식 지식셋(컬렉션) 메타 스토어 (data/knowledge.json).
 * 실제 문서·청크·임베딩은 rag.js 가 collectionId 로 보관하고, 여기선 컬렉션의
 * 이름/설명 등 메타만 관리한다. 삭제 시 rag.js 의 해당 문서도 함께 정리한다.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as rag from "./rag.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "knowledge.json");
const NAME_MAX = 60;
const DESC_MAX = 200;

let collections = null;
let saveTimer = null;

function newId() {
    return "kc_" + Date.now().toString(36) + randomBytes(3).toString("hex");
}

function normalizeName(value) {
    const t = String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    return t ? t.slice(0, NAME_MAX) : "";
}

function normalizeDesc(value) {
    const t = String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    return t ? t.slice(0, DESC_MAX) : "";
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
        description: normalizeDesc(raw.description),
        createdAt: raw.createdAt || new Date().toISOString(),
        updatedAt: raw.updatedAt || null,
    };
}

function load() {
    if (collections) return collections;
    let parsed = [];
    if (existsSync(FILE)) {
        try {
            const raw = JSON.parse(readFileSync(FILE, "utf-8"));
            if (Array.isArray(raw?.collections)) parsed = raw.collections;
        } catch {
            parsed = [];
        }
    }
    collections = parsed.map(sanitize).filter(Boolean);
    return collections;
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
        JSON.stringify({ collections: collections ?? [] }, null, 2),
        "utf-8",
    );
}

/** 컬렉션 목록 (문서 수 포함) */
export async function listCollections() {
    load();
    await rag.load();
    return collections
        .map((c) => ({
            ...c,
            docCount: rag.listDocuments(c.id).length,
        }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getCollection(id) {
    return load().find((c) => c.id === id) || null;
}

/** 존재하는 컬렉션 id 만 남긴다 (키 바인딩 검증용) */
export function filterExisting(ids) {
    if (!Array.isArray(ids)) return [];
    const set = new Set(load().map((c) => c.id));
    return ids.filter((id) => set.has(id));
}

export function createCollection(input = {}) {
    load();
    const rec = sanitize({
        name: input.name,
        description: input.description,
    });
    if (!rec) throw new Error("지식셋 이름은 필수입니다.");
    collections.push(rec);
    scheduleSave();
    return { ...rec, docCount: 0 };
}

export function updateCollection(id, patch = {}) {
    load();
    const rec = collections.find((c) => c.id === id);
    if (!rec) return null;
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    if (has("name")) {
        const name = normalizeName(patch.name);
        if (!name) throw new Error("지식셋 이름은 비울 수 없습니다.");
        rec.name = name;
    }
    if (has("description")) rec.description = normalizeDesc(patch.description);
    rec.updatedAt = new Date().toISOString();
    scheduleSave();
    return rec;
}

/** 컬렉션 삭제 + 소속 문서 정리 */
export async function deleteCollection(id) {
    load();
    const i = collections.findIndex((c) => c.id === id);
    if (i === -1) return false;
    collections.splice(i, 1);
    scheduleSave();
    // 소속 rag 문서 삭제
    await rag.load();
    const docs = rag.listDocuments(id);
    for (const d of docs) {
        await rag.deleteDocument(d.id, { collectionId: id }).catch(() => {});
    }
    return true;
}
