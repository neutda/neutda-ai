import { allBackendSpecs, config } from "./config.js";
import { chatCompletion, chatCompletionStream, checkHealth, fetchModel } from "./llamaClient.js";
import { logger } from "./logger.js";

const CHAT_TIERS = new Set(["small", "medium", "large"]);

/**
 * 여러 llama-server 백엔드를 관리하는 풀.
 * 백엔드마다 채팅·라우터 역할을 독립적으로 켜고 끌 수 있다.
 */
class Backend {
  constructor(url, tier = "large", device = null) {
    this.url = url;
    this.tier = tier;
    this.device = device;
    this.chatEnabled = true;
    this.routerEnabled = false;
    this.healthy = false;
    this.model = null;
    this.inFlight = 0;
    this.totalRequests = 0;
    this.routerRequests = 0;
    this.chatRequests = 0;
    this.totalErrors = 0;
    this.totalLatencyMs = 0;
    this.lastLatencyMs = null;
    this.healthLatencyMs = null;
    this.lastError = null;
    this.lastCheck = null;
  }

  get canChat() {
    return this.chatEnabled && CHAT_TIERS.has(this.tier);
  }

  get avgLatencyMs() {
    const done = this.totalRequests - this.inFlight;
    return done > 0 ? Math.round(this.totalLatencyMs / done) : null;
  }

  snapshot() {
    return {
      url: this.url,
      tier: this.tier,
      device: this.device,
      roles: { chat: this.chatEnabled, router: this.routerEnabled },
      chatEnabled: this.chatEnabled,
      routerEnabled: this.routerEnabled,
      healthy: this.healthy,
      model: this.model,
      inFlight: this.inFlight,
      totalRequests: this.totalRequests,
      routerRequests: this.routerRequests,
      chatRequests: this.chatRequests,
      totalErrors: this.totalErrors,
      avgLatencyMs: this.avgLatencyMs,
      lastLatencyMs: this.lastLatencyMs,
      healthLatencyMs: this.healthLatencyMs,
      lastError: this.lastError,
      lastCheck: this.lastCheck,
    };
  }
}

class Pool {
  constructor(specs) {
    this.backends = specs.map((s) => new Backend(s.url, s.tier, s.device));
    this.applyDefaultRouterRoles();
    this.rrCursor = 0;
    this.healthTimer = null;
    this.completed = [];
  }

  async checkAll() {
    await Promise.all(
      this.backends.map(async (b) => {
        const prev = b.healthy;
        const { ok, latencyMs } = await checkHealth(b.url);
        b.healthy = ok;
        b.healthLatencyMs = latencyMs;
        b.lastCheck = new Date().toISOString();
        if (ok && !b.model) b.model = await fetchModel(b.url);
        if (!ok && !b.lastError) b.lastError = "health check failed";
        if (prev !== ok) {
          if (ok) logger.info(`백엔드 복구됨 ✅ ${b.tier}/${b.device ?? "-"} @ ${b.url} (${latencyMs}ms)`);
          else logger.warn(`백엔드 다운 ⚠️ ${b.tier}/${b.device ?? "-"} @ ${b.url}`);
        }
      }),
    );
  }

  startHealthChecks() {
    if (this.healthTimer) return;
    this.checkAll();
    this.healthTimer = setInterval(() => this.checkAll(), config.healthIntervalMs);
    if (this.healthTimer.unref) this.healthTimer.unref();
  }

  stopHealthChecks() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /** ROUTING_MODE=llm 일 때 시작 라우터 역할 부여 (모니터 토글로 이후 변경) */
  applyDefaultRouterRoles() {
    if (config.routingMode === "heuristic") return;

    if (config.routerBackendUrl) {
      const b = this.backends.find((x) => x.url === config.routerBackendUrl);
      if (b) {
        b.routerEnabled = true;
        return;
      }
    }
    const small = this.backends.find((b) => b.tier === "small");
    if (small) small.routerEnabled = true;
  }

