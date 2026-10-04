import { describe, it, expect } from "vitest";
import { createSpanProcessor, parseSpan, stripPiiAttributes } from "../src/span_processor.js";

describe("stripPiiAttributes", () => {
  it("removes lk.pii.* keys at any depth marker", () => {
    const clean = stripPiiAttributes({
      "gen_ai.request.model": "llama",
      "lk.pii.response.text": "secret",
      "lk.pii.user_input": "hi",
      "lk.response.ttft": 0.3,
    });
    expect(clean).toEqual({ "gen_ai.request.model": "llama", "lk.response.ttft": 0.3 });
  });
});

describe("parseSpan", () => {
  it("computes ms times and strips PII", () => {
    const parsed = parseSpan({
      name: "llm_node",
      attributes: { "lk.response.ttft": 0.3, "lk.pii.response.text": "secret" },
      startTime: [10, 0],
      endTime: [10, 500_000_000],
      duration: [0, 500_000_000],
    });
    expect(parsed.startTimeMs).toBe(10_000);
    expect(parsed.endTimeMs).toBe(10_500);
    expect(parsed.durationMs).toBe(500);
    expect(parsed.attributes).toEqual({ "lk.response.ttft": 0.3 });
  });
});

describe("createSpanProcessor", () => {
  it("implements onStart so LiveKit's fanout never throws", () => {
    const processor = createSpanProcessor();
    expect(typeof processor.onStart).toBe("function");
    expect(() => processor.onStart({ name: "x" }, undefined)).not.toThrow();
  });

  it("forwards parsed spans on end", () => {
    const seen: string[] = [];
    const processor = createSpanProcessor((span) => seen.push(span.name));
    processor.onEnd({
      name: "tts_node",
      attributes: {},
      startTime: [0, 0],
      endTime: [0, 1_000_000],
      duration: [0, 1_000_000],
    });
    expect(seen).toEqual(["tts_node"]);
  });
});
