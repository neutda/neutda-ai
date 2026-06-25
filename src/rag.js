// 간단한 로컬 RAG 저장소.
// - 문서를 청크로 분할해 보관하고, BM25 점수로 질의에 관련된 청크를 검색한다.
// - 추가 모델/외부 의존성 없이 동작하며, 한국어는 음절 bigram 토크나이징으로 매칭을 개선한다.
// - 추후 임베딩 백엔드로 retrieve() 내부만 교체하면 의미검색으로 확장 가능.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data", "rag");
const INDEX_FILE = path.join(DATA_DIR, "index.json");

const CHUNK_CHARS = 600; // 청크 목표 길이(문자)
const CHUNK_OVERLAP = 100; // 청크 간 겹침(문맥 보존)

// 메모리 상태: 문서 목록 + BM25 인덱스
let docs = []; // [{ id, name, createdAt, chunkCount }]
let chunks = []; // [{ id, docId, docName, idx, text, tokens:Map<term,tf>, len }]
let df = new Map(); // term -> document(chunk) frequency
let avgdl = 0;
let loaded = false;

async function ensureDir() {
    await mkdir(DATA_DIR, { recursive: true });
}

// ---- 토크나이징 ----------------------------------------------------------
// 라틴/숫자는 단어 단위, 한글은 음절 bigram(+단일 음절)으로 토큰화한다.
function tokenize(text) {
    const out = [];
    const lower = String(text).toLowerCase();
    const re = /[a-z0-9]+|[\uac00-\ud7a3]+/g;
    let m;
    while ((m = re.exec(lower)) !== null) {
        const tok = m[0];
        if (/[a-z0-9]/.test(tok[0])) {
            out.push(tok);
        } else {
            // 한글 음절 덩어리 -> bigram 생성
            if (tok.length === 1) {
                out.push(tok);
            } else {
                for (let i = 0; i < tok.length - 1; i++) {
                    out.push(tok.slice(i, i + 2));
                }
            }
        }
    }
    return out;
}

function termFreq(tokens) {
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return tf;
}

// ---- 청킹 ---------------------------------------------------------------
function splitChunks(text) {
    const clean = String(text).replace(/\r\n/g, "\n").trim();
    if (!clean) return [];
    const paragraphs = clean.split(/\n{2,}/);
    const result = [];
    let buf = "";
    const flush = () => {
        const t = buf.trim();
        if (t) result.push(t);
        buf = "";
    };
    for (const p of paragraphs) {
        const para = p.trim();
        if (!para) continue;
        if (para.length > CHUNK_CHARS) {
            flush();
            // 긴 문단은 슬라이딩 윈도우로 분할
            for (let i = 0; i < para.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
                result.push(para.slice(i, i + CHUNK_CHARS));
            }
            continue;
        }
        if ((buf + "\n\n" + para).length > CHUNK_CHARS) flush();
        buf = buf ? buf + "\n\n" + para : para;
    }
    flush();
    return result;
}

// ---- 인덱스(영속) -------------------------------------------------------
function rebuildStats() {
    df = new Map();
    let total = 0;
    for (const c of chunks) {
        c.tokens = termFreq(tokenize(c.text));
        c.len = 0;
        for (const v of c.tokens.values()) c.len += v;
        total += c.len;
        for (const term of c.tokens.keys())
            df.set(term, (df.get(term) || 0) + 1);
    }
    avgdl = chunks.length ? total / chunks.length : 0;
}

async function persist() {
    await ensureDir();
    // tokens/len 등 파생 데이터는 저장하지 않고, 로드시 재계산한다.
    const data = {
        docs,
        chunks: chunks.map((c) => ({
            id: c.id,
            docId: c.docId,
            docName: c.docName,
            idx: c.idx,
            text: c.text,
        })),
    };
    await writeFile(INDEX_FILE, JSON.stringify(data), "utf-8");
}

export async function load() {
    if (loaded) return;
    try {
        const raw = await readFile(INDEX_FILE, "utf-8");
        const data = JSON.parse(raw);
        docs = Array.isArray(data.docs) ? data.docs : [];
        chunks = Array.isArray(data.chunks) ? data.chunks : [];
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
        docs = [];
        chunks = [];
    }
    rebuildStats();
    loaded = true;
}

// ---- 공개 API -----------------------------------------------------------
export function listDocuments() {
    return docs
        .map((d) => ({ ...d }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function stats() {
    return {
        documents: docs.length,
        chunks: chunks.length,
        terms: df.size,
        avgChunkTokens: Math.round(avgdl),
    };
}

export async function addDocument(name, text) {
    await load();
    const body = String(text || "").trim();
    if (!body) throw new Error("문서 내용이 비어 있습니다.");
    const parts = splitChunks(body);
    if (!parts.length) throw new Error("청크를 만들 수 없습니다.");

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const docName = (name && String(name).trim()) || `문서-${id}`;
    const createdAt = new Date().toISOString();

    parts.forEach((text, idx) => {
        chunks.push({
            id: `${id}:${idx}`,
            docId: id,
            docName,
            idx,
            text,
        });
    });
    docs.push({ id, name: docName, createdAt, chunkCount: parts.length });

    rebuildStats();
    await persist();
    return { id, name: docName, chunkCount: parts.length };
}

export async function deleteDocument(id) {
    await load();
    const before = docs.length;
    docs = docs.filter((d) => d.id !== id);
    chunks = chunks.filter((c) => c.docId !== id);
    rebuildStats();
    await persist();
    return { removed: before - docs.length };
}

// BM25 검색: 질의와 가장 관련성 높은 청크 topK 반환
export function retrieve(query, k = 4) {
    if (!chunks.length) return [];
    const k1 = 1.5;
    const b = 0.75;
    const N = chunks.length;
    const qTokens = [...new Set(tokenize(query))];

    const scored = chunks.map((c) => {
        let score = 0;
        for (const term of qTokens) {
            const tf = c.tokens.get(term);
            if (!tf) continue;
            const n = df.get(term) || 0;
            const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
            const denom = tf + k1 * (1 - b + (b * c.len) / (avgdl || 1));
            score += idf * ((tf * (k1 + 1)) / denom);
        }
        return { c, score };
    });

    return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((s) => ({
            chunkId: s.c.id,
            docId: s.c.docId,
            docName: s.c.docName,
            idx: s.c.idx,
            text: s.c.text,
            score: Number(s.score.toFixed(4)),
        }));
}
