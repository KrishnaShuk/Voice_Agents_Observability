import type {
  FailReason,
  FailoverTrigger,
  Metric,
  ProviderEventDraft,
  Stage,
  VoiceEvent,
} from "@voxobs/schema";

/** Sink used by provider wrappers. The tracker fills the envelope and turn id. */
export interface FailoverSink {
  emit(draft: ProviderEventDraft): VoiceEvent;
}

interface ProviderHealth {
  failed: boolean;
  fast: number;
}

export interface StageContextOptions {
  stage: Stage;
  sink: FailoverSink;
  monotonic?: () => number;
  logger?: (message: string) => void;
}

/**
 * Shared failover state for one stage. All `observe()` wrappers feeding the same
 * stage (inside one FallbackAdapter) share a context keyed by the sink object, so a
 * failure recorded on the primary is matched to the fallback's first successful chunk.
 */
export class StageContext {
  readonly stage: Stage;
  private readonly sink: FailoverSink;
  private readonly monotonic: () => number;
  private readonly logger?: (message: string) => void;

  private failure: { provider: string; at: number; trigger: FailoverTrigger } | null = null;
  private readonly health = new Map<string, ProviderHealth>();

  constructor(options: StageContextOptions) {
    this.stage = options.stage;
    this.sink = options.sink;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.logger = options.logger;
  }

  /** Record a hard provider failure and mark it unavailable. */
  noteFailure(provider: string, reason: FailReason, message?: string): void {
    this.logger?.(`[failover] ${this.stage} ${provider} failed: ${reason}`);
    this.markFailed(provider);
    this.failure = { provider, at: this.monotonic(), trigger: "error" };
    this.sink.emit({ type: "provider_failure", stage: this.stage, provider, reason, message });
  }

  /** Record a latency-guardrail breach (degraded, not failed). */
  noteDegraded(provider: string, metric: Metric, thresholdMs: number, observedMs: number): void {
    this.logger?.(
      `[failover] ${this.stage} ${provider} degraded: ${metric} ${observedMs.toFixed(0)}ms > ${thresholdMs}ms`,
    );
    this.markFailed(provider);
    this.failure = { provider, at: this.monotonic(), trigger: "degraded" };
    this.sink.emit({
      type: "provider_degraded",
      stage: this.stage,
      provider,
      metric,
      thresholdMs,
      observedMs,
    });
  }

  /**
   * Record a successful call. If a different provider previously failed, emit
   * `failover`; if this provider was marked failed (a passing recovery probe),
   * count it toward `recoverAfter` and emit `provider_recovered` when healthy.
   */
  noteSuccess(provider: string, recoverAfter: number): void {
    if (this.failure && this.failure.provider !== provider) {
      const recoveryMs = Math.max(0, this.monotonic() - this.failure.at);
      this.logger?.(`[failover] ${this.stage} ${this.failure.provider} -> ${provider}`);
      this.sink.emit({
        type: "failover",
        stage: this.stage,
        fromProvider: this.failure.provider,
        toProvider: provider,
        trigger: this.failure.trigger,
        recoveryMs,
      });
      this.failure = null;
    }

    const health = this.health.get(provider);
    if (!health || !health.failed) return;
    health.fast += 1;
    if (health.fast >= Math.max(1, recoverAfter)) {
      health.failed = false;
      health.fast = 0;
      this.sink.emit({ type: "provider_recovered", stage: this.stage, provider });
    }
  }

  isFailed(provider: string): boolean {
    return this.health.get(provider)?.failed ?? false;
  }

  private markFailed(provider: string): void {
    this.health.set(provider, { failed: true, fast: 0 });
  }
}

const registry = new WeakMap<FailoverSink, Map<Stage, StageContext>>();

export function contextFor(
  stage: Stage,
  sink: FailoverSink,
  options?: { monotonic?: () => number; logger?: (message: string) => void },
): StageContext {
  let byStage = registry.get(sink);
  if (!byStage) {
    byStage = new Map();
    registry.set(sink, byStage);
  }
  let context = byStage.get(stage);
  if (!context) {
    context = new StageContext({ stage, sink, ...options });
    byStage.set(stage, context);
  }
  return context;
}
