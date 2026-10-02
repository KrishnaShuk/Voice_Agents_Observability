import type { VoiceEvent } from "@voxobs/schema";

const T0 = 1_700_000_000_000;

export type Providers = { stt: string[]; llm: string[]; tts: string[] };

function base(sessionId: string, seq: number) {
  return {
    eventId: crypto.randomUUID(),
    sessionId,
    seq,
    tOffsetMs: seq * 100,
    timestamp: T0 + seq * 100,
  };
}

export function sessionStart(
  sessionId: string,
  seq: number,
  providers: Providers = { stt: ["deepgram"], llm: ["groq"], tts: ["elevenlabs"] },
): VoiceEvent {
  return { ...base(sessionId, seq), type: "session_start", agentVersion: "test", providers };
}

export function sessionEnd(sessionId: string, seq: number, reason = "completed"): VoiceEvent {
  return { ...base(sessionId, seq), type: "session_end", reason };
}

export function turnStart(sessionId: string, seq: number, turnId: string): VoiceEvent {
  return { ...base(sessionId, seq), type: "turn_start", turnId };
}

export function turnEnd(sessionId: string, seq: number, turnId: string): VoiceEvent {
  return { ...base(sessionId, seq), type: "turn_end", turnId };
}

export function speechEnd(sessionId: string, seq: number, turnId: string): VoiceEvent {
  return { ...base(sessionId, seq), type: "speech_end", turnId };
}

export function failover(sessionId: string, seq: number, turnId: string): VoiceEvent {
  return {
    ...base(sessionId, seq),
    type: "failover",
    turnId,
    stage: "llm",
    fromProvider: "groq",
    toProvider: "gemini",
    trigger: "error",
    recoveryMs: 300,
  };
}

export function sttLatency(
  sessionId: string,
  seq: number,
  turnId: string,
  latencyMs: number,
  provider = "deepgram",
): VoiceEvent {
  return { ...base(sessionId, seq), type: "stt_latency", turnId, provider, latencyMs };
}

export function llmTtft(
  sessionId: string,
  seq: number,
  turnId: string,
  latencyMs: number,
  provider = "groq",
): VoiceEvent {
  return {
    ...base(sessionId, seq),
    type: "llm_ttft",
    turnId,
    provider,
    model: "llama",
    promptTokens: 5,
    latencyMs,
  };
}

export function ttsTtfb(
  sessionId: string,
  seq: number,
  turnId: string,
  latencyMs: number,
  provider = "elevenlabs",
): VoiceEvent {
  return { ...base(sessionId, seq), type: "tts_ttfb", turnId, provider, latencyMs };
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitUntil timed out");
}
