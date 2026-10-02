import { describe, it, expect } from "vitest";
import { parseEvent } from "../src/index.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

function base(overrides: Record<string, unknown> = {}) {
  return {
    eventId: UUID,
    sessionId: "session-123",
    seq: 0,
    tOffsetMs: 0,
    timestamp: 1700000000000,
    ...overrides,
  };
}

const validSamples: Array<{ type: string; data: Record<string, unknown> }> = [
  {
    type: "session_start",
    data: base({
      type: "session_start",
      agentVersion: "1.0.0",
      providers: { stt: ["deepgram"], llm: ["groq"], tts: ["elevenlabs"] },
    }),
  },
  {
    type: "session_start",
    data: base({
      type: "session_start",
      agentVersion: "1.0.0",
      providers: { stt: [], llm: ["groq", "gemini"], tts: ["cartesia"] },
      acceptLatencyMs: 120,
      assignmentLatencyMs: 40,
    }),
  },
  { type: "session_end", data: base({ type: "session_end", reason: "disconnected" }) },
  { type: "turn_start", data: base({ type: "turn_start", turnId: "t1" }) },
  { type: "speech_end", data: base({ type: "speech_end", turnId: "t1" }) },
  { type: "eou_delay", data: base({ type: "eou_delay", turnId: "t1", delayMs: 250 }) },
  {
    type: "stt_latency",
    data: base({ type: "stt_latency", turnId: "t1", provider: "deepgram", latencyMs: 400 }),
  },
  {
    type: "llm_ttft",
    data: base({
      type: "llm_ttft",
      turnId: "t1",
      provider: "groq",
      model: "llama-3.1-8b",
      promptTokens: 12,
      latencyMs: 600,
    }),
  },
  {
    type: "llm_end",
    data: base({
      type: "llm_end",
      turnId: "t1",
      provider: "groq",
      outputTokens: 40,
      durationMs: 1200,
    }),
  },
  {
    type: "tts_ttfb",
    data: base({ type: "tts_ttfb", turnId: "t1", provider: "elevenlabs", latencyMs: 300 }),
  },
  {
    type: "agent_audio_start",
    data: base({
      type: "agent_audio_start",
      turnId: "t1",
      voiceToVoiceMs: 900,
      source: "state_change",
    }),
  },
  {
    type: "agent_audio_start",
    data: base({
      type: "agent_audio_start",
      turnId: "t1",
      voiceToVoiceMs: 900,
      source: "playback_hook",
    }),
  },
  { type: "turn_end", data: base({ type: "turn_end", turnId: "t1" }) },
  { type: "barge_in", data: base({ type: "barge_in", turnId: "t1", yieldMs: 80 }) },
  {
    type: "provider_degraded",
    data: base({
      type: "provider_degraded",
      turnId: "t1",
      stage: "llm",
      provider: "groq",
      metric: "ttft",
      thresholdMs: 1000,
      observedMs: 1500,
    }),
  },
  {
    type: "provider_failure",
    data: base({ type: "provider_failure", turnId: "t1", stage: "llm", provider: "groq", reason: "5xx" }),
  },
  {
    type: "provider_failure",
    data: base({
      type: "provider_failure",
      turnId: "t1",
      stage: "tts",
      provider: "elevenlabs",
      reason: "guardrail_latency",
      message: "ttfb exceeded threshold",
    }),
  },
  {
    type: "failover",
    data: base({
      type: "failover",
      turnId: "t1",
      stage: "llm",
      fromProvider: "groq",
      toProvider: "gemini",
      trigger: "error",
      recoveryMs: 300,
    }),
  },
  {
    type: "failover",
    data: base({
      type: "failover",
      turnId: "t1",
      stage: "tts",
      fromProvider: "elevenlabs",
      toProvider: "cartesia",
      trigger: "degraded",
      recoveryMs: 210,
    }),
  },
  {
    type: "provider_recovered",
    data: base({ type: "provider_recovered", stage: "stt", provider: "deepgram" }),
  },
];

describe("parseEvent", () => {
  it("parses a valid sample of every event type", () => {
    for (const sample of validSamples) {
      const parsed = parseEvent(sample.data);
      expect(parsed.type).toBe(sample.type);
    }
  });

  it("rejects an unknown event type", () => {
    expect(() => parseEvent(base({ type: "nonsense" }))).toThrow();
  });

  it("rejects an event missing a required field", () => {
    const withoutModel = {
      eventId: UUID,
      sessionId: "session-123",
      seq: 0,
      tOffsetMs: 0,
      timestamp: 1700000000000,
      type: "llm_ttft",
      turnId: "t1",
      provider: "groq",
      promptTokens: 12,
      latencyMs: 600,
    };
    expect(() => parseEvent(withoutModel)).toThrow();
  });

  it("rejects a negative latency", () => {
    expect(() =>
      parseEvent(base({ type: "tts_ttfb", turnId: "t1", provider: "x", latencyMs: -1 })),
    ).toThrow();
  });

  it("rejects a non-uuid eventId", () => {
    expect(() =>
      parseEvent(base({ eventId: "not-a-uuid", type: "turn_start", turnId: "t1" })),
    ).toThrow();
  });

  it("rejects a negative seq", () => {
    expect(() => parseEvent(base({ seq: -1, type: "turn_start", turnId: "t1" }))).toThrow();
  });

  it("rejects an invalid provider_degraded metric", () => {
    expect(() =>
      parseEvent(
        base({
          type: "provider_degraded",
          turnId: "t1",
          stage: "llm",
          provider: "groq",
          metric: "not-a-metric",
          thresholdMs: 1000,
          observedMs: 1500,
        }),
      ),
    ).toThrow();
  });

  it("rejects an invalid failover trigger", () => {
    expect(() =>
      parseEvent(
        base({
          type: "failover",
          turnId: "t1",
          stage: "llm",
          fromProvider: "a",
          toProvider: "b",
          trigger: "boom",
          recoveryMs: 100,
        }),
      ),
    ).toThrow();
  });

  it("rejects an empty sessionId", () => {
    expect(() =>
      parseEvent(base({ sessionId: "", type: "turn_start", turnId: "t1" })),
    ).toThrow();
  });
});
