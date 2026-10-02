import { WsTransport } from "@voxobs/sdk";
import type { VoiceEvent } from "@voxobs/schema";

const url = process.env.INGEST_WS_URL ?? "ws://localhost:4000/ingest";
const apiKey = process.env.INGEST_API_KEY ?? "dev-key";
const sessionId = process.env.SESSION_ID ?? `fake-${crypto.randomUUID()}`;
const t0 = Date.now();
let seq = 0;

function ev(partial: Record<string, unknown> & { type: string }): VoiceEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId,
    seq: seq++,
    tOffsetMs: Date.now() - t0,
    timestamp: Date.now(),
    ...partial,
  } as unknown as VoiceEvent;
}

const events: VoiceEvent[] = [
  ev({
    type: "session_start",
    agentVersion: "0.0.0",
    providers: { stt: ["deepgram"], llm: ["groq"], tts: ["elevenlabs"] },
  }),
  ev({ type: "turn_start", turnId: "t1" }),
  ev({ type: "speech_end", turnId: "t1" }),
  ev({ type: "eou_delay", turnId: "t1", delayMs: 180 }),
  ev({ type: "stt_latency", turnId: "t1", provider: "deepgram", latencyMs: 320 }),
  ev({
    type: "llm_ttft",
    turnId: "t1",
    provider: "groq",
    model: "llama-3.1-8b",
    promptTokens: 24,
    latencyMs: 540,
  }),
  ev({ type: "tts_ttfb", turnId: "t1", provider: "elevenlabs", latencyMs: 260 }),
  ev({ type: "agent_audio_start", turnId: "t1", voiceToVoiceMs: 1200, source: "state_change" }),
  ev({ type: "llm_end", turnId: "t1", provider: "groq", outputTokens: 48, durationMs: 900 }),
  ev({ type: "turn_end", turnId: "t1" }),
  ev({ type: "turn_start", turnId: "t2" }),
  ev({ type: "speech_end", turnId: "t2" }),
  ev({
    type: "provider_degraded",
    turnId: "t2",
    stage: "llm",
    provider: "groq",
    metric: "ttft",
    thresholdMs: 800,
    observedMs: 2100,
  }),
  ev({
    type: "provider_failure",
    turnId: "t2",
    stage: "llm",
    provider: "groq",
    reason: "guardrail_latency",
  }),
  ev({
    type: "failover",
    turnId: "t2",
    stage: "llm",
    fromProvider: "groq",
    toProvider: "gemini",
    trigger: "degraded",
    recoveryMs: 420,
  }),
  ev({ type: "turn_end", turnId: "t2" }),
  ev({ type: "session_end", reason: "completed" }),
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const transport = new WsTransport({ url, apiKey, sessionId });

transport.start();
for (const event of events) {
  transport.send(event);
  await sleep(20);
}

const deadline = Date.now() + 5_000;
while (transport.pendingCount > 0 && Date.now() < deadline) {
  await sleep(50);
}

console.log(
  `session=${sessionId} sent=${events.length} pending=${transport.pendingCount} dropped=${transport.dropped}`,
);
transport.close();