  setRoleEnabled(url, role, enabled) {
    const b = this.backends.find((x) => x.url === url);
    if (!b) return false;
    if (role === "chat") b.chatEnabled = Boolean(enabled);
    else if (role === "router") b.routerEnabled = Boolean(enabled);
    else return false;
    logger.info(
      `백엔드 ${role} ${enabled ? "ON" : "OFF"} → ${b.tier} @ ${b.url}`,
    );
    return true;
  }

  hasActiveRouter() {
    return this.backends.some((b) => b.routerEnabled);
  }

  getActiveRouterUrl() {
    return this.pickRouter()?.url ?? null;
  }

  /** 라우터 역할 백엔드 선택 (least-connections) */
  pickRouter(exclude = new Set()) {
    let candidates = this.backends.filter(
      (b) => b.routerEnabled && !exclude.has(b.url),
    );
    if (!candidates.length) return null;

    const healthy = candidates.filter((b) => b.healthy);
    if (healthy.length) candidates = healthy;

    let min = Infinity;
    for (const b of candidates) min = Math.min(min, b.inFlight);
    const leastLoaded = candidates.filter((b) => b.inFlight === min);
    this.rrCursor = (this.rrCursor + 1) % leastLoaded.length;
    return leastLoaded[this.rrCursor];
  }

  /**
   * 라우터 역할 백엔드에 분류 요청을 먼저 보낸다 (채팅보다 선행).
   * in-flight·요청 통계에 반영된다.
   */
  async classify(params = {}) {
    const tried = new Set();
    const maxAttempts = Math.max(this.backends.filter((b) => b.routerEnabled).length, 1);
    let lastErr = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const backend = this.pickRouter(tried);
      if (!backend) break;
      tried.add(backend.url);

      backend.inFlight++;
      backend.totalRequests++;
      backend.chatRequests++;
      backend.routerRequests++;
      const started = Date.now();
      try {
        const result = await chatCompletion({ baseUrl: backend.url, ...params, enableThinking: false });
        backend.lastLatencyMs = Date.now() - started;
        backend.totalLatencyMs += backend.lastLatencyMs;
        return { result, backendUrl: backend.url, tier: backend.tier, device: backend.device };
      } catch (err) {
        backend.totalErrors++;
        backend.lastError = err.message;
        lastErr = err;
        if (!err.retryable) throw err;
        backend.healthy = false;
        logger.warn(`라우터 백엔드 실패 → 재시도 (${backend.url}): ${err.message}`);
      } finally {
        backend.inFlight--;
        this.completed.push(Date.now());
      }
    }

