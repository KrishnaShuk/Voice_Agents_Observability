import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { VoiceEvent } from "@voxobs/schema";
import { WsTransport } from "../src/transport.js";
import { createTracker, type TrackerSession } from "../src/tracker.js";

class FakeTransport {
  readonly events: VoiceEvent[] = [];
  started = false;
  closed = false;

  start(): void {
    this.started = true;
  }

  send(event: VoiceEvent): void {
    this.events.push(event);
  }

  close(): void {
    this.closed = true;
  }
}

function setup() {
  const emitter = new EventEmitter();
  const transport = new FakeTransport();
  let clock = 1000;

  const tracker = createTracker({
    endpoint: "ws://unused",
    apiKey: "k",
    agentVersion: "test",
    sessionId: "s1",
    providers: { stt: ["deepgram"], llm: ["groq"], tts: ["elevenlabs"] },
    transport: transport as unknown as WsTransport,
    monotonic: () => clock,
    wallClock: () => 1_700_000_000_000 + clock,
    installTracing: false,
  });

  const advance = (ms: number) => {
    clock += ms;
  };

  return { emitter, tracker, transport, advance };
}

describe("Tracker", () => {
  it("assembles a full turn from session events and metrics", () => {
    const { emitter, tracker, transport, advance } = setup();
    tracker.attach(emitter as unknown as TrackerSession);

    advance(10);
    emitter.emit("user_state_changed", { type: "user_state_changed", oldState: "listening", newState: "speaking", createdAt: 0 });

    advance(1000);
    emitter.emit("user_state_changed", { type: "user_state_changed", oldState: "speaking", newState: "listening", createdAt: 0 });

    advance(200);
    emitter.emit("user_input_transcribed", { transcript: "hello", isFinal: true, itemId: "i1", speakerId: null, language: null, createdAt: 0 });

    advance(5);
    emitter.emit("metrics_collected", {
      type: "metrics_collected",
      createdAt: 0,
      metrics: {
        type: "eou_metrics",
        timestamp: 0,
        endOfUtteranceDelayMs: 120,
        transcriptionDelayMs: 200,
        onUserTurnCompletedDelayMs: 0,
        lastSpeakingTimeMs: 0,
        speechId: "sp1",
      },
    });

    advance(300);
    emitter.emit("metrics_collected", {
      type: "metrics_collected",
      createdAt: 0,
      metrics: {
        type: "llm_metrics",
        label: "groq",
        requestId: "r1",
        timestamp: 0,
        durationMs: 800,
        ttftMs: 300,
        cancelled: false,
        completionTokens: 20,
        promptTokens: 10,
        promptCachedTokens: 0,
        totalTokens: 30,
        tokensPerSecond: 25,
        speechId: "sp1",
        metadata: { modelProvider: "groq", modelName: "llama-3.1-8b" },
      },
    });

    advance(150);
    emitter.emit("metrics_collected", {
      type: "metrics_collected",
      createdAt: 0,
      metrics: {
        type: "tts_metrics",
        label: "elevenlabs",
        requestId: "r2",
        timestamp: 0,
        ttfbMs: 150,
        durationMs: 400,
        audioDurationMs: 900,
        cancelled: false,
        charactersCount: 5,
        streamed: true,
        speechId: "sp1",
        metadata: { modelProvider: "elevenlabs" },
      },
    });

    advance(50);
    emitter.emit("agent_state_changed", { type: "agent_state_changed", oldState: "thinking", newState: "speaking", createdAt: 0 });

    advance(500);
    emitter.emit("agent_state_changed", { type: "agent_state_changed", oldState: "speaking", newState: "listening", createdAt: 0 });

    const types = transport.events.map((event) => event.type);
    expect(types).toEqual([
      "session_start",
      "turn_start",
      "speech_end",
      "stt_latency",
      "eou_delay",
      "llm_ttft",
      "llm_end",
      "tts_ttfb",
      "agent_audio_start",
      "turn_end",
    ]);

    const turnIds = new Set(
      transport.events
        .filter((event) => "turnId" in event)
        .map((event) => (event as { turnId: string }).turnId),
    );
    expect(turnIds.size).toBe(1);

    const stt = transport.events.find((event) => event.type === "stt_latency");
    expect(stt && "latencyMs" in stt ? stt.latencyMs : -1).toBe(200);

    const audio = transport.events.find((event) => event.type === "agent_audio_start");
    expect(audio && "voiceToVoiceMs" in audio ? audio.voiceToVoiceMs : -1).toBe(620);

    const seqs = transport.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(transport.started).toBe(true);
  });

  it("emits session_end and closes the transport on shutdown", () => {
    const { emitter, tracker, transport } = setup();
    tracker.attach(emitter as unknown as TrackerSession);
    tracker.shutdown("user_initiated");

    expect(transport.events.at(-1)?.type).toBe("session_end");
    expect(transport.closed).toBe(true);
  });

  it("does not attach twice", () => {
    const { emitter, tracker, transport } = setup();
    tracker.attach(emitter as unknown as TrackerSession);
    tracker.attach(emitter as unknown as TrackerSession);
    expect(transport.events.filter((event) => event.type === "session_start")).toHaveLength(1);
  });
});
