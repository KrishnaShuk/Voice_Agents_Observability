import { describe, it, expect } from "vitest";
import type { ProviderEventDraft, VoiceEvent } from "@voxobs/schema";
import { StageContext, type FailoverSink } from "../src/context.js";

class FakeSink implements FailoverSink {
  readonly emitted: ProviderEventDraft[] = [];
  emit(draft: ProviderEventDraft): VoiceEvent {
    this.emitted.push(draft);
    return draft as unknown as VoiceEvent;
  }
}

function setup() {
  let clock = 0;
  const sink = new FakeSink();
  const ctx = new StageContext({ stage: "llm", sink, monotonic: () => clock });
  return { sink, ctx, advance: (ms: number) => (clock += ms) };
}

describe("StageContext", () => {
  it("emits provider_failure and marks the provider failed", () => {
    const { sink, ctx } = setup();
    ctx.noteFailure("a", "5xx", "server error");
    expect(sink.emitted).toEqual([
      { type: "provider_failure", stage: "llm", provider: "a", reason: "5xx", message: "server error" },
    ]);
    expect(ctx.isFailed("a")).toBe(true);
  });

  it("emits provider_degraded with trigger degraded", () => {
    const { sink, ctx } = setup();
    ctx.noteDegraded("a", "ttft", 800, 1500);
    expect(sink.emitted[0]).toMatchObject({
      type: "provider_degraded",
      provider: "a",
      metric: "ttft",
      thresholdMs: 800,
      observedMs: 1500,
    });
  });

  it("emits failover with recoveryMs when a different provider succeeds", () => {
    const { sink, ctx, advance } = setup();
    ctx.noteFailure("a", "5xx");
    advance(250);
    ctx.noteSuccess("b", 1);
    const failover = sink.emitted.find((e) => e.type === "failover");
    expect(failover).toMatchObject({
      type: "failover",
      stage: "llm",
      fromProvider: "a",
      toProvider: "b",
      trigger: "error",
      recoveryMs: 250,
    });
  });

  it("emits provider_recovered after recoverAfter fast probes", () => {
    const { sink, ctx } = setup();
    ctx.noteFailure("a", "5xx");
    ctx.noteSuccess("b", 1); // failover
    ctx.noteSuccess("a", 2); // probe 1
    expect(sink.emitted.some((e) => e.type === "provider_recovered")).toBe(false);
    ctx.noteSuccess("a", 2); // probe 2
    expect(sink.emitted.at(-1)).toEqual({ type: "provider_recovered", stage: "llm", provider: "a" });
  });

  it("stays silent on a healthy path", () => {
    const { sink, ctx } = setup();
    ctx.noteSuccess("a", 1);
    expect(sink.emitted).toHaveLength(0);
  });
});
