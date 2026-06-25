import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { toImageUrl } from "./image.js";
import { pool } from "./pool.js";
import { chooseRoute } from "./router.js";
import { appendHistory, readHistory, clearHistory } from "./history.js";
import { getMetrics } from "./metrics.js";
import { logger, getLogs } from "./logger.js";
import * as rag from "./rag.js";
import { extractText } from "./extract.js";
import multer from "multer";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024 },
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 외부 API 비동기 결과 JSON 저장 폴더 (정적 제공: /results/<id>.json)
const RESULTS_DIR = path.join(__dirname, "..", "public", "results");
fs.mkdir(RESULTS_DIR, { recursive: true }).catch(() => {});

async function writeResult(id, data) {
    await fs.writeFile(
        path.join(RESULTS_DIR, `${id}.json`),
        JSON.stringify(data, null, 2),
        "utf-8",
    );
}

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(
    express.static(path.join(__dirname, "..", "public"), {
        etag: false,
        lastModified: false,
        cacheControl: false,
        maxAge: 0,
    }),
);

/**
 * 요청 body -> OpenAI 형식 messages 로 변환한다.
 *
 * 입력(flat):
 * {
 *   "ROLE_SYSTEM": "시스템 지시문",      // optional
 *   "ROLE_USER": "사용자 질문",          // required
 *   "TEMPERATURE": 0.7,                   // optional
 *   "content": "이미지 URL/경로/dataURI", // optional (단일 또는 배열)
 *   "HISTORY": [{ role, content }]        // optional (이전 대화 기억용)
 * }
 */
async function buildMessages(body, promptCharBudget = Infinity) {
    const system = body.ROLE_SYSTEM;
    const user = body.ROLE_USER;
    const content = body.content;
    const history = Array.isArray(body.HISTORY) ? body.HISTORY : [];

    if (typeof user !== "string" || user.trim() === "") {
        throw new Error(
            '"ROLE_USER" 는 필수이며 비어있지 않은 문자열이어야 합니다.',
        );
    }

    const messages = [];
    const sysText =
        typeof system === "string" && system.trim() !== "" ? system : "";
    if (sysText) {
        messages.push({ role: "system", content: sysText });
    }

    // 이전 대화(메모리)를 컨텍스트 초과가 나지 않도록 최신 순으로 예산만큼만 삽입한다.
    const valid = history.filter(
        (t) =>
            t &&
            (t.role === "user" || t.role === "assistant") &&
            typeof t.content === "string" &&
            t.content !== "",
    );
    let remaining = promptCharBudget - sysText.length - user.length;
    const kept = [];
    for (let i = valid.length - 1; i >= 0 && remaining > 0; i--) {
        const turn = valid[i];
        if (turn.content.length > remaining) break; // 더 오래된 것은 버림
        remaining -= turn.content.length;
        kept.push(turn);
    }
    kept.reverse();
    for (const turn of kept) {
        messages.push({ role: turn.role, content: turn.content });
    }

    const hasImage =
        content !== undefined && content !== null && content !== "";
    if (hasImage) {
        const images = Array.isArray(content) ? content : [content];
        const parts = [{ type: "text", text: user }];
        for (const img of images) {
            parts.push({
                type: "image_url",
                image_url: { url: await toImageUrl(img) },
            });
        }
        messages.push({ role: "user", content: parts });
    } else {
        messages.push({ role: "user", content: user });
    }

    return messages;
}

app.get("/health", (_req, res) => {
    const s = pool.status();
    res.json({
        status: "ok",
        healthyBackends: s.healthyBackends,
        totalBackends: s.totalBackends,
    });
});

// 풀/백엔드 모니터링 상태
app.get("/api/status", (_req, res) => {
    res.json(pool.status());
});

