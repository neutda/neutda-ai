import "dotenv/config";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRolesSync, resolveServerRoles } from "./roles.js";
import {
  loadSecurityPoliciesSync,
  resolveServerSecurity,
  securityPoliciesById,
} from "./securityPolicies.js";
import { serverHost, serverUrl } from "./serverUrl.js";
import { osMode, isWindows, isLinux } from "./platform.js";

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeUrl(u) {
  return u.trim().replace(/\/+$/, "");
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 특기 텍스트 최대 길이 (라우터 프롬프트에 들어가므로 적당히 제한) */
export const SKILL_MAX_CHARS = 200;
/** 서버당 특기 최대 개수 */
export const SKILL_MAX_COUNT = 8;

/**
 * 특기(자유 텍스트) 한 줄 정규화.
 * 이 텍스트가 곧 백엔드를 묶는 키라서, 공백 차이로 같은 특기가 두 풀로
 * 쪼개지지 않도록 연속 공백을 1칸으로 맞춘다.
 */
export function normalizeSkill(value) {
  const t = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, SKILL_MAX_CHARS) : null;
}

/**
 * 특기 목록 정규화.
 * 배열·단일 문자열·구형 `skill` 필드를 모두 받아 중복 없는 배열로 만든다.
 */
export function normalizeSkills(value) {
  const raw = Array.isArray(value)
    ? value
    : value == null || value === ""
      ? []
      : [value];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const s = normalizeSkill(v);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= SKILL_MAX_COUNT) break;
  }
  return out;
}

/** servers.json 항목에서 커스텀 특기만 읽기 (구형 skill 호환) */
export function customSkillsFromDef(def) {
  if (!def || typeof def !== "object") return [];
  if (Array.isArray(def.skills) || def.skills != null) {
    return normalizeSkills(def.skills);
  }
  return normalizeSkills(def.skill);
}

/** @deprecated customSkillsFromDef 사용 */
export function skillsFromDef(def) {
  return customSkillsFromDef(def);
}

/**
 * servers.json 의 llmServers 를 풀 스펙으로 변환.
 * Express 백엔드 목록의 기준 소스 (npm run up / 모니터 추가·삭제와 동일).
 * 공통 역할은 roles.json 의 roleIds 로 해석한다.
 */
