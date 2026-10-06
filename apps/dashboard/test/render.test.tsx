import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceEvent } from "@voxobs/schema";
import { buildSession } from "../lib/model";
import { Timeline } from "../components/Timeline";
import { StatTiles } from "../components/StatTiles";
import { VoiceToVoiceChart } from "../components/VoiceToVoiceChart";

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

function syntheticSession(): VoiceEvent[] {
  return [
    ev({ type: "session_start", agentVersion: "1", providers: { stt: ["deepgram"], llm: ["qwen"], tts: ["deepgram-aura"] } }),
    ev({ type: "turn_start", turnId: "t1", tOffsetMs: 0 }),
    ev({ type: "speech_end", turnId: "t1", tOffsetMs: 1200 }),
    ev({ type: "eou_delay", turnId: "t1", tOffsetMs: 1380, delayMs: 180 }),
    ev({ type: "stt_latency", turnId: "t1", tOffsetMs: 1520, provider: "deepgram", latencyMs: 320 }),
    ev({ type: "llm_ttft", turnId: "t1", tOffsetMs: 1940, provider: "groq", model: "qwen", promptTokens: 5, latencyMs: 540 }),
    ev({ type: "llm_end", turnId: "t1", tOffsetMs: 2840, provider: "groq", outputTokens: 20, durationMs: 900 }),
    ev({ type: "tts_ttfb", turnId: "t1", tOffsetMs: 2220, provider: "aura", latencyMs: 260 }),
    ev({ type: "agent_audio_start", turnId: "t1", tOffsetMs: 2400, voiceToVoiceMs: 1200, source: "state_change" }),
    ev({ type: "turn_end", turnId: "t1", tOffsetMs: 3100 }),
  ];
}

describe("dashboard renders synthetic data", () => {
  const model = buildSession(syntheticSession())!;

  it("Timeline renders turn rows and segments", () => {
    const html = renderToStaticMarkup(<Timeline turns={model.turns} domainStartMs={model.startMs} />);
    expect(html).toContain("trace");
    expect(html).toContain("seg-stt");
    expect(html).toContain("seg-llm");
    expect(html).toContain("seg-tts");
  });

  it("StatTiles renders the four metrics", () => {
    const html = renderToStaticMarkup(<StatTiles model={model} />);
    expect(html).toContain("320");
    expect(html).toContain("540");
    expect(html).toContain("260");
    expect(html).toContain("1200");
  });

  it("VoiceToVoiceChart renders an svg", () => {
    const html = renderToStaticMarkup(<VoiceToVoiceChart model={model} />);
    expect(html).toContain("<svg");
  });
});
