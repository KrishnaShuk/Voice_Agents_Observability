import { describe, it, expect } from "vitest";
import type { LLM } from "@livekit/agents";
import type { ProviderEventDraft, VoiceEvent } from "@voxobs/schema";
import type { FailoverSink } from "../src/context.js";
import { LatencyGuardrailError } from "../src/errors.js";
import { InMemoryFailureInjector } from "../src/injector.js";
import { observe } from "../src/observe.js";

class FakeSink implements FailoverSink {
  readonly emitted: ProviderEventDraft[] = [];
  emit(draft: ProviderEventDraft): VoiceEvent {
    this.emitted.push(draft);
    return draft as unknown as VoiceEvent;
  }
  types(): string[] {
    return this.emitted.map((event) => event.type);
  }
}

function streamOf(next: () => Promise<IteratorResult<unknown>>): AsyncIterableIterator<unknown> {
  const stream: AsyncIterableIterator<unknown> = {
    next,
    return: async () => ({ done: true, value: undefined }),
    [Symbol.asyncIterator]() {
      return stream;
    },
  };
  return stream;
}

function once(value: unknown): () => Promise<IteratorResult<unknown>> {
  let used = false;
  return async () => {
    if (used) return { done: true, value: undefined };
    used = true;
    return { done: false, value };
  };
}

function rejects(status: number): () => Promise<IteratorResult<unknown>> {
  return async () => {
    throw { status };
  };
}

function fakeLLM(next: () => Promise<IteratorResult<unknown>>): LLM {
  return {
    label: () => "fake",
    model: "m",
    provider: "p",
    chat: () => streamOf(next),
  } as unknown as LLM;
}

function chat(provider: LLM): AsyncIterableIterator<unknown> {
  return (provider.chat as (o: unknown) => AsyncIterableIterator<unknown>)({});
}

function clock() {
  const state = { now: 0 };
  return { mono: () => state.now, advance: (ms: number) => (state.now += ms) };
}

describe("observe (LLM)", () => {
  it("emits nothing on a healthy call", async () => {
    const sink = new FakeSink();
    const llm = observe(fakeLLM(once({ delta: "hi" })), {
      stage: "llm",
      name: "a",
      sink,
      guardrail: { ttftMs: 100 },
    });
    const first = await chat(llm).next();
    expect(first.done).toBe(false);
    expect(sink.emitted).toHaveLength(0);
  });

  it("supports async iteration", async () => {
    const sink = new FakeSink();
    const llm = observe(fakeLLM(once({ delta: "a" })), {
      stage: "llm",
      name: "a",
      sink,
      guardrail: { ttftMs: 100 },
    });
    const chunks: unknown[] = [];
    for await (const chunk of chat(llm)) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
  });

  it("trips the guardrail and emits provider_degraded", async () => {
    const sink = new FakeSink();
    const slow = () =>
      new Promise<IteratorResult<unknown>>((resolve) =>
        setTimeout(() => resolve({ done: false, value: {} }), 200),
      );
    const llm = observe(fakeLLM(slow), {
      stage: "llm",
      name: "a",
      sink,
      guardrail: { ttftMs: 30 },
    });
    await expect(chat(llm).next()).rejects.toBeInstanceOf(LatencyGuardrailError);
    expect(sink.types()).toEqual(["provider_degraded"]);
  });

  it("classifies a provider error and emits provider_failure", async () => {
    const sink = new FakeSink();
    const llm = observe(fakeLLM(rejects(503)), {
      stage: "llm",
      name: "a",
      sink,
      guardrail: { ttftMs: 1000 },
    });
    await expect(chat(llm).next()).rejects.toBeDefined();
    expect(sink.emitted[0]).toMatchObject({
      type: "provider_failure",
      provider: "a",
      reason: "5xx",
    });
  });

  it("emits failover when the fallback succeeds after a failure", async () => {
    const sink = new FakeSink();
    const c = clock();
    const primary = observe(fakeLLM(rejects(500)), {
      stage: "llm",
      name: "a",
      sink,
      guardrail: { ttftMs: 1000 },
      monotonic: c.mono,
    });
    const fallback = observe(fakeLLM(once({ delta: "hi" })), {
      stage: "llm",
      name: "b",
      sink,
      guardrail: { ttftMs: 1000 },
      monotonic: c.mono,
    });

    await expect(chat(primary).next()).rejects.toBeDefined();
    c.advance(120);
    await chat(fallback).next();

    expect(sink.types()).toEqual(["provider_failure", "failover"]);
    expect(sink.emitted[1]).toMatchObject({
      type: "failover",
      fromProvider: "a",
      toProvider: "b",
      trigger: "error",
      recoveryMs: 120,
    });
  });

  it("emits provider_recovered after a fast probe", async () => {
    const sink = new FakeSink();
    const c = clock();
    const opts = { stage: "llm" as const, sink, guardrail: { ttftMs: 1000, recoverAfter: 1 }, monotonic: c.mono };
    const primary = observe(fakeLLM(rejects(500)), { ...opts, name: "a" });
    const fallback = observe(fakeLLM(once({ delta: "hi" })), { ...opts, name: "b" });

    await expect(chat(primary).next()).rejects.toBeDefined();
    await chat(fallback).next();

    const probe = observe(fakeLLM(once({ delta: "hi" })), { ...opts, name: "a" });
    await chat(probe).next();

    expect(sink.types()).toContain("provider_recovered");
    expect(sink.emitted.at(-1)).toEqual({ type: "provider_recovered", stage: "llm", provider: "a" });
  });

  it("routes an injected error through the real detection path", async () => {
    const sink = new FakeSink();
    const injector = new InMemoryFailureInjector();
    injector.arm("llm", "error");

    const first = observe(fakeLLM(once({ delta: "hi" })), {
      stage: "llm",
      name: "a",
      sink,
      guardrail: { ttftMs: 1000 },
      injector,
    });
    await expect(chat(first).next()).rejects.toBeDefined();
    expect(sink.emitted[0]).toMatchObject({
      type: "provider_failure",
      reason: "conn_error",
      message: "injected error",
    });

    const second = observe(fakeLLM(once({ delta: "hi" })), {
      stage: "llm",
      name: "a",
      sink,
      guardrail: { ttftMs: 1000 },
      injector,
    });
    await expect(chat(second).next()).resolves.toBeDefined();
  });

  it("routes an injected slow call through the guardrail", async () => {
    const sink = new FakeSink();
    const injector = new InMemoryFailureInjector();
    injector.arm("llm", "slow", 120);

    const llm = observe(fakeLLM(once({ delta: "hi" })), {
      stage: "llm",
      name: "a",
      sink,
      guardrail: { ttftMs: 30 },
      injector,
    });
    await expect(chat(llm).next()).rejects.toBeInstanceOf(LatencyGuardrailError);
    expect(sink.types()).toEqual(["provider_degraded"]);
  });
});
