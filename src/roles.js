/**
 * 공통 역할 카탈로그 (roles.json).
 * 모델(서버)에는 roleIds 로 입히고, 서버별 skills 는 커스텀 역할이다.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ROLES_FILE = path.join(ROOT, "roles.json");
const NAME_MAX = 40;
const DESC_MAX = 200;
// P1 고도화: 역할이 라우팅뿐 아니라 "답변 방식"까지 정의한다.
const INSTR_MAX = 2000; // 행동 지시(생성 시 시스템 프롬프트로 주입)
const SCHEMA_KEYS_MAX = 16;
const SCHEMA_HINT_MAX = 80;
const EXAMPLES_MAX = 5;
const EXAMPLE_FIELD_MAX = 600;
const SCHEMA_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LANGS = new Set(["ko", "en", "zh"]);

function normalizeSkill(value) {
  const t = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, DESC_MAX) : null;
}

function newId() {
  return (
    "r_" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

function normalizeName(value) {
  const t = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, NAME_MAX) : null;
}

function normalizeDesc(value) {
  const t = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, DESC_MAX) : "";
}

/** 라우터·풀에서 쓰는 특기 키 (= 역할 이름) */
export function roleSkillKey(role) {
  return normalizeSkill(role?.name) ?? null;
}

/** 행동 지시(생성 시 주입되는 시스템 프롬프트) */
function normalizeInstruction(value) {
  const t = String(value ?? "").trim();
  return t ? t.slice(0, INSTR_MAX) : "";
}

