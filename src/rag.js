// 간단한 로컬 RAG 저장소.
// - 기본: BM25 + 한글 bigram
// - 임베딩 역할 백엔드가 있으면 청크 벡터를 저장하고 코사인 유사도로 검색 (실패 시 BM25)
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data", "rag");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const IMAGES_DIR = path.join(DATA_DIR, "images");

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

const CHUNK_CHARS = 600; // 청크 목표 길이(문자)
const CHUNK_OVERLAP = 100; // 청크 간 겹침(문맥 보존)

// 메모리 상태: 문서 목록 + BM25 인덱스
let docs = []; // [{ id, name, createdAt, chunkCount }]
let chunks = []; // [{ id, docId, docName, idx, text, tokens, len, embedding? }]
let df = new Map(); // term -> document(chunk) frequency
let avgdl = 0;
let loaded = false;
/** @type {null | ((texts: string[]) => Promise<number[][]|null>)} */
let embedBatch = null;

/** 서버 기동 시 pool.embed 를 주입 */
export function setEmbedder(fn) {
    embedBatch = typeof fn === "function" ? fn : null;
}

async function ensureDir() {
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(IMAGES_DIR, { recursive: true });
}

export function imagePath(imageFile) {
    return path.join(IMAGES_DIR, imageFile);
}

export async function readImageDataUrl(imageFile) {
    const ext = path.extname(imageFile).toLowerCase();
    const mime =
        {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".bmp": "image/bmp",
        }[ext] || "image/jpeg";
    const buf = await readFile(imagePath(imageFile));
    return `data:${mime};base64,${buf.toString("base64")}`;
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
            kind: c.kind || "text",
            imageFile: c.imageFile || null,
            embedding: Array.isArray(c.embedding) ? c.embedding : undefined,
        })),
    };
    await writeFile(INDEX_FILE, JSON.stringify(data), "utf-8");
}

function cosine(a, b) {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function ensureChunkEmbeddings(list) {
    if (!embedBatch) return false;
    const need = list.filter((c) => !Array.isArray(c.embedding));
    if (!need.length) return list.some((c) => Array.isArray(c.embedding));
    const BATCH = 8;
    for (let i = 0; i < need.length; i += BATCH) {
        const slice = need.slice(i, i + BATCH);
        const vectors = await embedBatch(slice.map((c) => c.text));
        if (!vectors?.length) return false;
        for (let j = 0; j < slice.length; j++) {
            if (Array.isArray(vectors[j])) slice[j].embedding = vectors[j];
        }
    }
    await persist();
    return true;
}

export async function load() {
    if (loaded) return;
    try {
        const raw = await readFile(INDEX_FILE, "utf-8");
        const data = JSON.parse(raw);
        docs = Array.isArray(data.docs) ? data.docs : [];
        chunks = Array.isArray(data.chunks)
            ? data.chunks.map((c) => ({
                  ...c,
                  embedding: Array.isArray(c.embedding) ? c.embedding : undefined,
              }))
            : [];
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

export async function addDocument(name, text, opts = {}) {
    await load();
    const body = String(text || "").trim();
    if (!body) throw new Error("문서 내용이 비어 있습니다.");
    const parts = splitChunks(body);
    if (!parts.length) throw new Error("청크를 만들 수 없습니다.");

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const docName = (name && String(name).trim()) || `문서-${id}`;
    const createdAt = new Date().toISOString();
    const kind = opts.kind === "image" ? "image" : "text";
    const imageFile = opts.imageFile || null;

    parts.forEach((chunkText, idx) => {
        chunks.push({
            id: `${id}:${idx}`,
            docId: id,
            docName,
            idx,
            text: chunkText,
            kind,
            imageFile: idx === 0 ? imageFile : null,
        });
    });
    docs.push({
        id,
        name: docName,
        createdAt,
        chunkCount: parts.length,
        kind,
        imageFile,
    });

    rebuildStats();
    // 임베딩 역할이 있으면 새 청크 벡터를 채워 둔다 (실패해도 BM25 로 동작)
    try {
        const fresh = chunks.filter((c) => c.docId === id);
        await ensureChunkEmbeddings(fresh);
    } catch {
        /* ignore */
    }
    await persist();
    return { id, name: docName, chunkCount: parts.length, kind, imageFile };
}

/** 이미지 바이너리 저장 + 검색용 텍스트(비전 추출)로 문서 등록 */
export async function addImageDocument(name, buffer, ext, description) {
    await ensureDir();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const docName = (name && String(name).trim()) || `이미지-${id}`;
    const safeExt = IMAGE_EXT.has(ext.toLowerCase()) ? ext.toLowerCase() : ".png";
    const imageFile = `${id}${safeExt}`;
    await writeFile(imagePath(imageFile), buffer);
    return addDocument(docName, description, { kind: "image", imageFile });
}

/** 문서 부가정보(요약·예상 질문 등)를 갱신해 저장한다 */
export async function updateDocumentMeta(id, meta) {
    await load();
    const doc = docs.find((d) => d.id === id);
    if (!doc) return false;
    Object.assign(doc, meta);
    await persist();
    return true;
}

export async function deleteDocument(id) {
    await load();
    const doc = docs.find((d) => d.id === id);
    const before = docs.length;
    docs = docs.filter((d) => d.id !== id);
    chunks = chunks.filter((c) => c.docId !== id);
    if (doc?.imageFile) {
        await unlink(imagePath(doc.imageFile)).catch(() => {});
    }
    rebuildStats();
    await persist();
    return { removed: before - docs.length };
}

function hitFrom(c, score, mode) {
    return {
        chunkId: c.id,
        docId: c.docId,
        docName: c.docName,
        idx: c.idx,
        text: c.text,
        score: Number(score.toFixed(4)),
        kind: c.kind || "text",
        imageFile: c.imageFile || null,
        mode,
    };
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
        .map((s) => hitFrom(s.c, s.score, "bm25"));
}

/** 임베딩 역할이 있으면 의미 검색, 없거나 실패 시 BM25 */
export async function retrieveAsync(query, k = 4) {
    await load();
    if (!chunks.length) return [];
    if (embedBatch) {
        try {
            await ensureChunkEmbeddings(chunks);
            const qVecs = await embedBatch([String(query)]);
            const qv = qVecs?.[0];
            if (Array.isArray(qv)) {
                const scored = chunks
                    .filter((c) => Array.isArray(c.embedding))
                    .map((c) => ({ c, score: cosine(qv, c.embedding) }))
                    .filter((s) => s.score > 0.05)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, k)
                    .map((s) => hitFrom(s.c, s.score, "embedding"));
                if (scored.length) return scored;
            }
        } catch {
            /* BM25 폴백 */
        }
    }
    return retrieve(query, k);
}
