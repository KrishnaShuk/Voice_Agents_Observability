import type { LLM, stt, tts } from "@livekit/agents";
import type { Metric, Stage } from "@voxobs/schema";
import type { FailoverSink, StageContext } from "./context.js";
import { contextFor } from "./context.js";
import { classifyError, LatencyGuardrailError, messageOf, terminalError } from "./errors.js";
import type { FailureInjector, GuardrailConfig } from "./types.js";

export interface ObserveOptions {
  stage: Stage;
  name: string;
  sink: FailoverSink;
  guardrail?: GuardrailConfig;
  injector?: FailureInjector;
  monotonic?: () => number;
  logger?: (message: string) => void;
}

interface StreamConfig {
  ctx: StageContext;
  name: string;
  stage: Stage;
  metric: Metric;
  thresholdMs: number | undefined;
  recoverAfter: number;
  injector?: FailureInjector;
  monotonic: () => number;
}

/**
 * Wrap a provider so its calls are measured, errors classified, and latency
 * guardrails enforced. Place one wrapper per provider inside a FallbackAdapter.
 * A guardrail breach throws {@link LatencyGuardrailError} (terminal), which makes
 * the adapter rotate to the next provider.
 */
export function observe<T extends LLM | tts.TTS | stt.STT>(provider: T, opts: ObserveOptions): T {
  const ctx = contextFor(opts.stage, opts.sink, {
    monotonic: opts.monotonic,
    logger: opts.logger,
  });

  if (opts.stage === "llm") {
    return wrapStreaming(provider as object, ["chat"], streamConfig(ctx, opts, "ttft", opts.guardrail?.ttftMs)) as unknown as T;
  }
  if (opts.stage === "tts") {
    return wrapStreaming(
      provider as object,
      ["synthesize", "stream"],
      streamConfig(ctx, opts, "ttfb", opts.guardrail?.ttfbMs),
    ) as unknown as T;
  }
  return wrapStreaming(
    provider as object,
    ["stream"],
    // STT guardrails are per turn (speech_end -> final transcript), not per stream
    // event; only error classification + injection apply here. See docs/definitions.md.
    streamConfig(ctx, opts, "stt_final", undefined),
  ) as unknown as T;
}

function streamConfig(
  ctx: StageContext,
  opts: ObserveOptions,
  metric: Metric,
  thresholdMs: number | undefined,
): StreamConfig {
  return {
    ctx,
    name: opts.name,
    stage: opts.stage,
    metric,
    thresholdMs,
    recoverAfter: opts.guardrail?.recoverAfter ?? 1,
    injector: opts.injector,
    monotonic: opts.monotonic ?? (() => performance.now()),
  };
}

/** Proxy a provider, wrapping the named stream-returning methods. */
function wrapStreaming(provider: object, methods: string[], cfg: StreamConfig): object {
  return new Proxy(provider, {
    get(target, prop) {
      if (typeof prop === "string" && methods.includes(prop)) {
        return (...args: unknown[]) => {
          const method = Reflect.get(target, prop, target) as (...a: unknown[]) => unknown;
          const stream = method.apply(target, args) as AsyncIterableIterator<unknown>;
          return guardFirstResult(stream, cfg);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function guardFirstResult<T>(
  stream: AsyncIterableIterator<T>,
  cfg: StreamConfig,
): AsyncIterableIterator<T> {
  let first = true;
  const proxy: AsyncIterableIterator<T> = new Proxy(stream, {
    get(target, prop) {
      if (prop === "next") {
        return async (): Promise<IteratorResult<T>> => {
          if (!first) return target.next();
          first = false;
          return guardedFirstNext(target, cfg);
        };
      }
      if (prop === Symbol.asyncIterator) return () => proxy;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxy;
}

async function guardedFirstNext<T>(
  target: AsyncIterableIterator<T>,
  cfg: StreamConfig,
): Promise<IteratorResult<T>> {
  const injection = cfg.injector?.next(cfg.name, cfg.stage) ?? null;

  if (injection?.mode === "error") {
    cfg.ctx.noteFailure(cfg.name, "conn_error", "injected error");
    throw terminalError(`injected error on ${cfg.name}`);
  }

  if (injection?.mode === "timeout") {
    await sleep(injection.delayMs ?? 1500);
    cfg.ctx.noteFailure(cfg.name, "timeout", "injected timeout");
    throw terminalError(`injected timeout on ${cfg.name}`);
  }

  const slowDelay =
    injection?.mode === "slow" ? injection.delayMs ?? (cfg.thresholdMs ?? 500) + 100 : 0;

  if (injection?.mode === "slow" && cfg.thresholdMs === undefined) {
    await sleep(slowDelay);
    cfg.ctx.noteDegraded(cfg.name, cfg.metric, slowDelay, slowDelay);
    throw new LatencyGuardrailError(`injected slow on ${cfg.name}`);
  }

  const start = cfg.monotonic();
  const consume = async (): Promise<IteratorResult<T>> => {
    if (slowDelay > 0) await sleep(slowDelay);
    return target.next();
  };

  try {
    const result =
      cfg.thresholdMs !== undefined
        ? await raceWithTimeout(consume(), cfg.thresholdMs, () => {
            const observed = cfg.monotonic() - start;
            cfg.ctx.noteDegraded(cfg.name, cfg.metric, cfg.thresholdMs as number, observed);
            return new LatencyGuardrailError(
              `${cfg.name} ${cfg.metric} ${observed.toFixed(0)}ms > ${cfg.thresholdMs}ms`,
            );
          })
        : await consume();

    if (!result.done) cfg.ctx.noteSuccess(cfg.name, cfg.recoverAfter);
    return result;
  } catch (error) {
    if (error instanceof LatencyGuardrailError) {
      void target.return?.();
      throw error;
    }
    cfg.ctx.noteFailure(cfg.name, classifyError(error), messageOf(error));
    throw error;
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  makeError: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
