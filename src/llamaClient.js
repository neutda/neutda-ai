import { config } from "./config.js";

class LlamaError extends Error {
  constructor(message, { retryable = false, status } = {}) {
    super(message);
    this.name = "LlamaError";
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * 특정 llama-server(baseUrl)의 OpenAI 호환 /v1/chat/completions 를 호출한다.
 *
 * @param {object} params
 * @param {string} params.baseUrl - 대상 백엔드 베이스 URL
 * @param {Array<object>} params.messages - OpenAI 형식 메시지 배열
 * @param {number} params.temperature
 * @param {number} [params.maxTokens]
 * @param {boolean} [params.enableThinking]
 * @returns {Promise<{content: string, reasoning: string, raw: object}>}
 */
export async function chatCompletion({ baseUrl, messages, temperature, maxTokens, enableThinking }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.modelName,
        messages,
        temperature,
        max_tokens: maxTokens ?? config.defaultMaxTokens,
        stream: false,
        // Qwen 채팅 템플릿의 추론 모드 토글 (llama-server 가 그대로 전달)
        chat_template_kwargs: { enable_thinking: enableThinking ?? config.enableThinking },
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") {
      // 타임아웃은 다른 백엔드로 재시도 가능
      throw new LlamaError(`모델 응답 타임아웃 (${config.requestTimeoutMs}ms 초과)`, { retryable: true });
    }
    // 연결 실패도 재시도 가능
    throw new LlamaError(`llama-server 연결 실패: ${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  if (!response.ok) {
    // 5xx 는 백엔드 문제 → 재시도, 4xx 는 요청 문제 → 재시도 안 함
    throw new LlamaError(`llama-server 오류 (${response.status}): ${text.slice(0, 300)}`, {
      retryable: response.status >= 500,
      status: response.status,
    });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LlamaError(`llama-server 응답 파싱 실패: ${text.slice(0, 300)}`, { retryable: true });
  }

  const message = data?.choices?.[0]?.message ?? {};
  const content = message.content ?? "";
  const reasoning = message.reasoning_content ?? "";
  return { content, reasoning, raw: data };
}

/**
 * 스트리밍(SSE) 채팅. 토큰이 도착할 때마다 onToken(text) 호출.
 * @returns {Promise<{content,reasoning,usage,firstTokenAt,tokenCount}>}
 */
export async function chatCompletionStream({ baseUrl, messages, temperature, maxTokens, enableThinking, onToken }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.modelName,
        messages,
        temperature,
        max_tokens: maxTokens ?? config.defaultMaxTokens,
        stream: true,
        stream_options: { include_usage: true },
        chat_template_kwargs: { enable_thinking: enableThinking ?? config.enableThinking },
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new LlamaError(`모델 응답 타임아웃 (${config.requestTimeoutMs}ms 초과)`, { retryable: true });
    throw new LlamaError(`llama-server 연결 실패: ${err.message}`, { retryable: true });
  }

  if (!response.ok) {
    const text = await response.text();
    clearTimeout(timeout);
    throw new LlamaError(`llama-server 오류 (${response.status}): ${text.slice(0, 300)}`, {
      retryable: response.status >= 500,
      status: response.status,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  let firstTokenAt = null;
  let tokenCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "" || data === "[DONE]") continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta;
        if (delta) {
          if (delta.reasoning_content) reasoning += delta.reasoning_content;
          if (delta.content) {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            content += delta.content;
            tokenCount++;
            onToken?.(delta.content);
          }
        }
      }
    }
  } catch (err) {
    throw new LlamaError(`스트리밍 중 오류: ${err.message}`, { retryable: false });
  } finally {
    clearTimeout(timeout);
  }

  return { content, reasoning, usage, firstTokenAt, tokenCount };
}

/** 백엔드에 로드된 모델 이름을 조회한다(파일명만). 실패 시 null */
export async function fetchModel(baseUrl, timeoutMs = 3000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const id = data?.data?.[0]?.id;
    if (!id) return null;
    return String(id).split(/[\\/]/).pop();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** 특정 백엔드가 떠 있는지 확인 (응답시간 ms 포함) */
export async function checkHealth(baseUrl, timeoutMs = 3000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}/health`, { method: "GET", signal: controller.signal });
    return { ok: res.ok, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(t);
  }
}

export { LlamaError };
