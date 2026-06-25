import { config } from "./config.js";
import { chatCompletion, chatCompletionStream, checkHealth, fetchModel } from "./llamaClient.js";
import { logger } from "./logger.js";

/**
 * 여러 llama-server 백엔드를 관리하는 풀.
 * - 주기적 헬스체크
 * - least-connections(최소 in-flight) 라우팅
 * - 장애 시 다른 백엔드로 failover
 * - 백엔드별 통계 수집(모니터링용)
 */
class Backend {
  constructor(url, tier = "large", device = null) {
    this.url = url;
    this.tier = tier;
    this.device = device; // "gpu" | "cpu" | null(미지정)
    this.healthy = false;
    this.model = null;
    this.inFlight = 0;
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.totalLatencyMs = 0;
    this.lastLatencyMs = null;
    this.healthLatencyMs = null;
    this.lastError = null;
    this.lastCheck = null;
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
      healthy: this.healthy,
      model: this.model,
      inFlight: this.inFlight,
      totalRequests: this.totalRequests,
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
    this.rrCursor = 0;
    this.healthTimer = null;
    this.completed = []; // 최근 완료 시각(ms) — 처리량 계산용
  }

  /** 헬스체크 1회 (모든 백엔드 병렬) */
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
        // 상태 전이만 로깅(도배 방지)
        if (prev !== ok) {
          if (ok) logger.info(`백엔드 복구됨 ✅ ${b.tier}/${b.device ?? "-"} @ ${b.url} (${latencyMs}ms)`);
          else logger.warn(`백엔드 다운 ⚠️ ${b.tier}/${b.device ?? "-"} @ ${b.url}`);
        }
      })
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

  /**
   * 건강한 백엔드 중 in-flight 가 가장 적은 것 선택 (동률이면 round-robin).
   * preferredTier 의 후보를 우선하고, 없으면(allowOtherTiers) 다른 티어로 폴백.
   */
  pick(exclude = new Set(), preferredTier = null, allowOtherTiers = true, preferredDevice = null) {
    const healthy = this.backends.filter((b) => b.healthy && !exclude.has(b.url));
    if (healthy.length === 0) return null;

    let candidates = preferredTier ? healthy.filter((b) => b.tier === preferredTier) : healthy;
    if (candidates.length === 0) {
      if (!allowOtherTiers) return null;
      candidates = healthy; // 에스컬레이션: 다른 티어 허용
    }

    // 같은 티어 내에서 선호 장치(gpu/cpu)가 있으면 우선, 없으면 티어 전체로 폴백
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

  /**
   * 채팅 요청을 풀을 통해 실행한다. preferredTier 우선, 실패 시 failover/escalation.
   * @returns {Promise<{result: object, backendUrl: string, tier: string}>}
   */
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

    const healthyCount = this.backends.filter((b) => b.healthy).length;
    if (healthyCount === 0) {
      throw new Error("사용 가능한 llama-server 백엔드가 없습니다(모두 비정상).");
    }
    throw lastErr ?? new Error("요청을 처리할 백엔드를 찾지 못했습니다.");
  }

  /**
   * 스트리밍 채팅. 토큰을 onToken 으로 흘려보낸다.
   * 첫 토큰 전송 후에는 failover 불가(연결 초기 실패만 다른 백엔드로 재시도).
   */
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
        if (gotToken || !err.retryable) throw err; // 이미 토큰을 보냈으면 재시도 불가
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
      const t = (tiers[b.tier] ??= { total: 0, healthy: 0 });
      t.total++;
      if (b.healthy) t.healthy++;
    }
    const now = Date.now();
    this.completed = this.completed.filter((t) => now - t < 60000);
    return {
      totalBackends: backends.length,
      healthyBackends: backends.filter((b) => b.healthy).length,
      totalInFlight: backends.reduce((s, b) => s + b.inFlight, 0),
      totalRequests: backends.reduce((s, b) => s + b.totalRequests, 0),
      totalErrors: backends.reduce((s, b) => s + b.totalErrors, 0),
      requestsLastMin: this.completed.length,
      tiers,
      backends,
    };
  }
}

export const pool = new Pool(config.backends);
