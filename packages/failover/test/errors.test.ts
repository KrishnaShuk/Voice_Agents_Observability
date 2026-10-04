import { describe, it, expect } from "vitest";
import { classifyError, LatencyGuardrailError } from "../src/errors.js";

describe("classifyError", () => {
  it("classifies guardrail errors", () => {
    expect(classifyError(new LatencyGuardrailError("slow"))).toBe("guardrail_latency");
  });

  it("maps HTTP status codes", () => {
    expect(classifyError({ status: 429 })).toBe("rate_limit");
    expect(classifyError({ status: 500 })).toBe("5xx");
    expect(classifyError({ status: 503 })).toBe("5xx");
    expect(classifyError({ response: { status: 502 } })).toBe("5xx");
    expect(classifyError({ status: 408 })).toBe("timeout");
  });

  it("maps timeouts and aborts", () => {
    const abort = new Error("the operation was aborted");
    abort.name = "AbortError";
    expect(classifyError(abort)).toBe("timeout");
    expect(classifyError(new Error("request timed out"))).toBe("timeout");
  });

  it("defaults to conn_error", () => {
    expect(classifyError(new Error("boom"))).toBe("conn_error");
  });
});

describe("LatencyGuardrailError", () => {
  it("is a terminal APIError", () => {
    const error = new LatencyGuardrailError("x");
    expect(error.retryable).toBe(false);
    expect(error.name).toBe("LatencyGuardrailError");
  });
});
