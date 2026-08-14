/**
 * 긴 입력(모델 컨텍스트 초과) 처리 파이프라인.
 *
 * 흐름:
 *   1) 전달된 긴 내용을 물리 파일로 저장 (data/longdocs/*.txt — 감사·재현용)
 *   2) 문단 우선으로 청크 분할 (각 청크가 모델 ctx 안에 들어가도록)
 *   3) MAP: 각 청크에서 "사용자 질문에 답하는 데 필요한 내용"을 빠짐없이 추출
 *   4) REDUCE: 부분 결과들을 하나로 종합해 최종 답 생성 (양이 많으면 계층적으로 병합)
 *
 * RAG 검색(관련 청크만 뽑음)과 달리 모든 청크를 반드시 거치므로 내용 누락이 없다.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./pool.js";
import {
  replyLanguageReminder,
  replyLanguageSystemLine,
} from "./replyLanguage.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LONGDOC_DIR = path.join(ROOT, "data", "longdocs");

function truncate(s, max) {
  const t = String(s ?? "");
  return t.length <= max ? t : t.slice(0, max) + "…";
}

/**
 * Qwen 계열 대략 토큰 수 (한글·한자는 토큰을 많이 씀).
 * 정확한 tokenizer 대신 보수적 상한으로 컨텍스트 초과를 미리 피한다.
 */
export function estimateTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  const hangul = (s.match(/[가-힣]/g) || []).length;
  const han = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = Math.max(0, s.length - hangul - han);
  const est = config.tokenEstimate;
  return Math.ceil(hangul * est.hangul + han * est.han + other * est.other);
}

/** 텍스트 길이·추정 토큰으로 긴 입력 여부 판정. 이미지 요청은 제외. */
export function needsLongPipeline(body) {
  const hasImage =
    body?.content !== undefined && body?.content !== null && body?.content !== "";
  if (hasImage) return false;
  const user = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const sys = typeof body?.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "";
  const combined = user + "\n" + sys;
  if (combined.length > config.longTriggerChars) return true;
  return estimateTokens(combined) > config.longTriggerTokens;
}

export function isContextOverflowError(err) {
  const msg = String(err?.message ?? err ?? "");
  return /exceed_context_size|context size|n_prompt_tokens|available context/i.test(
    msg,
  );
}

/** 긴 내용을 물리 파일로 저장하고 {id, file} 반환. */
export async function saveLongContent(text, meta = {}) {
  await fs.mkdir(LONGDOC_DIR, { recursive: true });
  const id =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const file = path.join(LONGDOC_DIR, `${id}.txt`);
  const header =
    meta && Object.keys(meta).length
      ? `# saved ${new Date().toISOString()}\n# ${JSON.stringify(meta)}\n\n`
      : "";
  await fs.writeFile(file, header + String(text ?? ""), "utf-8");
  return { id, file };
}

/**
 * 청크 분할 (무손실).
 * - 먼저 마크다운 헤더(#..) 기준으로 섹션 블록을 나눠, 같은 섹션(제목+본문)이
 *   한 청크에 유지되도록 한다 (제목과 수치가 다른 청크로 갈라지는 문제 방지).
 * - 섹션이 목표 길이를 넘으면 문단 우선 → 그래도 크면 overlap 슬라이딩 윈도우.
 */
