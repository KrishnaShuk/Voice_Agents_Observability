import { describe, it, expect } from "vitest";
import { containsPii, validateEvent } from "../src/validate.js";
import * as h from "./helpers.js";

describe("containsPii", () => {
  it("detects nested lk.pii.* keys", () => {
    expect(containsPii({ a: { "lk.pii.response.text": "secret" } })).toBe(true);
    expect(containsPii([{ b: [{ "lk.pii.prompt": "x" }] }])).toBe(true);
  });

  it("returns false for clean payloads", () => {
    expect(containsPii({ a: 1, b: { c: "ok" } })).toBe(false);
  });
});

describe("validateEvent", () => {
  it("accepts a valid event", () => {
    const result = validateEvent(h.turnStart("s1", 0, "t1"));
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown type", () => {
    const result = validateEvent({ ...h.turnStart("s1", 0, "t1"), type: "nope" });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing required field", () => {
    const result = validateEvent({
      eventId: crypto.randomUUID(),
      sessionId: "s1",
      seq: 0,
      tOffsetMs: 0,
      timestamp: 1,
      type: "llm_ttft",
      turnId: "t1",
      provider: "groq",
      promptTokens: 1,
      latencyMs: 10,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects payloads carrying lk.pii.* fields", () => {
    const event = { ...h.turnStart("s1", 0, "t1"), "lk.pii.response.text": "secret" };
    const result = validateEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/lk\.pii/);
  });
});