// 시스템 자원(GPU/CPU/RAM) 실시간 지표
app.get("/api/metrics", async (_req, res) => {
    try {
        res.json(await getMetrics());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 로그 조회 (level=all|info|warn|error)
app.get("/api/logs", (req, res) => {
    const level = String(req.query.level || "all");
    const limit = Number(req.query.limit);
    const sinceId = Number(req.query.sinceId);
    res.json({
        items: getLogs({
            level,
            limit: Number.isFinite(limit) ? limit : 300,
            sinceId: Number.isFinite(sinceId) ? sinceId : 0,
        }),
    });
});

/**
 * 특정 백엔드(모델)에 실제 오류를 강제로 유발한다.
 * 시나리오는 모두 llama-server 가 비정상 응답(4xx/5xx)을 내도록 만든다.
 */
async function induceError(backend, scenario) {
    const url = backend.url;
    if (scenario === "context_overflow") {
        const huge = "오류 유발용 초과 입력 토큰 ".repeat(4000); // 모델 컨텍스트를 크게 초과
        const r = await fetch(`${url}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: config.modelName,
                messages: [{ role: "user", content: huge }],
                max_tokens: 50,
            }),
        });
        return {
            cause: `의도적으로 모델 컨텍스트 한도를 초과하는 대용량 프롬프트(약 ${huge.length.toLocaleString()}자) 전송`,
            status: r.status,
            serverMessage: (await r.text()).slice(0, 400),
        };
    }
    if (scenario === "bad_endpoint") {
        const r = await fetch(`${url}/v1/chat/completions/__force_error__`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
        return {
            cause: "존재하지 않는 엔드포인트 경로 호출(라우팅 실패 유발)",
            status: r.status,
            serverMessage: (await r.text()).slice(0, 400),
        };
    }
    // malformed_json
    const r = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"model": "x", "messages": [ {invalid json',
    });
    return {
        cause: "문법이 깨진 JSON 본문 전송(파싱 실패 유발)",
        status: r.status,
        serverMessage: (await r.text()).slice(0, 400),
    };
}

// 오류 테스트: 무작위 모델을 골라 실제 오류를 강제 유발하고 원인/이유를 로그로 남긴다.
app.post("/api/logs/test-error", async (req, res) => {
    const healthy = pool.backends.filter((b) => b.healthy);
    const pickFrom = healthy.length ? healthy : pool.backends;
    if (!pickFrom.length) {
        logger.error("강제 오류 테스트 실패: 사용 가능한 백엔드가 없습니다.");
        return res
            .status(503)
            .json({ error: "사용 가능한 백엔드가 없습니다." });
    }

    const backend = pickFrom[Math.floor(Math.random() * pickFrom.length)];
    const scenarios = ["context_overflow", "bad_endpoint", "malformed_json"];
    const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
    const modelName = backend.model || "(미확인)";

    let detail;
    try {
        detail = await induceError(backend, scenario);
    } catch (e) {
        detail = {
            cause: "백엔드 연결 자체가 실패",
            status: 0,
            serverMessage: e.message,
        };
    }

    // 통계에도 오류 1건 반영(모니터 오류 카운트 증가)
    backend.totalErrors++;
    backend.lastError = `[강제 테스트:${scenario}] ${detail.serverMessage}`;

    logger.error(
        `강제 오류 유발 [${scenario}] → 모델="${modelName}" (${backend.tier}/${backend.device ?? "-"}) @ ${backend.url}\n` +
            `   · 원인: ${detail.cause}\n` +
            `   · 결과: HTTP ${detail.status} | 서버응답: ${detail.serverMessage}`,
        {
            scenario,
            model: modelName,
            tier: backend.tier,
            device: backend.device,
            backend: backend.url,
            status: detail.status,
        },
    );

    res.status(502).json({
        error: `모델 "${modelName}" 에 강제 오류 유발 완료`,
        scenario,
        model: modelName,
        tier: backend.tier,
        device: backend.device,
        backend: backend.url,
        cause: detail.cause,
        status: detail.status,
        serverMessage: detail.serverMessage,
    });
});

// 저장된 대화 내역 조회
app.get("/api/history", async (req, res) => {
    try {
        const limit = Number(req.query.limit);
        const items = await readHistory(
            Number.isFinite(limit) ? limit : undefined,
        );
        res.json({ items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 대화 내역 전체 삭제
app.delete("/api/history", async (_req, res) => {
    try {
        await clearHistory();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 외부 API: 백그라운드에서 답변을 생성해 결과 JSON 파일에 기록한다.
async function processAsk(id, body, ref) {
    const started = Date.now();
    try {
        const route = chooseRoute(body);
        logger.info(
            `라우팅 [ask #${id}] → tier=${route.tier} device=${route.device} 난이도=${route.difficulty} (${route.reason})`,
        );
        const isLarge = route.tier === "large";
        const promptCharBudget = isLarge
            ? config.maxPromptCharsLarge
            : config.maxPromptCharsSmall;
        const maxTokens = isLarge
            ? config.defaultMaxTokens
            : config.maxTokensSmall;
        const messages = await buildMessages(body, promptCharBudget);

        const rawTemp = Number(body?.TEMPERATURE);
        const temperature = Number.isFinite(rawTemp)
            ? rawTemp
            : config.defaultTemperature;

        const {
            result,
            backendUrl,
            tier: usedTier,
            device: usedDevice,
        } = await pool.chat({
            messages,
            temperature,
            maxTokens,
            enableThinking: config.enableThinking,
            preferredTier: route.tier,
            preferredDevice: route.device,
        });

        const data = {
            status: "done",
            id,
            ref,
            question: body.ROLE_USER,
            answer: result.content,
            reasoning: result.reasoning || undefined,
            model: result.raw?.model ?? config.modelName,
            tier: usedTier,
            device: usedDevice,
            backend: backendUrl,
            elapsedMs: Date.now() - started,
            finishedAt: new Date().toISOString(),
        };
        await writeResult(id, data);
        logger.info(
            `ask 완료 #${id} tier=${usedTier} device=${usedDevice ?? "-"} ${Date.now() - started}ms`,
        );
        return data;
    } catch (err) {
        const data = {
            status: "error",
            id,
            ref,
            question: body.ROLE_USER,
            error: err.message,
            finishedAt: new Date().toISOString(),
        };
        await writeResult(id, data).catch(() => {});
        logger.error(`ask 실패 #${id}: ${err.message}`);
        return data;
    }
}

// 외부 API (GET): key + q 를 받아 즉시 "생성중" + 결과 URL 을 반환하고, 답변은 비동기로 파일에 기록한다.
app.get("/api/ask", async (req, res) => {
    const key = req.query.key || req.headers["x-api-key"];
    if (key !== config.apiKey) {
        return res.status(401).json({ error: "유효하지 않은 API KEY 입니다." });
    }

    const q = req.query.q ?? req.query.content ?? req.query.ROLE_USER;
    if (typeof q !== "string" || q.trim() === "") {
        return res
            .status(400)
            .json({ error: "q (질문) 파라미터가 필요합니다." });
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    // 호출자가 보낸 식별용 key(ref). 어떤 요청에 대한 답변인지 매칭하기 위해 응답에 그대로 echo 한다.
    const ref =
        typeof req.query.ref === "string"
            ? req.query.ref
            : typeof req.query.reqKey === "string"
              ? req.query.reqKey
              : undefined;
    const body = {
        ROLE_USER: q,
        ROLE_SYSTEM:
            typeof req.query.system === "string" ? req.query.system : undefined,
        TEMPERATURE: req.query.temperature,
        MODEL_TIER:
            typeof req.query.tier === "string" ? req.query.tier : undefined,
    };

    await writeResult(id, {
        status: "generating",
        id,
        ref,
        question: q,
        createdAt: new Date().toISOString(),
    });

    const wait = String(req.query.WAIT ?? req.query.wait ?? "N").toUpperCase() === "Y";
    const resultUrl = `/results/${id}.json`;

    // WAIT=Y: 완료까지 기다렸다가 결과를 바로 반환
    if (wait) {
        logger.info(`ask 접수 #${id} ref=${ref ?? "-"} (WAIT=Y, 동기 대기): "${q.slice(0, 50)}"`);
        const data = await processAsk(id, body, ref);
        return res.status(data.status === "error" ? 502 : 200).json({ ...data, resultUrl });
    }

    // WAIT=N(기본): 즉시 "생성중" 응답 + 결과 URL, 답변은 백그라운드로 파일에 기록
    logger.info(`ask 접수 #${id} ref=${ref ?? "-"} (WAIT=N, 비동기): "${q.slice(0, 50)}"`);
    processAsk(id, body, ref);
    res.json({
        status: "generating",
        message: "답변을 생성중입니다",
        id,
        ref,
        resultUrl,
    });
});

// 스트리밍(SSE) 채팅: 토큰을 실시간 전송하고, 마지막에 TTFT/tokens-per-sec 지표를 보낸다.
app.post("/api/chat/stream", async (req, res) => {
    const started = Date.now();
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (event, data) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
        const q =
            typeof req.body?.ROLE_USER === "string" ? req.body.ROLE_USER : "";
        logger.info(
            `요청 수신 [chat/stream] "${q.slice(0, 60)}" (len=${q.length}, memory=${Array.isArray(req.body?.HISTORY) ? req.body.HISTORY.length : 0}턴)`,
        );

        const route = chooseRoute(req.body ?? {});
        const isLarge = route.tier === "large";
        const promptCharBudget = isLarge
            ? config.maxPromptCharsLarge
            : config.maxPromptCharsSmall;
        const maxTokens = isLarge
            ? config.defaultMaxTokens
            : config.maxTokensSmall;
        logger.info(
            `라우팅 [chat/stream] → tier=${route.tier} device=${route.device} 난이도=${route.difficulty} (티어사유: ${route.reason} / 장치사유: ${route.deviceReason})`,
        );

        const messages = await buildMessages(req.body ?? {}, promptCharBudget);
        logger.debug(
            `메시지 구성 [chat/stream] 총 ${messages.length}개, maxTokens=${maxTokens}, 프롬프트예산=${promptCharBudget}자`,
        );

        const rawTemp = Number(req.body?.TEMPERATURE);
        const temperature = Number.isFinite(rawTemp)
            ? rawTemp
            : config.defaultTemperature;
        const enableThinking =
            req.body?.THINKING === undefined
                ? config.enableThinking
                : Boolean(req.body.THINKING);

        send("meta", {
            routedTier: route.tier,
            routedDevice: route.device,
            difficulty: route.difficulty,
        });

        let firstLogged = false;
        const out = await pool.chatStream({
            messages,
            temperature,
            maxTokens,
            enableThinking,
            preferredTier: route.tier,
            preferredDevice: route.device,
            onMeta: (m) => {
                send("meta", m);
                logger.info(
                    `백엔드 선택 [chat/stream] → ${m.tier}/${m.device ?? "-"} @ ${m.backend} (model=${m.model ?? "?"})`,
                );
            },
            onToken: (t) => {
                if (!firstLogged) {
                    firstLogged = true;
                    logger.debug(
                        `첫 토큰 수신 [chat/stream] (${Date.now() - started}ms)`,
                    );
                }
                send("token", { text: t });
            },
        });

        const genMs =
            out.ttftMs != null
                ? Math.max(out.totalMs - out.ttftMs, 1)
                : out.totalMs;
        const tokens = out.usage?.completion_tokens ?? out.tokenCount;
        const tokensPerSec =
            tokens && genMs
                ? Number((tokens / (genMs / 1000)).toFixed(1))
                : null;

        send("done", {
            answer: out.content,
            reasoning: out.reasoning || undefined,
            model: out.model ?? config.modelName,
            tier: out.tier,
            device: out.device,
            difficulty: route.difficulty,
            backend: out.backendUrl,
            ttftMs: out.ttftMs,
            totalMs: out.totalMs,
            tokens,
            tokensPerSec,
            usage: out.usage ?? null,
        });

        const body = req.body ?? {};
        appendHistory({
            id:
                Date.now().toString(36) +
                Math.random().toString(36).slice(2, 8),
            ts: new Date().toISOString(),
            system:
                typeof body.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "",
            user: body.ROLE_USER,
            hasImage: false,
            temperature,
            thinking: enableThinking,
            tier: out.tier,
            routedTier: route.tier,
            device: out.device,
            backend: out.backendUrl,
            model: out.model ?? config.modelName,
            answer: out.content,
            reasoning: out.reasoning || "",
            usage: out.usage ?? null,
        }).catch((e) => logger.error(`history 저장 실패: ${e.message}`));

        logger.info(
            `chat(stream) tier=${out.tier} device=${out.device ?? "-"} ttft=${out.ttftMs ?? "?"}ms tps=${tokensPerSec ?? "?"} ${out.totalMs}ms`,
        );
        res.end();
    } catch (err) {
        logger.error(
            `chat(stream) 실패 (${Date.now() - started}ms): ${err.message}`,
        );
        send("error", { error: err.message });
        res.end();
    }
});

app.post("/api/chat", async (req, res) => {
    const started = Date.now();
    try {
        const q =
            typeof req.body?.ROLE_USER === "string" ? req.body.ROLE_USER : "";
        logger.info(
            `요청 수신 [chat] "${q.slice(0, 60)}" (len=${q.length}, memory=${Array.isArray(req.body?.HISTORY) ? req.body.HISTORY.length : 0}턴)`,
        );

        const { tier, reason, device, difficulty, deviceReason } = chooseRoute(
            req.body ?? {},
        );
        logger.info(
            `라우팅 [chat] → tier=${tier} device=${device} 난이도=${difficulty} (티어사유: ${reason} / 장치사유: ${deviceReason})`,
        );

        // 티어별 컨텍스트 예산/출력 토큰 (large 만 큰 ctx 가정)
        const isLarge = tier === "large";
        const promptCharBudget = isLarge
            ? config.maxPromptCharsLarge
            : config.maxPromptCharsSmall;
        const maxTokens = isLarge
            ? config.defaultMaxTokens
            : config.maxTokensSmall;

        const messages = await buildMessages(req.body ?? {}, promptCharBudget);

        const rawTemp = Number(req.body?.TEMPERATURE);
        const temperature = Number.isFinite(rawTemp)
            ? rawTemp
            : config.defaultTemperature;

        const enableThinking =
            req.body?.THINKING === undefined
                ? config.enableThinking
                : Boolean(req.body.THINKING);

        const {
            result,
            backendUrl,
            tier: usedTier,
            device: usedDevice,
        } = await pool.chat({
            messages,
            temperature,
            maxTokens,
            enableThinking,
            preferredTier: tier,
            preferredDevice: device,
        });

        const body = req.body ?? {};
        const entry = {
            id:
                Date.now().toString(36) +
                Math.random().toString(36).slice(2, 8),
            ts: new Date().toISOString(),
            system:
                typeof body.ROLE_SYSTEM === "string" ? body.ROLE_SYSTEM : "",
            user: body.ROLE_USER,
            hasImage: !!(
                body.content !== undefined &&
                body.content !== null &&
                body.content !== ""
            ),
            temperature,
            thinking: enableThinking,
            tier: usedTier,
            routedTier: tier,
            routeReason: reason,
            device: usedDevice,
            routedDevice: device,
            difficulty,
            deviceReason,
            backend: backendUrl,
            model: result.raw?.model ?? config.modelName,
            answer: result.content,
            reasoning: result.reasoning || "",
            usage: result.raw?.usage ?? null,
        };
        logger.info(
            `chat 성공 tier=${usedTier} device=${usedDevice ?? "-"} diff=${difficulty} backend=${backendUrl} ${Date.now() - started}ms`,
            {
                tier: usedTier,
                device: usedDevice,
                backend: backendUrl,
                ms: Date.now() - started,
            },
        );

        // 저장 실패가 응답을 막지 않도록 best-effort
        appendHistory(entry).catch((e) =>
            logger.error(`history 저장 실패: ${e.message}`),
        );

        res.json({
            id: entry.id,
            ts: entry.ts,
            answer: result.content,
            reasoning: result.reasoning || undefined,
            model: entry.model,
            tier: usedTier,
            routedTier: tier,
            routeReason: reason,
            device: usedDevice,
            routedDevice: device,
            difficulty,
            deviceReason,
            backend: backendUrl,
            usage: result.raw?.usage ?? null,
        });
    } catch (err) {
        if (/exceed_context_size|context size/.test(err.message)) {
            logger.warn(`chat 컨텍스트 초과: ${err.message}`);
            return res.status(413).json({
                error: "입력/대화가 모델 컨텍스트 한도를 초과했습니다. 대화를 초기화하거나 질문을 줄여주세요.",
                detail: err.message,
            });
        }
        const isClientError =
            /필수|문자열|확장자|이미지/.test(err.message) && !err.retryable;
        logger.error(`chat 실패 (${Date.now() - started}ms): ${err.message}`);
        res.status(isClientError ? 400 : 502).json({ error: err.message });
    }
});

// ===== RAG: 문서 기반 질의응답 =====================================

// 문서 목록 + 통계
app.get("/api/rag/docs", async (_req, res) => {
    try {
        await rag.load();
        res.json({ docs: rag.listDocuments(), stats: rag.stats() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 파일 업로드로 문서 추가 (pdf/docx/hwpx/hwp/txt ...): multipart, field name="file"
app.post("/api/rag/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "파일이 필요합니다." });
        }
        // multer 는 한글 파일명을 latin1 로 디코딩하므로 utf8 로 복원한다.
        const original = Buffer.from(req.file.originalname, "latin1").toString(
            "utf8",
        );
        const text = await extractText(original, req.file.buffer);
        if (!text || !text.trim()) {
            throw new Error(
                "문서에서 텍스트를 추출하지 못했습니다. (스캔 이미지 PDF이거나 지원하지 않는 형식일 수 있습니다)",
            );
        }
        const name =
            (req.body?.name && String(req.body.name).trim()) ||
            original.replace(/\.[^.]+$/, "");
        const info = await rag.addDocument(name, text);
        logger.info(
            `RAG 업로드: "${info.name}" (${original}, ${text.length}자, 청크 ${info.chunkCount}개)`,
        );
        res.json({ ok: true, ...info, chars: text.length, stats: rag.stats() });
    } catch (err) {
        logger.warn(`RAG 업로드 실패: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

// 문서 추가 ({ name, text })
app.post("/api/rag/docs", async (req, res) => {
    try {
        const { name, text } = req.body ?? {};
        const info = await rag.addDocument(name, text);
        logger.info(
            `RAG 문서 추가: "${info.name}" (청크 ${info.chunkCount}개)`,
        );
        res.json({ ok: true, ...info, stats: rag.stats() });
    } catch (err) {
        logger.warn(`RAG 문서 추가 실패: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

// 문서 삭제
app.delete("/api/rag/docs/:id", async (req, res) => {
    try {
        const r = await rag.deleteDocument(req.params.id);
        logger.info(`RAG 문서 삭제: ${req.params.id}`);
        res.json({ ok: true, ...r, stats: rag.stats() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 문서 기반 질문: 관련 청크 검색 → 컨텍스트로 주입 → LLM 답변(+출처)
app.post("/api/rag/ask", async (req, res) => {
    const started = Date.now();
    try {
        await rag.load();
        const q =
            typeof req.body?.q === "string"
                ? req.body.q
                : typeof req.body?.ROLE_USER === "string"
                  ? req.body.ROLE_USER
                  : "";
        if (!q.trim()) {
            return res.status(400).json({ error: "q (질문) 가 필요합니다." });
        }
        const topK = Number.isFinite(Number(req.body?.topK))
            ? Math.max(1, Math.min(8, Number(req.body.topK)))
            : 4;
        // strict=true(문서만 답변): 문서 밖 내용은 "문서 내용에 없습니다"로 답한다.
        const strict = req.body?.strict !== false;

        // RAG 대화도 새로고침 후 복원되도록 히스토리에 저장한다.
        const persist = (payload) =>
            appendHistory({
                id:
                    Date.now().toString(36) +
                    Math.random().toString(36).slice(2, 8),
                ts: new Date().toISOString(),
                rag: true,
                strict: payload.strict,
                user: q,
                answer: payload.answer,
                model: payload.model ?? null,
                tier: payload.tier ?? null,
                device: payload.device ?? null,
                sources: payload.sources || [],
            }).catch((e) => logger.error(`history 저장 실패: ${e.message}`));

        const hits = rag.retrieve(q, topK);
        logger.info(
            `RAG 질문 "${q.slice(0, 50)}" (strict=${strict}) → 관련 청크 ${hits.length}개 검색`,
        );

        // 관련 문서가 없을 때
        if (!hits.length) {
            if (strict) {
                const payload = {
                    answer: "문서 내용에 없습니다.",
                    sources: [],
                    strict,
                    elapsedMs: Date.now() - started,
                };
                persist(payload);
                return res.json(payload);
            }
            // 보강 모드: 문서가 없으면 일반 지식으로 답변
            const { result, backendUrl, tier, device } = await pool.chat({
                messages: [
                    {
                        role: "system",
                        content: "너는 한국어로 답하는 친절한 어시스턴트다.",
                    },
                    { role: "user", content: q },
                ],
                temperature: 0.4,
                maxTokens: config.defaultMaxTokens,
                enableThinking: config.enableThinking,
                preferredTier: "large",
            });
            const payload = {
                answer: result.content,
                sources: [],
                strict,
                model: result.raw?.model ?? config.modelName,
                tier,
                device,
                backend: backendUrl,
                elapsedMs: Date.now() - started,
            };
            persist(payload);
            return res.json(payload);
        }

        const context = hits
            .map(
                (h, i) =>
                    `[출처 ${i + 1}] (${h.docName} #${h.idx})\n${h.text}`,
            )
            .join("\n\n");

        const system = strict
            ? "너는 제공된 '참고 문서'만 근거로 한국어로 답하는 어시스턴트다. " +
              "문서에 없는 내용은 절대 추측하지 말고 정확히 '문서 내용에 없습니다.'라고만 답하라. " +
              "답변에 [출처 N] 같은 출처 표기는 넣지 말고 내용만 자연스럽게 답하라."
            : "너는 한국어로 답하는 어시스턴트다. '참고 문서'를 우선 근거로 사용하되, " +
              "문서에 없으면 너의 일반 지식으로 보완해 답하라. " +
              "답변에 [출처 N] 같은 출처 표기는 넣지 말고 내용만 자연스럽게 답하라.";
        const userMsg = `참고 문서:\n${context}\n\n질문: ${q}`;

        const messages = [
            { role: "system", content: system },
            { role: "user", content: userMsg },
        ];

        const { result, backendUrl, tier, device } = await pool.chat({
            messages,
            temperature: strict ? 0.2 : 0.4,
            maxTokens: config.defaultMaxTokens,
            enableThinking: config.enableThinking,
            preferredTier: "large",
        });

        logger.info(
            `RAG 답변 완료 tier=${tier} device=${device ?? "-"} ${Date.now() - started}ms`,
        );
        const payload = {
            answer: result.content,
            strict,
            sources: hits.map((h, i) => ({
                n: i + 1,
                docName: h.docName,
                idx: h.idx,
                score: h.score,
                preview: h.text.slice(0, 200),
            })),
            model: result.raw?.model ?? config.modelName,
            tier,
            device,
            backend: backendUrl,
            elapsedMs: Date.now() - started,
        };
        persist(payload);
        res.json(payload);
    } catch (err) {
        logger.error(`RAG 질문 실패 (${Date.now() - started}ms): ${err.message}`);
        res.status(502).json({ error: err.message });
    }
});

app.use((_req, res) => res.status(404).json({ error: "Not Found" }));

pool.startHealthChecks();

app.listen(config.port, () => {
    logger.info(
        `Express 서버 시작 (port ${config.port}, 백엔드 ${config.backends.length}개)`,
    );
    console.log(
        `[neutda-ai] Express 서버 실행: http://localhost:${config.port}`,
    );
    console.log(`[neutda-ai] 테스트 페이지: http://localhost:${config.port}/`);
    console.log(
        `[neutda-ai] 모니터링: http://localhost:${config.port}/monitor.html`,
    );
    console.log(
        `[neutda-ai] LLM 백엔드 ${config.backends.length}개: ${config.backends.map((b) => `${b.tier}@${b.url}`).join(", ")}`,
    );
    console.log(
        `[neutda-ai] POST /api/chat 로 ROLE_SYSTEM/ROLE_USER/TEMPERATURE/content 전송`,
    );
});