export function chunkText(
  text,
  targetChars = config.longChunkChars,
  overlap = config.longChunkOverlap,
) {
  const clean = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const step = Math.max(targetChars - overlap, 1);

  // 헤더 줄(#, ##, …)에서 새 블록을 시작한다 (헤더는 다음 섹션의 시작).
  const blocks = [];
  let curLines = [];
  for (const line of clean.split("\n")) {
    if (/^#{1,6}\s/.test(line) && curLines.some((l) => l.trim())) {
      blocks.push(curLines.join("\n").trim());
      curLines = [];
    }
    curLines.push(line);
  }
  if (curLines.length) blocks.push(curLines.join("\n").trim());

  const chunks = [];
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };

  for (const block of blocks.filter(Boolean)) {
    if (block.length <= targetChars) {
      // 작은 섹션은 목표 길이까지 묶되, 넘치면 새 청크로
      if (buf && (buf + "\n\n" + block).length > targetChars) flush();
      buf = buf ? buf + "\n\n" + block : block;
      continue;
    }
    // 큰 섹션: 문단 우선 → 초대형 문단은 슬라이딩 윈도우
    flush();
    let pbuf = "";
    const pflush = () => {
      const t = pbuf.trim();
      if (t) chunks.push(t);
      pbuf = "";
    };
    for (const p of block.split(/\n{2,}/)) {
      const para = p.trim();
      if (!para) continue;
      if (para.length > targetChars) {
        pflush();
        for (let i = 0; i < para.length; i += step) {
          chunks.push(para.slice(i, i + targetChars));
        }
        continue;
      }
      if (pbuf && (pbuf + "\n\n" + para).length > targetChars) pflush();
      pbuf = pbuf ? pbuf + "\n\n" + para : para;
    }
    pflush();
  }
  flush();
  return chunks;
}