    if (lastErr) throw lastErr;
    return null;
  }

  getRoutingSummary() {
    const activeRouters = this.backends.filter((b) => b.routerEnabled);
    return {
      effectiveMode: this.hasActiveRouter() ? "llm" : "heuristic",
      activeRouterCount: activeRouters.length,
      activeRouterUrl: this.getActiveRouterUrl(),
    };
  }

  pick(exclude = new Set(), preferredTier = null, allowOtherTiers = true, preferredDevice = null) {
    const healthy = this.backends.filter(
      (b) => b.healthy && b.canChat && !exclude.has(b.url),
    );
    if (healthy.length === 0) return null;

    let candidates = preferredTier ? healthy.filter((b) => b.tier === preferredTier) : healthy;
    if (candidates.length === 0) {
      if (!allowOtherTiers) return null;
      candidates = healthy;
    }

    if (preferredDevice) {
      const byDevice = candidates.filter((b) => b.device === preferredDevice);
      if (byDevice.length > 0) candidates = byDevice;
    }

    let min = Infinity;
    for (const b of candidates) min = Math.min(min, b.inFlight);
    const leastLoaded = candidates.filter((b) => b.inFlight === min);

    this.rrCursor = (this.rrCursor + 1) % leastLoaded.length;
    return leastLoaded[this.rrCursor];
  }

  async chat(params = {}) {
    const { preferredTier = null, allowOtherTiers = config.escalateTier, preferredDevice = null, ...rest } = params;
    const tried = new Set();
    const maxAttempts = Math.max(this.backends.length, 1);
    let lastErr = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const backend = this.pick(tried, preferredTier, allowOtherTiers, preferredDevice);
      if (!backend) break;
      tried.add(backend.url);

      backend.inFlight++;
      backend.totalRequests++;
      backend.chatRequests++;
      const started = Date.now();
      try {
        const result = await chatCompletion({ baseUrl: backend.url, ...rest });
        backend.lastLatencyMs = Date.now() - started;
        backend.totalLatencyMs += backend.lastLatencyMs;
        return { result, backendUrl: backend.url, tier: backend.tier, device: backend.device };
      } catch (err) {
        backend.totalErrors++;
        backend.lastError = err.message;
        lastErr = err;
        if (!err.retryable) throw err;
        backend.healthy = false;
        logger.warn(`백엔드 실패 → 페일오버 시도 (${backend.url}): ${err.message}`);
      } finally {
        backend.inFlight--;
        this.completed.push(Date.now());
      }
    }

    const healthyCount = this.backends.filter((b) => b.healthy && b.canChat).length;
    if (healthyCount === 0) {
      throw new Error("사용 가능한 llama-server 백엔드가 없습니다(모두 비정상 또는 채팅 역할 비활성).");
    }
    throw lastErr ?? new Error("요청을 처리할 백엔드를 찾지 못했습니다.");
  }

  async chatStream(params = {}) {
    const { preferredTier = null, allowOtherTiers = config.escalateTier, preferredDevice = null, onToken, onMeta, ...rest } = params;
    const tried = new Set();
    const maxAttempts = Math.max(this.backends.length, 1);
    let lastErr = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const backend = this.pick(tried, preferredTier, allowOtherTiers, preferredDevice);
      if (!backend) break;
      tried.add(backend.url);

      backend.inFlight++;
      backend.totalRequests++;
      backend.chatRequests++;
      const started = Date.now();
      let gotToken = false;
      try {
        onMeta?.({ backend: backend.url, tier: backend.tier, device: backend.device, model: backend.model });
        const out = await chatCompletionStream({
          baseUrl: backend.url,
          ...rest,
          onToken: (t) => {
            gotToken = true;
            onToken?.(t);
          },
        });
        const totalMs = Date.now() - started;
        backend.lastLatencyMs = totalMs;
        backend.totalLatencyMs += totalMs;
        return {
          ...out,
          backendUrl: backend.url,
          tier: backend.tier,
          device: backend.device,
          model: backend.model,
          ttftMs: out.firstTokenAt ? out.firstTokenAt - started : null,
          totalMs,
        };
      } catch (err) {
        backend.totalErrors++;
        backend.lastError = err.message;
        lastErr = err;
        if (gotToken || !err.retryable) throw err;
        backend.healthy = false;
        logger.warn(`스트리밍 백엔드 실패 → 페일오버 시도 (${backend.url}): ${err.message}`);
      } finally {
        backend.inFlight--;
        this.completed.push(Date.now());
      }
    }

    throw lastErr ?? new Error("스트리밍 가능한 백엔드를 찾지 못했습니다.");
  }

  status() {
    const backends = this.backends.map((b) => b.snapshot());
    const tiers = {};
    for (const b of backends) {
      if (!CHAT_TIERS.has(b.tier)) continue;
      const t = (tiers[b.tier] ??= { total: 0, healthy: 0, active: 0 });
      t.total++;
      if (b.healthy) t.healthy++;
      if (b.chatEnabled) t.active++;
    }
    const now = Date.now();
    this.completed = this.completed.filter((t) => now - t < 60000);
    return {
      totalBackends: backends.length,
      healthyBackends: backends.filter((b) => b.healthy && b.chatEnabled && CHAT_TIERS.has(b.tier)).length,
      totalInFlight: backends.reduce((s, b) => s + b.inFlight, 0),
      totalRequests: backends.reduce((s, b) => s + b.totalRequests, 0),
      totalErrors: backends.reduce((s, b) => s + b.totalErrors, 0),
      requestsLastMin: this.completed.length,
      tiers,
      backends,
      routing: this.getRoutingSummary(),
    };
  }
}

export const pool = new Pool(allBackendSpecs);
