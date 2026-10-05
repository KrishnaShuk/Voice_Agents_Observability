import { WsTransport } from "@voxobs/sdk";
import type { VoiceEvent } from "@voxobs/schema";

const url = process.env.INGEST_WS_URL ?? "ws://localhost:4000/ingest";
const apiKey = process.env.INGEST_API_KEY ?? "dev-key";
const sessionId = process.env.SESSION_ID ?? `fake-${crypto.randomUUID()}`;
const t0 = Date.now();
let seq = 0;

function ev(tOffsetMs: number, partial: Record<string, unknown> & { type: string }): VoiceEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId,
    seq: seq++,
    tOffsetMs,
    timestamp: t0 + tOffsetMs,
    ...partial,
  } as unknown as VoiceEvent;
}

// A virtual timeline (ms since session start) whose offsets match the latencies,
// so the dashboard renders realistic block positions.
const events: VoiceEvent[] = [
  ev(0, {
    type: "session_start",
    agentVersion: "0.0.0",
    providers: { stt: ["deepgram"], llm: ["groq"], tts: ["deepgram-aura"] },
  }),

  // turn 1 — healthy
  ev(0, { type: "turn_start", turnId: "t1" }),
  ev(1200, { type: "speech_end", turnId: "t1" }),
  ev(1380, { type: "eou_delay", turnId: "t1", delayMs: 180 }),
  ev(1520, { type: "stt_latency", turnId: "t1", provider: "deepgram", latencyMs: 320 }),
  ev(1940, {
    type: "llm_ttft",
    turnId: "t1",
    provider: "groq",
    model: "qwen/qwen3.8-27b",
    promptTokens: 24,
    latencyMs: 540,
  }),
  ev(2220, { type: "tts_ttfb", turnId: "t1", provider: "deepgram-aura", latencyMs: 260 }),
  ev(2400, { type: "agent_audio_start", turnId: "t1", voiceToVoiceMs: 1200, source: "state_change" }),
  ev(2840, { type: "llm_end", turnId: "t1", provider: "groq", outputTokens: 48, durationMs: 900 }),
  ev(3100, { type: "turn_end", turnId: "t1" }),

  // turn 2 — degraded -> failure -> failover
  ev(3500, { type: "turn_start", turnId: "t2" }),
  ev(4700, { type: "speech_end", turnId: "t2" }),
  ev(4900, {
    type: "provider_degraded",
    turnId: "t2",
    stage: "llm",
    provider: "groq",
    metric: "ttft",
    thresholdMs: 800,
    observedMs: 2100,
  }),
  ev(5000, {
    type: "provider_failure",
    turnId: "t2",
    stage: "llm",
    provider: "groq",
    reason: "guardrail_latency",
  }),
  ev(5440, {
    type: "failover",
    turnId: "t2",
    stage: "llm",
    fromProvider: "groq",
    toProvider: "openai/gpt-oss-20b",
    trigger: "degraded",
    recoveryMs: 420,
  }),
  ev(5900, { type: "turn_end", turnId: "t2" }),
  ev(6200, { type: "session_end", reason: "completed" }),
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const transport = new WsTransport({ url, apiKey, sessionId });

transport.start();
for (const event of events) {
  transport.send(event);
  await sleep(15);
}

const deadline = Date.now() + 5_000;
while (transport.pendingCount > 0 && Date.now() < deadline) {
  await sleep(50);
}

console.log(
  `session=${sessionId} sent=${events.length} pending=${transport.pendingCount} dropped=${transport.dropped}`,
);
transport.close();
