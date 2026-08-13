/**
 * 보안 정책 카탈로그 (security.json).
 * 보안검증(fixed role)이 켜진 모델에만 securityIds 로 입힌다.
 * 최종 답변 직전 보안검증 단계에서 정책 본문을 사용한다.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "security.json");
const NAME_MAX = 40;
const DESC_MAX = 200;
const BODY_MAX = 6000;

function newId() {
  return (
    "s_" +
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

function normalizeBody(value) {
  const t = String(value ?? "").trim();
  return t ? t.slice(0, BODY_MAX) : "";
}

function sanitizePolicy(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = normalizeName(raw.name);
  if (!name) return null;
  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim().slice(0, 40)
      : newId();
  const body = normalizeBody(
    raw.body ?? raw.policy ?? raw.text ?? raw.description ?? "",
  );
  return {
    id,
    name,
    description: normalizeDesc(raw.description ?? ""),
    body,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || null,
  };
}

export function loadSecurityPoliciesSync() {
  return loadSecurityConfigSync().policies;
}

/** @returns {{ enabled: boolean, policies: object[] }} */
export function loadSecurityConfigSync() {
  if (!existsSync(FILE)) return { enabled: true, policies: [] };
  try {
    const cfg = JSON.parse(readFileSync(FILE, "utf-8"));
    const list = Array.isArray(cfg?.policies)
      ? cfg.policies
      : Array.isArray(cfg?.roles)
        ? cfg.roles
        : Array.isArray(cfg)
          ? cfg
          : [];
    const out = [];
    const seen = new Set();
    for (const r of list) {
      const p = sanitizePolicy(r);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
    return {
      // 기본 ON. enabled: false 로만 전체 게이트 끔
      enabled: cfg?.enabled !== false,
      policies: out,
    };
  } catch {
    return { enabled: true, policies: [] };
  }
}

/** 보안검증 게이트 전역 스위치 */
export function isSecurityEnabledSync() {
  return loadSecurityConfigSync().enabled;
}

export async function setSecurityEnabled(enabled) {
  const cfg = loadSecurityConfigSync();
  cfg.enabled = Boolean(enabled);
  await saveConfig(cfg);
  return cfg.enabled;
}

export async function loadSecurityPolicies() {
  return loadSecurityPoliciesSync();
}

async function savePolicies(policies) {
  const cfg = loadSecurityConfigSync();
  await saveConfig({ enabled: cfg.enabled, policies });
}

async function saveConfig({ enabled, policies }) {
  await mkdir(path.dirname(FILE), { recursive: true });
  const body =
    JSON.stringify(
      {
        enabled: enabled !== false,
        policies: Array.isArray(policies) ? policies : [],
      },
      null,
      4,
    ) + "\n";
  await writeFile(FILE, body, "utf-8");
}

export function securityPoliciesById(policies = loadSecurityPoliciesSync()) {
  return new Map(policies.map((p) => [p.id, p]));
}

/** securityIds 정규화 */
export function normalizeSecurityIds(
  value,
  policyMap = securityPoliciesById(),
) {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const id = String(v ?? "").trim();
    if (!id || seen.has(id) || !policyMap.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 서버 정의 → 배정된 보안 정책 + 검사에 쓸 본문 텍스트.
 * body 가 비어 있으면 description 을 쓴다. 구형 securityPolicy 문자열도 병합.
 */
export function resolveServerSecurity(
  def,
  policyMap = securityPoliciesById(),
) {
  const securityIds = normalizeSecurityIds(def?.securityIds, policyMap);
  const policies = securityIds
    .map((id) => policyMap.get(id))
    .filter(Boolean);
  const parts = [];
  for (const p of policies) {
    const text = (p.body || p.description || "").trim();
    if (!text) continue;
    parts.push(`【${p.name}】\n${text}`);
  }
  const legacy = String(def?.securityPolicy ?? "").trim();
  if (legacy && !parts.some((x) => x.includes(legacy))) {
    parts.push(legacy);
  }
  return {
    securityIds,
    policies,
    securityPolicyText: parts.join("\n\n").trim(),
  };
}

export async function createSecurityPolicy({
  name,
  description,
  body,
} = {}) {
  const policies = await loadSecurityPolicies();
  const policy = sanitizePolicy({
    id: newId(),
    name,
    description,
    body: body ?? description,
    createdAt: new Date().toISOString(),
  });
  if (!policy) throw new Error("보안 정책 이름(name)을 입력하세요.");
  if (!policy.body) {
    throw new Error("보안 내역(본문)을 입력하세요.");
  }
  if (policies.some((p) => p.name === policy.name)) {
    throw new Error(`이미 같은 이름의 보안 정책이 있습니다: "${policy.name}"`);
  }
  policies.push(policy);
  await savePolicies(policies);
  return policy;
}

export async function updateSecurityPolicy(id, patch = {}) {
  const policies = await loadSecurityPolicies();
  const idx = policies.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const prev = policies[idx];
  const next = sanitizePolicy({
    ...prev,
    name: Object.prototype.hasOwnProperty.call(patch, "name")
      ? patch.name
      : prev.name,
    description: Object.prototype.hasOwnProperty.call(patch, "description")
      ? patch.description
      : prev.description,
    body: Object.prototype.hasOwnProperty.call(patch, "body")
      ? patch.body
      : Object.prototype.hasOwnProperty.call(patch, "policy")
        ? patch.policy
        : prev.body,
    id: prev.id,
    createdAt: prev.createdAt,
    updatedAt: new Date().toISOString(),
  });
  if (!next) throw new Error("보안 정책 이름(name)을 입력하세요.");
  if (!next.body) throw new Error("보안 내역(본문)을 입력하세요.");
  if (policies.some((p, i) => i !== idx && p.name === next.name)) {
    throw new Error(`이미 같은 이름의 보안 정책이 있습니다: "${next.name}"`);
  }
  policies[idx] = next;
  await savePolicies(policies);
  return next;
}

export async function deleteSecurityPolicy(id) {
  const policies = await loadSecurityPolicies();
  const idx = policies.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  policies.splice(idx, 1);
  await savePolicies(policies);
  return true;
}
