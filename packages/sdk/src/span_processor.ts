export interface ReadableSpanLike {
  name: string;
  attributes: Record<string, unknown>;
  startTime: [number, number];
  endTime: [number, number];
  duration: [number, number];
}

export interface SpanLike {
  name: string;
}

export interface SpanProcessorLike {
  onStart?(span: SpanLike, parentContext: unknown): void;
  onEnd(span: ReadableSpanLike): void;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

export interface ParsedSpan {
  name: string;
  attributes: Record<string, unknown>;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
}

const PII_KEY = /(^|\.)pii(\.|$)/i;

export function stripPiiAttributes(
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (PII_KEY.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function hrTimeToMs(time: [number, number]): number {
  return time[0] * 1000 + time[1] / 1e6;
}

export function parseSpan(span: ReadableSpanLike): ParsedSpan {
  const startTimeMs = hrTimeToMs(span.startTime);
  const endTimeMs = hrTimeToMs(span.endTime);
  const rawDuration = hrTimeToMs(span.duration);
  return {
    name: span.name,
    attributes: stripPiiAttributes(span.attributes ?? {}),
    startTimeMs,
    endTimeMs,
    durationMs: rawDuration > 0 ? rawDuration : Math.max(0, endTimeMs - startTimeMs),
  };
}

export function createSpanProcessor(onSpan?: (span: ParsedSpan) => void): SpanProcessorLike {
  return {
    onEnd(span: ReadableSpanLike): void {
      onSpan?.(parseSpan(span));
    },
    async shutdown(): Promise<void> {},
    async forceFlush(): Promise<void> {},
  };
}

export async function installLiveKitTracing(processor: SpanProcessorLike): Promise<void> {
  const [{ NodeTracerProvider }, agents] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@livekit/agents"),
  ]);

  const fanout = new agents.telemetry.FanoutSpanProcessor();
  fanout.add(processor as never);
  const provider = new NodeTracerProvider({ spanProcessors: [fanout] });
  provider.register();
  agents.telemetry.setTracerProvider(provider, {
    registerSpanProcessor: (spanProcessor: Parameters<typeof fanout.add>[0]) =>
      fanout.add(spanProcessor),
  });
}