function backendsFromServersJson() {
  const file = path.join(ROOT, "servers.json");
  if (!existsSync(file)) return null;
  try {
    const roleMap = new Map(loadRolesSync().map((r) => [r.id, r]));
    const policyMap = securityPoliciesById(loadSecurityPoliciesSync());
    const cfg = JSON.parse(readFileSync(file, "utf-8"));
    const list = Array.isArray(cfg.llmServers) ? cfg.llmServers : [];
    if (!list.length) return null;
    const tierRank = { large: 0, medium: 1, small: 2 };
    const sorted = [...list].sort((a, b) => {
      const ta = tierRank[String(a.tier).toLowerCase()] ?? 9;
      const tb = tierRank[String(b.tier).toLowerCase()] ?? 9;
      if (ta !== tb) return ta - tb;
      const ga = Number(a.ngl) > 0 ? 0 : 1;
      const gb = Number(b.ngl) > 0 ? 0 : 1;
      if (ga !== gb) return ga - gb;
      return Number(a.port) - Number(b.port);
    });
    const seen = new Set();
    const out = [];
    for (const s of sorted) {
      const port = Number(s.port);
      if (!Number.isFinite(port) || port <= 0) continue;
      const host = serverHost(s);
      const url = serverUrl({ host, port });
      if (seen.has(url)) continue;
      seen.add(url);
      const tier = String(s.tier || "large").toLowerCase();
      const resolved = resolveServerRoles(s, roleMap);
      const sec = resolveServerSecurity(s, policyMap);
      out.push({
        url,
        host,
        port,
        tier: tier === "router" ? "small" : tier,
        device: Number(s.ngl) > 0 ? "gpu" : "cpu",
        alias: (s.alias && String(s.alias).trim()) || s.name || null,
        roleIds: resolved.roleIds,
        customSkills: resolved.customSkills,
        skills: resolved.skills,
        skill: resolved.skills[0] ?? null,
        solve:
            s.solve !== false &&
            s.solve !== "false" &&
            s.solve !== 0 &&
            s.chat !== false &&
            s.chat !== "false" &&
            s.chat !== 0,
        router: s.router === true || s.router === "true" || s.router === 1,
        planner:
            s.planner === true ||
            s.planner === "true" ||
            s.planner === 1 ||
            s.pipeline === true,
        embedding:
            s.embedding === true ||
            s.embedding === "true" ||
            s.embedding === 1,
        security:
            s.security === true ||
            s.security === "true" ||
            s.security === 1,
        securityIds: sec.securityIds,
        securityPolicy: sec.securityPolicyText,
        ctx: Number(s.ctx) > 0 ? Number(s.ctx) : 4096,
        vision: Boolean(s.mmproj && String(s.mmproj).trim()),
      });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

function backendsFromEnvTagged(tagged) {
  const seen = new Set();
  const out = [];
  for (const part of tagged.split(",")) {
    const token = part.trim();
    if (!token) continue;
    // 형식: "tier@url" 또는 "tier@url@device"(device=gpu|cpu)
    const segs = token.split("@");
    let tier = "large";
    let url = token;
    let device = null;
    if (segs.length >= 2) {
      tier = segs[0].trim().toLowerCase() || "large";
      if (tier === "router") tier = "small"; // 구설정 호환: router 는 티어가 아님
      const last = segs[segs.length - 1].trim().toLowerCase();
      if (segs.length >= 3 && (last === "gpu" || last === "cpu")) {
        device = last;
        url = segs.slice(1, -1).join("@");
      } else {
        url = segs.slice(1).join("@");
      }
    }
    url = normalizeUrl(url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, tier, device });
  }
  return out;
}

// 백엔드 목록을 [{ url, tier, device }] 형태로 파싱한다.
// 우선순위: servers.json > LLAMA_BACKENDS > LLAMA_SERVERS / LLAMA_SERVER_URL > 기본값
// (.env 의 LLAMA_BACKENDS 가 예전에 4개로 고정돼 있어도 servers.json 전체가 풀에 등록됨)
function parseBackends() {
  const fromJson = backendsFromServersJson();
  if (fromJson) return fromJson;

  const tagged = process.env.LLAMA_BACKENDS;
  if (tagged) {
    const out = backendsFromEnvTagged(tagged);
    if (out.length) return out;
  }
  const raw = process.env.LLAMA_SERVERS || process.env.LLAMA_SERVER_URL || "http://127.0.0.1:8080";
  const seen = new Set();
  return raw
    .split(",")
    .map(normalizeUrl)
    .filter((u) => u && !seen.has(u) && seen.add(u))
    .map((url) => ({ url, tier: "large" }));
}

export const allBackendSpecs = parseBackends();

const routingModeRaw = (process.env.ROUTING_MODE || "llm").toLowerCase();
const routingMode =
  routingModeRaw === "heuristic" || routingModeRaw === "llm" || routingModeRaw === "hybrid"
    ? routingModeRaw
    : "llm";

export const config = {
  /** LINUX | WINDOW — .env OS=… (serve·agent 프로세스 제어 분기) */
  osMode,
  isWindows,
  isLinux,
  port: num(process.env.PORT, 3000),
  backends: allBackendSpecs,
  // llama-server 바인드 호스트. 단일 머신은 127.0.0.1(기본).
  // 하위 관리서버(agent)로 분산 시 부모가 접근하도록 0.0.0.0 으로 띄운다.
  llamaBindHost: process.env.LLAMA_BIND_HOST || "127.0.0.1",
  // llama-server 기본 동시 처리 슬롯 수(continuous batching). 외부 API 로
  // 동시에 여러 요청이 들어와도 한 인스턴스가 병렬 처리하도록 기본 4.
  // 요청당 컨텍스트는 유지(총 컨텍스트 = ctx × slots) → KV VRAM 이 slots 배로 증가.
  // 서버별 servers.json 의 "parallel" 로 개별 지정 가능.
  llamaParallel: Math.max(1, num(process.env.LLAMA_PARALLEL, 4)),
  // 하위 관리서버(agent) 폴링 — 부모가 각 agent 의 metrics/health 를 확인하는 주기
  agentPollIntervalMs: num(process.env.AGENT_POLL_INTERVAL_MS, 5000),
  // 이 횟수만큼 연속 폴링 실패하면 해당 agent 를 down 으로 표시
  agentDownAfterMisses: num(process.env.AGENT_DOWN_AFTER_MISSES, 3),
  // agent 폴링 1회 요청 타임아웃
  agentRequestTimeoutMs: num(process.env.AGENT_REQUEST_TIMEOUT_MS, 4000),
  // [하위 관리서버(agent) 실행 설정] `npm run agent` 이 읽는다.
  // host/port/부모주소는 소스에 박지 않고 .env 로 지정한다.
  agent: {
    // 등록할 부모 관리서버 URL
    parentUrl: normalizeUrl(process.env.PARENT_URL || "http://127.0.0.1:3000"),
    // 이 agent 식별자 (미지정 시 머신 hostname)
    id: (process.env.AGENT_ID || os.hostname()).trim(),
    // 이 agent 가 listen 할 포트
    port: num(process.env.AGENT_PORT, 4100),
    // 부모가 이 머신(agent·llama)에 접속할 주소. 비우면:
    //   PARENT_URL 이 localhost → 127.0.0.1 (한 머신 serve+agent)
    //   원격 부모 → LAN IP 자동 감지
    host: (process.env.AGENT_HOST || "").trim(),
    // 부모 재등록(heartbeat) 주기
    heartbeatMs: num(process.env.AGENT_HEARTBEAT_MS, 5000),
    // 부팅 시 로컬 llama 서버 자동 기동 여부
    autostart:
      String(process.env.AGENT_AUTOSTART ?? "false").toLowerCase() === "true",
    // 단일 서버 모드(npm run solo): 부모+에이전트를 한 프로세스로. 자체 재시작은 재등록으로 대체.
    solo:
      process.env.SOLO === "1" ||
      String(process.env.SOLO ?? "").toLowerCase() === "true",
  },
  // 시작 시 라우터 역할을 켤 백엔드 URL (모니터에서도 변경 가능). tier 와 무관.
  routerBackendUrl: process.env.ROUTER_BACKEND_URL
    ? normalizeUrl(process.env.ROUTER_BACKEND_URL)
    : null,
  routingMode,
  routerTemperature: num(process.env.ROUTER_TEMPERATURE, 0.1),
  routerMaxTokens: num(process.env.ROUTER_MAX_TOKENS, 128),
  modelName: process.env.MODEL_NAME || "qwen",
  // 어시스턴트 정체성 (이름 질문·단답 시 환각 방지)
  assistantName: process.env.ASSISTANT_NAME || "neutda-ai (뉴트다)",
  assistantIdentity:
    process.env.ASSISTANT_IDENTITY ||
    "You are neutda-ai (뉴트다), a local multi-model AI assistant. Your name is neutda-ai / 뉴트다. Never invent another name from the user's words. Do not echo or rephrase the question as the answer.",
  // 외부 API 키(우선 고정값). .env 의 API_KEY 로 덮어쓸 수 있음
  apiKey: process.env.API_KEY || "tw-demo-key-2026",
  defaultTemperature: num(process.env.DEFAULT_TEMPERATURE, 0.7),
  // 언어 드리프트 방지(Qwen 계열이 한국어 질문에 중국어로 답하는 문제).
  // 사용자 노출 답변의 시스템 프롬프트에 아래 지시를 주입한다.
  enforceLanguage:
    String(process.env.ENFORCE_LANGUAGE ?? "true").toLowerCase() === "true",
  langDirective:
    process.env.REPLY_LANGUAGE_DIRECTIVE ||
    "Reply in the same language as the user's question. Do not switch languages. Korean question → Korean only (not Chinese). English question → English only. Chinese question → Chinese only.",
  defaultMaxTokens: num(process.env.DEFAULT_MAX_TOKENS, 2048),
  // 컨텍스트 초과 방지: 티어별 max_tokens 와 프롬프트(시스템+히스토리+질문) 글자수 상한
  // small/medium 은 ctx 4096 가정 → 보수적으로 제한, large 는 ctx 8192 가정
  maxTokensSmall: num(process.env.MAX_TOKENS_SMALL, 1024),
  maxPromptCharsSmall: num(process.env.MAX_PROMPT_CHARS_SMALL, 1800),
  maxPromptCharsLarge: num(process.env.MAX_PROMPT_CHARS_LARGE, 3500),
  requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 120000),
  // 스트리밍 유휴 타임아웃: 마지막 데이터 수신 후 이 시간(ms) 동안 무응답이면 중단.
  // (전체 시간 캡이 아니라 유휴 기준 — 긴 답변 생성이 도중에 잘리지 않도록)
  streamIdleTimeoutMs: num(process.env.STREAM_IDLE_TIMEOUT_MS, 120000),
  // Qwen3.6 는 thinking(추론) 모델. 기본은 끔(직접 답변). 켜면 추론에 토큰을 많이 사용.
  enableThinking: String(process.env.ENABLE_THINKING).toLowerCase() === "true",
  // 풀/로드밸런서 설정
  healthIntervalMs: num(process.env.HEALTH_INTERVAL_MS, 5000),
  maxRetries: num(process.env.MAX_RETRIES, 2),
  // 라우팅 설정
  defaultTier: (process.env.DEFAULT_TIER || "small").toLowerCase(),
  escalateTier: String(process.env.ESCALATE_TIER ?? "true").toLowerCase() === "true",
  // 멀티모델 워크플로우: auto=일반(라우터 판단), on=파이프라인 강제, off=단일만
  // 콘솔 "파이프라인 강제사용" 체크 시 요청마다 on 으로 덮어씀
  workflowMode: ["auto", "on", "off"].includes(
    String(process.env.WORKFLOW_MODE || "auto").toLowerCase(),
  )
    ? String(process.env.WORKFLOW_MODE || "auto").toLowerCase()
    : "auto",
  // 휴리스틱 임계값(글자수): smallMaxChars 이하=small, 그 사이=medium, largeMinChars 초과=large
  smallMaxChars: num(process.env.SMALL_MAX_CHARS, 200),
  largeMinChars: num(process.env.LARGE_MIN_CHARS, 600),
  // 난이도 점수(0~100)가 이 값 이상이면 같은 티어 내에서 GPU 백엔드 선호
  gpuMinDifficulty: num(process.env.GPU_MIN_DIFFICULTY, 50),
  // 긴 입력(컨텍스트 초과) 처리: medium ctx 4096 기준으로 보수적 분할
  // (예전 9000자는 한글 토큰 밀도상 medium 에 들어가 400 에러가 났음)
  longTriggerChars: num(process.env.LONG_TRIGGER_CHARS, 3200),
  // 추정 토큰이 이 값을 넘어도 맵리듀스 (시스템·지시 여유 포함)
  longTriggerTokens: num(process.env.LONG_TRIGGER_TOKENS, 3000),
  // 청크 하나의 목표 글자수(맵 입력이 medium ctx 4096 을 넘지 않도록)
  longChunkChars: num(process.env.LONG_CHUNK_CHARS, 1800),
  // 청크 간 겹침(문맥 보존)
  longChunkOverlap: num(process.env.LONG_CHUNK_OVERLAP, 180),
  // 리듀스(병합) 1회 입력 상한 — 넘으면 계층적으로 나눠 병합 (large ctx 8192 안에서)
  longReduceInputChars: num(process.env.LONG_REDUCE_INPUT_CHARS, 4500),
  // 맵 단계 티어(청크별 추출) / 리듀스 단계 티어(종합)
  longMapTier: (process.env.LONG_MAP_TIER || "medium").toLowerCase(),
  longReduceTier: (process.env.LONG_REDUCE_TIER || "large").toLowerCase(),
  // 맵 단계 병렬 처리 개수 (여러 백엔드에 분산 — 너무 크면 백엔드 과부하)
  longMapConcurrency: num(process.env.LONG_MAP_CONCURRENCY, 4),
  // 채팅 요청 큐: solve 슬롯이 가득이면 대기(바로 오류 내지 않음).
  // CHAT_MAX_INFLIGHT=0(기본·미지정) → 자동: 건강한 solve 수 × LLAMA_PARALLEL
  // (llama --parallel 과 맞춰 슬롯이 비면 바로 보냄. 인위적으로 2로 조이지 않음)
  // 양의 정수면 그 값으로 상한(여전히 solve×parallel 을 넘지 않음).
  chatMaxInFlight: (() => {
    const raw = process.env.CHAT_MAX_INFLIGHT;
    if (raw === undefined || String(raw).trim() === "") return 0;
    return Math.max(0, num(raw, 0));
  })(),
  chatQueueMax: Math.max(0, num(process.env.CHAT_QUEUE_MAX, 10)),
  // 큐에서 슬롯을 기다리는 최대 시간 (기본 = REQUEST_TIMEOUT)
  chatQueueWaitMs: num(
    process.env.CHAT_QUEUE_WAIT_MS,
    num(process.env.REQUEST_TIMEOUT_MS, 120000),
  ),
  // 슬롯 인지 라우팅: large 포화 시 중간 난이도를 medium 으로 강등
  loadAware: (() => {
    const raw = String(process.env.LOAD_AWARE || "on").trim().toLowerCase();
    return raw !== "off" && raw !== "0" && raw !== "false";
  })(),
  // 이 난이도 미만만 large→medium 강등 허용 (이상이면 large 대기)
  loadDemoteMaxDifficulty: Math.min(
    100,
    Math.max(0, num(process.env.LOAD_DEMOTE_MAX_DIFFICULTY, 75)),
  ),
};
