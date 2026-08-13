// GGUF 모델 파일 메타데이터 리더.
// llama 프로세스 기동 전 VRAM 사전 점검에서 레이어 수(*.block_count)를 얻는 데 쓴다.
// GGUF 포맷: "GGUF" 매직 + 버전(u32) + tensorCount(u64) + kvCount(u64) 헤더 뒤로
// key(string) + valueType(u32) + value 가 kvCount 개 이어진다.
import { openSync, readSync, closeSync } from "node:fs";

// ── 파싱 안전 한계 (손상/비정상 파일에서 무한 루프·과대 할당 방지) ──
const HEADER_BYTES = 24; // 매직(4)+버전(4)+tensorCount(8)+kvCount(8)
const SCRATCH_BYTES = 16; // 스칼라 읽기용 재사용 버퍼
const MAX_KV_COUNT = 20000; // KV 엔트리 상한
const MAX_STRING_LEN = 1_000_000; // 문자열 값 길이 상한

// GGUF value type → 고정 바이트 크기 (가변형 string(8)/array(9) 는 별도 처리)
const SCALAR_SIZES = {
    0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8,
};
const TYPE_STRING = 8;
const TYPE_ARRAY = 9;

/**
 * GGUF 메타에서 레이어 수(*.block_count)를 읽는다. 실패 시 null.
 * @param {string} absPath GGUF 파일 절대 경로
 * @returns {number|null}
 */
export function readGgufBlockCount(absPath) {
    let fd;
    try {
        fd = openSync(absPath, "r");
        const head = Buffer.alloc(HEADER_BYTES);
        if (readSync(fd, head, 0, HEADER_BYTES, 0) < HEADER_BYTES) return null;
        if (head.toString("utf8", 0, 4) !== "GGUF") return null;
        const kvCount = Number(head.readBigUInt64LE(16));
        if (!Number.isFinite(kvCount) || kvCount <= 0 || kvCount > MAX_KV_COUNT) {
            return null;
        }

        const cursor = { fd, pos: HEADER_BYTES, scratch: Buffer.alloc(SCRATCH_BYTES) };

        for (let i = 0; i < kvCount; i++) {
            const key = readString(cursor);
            const type = readU32(cursor);
            if (key == null || type == null) return null;
            if (key.endsWith(".block_count")) {
                const v = readScalar(cursor, type);
                return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
            }
            if (!skipValue(cursor, type)) return null;
        }
        return null;
    } catch {
        return null;
    } finally {
        if (fd != null) {
            try {
                closeSync(fd);
            } catch {}
        }
    }
}

// ── 저수준 리더 프리미티브 (cursor.pos 를 전진시키며 읽는다) ──

function readExact(cursor, n) {
    const b = n <= cursor.scratch.length ? cursor.scratch : Buffer.alloc(n);
    const got = readSync(cursor.fd, b, 0, n, cursor.pos);
    if (got !== n) return null;
    cursor.pos += n;
    return b;
}

function readU32(cursor) {
    const b = readExact(cursor, 4);
    return b ? b.readUInt32LE(0) : null;
}

function readU64(cursor) {
    const b = readExact(cursor, 8);
    return b ? Number(b.readBigUInt64LE(0)) : null;
}

function readI32(cursor) {
    const b = readExact(cursor, 4);
    return b ? b.readInt32LE(0) : null;
}

function readI64(cursor) {
    const b = readExact(cursor, 8);
    return b ? Number(b.readBigInt64LE(0)) : null;
}

function readString(cursor) {
    const len = readU64(cursor);
    if (len == null || len < 0 || len > MAX_STRING_LEN) return null;
    if (len === 0) return "";
    const b = Buffer.alloc(len);
    const got = readSync(cursor.fd, b, 0, len, cursor.pos);
    cursor.pos += len;
    return got === len ? b.toString("utf8") : null;
}

/** 값을 실제로 읽지 않고 커서만 건너뛴다. 성공 여부 반환. */
function skipValue(cursor, type) {
    if (type === TYPE_STRING) return readString(cursor) != null;
    if (type === TYPE_ARRAY) {
        const at = readU32(cursor);
        const ac = readU64(cursor);
        if (at == null || ac == null) return false;
        for (let i = 0; i < ac; i++) if (!skipValue(cursor, at)) return false;
        return true;
    }
    const sz = SCALAR_SIZES[type];
    if (!sz) return false;
    cursor.pos += sz;
    return true;
}

/** 스칼라 정수 값을 읽어 반환 (그 외 타입은 건너뛰고 null). */
function readScalar(cursor, type) {
    if (type === 4) return readU32(cursor);
    if (type === 5) return readI32(cursor);
    if (type === 10) return readU64(cursor);
    if (type === 11) return readI64(cursor);
    skipValue(cursor, type);
    return null;
}
