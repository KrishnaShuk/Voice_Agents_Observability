import { describe, it, expect } from "vitest";
import { TurnGuardrail } from "../src/guardrail.js";

describe("TurnGuardrail", () => {
  it("trips only after `consecutive` slow turns", () => {
    const guard = new TurnGuardrail(400, 2);
    expect(guard.record(500).degraded).toBe(false);
    expect(guard.record(600).degraded).toBe(true);
  });

  it("resets the streak on a fast turn", () => {
    const guard = new TurnGuardrail(400, 2);
    guard.record(500);
    guard.record(100);
    expect(guard.record(500).degraded).toBe(false);
  });

  it("never trips without a threshold", () => {
    const guard = new TurnGuardrail(undefined, 1);
    expect(guard.record(9999).degraded).toBe(false);
  });
});
