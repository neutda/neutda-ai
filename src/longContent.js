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

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LONGDOC_DIR = path.join(ROOT, "data", "longdocs");

/** 역할 관리의 «요약» 특기가 있으면 맵리듀스에서 선호 */
function summarizeSkill() {
  const hit = pool
    .skillOptions()
    .find((s) => /요약|summar/i.test(String(s?.skill ?? "")));
  return hit?.skill ?? null;
}

function truncate(s, max) {
  const t = String(s ?? "");
  return t.length <= max ? t : t.slice(0, max) + "…";
}

/** 텍스트 길이(문자)로 긴 입력 여부 판정. 이미지 요청은 제외. */
export function needsLongPipeline(body) {
  const hasImage =
    body?.content !== undefined && body?.content !== null && body?.content !== "";
  if (hasImage) return false;
  const user = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const sys = typeof body?.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "";
  return user.length + sys.length > config.longTriggerChars;
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

const MAP_SYSTEM = [
  "너는 긴 문서를 나눠 처리하는 파이프라인의 '추출' 단계다.",
  "주어진 문서 '일부'에서 사용자 요청과 관련된 사실을 하나도 빠짐없이 뽑아라.",
  "특히 숫자·금액·날짜·비율, 사람/조직/부서/제품 등 고유명사는 원문 표현 그대로 반드시 포함하라.",
  "반복되는 일반 설명은 건너뛰되, 구체적 사실이 한 줄이라도 있으면 무조건 추출하라.",
  "간결한 한국어 불릿으로 정리하라. 추측·결론은 만들지 마라(다음 단계가 종합).",
  "관련 사실이 전혀 없을 때에만 정확히 '(핵심 없음)' 이라고만 답하라.",
].join("\n");

// 지시문은 짧게만 넣는다. 긴 본문(userQ 전체)을 청크마다 재삽입하면 ctx 를 초과한다.
const TASK_HINT_CHARS = 600;

function buildMapUser(userQ, sysText, chunk, idx, total) {
  return [
    sysText ? `사용자 시스템 지시:\n${truncate(sysText, 400)}` : "",
    `사용자 요청(지시):\n${truncate(userQ, TASK_HINT_CHARS)}`,
    `문서 조각 ${idx + 1}/${total}:\n${chunk}`,
    "이 조각에서 요청 수행에 필요한 내용만 추출:",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildReduceMessages({ userQ, sysText, partials, isFinal }) {
  const joined = partials
    .map((p, i) => `--- 조각 ${p.i ?? i + 1} 추출 ---\n${p.text}`)
    .join("\n\n");
  const system = isFinal
    ? [
        "너는 긴 문서 파이프라인의 '종합' 단계다.",
        "아래는 문서 각 부분에서 뽑은 내용이다. 이를 근거로 사용자 요청에 대한 최종 답을 작성하라.",
        sysText ? `사용자 시스템 지시도 반드시 반영: ${sysText}` : "",
        "중복은 합치고 누락 없이 종합하되, 조각 라벨·메타는 답에 쓰지 마라. 완성된 답 본문만 출력하라.",
        config.enforceLanguage ? config.langDirective : "",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        "너는 긴 문서 파이프라인의 '부분 병합' 단계다.",
        "아래 여러 조각 추출들을 사용자 요청 관점에서 중복 없이 하나로 합쳐라.",
        "정보 손실 없이 요약·정리만 하고, 최종 결론은 만들지 마라(다음 단계가 종합).",
      ].join("\n");
  const koreanHint =
    isFinal && config.enforceLanguage && /[가-힣]/.test(userQ)
      ? "(답변은 반드시 한국어로만 작성하고, 중국어를 섞지 마세요.)"
      : "";
  const user = [
    sysText ? `사용자 시스템 지시:\n${truncate(sysText, 400)}` : "",
    `사용자 요청(지시):\n${truncate(userQ, TASK_HINT_CHARS)}`,
    `추출 모음:\n${joined}`,
    isFinal ? "위 내용을 종합한 최종 답:" : "위 내용을 손실 없이 하나로 병합:",
    koreanHint,
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
export async function runLongContent({ body, temperature, onEvent }) {
  const started = Date.now();
  const userQ = typeof body?.ROLE_USER === "string" ? body.ROLE_USER : "";
  const sysText =
    typeof body?.ROLE_SYSTEM === "string" && body.ROLE_SYSTEM.trim()
      ? body.ROLE_SYSTEM.trim()
      : "";
  const mapTier = config.longMapTier;
  const reduceTier = config.longReduceTier;

  // 1) 물리 파일 저장
  const saved = await saveLongContent(userQ, {
    chars: userQ.length,
    system: sysText ? truncate(sysText, 120) : undefined,
  });
  const chunks = chunkText(userQ);
  logger.info(
    `긴 입력 파이프라인: ${userQ.length}자 → ${chunks.length}청크 저장 ${saved.file}`,
  );

  const stepsPlan = [
    ...chunks.map((_, i) => ({
      i: i + 1,
      tier: mapTier,
      role: "extract",
      instruction: `조각 ${i + 1}/${chunks.length} 핵심 추출`,
    })),
    {
      i: chunks.length + 1,
      tier: reduceTier,
      role: "synthesize",
      instruction: "부분 결과 종합 → 최종 답",
    },
  ];
  const flowLabel = `${chunks.length}×${mapTier}(추출) → ${reduceTier}(종합)`;

  const trace = [
    {
      kind: "router",
      title: "긴 입력 처리 계획",
      planner: `긴 입력 자동 분할 (${userQ.length}자 > ${config.longTriggerChars}자)`,
      routerTier: null,
      reason: `컨텍스트 초과 방지: ${chunks.length}개 청크로 나눠 맵리듀스 (파일 저장: ${path.basename(saved.file)})`,
      decision: "청크 맵리듀스",
      flow: flowLabel,
      stepsPlan,
    },
  ];

  onEvent?.({
    type: "plan",
    mode: "workflow",
    reason: `긴 입력 → ${chunks.length}청크 맵리듀스`,
    flow: flowLabel,
    steps: stepsPlan.map((s, i) => ({
      i,
      tier: s.tier,
      role: s.role,
      instruction: s.instruction,
    })),
  });

  // 3) MAP: 청크별 추출 — 백엔드 여러 대에 분산하도록 제한된 병렬로 실행
  //    (순차 실행 시 청크가 많으면 전체 시간이 과도해져 타임아웃 위험)
  const stepRecs = new Array(chunks.length);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(config.longMapConcurrency, chunks.length));

  async function mapWorker() {
    while (true) {
      const i = cursor++;
      if (i >= chunks.length) break;
      onEvent?.({
        type: "step_start",
        i,
        tier: mapTier,
        role: "extract",
        instruction: `조각 ${i + 1}/${chunks.length} 추출`,
        receivedFrom: {
          label: `문서 조각 ${i + 1}/${chunks.length}`,
          preview: truncate(chunks[i], 240),
        },
      });
      const t0 = Date.now();
      let stepRec;
      try {
        const { result, backendUrl, tier, device, alias } = await pool.chat({
          messages: [
            { role: "system", content: MAP_SYSTEM },
            {
              role: "user",
              content: buildMapUser(userQ, sysText, chunks[i], i, chunks.length),
            },
          ],
          temperature: Math.min(temperature ?? 0.3, 0.3),
          maxTokens: config.maxTokensSmall,
          preferredTier: mapTier,
          allowOtherTiers: config.escalateTier,
          preferredSkill: summarizeSkill(),
        });
        const text = String(result.content || "").trim();
        const relevant =
          text && !/^\(?\s*핵심\s*없음\s*\)?[.!\s]*$/.test(text);
        stepRec = {
          kind: "model",
          i: i + 1,
          role: "extract",
          instruction: `조각 ${i + 1}/${chunks.length} 추출`,
          tier,
          device,
          alias,
          backend: backendUrl,
          model: result.raw?.model,
          ms: Date.now() - t0,
          receivedFrom: {
            kind: "doc",
            label: `문서 조각 ${i + 1}/${chunks.length}`,
            text: truncate(chunks[i], 2000),
          },
          output: relevant ? text : "관련 없음 (건너뜀)",
          isLast: false,
          _relevant: relevant,
          _text: text,
        };
      } catch (err) {
        // 개별 청크 실패는 전체를 막지 않는다 (누락은 로그로 남김)
        logger.warn(`긴 입력 MAP ${i + 1}/${chunks.length} 실패: ${err.message}`);
        stepRec = {
          kind: "model",
          i: i + 1,
          role: "extract",
          instruction: `조각 ${i + 1}/${chunks.length} 추출`,
          tier: mapTier,
          ms: Date.now() - t0,
          receivedFrom: {
            kind: "doc",
            label: `문서 조각 ${i + 1}/${chunks.length}`,
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
        role: "extract",
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

  // 청크 순서대로 trace·partials 재구성 (병렬이라 완료 순서가 섞였을 수 있음)
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
    // 전 조각이 '관련 없음' — 그래도 최종 단계는 원문 앞부분으로 답을 시도
    partials.push({ i: 1, text: truncate(userQ, config.longReduceInputChars) });
  }

  // 4) REDUCE: 상한을 넘으면 계층적으로 병합한 뒤 최종 종합
  let level = partials;
  let round = 0;
  while (
    level.map((p) => p.text).join("\n").length > config.longReduceInputChars &&
    level.length > 1
  ) {
    round++;
    const groups = groupPartials(level, config.longReduceInputChars);
    if (groups.length >= level.length) break; // 더 못 줄이면 중단
    const merged = [];
    for (let g = 0; g < groups.length; g++) {
      const { result } = await pool.chat({
        messages: buildReduceMessages({
          userQ,
          sysText,
          partials: groups[g],
          isFinal: false,
        }),
        temperature: 0.3,
        maxTokens: config.defaultMaxTokens,
        preferredTier: reduceTier,
        allowOtherTiers: config.escalateTier,
        preferredSkill: summarizeSkill(),
      });
      merged.push({ i: g + 1, text: String(result.content || "").trim() });
    }
    logger.info(
      `긴 입력 REDUCE 라운드 ${round}: ${level.length}→${merged.length} 그룹 병합`,
    );
    level = merged;
  }

  // 최종 종합 (마지막 단계는 스트리밍)
  const reduceMessages = buildReduceMessages({
    userQ,
    sysText,
    partials: level,
    isFinal: true,
  });
  const finalIdx = stepsPlan.length - 1;
  onEvent?.({
    type: "step_start",
    i: finalIdx,
    tier: reduceTier,
    role: "synthesize",
    instruction: "부분 결과 종합 → 최종 답",
    receivedFrom: {
      label: `부분 추출 ${level.length}개`,
      preview: truncate(level.map((p) => p.text).join(" / "), 240),
    },
  });

  const t0 = Date.now();
  let last;
  if (onEvent) {
    const out = await pool.chatStream({
      messages: reduceMessages,
      temperature: Math.min(temperature ?? 0.5, 0.5),
      maxTokens: config.defaultMaxTokens,
      enableThinking: false,
      preferredTier: reduceTier,
      allowOtherTiers: config.escalateTier,
      preferredSkill: summarizeSkill(),
      onMeta: (m) => onEvent({ type: "step_meta", i: finalIdx, ...m }),
      onToken: (t) => onEvent({ type: "token", text: t, i: finalIdx }),
    });
    last = {
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
  } else {
    const { result, backendUrl, tier, device, alias } = await pool.chat({
      messages: reduceMessages,
      temperature: Math.min(temperature ?? 0.5, 0.5),
      maxTokens: config.defaultMaxTokens,
      preferredTier: reduceTier,
      allowOtherTiers: config.escalateTier,
      preferredSkill: summarizeSkill(),
    });
    last = {
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

  const finalRec = {
    kind: "model",
    i: stepsPlan.length,
    role: "synthesize",
    instruction: "부분 결과 종합 → 최종 답",
    tier: last.tier,
    device: last.device,
    alias: last.alias,
    backend: last.backend,
    model: last.model,
    ms: last.totalMs,
    receivedFrom: {
      kind: "model",
      label: `부분 추출 ${level.length}개`,
      text: truncate(level.map((p) => p.text).join("\n\n"), 2000),
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
    tier: reduceTier,
    difficulty: 100,
    reason: `긴 입력 → ${chunks.length}청크 맵리듀스`,
    steps: stepsPlan.map((s) => ({
      tier: s.tier,
      role: s.role,
      instruction: s.instruction,
    })),
    longContent: true,
    savedFile: saved.file,
  };

  logger.info(
    `긴 입력 파이프라인 완료: ${chunks.length}청크 → 최종 @${last.tier}/${last.device ?? "-"} ${Date.now() - started}ms`,
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