const CODE_UNIT_RE =
  /\n(?=(?:export\s+)?(?:async\s+)?(?:function\s+\w+|class\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?(?:\(|function))| {2,8}(?:async\s+)?(?:static\s+)?[A-Za-z_][\w]*\s*\()/;

/** 함수/클래스 경계를 우선해 코드를 묶는다. 한 함수가 목표를 넘으면 일반 청크. */
export function chunkCode(
  text,
  targetChars = config.longCodeChunkChars,
  overlap = config.longChunkOverlap,
) {
  const clean = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const parts = clean
    .split(CODE_UNIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return chunkText(clean, targetChars, overlap);
  const chunks = [];
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };
  for (const p of parts) {
    if (p.length > targetChars) {
      flush();
      chunks.push(...chunkText(p, targetChars, overlap));
      continue;
    }
    if (buf && buf.length + p.length + 2 > targetChars) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  for (let i = chunks.length - 1; i > 0; i--) {
    if (chunks[i].length >= 200) continue;
    chunks[i - 1] = `${chunks[i - 1]}\n\n${chunks[i]}`;
    chunks.splice(i, 1);
  }
  return chunks;
}

export function looksLikeCode(text) {
  const s = String(text ?? "");
  if (s.length < 400) return false;
  let n = 0;
  if (/```/.test(s)) n += 2;
  if (/\b(?:import|export)\s+/.test(s)) n += 1;
  if (/\bfunction\s+\w+\s*\(/.test(s)) n += 1;
  if (/\bclass\s+\w+/.test(s)) n += 1;
  if (/\bconst\s+\w+\s*=/.test(s)) n += 1;
  return n >= 2;
}

const CODE_REVIEW_ASK =
  "이 소스 코드를 리뷰하라. 버그·동시성·예외처리·설계·성능 문제를 함수/모듈 이름을 들어 구체적으로 지적하라. 일반론·칭찬만으로 끝내지 마라.";

/** 앞의 짧은 요청과 뒤에 붙은 코드/본문을 분리한다. */
export function splitAskAndBody(userQ) {
  const full = String(userQ ?? "");
  const isCode = looksLikeCode(full);
  if (!isCode) {
    return { ask: truncate(full, 800), body: full, isCode: false };
  }
  const fence = full.search(/```/);
  const codeStart = full.search(
    /^(?:import\s+|export\s+|package\s+|from\s+\w+|using\s+|#include\b)/m,
  );
  let cut = -1;
  if (fence >= 0 && fence < 500) cut = fence;
  if (codeStart >= 0 && codeStart < 500 && (cut < 0 || codeStart < cut)) {
    cut = codeStart;
  }
  if (cut > 8) {
    const head = full.slice(0, cut).trim();
    const body = full.slice(cut).trim();
    const looksAsk = /리뷰|검토|review|개선|분석|품질|버그|피드백/i.test(head);
    return {
      ask: looksAsk ? `${head}\n${CODE_REVIEW_ASK}` : CODE_REVIEW_ASK,
      body: body || full,
      isCode: true,
    };
  }
  return { ask: CODE_REVIEW_ASK, body: full, isCode: true };
}

const MAP_SYSTEM_DOC = [
  "너는 긴 문서를 나눠 처리하는 파이프라인의 '추출' 단계다.",
  "주어진 문서 '일부'에서 사용자 요청과 관련된 사실을 하나도 빠짐없이 뽑아라.",
  "특히 숫자·금액·날짜·비율, 사람/조직/부서/제품 등 고유명사는 원문 표현 그대로 반드시 포함하라.",
  "반복되는 일반 설명은 건너뛰되, 구체적 사실이 한 줄이라도 있으면 무조건 추출하라.",
  "간결한 불릿으로 정리하라. 추측·결론은 만들지 마라(다음 단계가 종합).",
  "관련 사실이 전혀 없을 때에만 정확히 '(핵심 없음)' 이라고만 답하라.",
].join("\n");

const MAP_SYSTEM_CODE = [
  "너는 코드 리뷰 파이프라인의 '조각 검토' 단계다. 이 파일의 일부만 본다.",
  "이 조각에서 발견한 문제만 적어라: 버그, 예외 누락, 레이스/동시성, 자원 누수, 잘못된 분기, 보안, API 오용.",
  "각 항목에 함수/메서드/식별자 이름을 반드시 넣고 한 줄 근거를 붙여라.",
  "치명적 문제가 없으면 '역할: (이 조각이 하는 일 한 줄). 이 조각에서 치명적 문제 없음' 만 출력하라.",
  "'(핵심 없음)'이라고 하지 마라. 코드 조각은 항상 리뷰 대상이다.",
  "파일 전체 결론·칭찬·일반론은 쓰지 마라(다음 단계가 종합).",
].join("\n");

function buildMapUser({ ask, sysText, chunk, idx, total, isCode }) {
  return [
    sysText ? `사용자 시스템 지시:\n${truncate(sysText, 400)}` : "",
    `사용자 요청:\n${truncate(ask, 500)}`,
    `${isCode ? "코드" : "문서"} 조각 ${idx + 1}/${total}:\n${chunk}`,
    isCode
      ? "이 조각만 검토한 이슈 목록:"
      : "이 조각에서 요청 수행에 필요한 내용만 추출:",
    replyLanguageReminder(ask, { pipeline: true }),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildReduceMessages({ ask, sysText, partials, isFinal, isCode }) {
  const joined = partials
    .map((p, i) => `--- 조각 ${p.i ?? i + 1} ${isCode ? "리뷰" : "추출"} ---\n${p.text}`)
    .join("\n\n");
  const langLine = replyLanguageSystemLine(ask);
  const system = isFinal
    ? isCode
      ? [
          "너는 시니어 엔지니어다. 아래는 한 파일을 나눠 검토한 메모다.",
          "사용자 요청(코드 리뷰)에 대한 최종 리뷰만 작성하라.",
          "심각도 높은 이슈부터. 함수/모듈 이름을 유지하고 중복은 합쳐라.",
          "파일 구조에 대한 짧은 평가 뒤에, 실행 가능한 지적만 남겨라.",
          "일반론·빈 칭찬·조각 번호는 쓰지 마라.",
          sysText ? `사용자 시스템 지시: ${sysText}` : "",
          langLine,
        ]
          .filter(Boolean)
          .join("\n")
      : [
          "너는 긴 문서 파이프라인의 '종합' 단계다.",
          "아래는 문서 각 부분에서 뽑은 내용이다. 이를 근거로 사용자 요청에 대한 최종 답을 작성하라.",
          sysText ? `사용자 시스템 지시도 반드시 반영: ${sysText}` : "",
          "중복은 합치고 누락 없이 종합하되, 조각 라벨·메타는 답에 쓰지 마라. 완성된 답 본문만 출력하라.",
          langLine,
          "부분 추출 언어가 달라도 최종 답은 사용자 질문과 같은 언어로.",
        ]
          .filter(Boolean)
          .join("\n")
    : isCode
      ? [
          "너는 코드 리뷰 메모를 병합하는 단계다.",
          "이슈를 함수/모듈 이름 기준으로 중복 없이 합쳐라. 심각도 힌트를 유지하라.",
          "최종 총평은 쓰지 마라(다음 단계가 종합).",
          langLine,
        ].join("\n")
      : [
          "너는 긴 문서 파이프라인의 '부분 병합' 단계다.",
          "아래 여러 조각 추출들을 사용자 요청 관점에서 중복 없이 하나로 합쳐라.",
          "정보 손실 없이 요약·정리만 하고, 최종 결론은 만들지 마라(다음 단계가 종합).",
          langLine,
        ].join("\n");
  const langHint = replyLanguageReminder(ask, { pipeline: true });
  const user = [
    `사용자 요청:\n${truncate(ask, 700)}`,
    joined,
    isFinal
      ? isCode
        ? "위 메모를 종합한 최종 코드 리뷰:"
        : "위 추출을 종합한 최종 답:"
      : "위 메모들을 하나로 병합:",
    langHint,
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** partials 를 reduce 입력 상한에 맞춰 그룹으로 묶는다. */
function groupPartials(partials, maxChars) {
  const groups = [];
  let cur = [];
  let len = 0;
  for (const p of partials) {
    const add = p.text.length + 40;
    if (cur.length && len + add > maxChars) {
      groups.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += add;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * 긴 입력 맵리듀스 실행.
 * @param onEvent (ev) => void  — runWorkflow 와 호환되는 plan/step_start/step_done/token 이벤트
 * @returns runWorkflow 와 유사한 { answer, model, tier, device, alias, backend, steps, trace, plan }
 */
/**
 * 1) 물리 파일 저장 + 청크 분할 + 단계 계획(stepsPlan) 수립.
 * plan 이벤트를 방출하고 { saved, chunks, stepsPlan, flowLabel, trace } 반환.
 */
async function prepareLongRun({
  ask,
  bodyText,
  sysText,
  isCode,
  mapTier,
  reduceTier,
  onEvent,
}) {
  const saved = await saveLongContent(bodyText, {
    chars: bodyText.length,
    ask: truncate(ask, 120),
    kind: isCode ? "code" : "doc",
    system: sysText ? truncate(sysText, 120) : undefined,
  });
  const chunks = isCode
    ? chunkCode(bodyText)
    : chunkText(bodyText);
  logger.info(
    `긴 입력 파이프라인: ${bodyText.length}자 ${isCode ? "코드" : "문서"} → ${chunks.length}청크 저장 ${saved.file}`,
  );

  const mapRole = isCode ? "review" : "extract";
  const mapInstr = isCode ? "조각 코드 리뷰" : "핵심 추출";
  const stepsPlan = [
    ...chunks.map((_, i) => ({
      i: i + 1,
      tier: mapTier,
      role: mapRole,
      instruction: `조각 ${i + 1}/${chunks.length} ${mapInstr}`,
    })),
    {
      i: chunks.length + 1,
      tier: reduceTier,
      role: "synthesize",
      instruction: isCode ? "리뷰 메모 종합 → 최종 리뷰" : "부분 결과 종합 → 최종 답",
    },
  ];
  const flowLabel = isCode
    ? `${chunks.length}×${mapTier}(조각리뷰) → ${reduceTier}(최종리뷰)`
    : `${chunks.length}×${mapTier}(추출) → ${reduceTier}(종합)`;

  const trace = [
    {
      kind: "router",
      title: "긴 입력 처리 계획",
      planner: `긴 입력 자동 분할 (${bodyText.length}자/~${estimateTokens(bodyText)}tok, ${isCode ? "코드 리뷰" : "문서"} )`,
      routerTier: null,
      reason: `컨텍스트 초과 방지: ${chunks.length}개 청크로 나눠 맵리듀스 (파일 저장: ${path.basename(saved.file)})`,
      decision: isCode ? "코드 리뷰 맵리듀스" : "청크 맵리듀스",
      flow: flowLabel,
      stepsPlan,
    },
  ];

  onEvent?.({
    type: "plan",
    mode: "workflow",
    reason: `긴 입력 → ${chunks.length}청크 ${isCode ? "코드 리뷰" : "맵리듀스"}`,
    flow: flowLabel,
    steps: stepsPlan.map((s, i) => ({
      i,
      tier: s.tier,
      role: s.role,
      instruction: s.instruction,
    })),
  });

  return { saved, chunks, stepsPlan, flowLabel, trace };
}

/**
 * 2) MAP: 청크별 추출 — 백엔드 여러 대에 분산하도록 제한된 병렬로 실행.
 *    (순차 실행 시 청크가 많으면 전체 시간이 과도해져 타임아웃 위험)
 * 청크 인덱스 순서대로 채워진 stepRecs 배열을 반환.
 */
async function runMapPhase({
  ask,
  sysText,
  chunks,
  mapTier,
  temperature,
  isCode,
  onEvent,
}) {
  const stepRecs = new Array(chunks.length);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(config.longMapConcurrency, chunks.length));
  const mapRole = isCode ? "review" : "extract";
  const mapInstr = isCode ? "조각 코드 리뷰" : "추출";

  async function mapWorker() {
    while (true) {
      const i = cursor++;
      if (i >= chunks.length) break;
      onEvent?.({
        type: "step_start",
        i,
        tier: mapTier,
        role: mapRole,
        instruction: `조각 ${i + 1}/${chunks.length} ${mapInstr}`,
        receivedFrom: {
          label: `${isCode ? "코드" : "문서"} 조각 ${i + 1}/${chunks.length}`,
          preview: truncate(chunks[i], 240),
        },
      });
      const t0 = Date.now();
      let stepRec;
      try {
        const { result, backendUrl, tier, device, alias } = await pool.chat({
          messages: [
            {
              role: "system",
              content: [
                isCode ? MAP_SYSTEM_CODE : MAP_SYSTEM_DOC,
                replyLanguageSystemLine(ask),
                isCode
                  ? "리뷰 메모도 사용자 질문과 같은 언어로."
                  : "추출 결과도 사용자 질문과 같은 언어로.",
              ]
                .filter(Boolean)
                .join("\n"),
            },
            {
              role: "user",
              content: buildMapUser({
                ask,
                sysText,
                chunk: chunks[i],
                idx: i,
                total: chunks.length,
                isCode,
              }),
            },
          ],
          temperature: Math.min(temperature ?? 0.3, 0.3),
          maxTokens: isCode ? Math.max(config.maxTokensSmall, 768) : config.maxTokensSmall,
          preferredTier: mapTier,
          // 맵은 지정 티어에 고정 — large 로 새면 27B 타임아웃이 청크마다 난다
          allowOtherTiers: false,
        });
        const text = String(result.content || "").trim();
        const relevant = isCode
          ? Boolean(text)
          : text && !/^\(?\s*핵심\s*없음\s*\)?[.!\s]*$/.test(text);
        stepRec = {
          kind: "model",
          i: i + 1,
          role: mapRole,
          instruction: `조각 ${i + 1}/${chunks.length} ${mapInstr}`,
          tier,
          device,
          alias,
          backend: backendUrl,
          model: result.raw?.model,
          ms: Date.now() - t0,
          receivedFrom: {
            kind: "doc",
            label: `${isCode ? "코드" : "문서"} 조각 ${i + 1}/${chunks.length}`,
            text: truncate(chunks[i], 2000),
          },
          output: relevant ? text : "관련 없음 (건너뜀)",
          isLast: false,
          _relevant: relevant,
          _text: text,
        };
      } catch (err) {
        logger.warn(`긴 입력 MAP ${i + 1}/${chunks.length} 실패: ${err.message}`);
        stepRec = {
          kind: "model",
          i: i + 1,
          role: mapRole,
          instruction: `조각 ${i + 1}/${chunks.length} ${mapInstr}`,
          tier: mapTier,
          ms: Date.now() - t0,
          receivedFrom: {
            kind: "doc",
            label: `${isCode ? "코드" : "문서"} 조각 ${i + 1}/${chunks.length}`,
            text: truncate(chunks[i], 2000),
          },
          output: `추출 실패: ${err.message}`,
          isLast: false,
          _relevant: false,
          _text: "",
        };
      }
      stepRecs[i] = stepRec;
      onEvent?.({
        type: "step_done",
        i,
        tier: stepRec.tier,
        role: mapRole,
        device: stepRec.device,
        alias: stepRec.alias,
        backend: stepRec.backend,
        instruction: stepRec.instruction,
        preview: truncate(stepRec.output, 240),
        output: stepRec.output,
        ms: stepRec.ms,
        isLast: false,
      });
      logger.info(
        `긴 입력 MAP ${i + 1}/${chunks.length} @${stepRec.tier}/${stepRec.device ?? "-"} ${stepRec.ms}ms${stepRec._relevant ? "" : " (관련없음)"}`,
      );
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => mapWorker()));
  return stepRecs;
}

/**
 * MAP 결과를 청크 순서대로 trace 에 넣고, 관련 있는 조각만 partials 로 뽑는다.
 * (병렬이라 완료 순서가 섞였을 수 있어 인덱스 순으로 재구성)
 * 전 조각이 '관련 없음'이면 원문 앞부분으로 최소 1건을 만든다.
 */
function collectPartials(stepRecs, chunks, trace, fallbackText, isCode) {
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    const rec = stepRecs[i];
    if (!rec) continue;
    trace.push(rec);
    if (rec._relevant) partials.push({ i: i + 1, text: rec._text });
    delete rec._relevant;
    delete rec._text;
  }
  if (!partials.length) {
    partials.push({
      i: 1,
      text: truncate(fallbackText, config.longReduceInputChars),
    });
  }
  return partials;
}

async function runReducePhase({ ask, sysText, partials, reduceTier, isCode }) {
  const maxChars = isCode
    ? config.longCodeReduceInputChars
    : config.longReduceInputChars;
  // 중간 병합은 medium 고정 — 27B 에 여러 번 넣으면 타임아웃 후 7B 로 떨어진다
  const mergeWanted = isCode ? "medium" : reduceTier;
  const mergeTier = pool.resolveSolveTier(mergeWanted);
  let level = partials;
  let round = 0;
  while (
    level.map((p) => p.text).join("\n").length > maxChars &&
    level.length > 1
  ) {
    round++;
    const groups = groupPartials(level, maxChars);
    if (groups.length >= level.length) break;
    const merged = [];
    for (let g = 0; g < groups.length; g++) {
      const { result } = await pool.chat({
        messages: buildReduceMessages({
          ask,
          sysText,
          partials: groups[g],
          isFinal: false,
          isCode,
        }),
        temperature: 0.3,
        maxTokens: config.defaultMaxTokens,
        preferredTier: mergeTier,
        allowOtherTiers: false,
      });
      merged.push({ i: g + 1, text: String(result.content || "").trim() });
    }
    logger.info(
      `긴 입력 REDUCE 라운드 ${round}: ${level.length}→${merged.length} 그룹 병합 @${mergeTier}`,
    );
    level = merged;
  }
  return level;
}

/**
 * 4) 최종 종합 (onEvent 있으면 스트리밍, 없으면 단발).
 * { last, finalIdx } 반환.
 */
async function runFinalSynthesis({
  ask,
  sysText,
  level,
  reduceTier,
  temperature,
  stepsPlan,
  isCode,
  onEvent,
}) {
  const cap = isCode ? 3500 : config.longReduceInputChars;
  let notes = level;
  const joinedLen = notes.map((p) => p.text).join("\n").length;
  if (joinedLen > cap && notes.length) {
    const per = Math.max(400, Math.floor(cap / notes.length));
    notes = notes.map((p) => ({ ...p, text: truncate(p.text, per) }));
    logger.info(
      `긴 입력 최종 입력 축소: ${joinedLen}자 → 조각당 ${per}자 (${notes.length}개)`,
    );
  }

  const reduceMessages = buildReduceMessages({
    ask,
    sysText,
    partials: notes,
    isFinal: true,
    isCode,
  });
  const finalIdx = stepsPlan.length - 1;
  onEvent?.({
    type: "step_start",
    i: finalIdx,
    tier: reduceTier,
    role: "synthesize",
    instruction: isCode ? "리뷰 메모 종합 → 최종 리뷰" : "부분 결과 종합 → 최종 답",
    receivedFrom: {
      label: `부분 ${isCode ? "리뷰" : "추출"} ${notes.length}개`,
      preview: truncate(notes.map((p) => p.text).join(" / "), 240),
    },
  });

  const t0 = Date.now();
  const common = {
    messages: reduceMessages,
    temperature: Math.min(temperature ?? 0.5, 0.5),
    maxTokens: isCode ? Math.min(config.defaultMaxTokens, 1536) : config.defaultMaxTokens,
    enableThinking: false,
    preferredTier: reduceTier,
    allowOtherTiers: false,
    timeoutMs: 180000,
  };

  async function runOnce(msgs) {
    if (onEvent) {
      const out = await pool.chatStream({
        ...common,
        messages: msgs,
        onMeta: (m) => onEvent({ type: "step_meta", i: finalIdx, ...m }),
        onToken: (t) => onEvent({ type: "token", text: t, i: finalIdx }),
      });
      return {
        content: out.content,
        reasoning: out.reasoning,
        tier: out.tier,
        device: out.device,
        alias: out.alias,
        backend: out.backendUrl,
        model: out.model,
        usage: out.usage,
        ttftMs: out.ttftMs,
        totalMs: out.totalMs,
        tokenCount: out.tokenCount,
      };
    }
    const { result, backendUrl, tier, device, alias } = await pool.chat({
      ...common,
      messages: msgs,
    });
    return {
      content: result.content,
      reasoning: result.reasoning,
      tier,
      device,
      alias,
      backend: backendUrl,
      model: result.raw?.model,
      usage: result.raw?.usage,
      totalMs: Date.now() - t0,
    };
  }

  let last;
  try {
    last = await runOnce(reduceMessages);
  } catch (err) {
    logger.warn(`긴 입력 최종 @${reduceTier} 실패 → 입력 축소 재시도: ${err.message}`);
    const tighter = notes.map((p) => ({ ...p, text: truncate(p.text, 400) }));
    last = await runOnce(
      buildReduceMessages({
        ask,
        sysText,
        partials: tighter,
        isFinal: true,
        isCode,
      }),
    );
  }

  return { last, finalIdx, notes };
}

/**
 * 긴 입력 맵리듀스 실행 (오케스트레이터).
 * @param onEvent (ev) => void  — runWorkflow 와 호환되는 plan/step_start/step_done/token 이벤트
 * @returns runWorkflow 와 유사한 { answer, model, tier, device, alias, backend, steps, trace, plan }
 */
export async function runLongContent({ body, temperature, onEvent }) {
  const started = Date.now();
  const userQ = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const sysText =
    typeof body?.ROLE_SYSTEM === "string" && body.ROLE_SYSTEM.trim()
      ? body.ROLE_SYSTEM.trim()
      : "";
  const { ask, body: bodyText, isCode } = splitAskAndBody(userQ);
  const mapWanted = config.longMapTier;
  const reduceWanted = config.longReduceTier;
  const mapTier = pool.resolveSolveTier(mapWanted);
  const reduceTier = pool.resolveSolveTier(reduceWanted);
  if (mapTier !== mapWanted) {
    logger.info(
      `긴 입력 맵 티어 ${mapWanted} → ${mapTier} (해결 풀: ${pool.solvePoolLabel()})`,
    );
  }
  if (reduceTier !== reduceWanted) {
    logger.info(
      `긴 입력 종합 티어 ${reduceWanted} → ${reduceTier} (해결 풀: ${pool.solvePoolLabel()})`,
    );
  }

  const { saved, chunks, stepsPlan, trace } = await prepareLongRun({
    ask,
    bodyText,
    sysText,
    isCode,
    mapTier,
    reduceTier,
    onEvent,
  });

  const stepRecs = await runMapPhase({
    ask,
    sysText,
    chunks,
    mapTier,
    temperature,
    isCode,
    onEvent,
  });
  const partials = collectPartials(
    stepRecs,
    chunks,
    trace,
    isCode ? ask : userQ,
    isCode,
  );

  const level = await runReducePhase({
    ask,
    sysText,
    partials,
    reduceTier,
    isCode,
  });

  const { last, finalIdx, notes } = await runFinalSynthesis({
    ask,
    sysText,
    level,
    reduceTier,
    temperature,
    stepsPlan,
    isCode,
    onEvent,
  });

  const finalRec = {
    kind: "model",
    i: stepsPlan.length,
    role: "synthesize",
    instruction: isCode ? "리뷰 메모 종합 → 최종 리뷰" : "부분 결과 종합 → 최종 답",
    tier: last.tier,
    device: last.device,
    alias: last.alias,
    backend: last.backend,
    model: last.model,
    ms: last.totalMs,
    receivedFrom: {
      kind: "model",
      label: `부분 ${isCode ? "리뷰" : "추출"} ${(notes || level).length}개`,
      text: truncate((notes || level).map((p) => p.text).join("\n\n"), 2000),
    },
    output: last.content,
    isLast: true,
  };
  trace.push(finalRec);
  onEvent?.({
    type: "step_done",
    i: finalIdx,
    tier: last.tier,
    role: "synthesize",
    device: last.device,
    alias: last.alias,
    backend: last.backend,
    model: last.model,
    instruction: finalRec.instruction,
    preview: truncate(last.content, 240),
    output: last.content,
    ms: last.totalMs,
    isLast: true,
  });

  const plan = {
    mode: "workflow",
    tier: last.tier || reduceTier,
    difficulty: 100,
    reason: `긴 입력 → ${chunks.length}청크 ${isCode ? "코드 리뷰" : "맵리듀스"}`,
    steps: stepsPlan.map((s) => ({
      tier: s.tier,
      role: s.role,
      instruction: s.instruction,
    })),
    longContent: true,
    savedFile: saved.file,
  };

  logger.info(
    `긴 입력 파이프라인 완료: ${chunks.length}청크 ${isCode ? "코드리뷰" : ""} → 최종 @${last.tier}/${last.device ?? "-"} ${Date.now() - started}ms`,
  );

  return {
    answer: last.content ?? "",
    reasoning: last.reasoning,
    model: last.model ?? config.modelName,
    tier: last.tier,
    device: last.device,
    alias: last.alias,
    backend: last.backend,
    usage: last.usage ?? null,
    ttftMs: last.ttftMs ?? null,
    totalMs: last.totalMs ?? null,
    tokens: last.usage?.completion_tokens ?? last.tokenCount,
    steps: trace.filter((n) => n.kind === "model"),
    trace,
    plan,
  };
}
