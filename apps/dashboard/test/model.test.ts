import { describe, it, expect } from "vitest";
import type { VoiceEvent } from "@voxobs/schema";
import {
  applyEvent,
  buildSession,
  createSession,
  sessionDurationMs,
  turnMarkers,
  turnSegments,
  voiceToVoiceSeries,
  type SessionModel,
} from "../lib/model.js";

let seq = 0;
function ev(partial: Record<string, unknown> & { type: string }): VoiceEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId: "s1",
    seq: seq++,
    tOffsetMs: 0,
    timestamp: 1_700_000_000_000 + seq,
    ...partial,
  } as unknown as VoiceEvent;
}

function start(): SessionModel {
  return createSession(
    ev({
      type: "session_start",
      agentVersion: "1",
      providers: { stt: ["deepgram"], llm: ["qwen"], tts: ["deepgram-aura"] },
    }) as Extract<VoiceEvent, { type: "session_start" }>,
  );
}

function turn(model: SessionModel, events: VoiceEvent[]): SessionModel {
  return events.reduce(applyEvent, model);
}

describe("session model", () => {
  it("folds a full turn", () => {
    const model = turn(start(), [
      ev({ type: "turn_start", turnId: "t1", tOffsetMs: 1000 }),
      ev({ type: "speech_end", turnId: "t1", tOffsetMs: 2000 }),
      ev({ type: "stt_latency", turnId: "t1", tOffsetMs: 2200, provider: "deepgram", latencyMs: 200 }),
      ev({ type: "eou_delay", turnId: "t1", tOffsetMs: 2300, delayMs: 300 }),
      ev({ type: "llm_ttft", turnId: "t1", tOffsetMs: 2600, provider: "qwen", model: "m", promptTokens: 5, latencyMs: 200 }),
      ev({ type: "llm_end", turnId: "t1", tOffsetMs: 3000, provider: "qwen", outputTokens: 10, durationMs: 600 }),
      ev({ type: "tts_ttfb", turnId: "t1", tOffsetMs: 3200, provider: "aura", latencyMs: 300 }),
      ev({ type: "agent_audio_start", turnId: "t1", tOffsetMs: 3400, voiceToVoiceMs: 1400, source: "state_change" }),
      ev({ type: "turn_end", turnId: "t1", tOffsetMs: 4000 }),
    ]);

    expect(model.turns).toHaveLength(1);
    const t = model.turns[0]!;
    expect(t.turnId).toBe("t1");
    expect(t.sttLatencyMs).toBe(200);
    expect(t.llmRequestStartMs).toBe(2400);
    expect(t.voiceToVoiceMs).toBe(1400);
    expect(t.endMs).toBe(4000);

    const segments = turnSegments(t);
    expect(segments).toContainEqual({ kind: "stt", startMs: 2000, endMs: 2200 });
    expect(segments).toContainEqual({ kind: "eou", startMs: 2000, endMs: 2300 });
    expect(segments).toContainEqual({ kind: "llm", startMs: 2400, endMs: 3000 });
    expect(segments).toContainEqual({ kind: "tts", startMs: 2900, endMs: 3200 });
  });

  it("records failover and degraded markers", () => {
    const model = turn(start(), [
      ev({ type: "turn_start", turnId: "t1", tOffsetMs: 1000 }),
      ev({ type: "speech_end", turnId: "t1", tOffsetMs: 2000 }),
      ev({
        type: "provider_degraded",
        turnId: "t1",
        tOffsetMs: 2100,
        stage: "llm",
        provider: "qwen",
        metric: "ttft",
        thresholdMs: 800,
        observedMs: 1500,
      }),
      ev({
        type: "failover",
        turnId: "t1",
        tOffsetMs: 2600,
        stage: "llm",
        fromProvider: "qwen",
        toProvider: "gpt-oss",
        trigger: "degraded",
        recoveryMs: 420,
      }),
    ]);

    const markers = turnMarkers(model.turns[0]!);
    expect(markers.map((m) => m.kind)).toEqual(["degraded", "failover"]);
    expect(markers.find((m) => m.kind === "failover")?.label).toContain("420ms");
  });

  it("computes duration and voice-to-voice series", () => {
    let model = start();
    model = turn(model, [
      ev({ type: "turn_start", turnId: "t1", tOffsetMs: 1000 }),
      ev({ type: "agent_audio_start", turnId: "t1", tOffsetMs: 3000, voiceToVoiceMs: 1200, source: "state_change" }),
      ev({ type: "turn_end", turnId: "t1", tOffsetMs: 5000 }),
      ev({ type: "turn_start", turnId: "t2", tOffsetMs: 6000 }),
      ev({ type: "agent_audio_start", turnId: "t2", tOffsetMs: 8000, voiceToVoiceMs: 900, source: "state_change" }),
      ev({ type: "turn_end", turnId: "t2", tOffsetMs: 9000 }),
    ]);
    expect(voiceToVoiceSeries(model)).toEqual([1200, 900]);
    expect(sessionDurationMs(model)).toBeGreaterThanOrEqual(9000);
  });

  it("rebuilds a session truncated at a replay cursor", () => {
    const events: VoiceEvent[] = [
      ev({ type: "session_start", agentVersion: "1", providers: { stt: [], llm: [], tts: [] } }),
      ev({ type: "turn_start", turnId: "t1", tOffsetMs: 1000 }),
      ev({ type: "speech_end", turnId: "t1", tOffsetMs: 2000 }),
      ev({ type: "agent_audio_start", turnId: "t1", tOffsetMs: 3000, voiceToVoiceMs: 1000, source: "state_change" }),
      ev({ type: "turn_end", turnId: "t1", tOffsetMs: 4000 }),
    ];

    const full = buildSession(events);
    expect(full?.turns[0]?.endMs).toBe(4000);

    const partial = buildSession(events, 2500);
    expect(partial?.turns[0]?.speechEndMs).toBe(2000);
    expect(partial?.turns[0]?.audioStartMs).toBeNull();
    expect(partial?.turns[0]?.endMs).toBeNull();
  });
});
