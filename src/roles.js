/**
 * 공통 역할 카탈로그 (roles.json).
 * 모델(서버)에는 roleIds 로 입히고, 서버별 skills 는 커스텀 역할이다.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ROLES_FILE = path.join(ROOT, "roles.json");
const NAME_MAX = 40;
const DESC_MAX = 200;

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
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || null,
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

export async function createRole({ name, description } = {}) {
  const roles = await loadRoles();
  const role = sanitizeRole({
    id: newId(),
    name,
    description,
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
  const next = sanitizeRole({
    ...prev,
    name: Object.prototype.hasOwnProperty.call(patch, "name")
      ? patch.name
      : prev.name,
    description: Object.prototype.hasOwnProperty.call(patch, "description")
      ? patch.description
      : prev.description,
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