/** 출력 JSON 스키마 { 키: 힌트 }. 객체 또는 JSON 문자열 허용. 없으면 {}. */
function normalizeOutputSchema(value) {
  let obj = value;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return {};
    try {
      obj = JSON.parse(s);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  let n = 0;
  for (const k of Object.keys(obj)) {
    const key = String(k).trim().slice(0, 40);
    if (!key || !SCHEMA_KEY_RE.test(key)) continue;
    const v = obj[k];
    out[key] = typeof v === "string" ? v.slice(0, SCHEMA_HINT_MAX) : "";
    if (++n >= SCHEMA_KEYS_MAX) break;
  }
  return out;
}

/** few-shot 예시 [{ input, output }]. 배열 또는 JSON 문자열 허용. */
function normalizeExamples(value) {
  let arr = value;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return [];
    try {
      arr = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const input = String(e.input ?? "").trim().slice(0, EXAMPLE_FIELD_MAX);
    const output = String(e.output ?? "").trim().slice(0, EXAMPLE_FIELD_MAX);
    if (!input && !output) continue;
    out.push({ input, output });
    if (out.length >= EXAMPLES_MAX) break;
  }
  return out;
}

/** 생성 파라미터 오버라이드 { temperature, maxTokens, thinking, language } — null = 미지정(기본 사용) */
function normalizeParams(value) {
  const o = value && typeof value === "object" ? value : {};
  let temperature = null;
  if (o.temperature != null && o.temperature !== "") {
    const t = Number(o.temperature);
    if (Number.isFinite(t)) temperature = Math.min(2, Math.max(0, t));
  }
  let maxTokens = null;
  if (o.maxTokens != null && o.maxTokens !== "") {
    const m = Math.floor(Number(o.maxTokens));
    if (Number.isFinite(m) && m >= 1) maxTokens = Math.min(32768, m);
  }
  let thinking = null;
  if (o.thinking != null && o.thinking !== "") {
    thinking =
      o.thinking === true || o.thinking === "true" || o.thinking === 1;
  }
  let language = null;
  if (o.language != null && o.language !== "") {
    const l = String(o.language).trim().toLowerCase();
    if (LANGS.has(l)) language = l;
  }
  return { temperature, maxTokens, thinking, language };
}

function sanitizeRole(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = normalizeName(raw.name);
  if (!name) return null;
  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim().slice(0, 40)
      : newId();
  return {
    id,
    name,
    description: normalizeDesc(raw.description ?? raw.text ?? ""),
    instruction: normalizeInstruction(raw.instruction),
    outputSchema: normalizeOutputSchema(raw.outputSchema),
    examples: normalizeExamples(raw.examples),
    params: normalizeParams(raw.params),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || null,
  };
}

/** 역할이 라우팅 외 "행동"을 정의하는지 (지시/스키마/예시/파라미터 중 하나라도) */
export function hasBehavior(role) {
  if (!role) return false;
  const p = role.params || {};
  return Boolean(
    (role.instruction && role.instruction.trim()) ||
      (role.outputSchema && Object.keys(role.outputSchema).length) ||
      (Array.isArray(role.examples) && role.examples.length) ||
      p.temperature != null ||
      p.maxTokens != null ||
      p.thinking != null ||
      p.language != null,
  );
}

// 이름→역할 맵 캐시 (생성 hot-path 에서 roles.json 재파싱 방지, mtime 로 자동 무효화)
let _roleMapCache = { mtime: -1, map: null };
function roleMapByName() {
  let mtime = 0;
  try {
    mtime = statSync(ROLES_FILE).mtimeMs;
  } catch {
    mtime = 0;
  }
  if (_roleMapCache.map && _roleMapCache.mtime === mtime) {
    return _roleMapCache.map;
  }
  const map = new Map();
  for (const r of loadRolesSync()) map.set(r.name, r);
  _roleMapCache = { mtime, map };
  return map;
}

/**
 * 특기(역할 이름)로 행동 정의 조회. 생성 파이프라인이 시스템 프롬프트·파라미터에 주입한다.
 * 행동이 없는(라우팅 전용) 역할·커스텀 특기면 null.
 */
export function roleBehaviorFor(name) {
  const key = normalizeName(name);
  if (!key) return null;
  const role = roleMapByName().get(key);
  if (!role || !hasBehavior(role)) return null;
  return {
    name: role.name,
    instruction: role.instruction,
    schema: role.outputSchema,
    examples: role.examples,
    params: role.params,
  };
}

/** 동기 로드 (풀 기동·config 스펙용) */
export function loadRolesSync() {
  if (!existsSync(ROLES_FILE)) return [];
  try {
    const cfg = JSON.parse(readFileSync(ROLES_FILE, "utf-8"));
    const list = Array.isArray(cfg?.roles) ? cfg.roles : Array.isArray(cfg) ? cfg : [];
    const out = [];
    const seen = new Set();
    for (const r of list) {
      const role = sanitizeRole(r);
      if (!role || seen.has(role.id)) continue;
      seen.add(role.id);
      out.push(role);
    }
    return out;
  } catch {
    return [];
  }
}

export async function loadRoles() {
  return loadRolesSync();
}

async function saveRoles(roles) {
  await mkdir(path.dirname(ROLES_FILE), { recursive: true });
  const body = JSON.stringify({ roles }, null, 4) + "\n";
  await writeFile(ROLES_FILE, body, "utf-8");
  _roleMapCache = { mtime: -1, map: null };
}

export function rolesById(roles = loadRolesSync()) {
  return new Map(roles.map((r) => [r.id, r]));
}

/**
 * 서버 정의 → 공통 역할 + 커스텀 역할 분리·병합.
 * roleIds → 공통, skills/skill → 커스텀.
 */
export function resolveServerRoles(def, roleMap = rolesById()) {
  const roleIds = [];
  const seenId = new Set();
  for (const id of Array.isArray(def?.roleIds) ? def.roleIds : []) {
    const key = String(id ?? "").trim();
    if (!key || seenId.has(key) || !roleMap.has(key)) continue;
    seenId.add(key);
    roleIds.push(key);
  }
  const commonRoles = roleIds.map((id) => roleMap.get(id)).filter(Boolean);
  const commonSkills = [];
  const seenSkill = new Set();
  for (const r of commonRoles) {
    const k = roleSkillKey(r);
    if (!k || seenSkill.has(k)) continue;
    seenSkill.add(k);
    commonSkills.push(k);
  }

  // 커스텀: skills 배열 (구형 skill 단일값도 허용)
  const rawCustom = Array.isArray(def?.skills)
    ? def.skills
    : def?.skill
      ? [def.skill]
      : [];
  const customSkills = [];
  for (const v of rawCustom) {
    const s = normalizeSkill(v);
    if (!s || seenSkill.has(s)) continue; // 공통과 중복이면 커스텀에서 제외
    seenSkill.add(s);
    customSkills.push(s);
  }

  return {
    roleIds,
    commonRoles,
    commonSkills,
    customSkills,
    skills: [...commonSkills, ...customSkills],
  };
}

export async function createRole(input = {}) {
  const roles = await loadRoles();
  const role = sanitizeRole({
    id: newId(),
    name: input.name,
    description: input.description,
    instruction: input.instruction,
    outputSchema: input.outputSchema,
    examples: input.examples,
    params: input.params,
    createdAt: new Date().toISOString(),
  });
  if (!role) throw new Error("역할 이름(name)을 입력하세요.");
  if (roles.some((r) => r.name === role.name)) {
    throw new Error(`이미 같은 이름의 역할이 있습니다: "${role.name}"`);
  }
  roles.push(role);
  await saveRoles(roles);
  return role;
}

export async function updateRole(id, patch = {}) {
  const roles = await loadRoles();
  const idx = roles.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const prev = roles[idx];
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  const next = sanitizeRole({
    ...prev,
    name: has("name") ? patch.name : prev.name,
    description: has("description") ? patch.description : prev.description,
    instruction: has("instruction") ? patch.instruction : prev.instruction,
    outputSchema: has("outputSchema") ? patch.outputSchema : prev.outputSchema,
    examples: has("examples") ? patch.examples : prev.examples,
    params: has("params") ? { ...prev.params, ...patch.params } : prev.params,
    id: prev.id,
    createdAt: prev.createdAt,
    updatedAt: new Date().toISOString(),
  });
  if (!next) throw new Error("역할 이름(name)을 입력하세요.");
  if (roles.some((r, i) => i !== idx && r.name === next.name)) {
    throw new Error(`이미 같은 이름의 역할이 있습니다: "${next.name}"`);
  }
  roles[idx] = next;
  await saveRoles(roles);
  return next;
}

export async function deleteRole(id) {
  const roles = await loadRoles();
  const idx = roles.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  roles.splice(idx, 1);
  await saveRoles(roles);
  return true;
}

/** roleIds 정규화 (존재하는 id 만, 중복 제거) */
export function normalizeRoleIds(value, roleMap = rolesById()) {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const id = String(v ?? "").trim();
    if (!id || seen.has(id) || !roleMap.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
