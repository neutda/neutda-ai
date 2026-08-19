/**
 * 파일 백엔드 — 저장소 추상화(src/storage/index.js)의 기본 구현.
 *
 * 세 가지 저장소 종류를 파일로 구현한다. DB 이행 시 같은 인터페이스로
 * 다른 백엔드(예: src/storage/pgBackend.js)를 만들어 index.js 에서 갈아끼운다.
 *
 *  - fileDocStore(file)      … 단일 JSON 문서 (read / save)
 *  - fileCollectionStore(f)  … 레코드 컬렉션 (all / get / upsert / remove / replaceAll)
 *  - fileAppendLog(file)     … append 로그(JSONL) (append / readAll / overwrite / clear)
 *
 * 공통: 쓰기는 항상 원자적(tmp 파일 → rename)이라 도중 크래시로 파일이
 * 잘려 손상되는 일이 없다. 잦은 저장은 debounce 로 coalescing 한다.
 */
import {
  readFile,
  writeFile,
  rename,
  mkdir,
  appendFile,
  rm,
  readdir,
  unlink,
} from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/** tmp 파일에 쓰고 rename — 부분 쓰기로 인한 손상 방지 (rename 은 원자적). */
async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf-8");
  await rename(tmp, file); // Windows(MoveFileEx replace)·POSIX 모두 기존 파일 대체
}

function serialize(obj, pretty) {
  return JSON.stringify(obj, null, pretty ? 2 : 0);
}

/**
 * 한 파일에 대한 debounce 쓰기. 최신 값만 남겨 coalescing 하고,
 * 쓰기 순서는 내부 프라미스 체인으로 직렬화한다.
 */
class DebouncedWriter {
  constructor(file, debounceMs) {
    this.file = file;
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.timer = null;
    this.pending = null; // 최신 직렬화 텍스트 (null = 대기 없음)
    this.chain = Promise.resolve();
  }
  schedule(text) {
    this.pending = text;
    if (this.timer || this.debounceMs === 0) {
      if (this.debounceMs === 0) return this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, this.debounceMs);
    if (this.timer.unref) this.timer.unref();
  }
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending == null) return this.chain;
    const text = this.pending;
    this.pending = null;
    this.chain = this.chain
      .then(() => atomicWrite(this.file, text))
      .catch(() => {
        // best-effort: 다음 save 에서 최신 값으로 다시 시도됨
      });
    return this.chain;
  }
}

/** 단일 JSON 문서. read() → 파싱된 객체 | null (없음/손상). */
export function fileDocStore(file, { debounceMs = 1000, pretty = false } = {}) {
  const writer = new DebouncedWriter(file, debounceMs);
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  return {
    readSync() {
      if (!existsSync(file)) return null;
      try {
        return parse(readFileSync(file, "utf-8"));
      } catch {
        return null;
      }
    },
    async read() {
      try {
        return parse(await readFile(file, "utf-8"));
      } catch (err) {
        if (err && err.code === "ENOENT") return null;
        return null;
      }
    },
    save(obj) {
      writer.schedule(serialize(obj, pretty));
    },
    flush: () => writer.flush(),
  };
}

/**
 * 레코드 컬렉션. 파일에는 { [rootKey]: [...] } 로 저장한다.
 * 로드 시 sanitize 를 적용(디스크 방어), upsert/replaceAll 입력은 신뢰한다.
 */
export function fileCollectionStore(
  file,
  {
    rootKey = "items",
    idField = "id",
    sanitize = (x) => x,
    pretty = true,
    debounceMs = 1000,
  } = {},
) {
  const writer = new DebouncedWriter(file, debounceMs);
  let items = null; // 로드 전 null

  function loadSync() {
    if (items) return items;
    let parsed = [];
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf-8"));
        if (Array.isArray(raw?.[rootKey])) parsed = raw[rootKey];
      } catch {
        parsed = [];
      }
    }
    items = parsed.map(sanitize).filter(Boolean);
    return items;
  }

  function persist() {
    writer.schedule(serialize({ [rootKey]: items ?? [] }, pretty));
  }

  return {
    loadSync,
    all: () => loadSync(),
    /** 레코드를 제자리 수정한 뒤 현재 컬렉션 전체를 저장 예약.
     *  (DB 백엔드에선 dirty 레코드 upsert 로 해석) */
    persist,
    get(id) {
      return loadSync().find((x) => x[idField] === id) || null;
    },
    /** id 가 있으면 교체, 없으면 추가. 반환: 저장된 레코드. */
    upsert(rec) {
      loadSync();
      const id = rec?.[idField];
      const i = id != null ? items.findIndex((x) => x[idField] === id) : -1;
      if (i >= 0) items[i] = rec;
      else items.push(rec);
      persist();
      return rec;
    },
    remove(id) {
      loadSync();
      const i = items.findIndex((x) => x[idField] === id);
      if (i === -1) return false;
      items.splice(i, 1);
      persist();
      return true;
    },
    replaceAll(arr) {
      items = Array.isArray(arr) ? arr : [];
      persist();
      return items;
    },
    flush: () => writer.flush(),
  };
}

/** append 로그(JSONL). 한 줄에 레코드 하나. */
export function fileAppendLog(file) {
  return {
    async append(record) {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(record) + "\n", "utf8");
    },
    async readAll() {
      let text;
      try {
        text = await readFile(file, "utf8");
      } catch (err) {
        if (err && err.code === "ENOENT") return [];
        throw err;
      }
      const out = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // 손상된 줄은 건너뜀
        }
      }
      return out;
    },
    async overwrite(records) {
      await mkdir(path.dirname(file), { recursive: true });
      const text = (records || []).map((r) => JSON.stringify(r) + "\n").join("");
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, text, "utf8");
      await rename(tmp, file);
    },
    async clear() {
      await rm(file, { force: true });
    },
  };
}

/**
 * id 로 키된 다중 문서 저장소 — 디렉터리 안에 `<id>.json` 하나씩.
 * DB 백엔드에선 id 를 PK 로 하는 테이블 한 개로 직역된다
 * (put → upsert, get → select, list → select all, remove → delete).
 */
export function fileKeyedDocStore(dir, { pretty = true } = {}) {
  const safeId = (id) => String(id).replace(/[^a-zA-Z0-9._-]/g, "");
  const fileFor = (id) => path.join(dir, `${safeId(id)}.json`);
  return {
    async put(id, obj) {
      await mkdir(dir, { recursive: true });
      await atomicWrite(fileFor(id), serialize(obj, pretty));
      return obj;
    },
    async get(id) {
      try {
        return JSON.parse(await readFile(fileFor(id), "utf-8"));
      } catch {
        return null;
      }
    },
    /** 모든 문서를 파싱해 배열로 (손상 파일은 건너뜀). */
    async list() {
      let files;
      try {
        await mkdir(dir, { recursive: true });
        files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
      } catch {
        return [];
      }
      const out = [];
      for (const f of files) {
        try {
          out.push(JSON.parse(await readFile(path.join(dir, f), "utf-8")));
        } catch {
          // 손상 파일 skip
        }
      }
      return out;
    },
    async remove(id) {
      try {
        await unlink(fileFor(id));
        return true;
      } catch {
        return false;
      }
    },
  };
}
