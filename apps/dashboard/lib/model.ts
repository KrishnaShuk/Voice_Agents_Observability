import type { VoiceEvent } from "@voxobs/schema";

export type SegmentKind = "eou" | "stt" | "llm" | "tts";
export type MarkerKind = "barge_in" | "degraded" | "failure" | "failover" | "audio_start";

export interface Segment {
  kind: SegmentKind;
  startMs: number;
  endMs: number;
}

export interface Marker {
  kind: MarkerKind;
  tMs: number;
  label?: string;
}

export interface Turn {
  turnId: string;
  startMs: number;
  endMs: number | null;
  speechEndMs: number | null;
  sttLatencyMs: number | null;
  eouDelayMs: number | null;
  llmRequestStartMs: number | null;
  llmEndMs: number | null;
  llmTtftMs: number | null;
  ttsTtfbStartMs: number | null;
  ttsTtfbMs: number | null;
  audioStartMs: number | null;
  voiceToVoiceMs: number | null;
  bargeInMs: number | null;
  degraded: { provider: string; metric: string; observedMs: number; thresholdMs: number } | null;
  failure: { provider: string; reason: string } | null;
  failover: { fromProvider: string; toProvider: string; trigger: string; recoveryMs: number } | null;
}

export interface SessionModel {
  sessionId: string;
  agentVersion: string;
  providers: Record<string, string[]>;
  startMs: number;
  endReason: string | null;
  turns: Turn[];
}

export function createSession(event: Extract<VoiceEvent, { type: "session_start" }>): SessionModel {
  return {
    sessionId: event.sessionId,
    agentVersion: event.agentVersion,
    providers: event.providers,
    startMs: event.tOffsetMs,
    endReason: null,
    turns: [],
  };
}

function emptyTurn(turnId: string, startMs: number): Turn {
  return {
    turnId,
    startMs,
    endMs: null,
    speechEndMs: null,
    sttLatencyMs: null,
    eouDelayMs: null,
    llmRequestStartMs: null,
    llmEndMs: null,
    llmTtftMs: null,
    ttsTtfbStartMs: null,
    ttsTtfbMs: null,
    audioStartMs: null,
    voiceToVoiceMs: null,
    bargeInMs: null,
    degraded: null,
    failure: null,
    failover: null,
  };
}

export function applyEvent(model: SessionModel, event: VoiceEvent): SessionModel {
  if (event.type === "session_start") return createSession(event);
  if (event.type === "session_end") return { ...model, endReason: event.reason };
  if (!("turnId" in event)) return model;

  const turns = model.turns.slice();
  let index = turns.findIndex((turn) => turn.turnId === event.turnId);
  if (index === -1) {
    turns.push(emptyTurn(event.turnId, event.tOffsetMs));
    index = turns.length - 1;
  }

  const turn: Turn = { ...(turns[index] as Turn) };
  const t = event.tOffsetMs;

  switch (event.type) {
    case "turn_start":
      turn.startMs = t;
      break;
    case "speech_end":
      turn.speechEndMs = t;
      break;
    case "stt_latency":
      turn.sttLatencyMs = event.latencyMs;
      break;
    case "eou_delay":
      turn.eouDelayMs = event.delayMs;
      break;
    case "llm_ttft":
      turn.llmTtftMs = event.latencyMs;
      turn.llmRequestStartMs = t - event.latencyMs;
      break;
    case "llm_end":
      turn.llmEndMs = t;
      break;
    case "tts_ttfb":
      turn.ttsTtfbMs = event.latencyMs;
      turn.ttsTtfbStartMs = t - event.latencyMs;
      break;
    case "agent_audio_start":
      turn.audioStartMs = t;
      turn.voiceToVoiceMs = event.voiceToVoiceMs;
      break;
    case "turn_end":
      turn.endMs = t;
      break;
    case "barge_in":
      turn.bargeInMs = t;
      break;
    case "provider_degraded":
      turn.degraded = {
        provider: event.provider,
        metric: event.metric,
        observedMs: event.observedMs,
        thresholdMs: event.thresholdMs,
      };
      break;
    case "provider_failure":
      turn.failure = { provider: event.provider, reason: event.reason };
      break;
    case "failover":
      turn.failover = {
        fromProvider: event.fromProvider,
        toProvider: event.toProvider,
        trigger: event.trigger,
        recoveryMs: event.recoveryMs,
      };
      break;
    default:
      break;
  }

  turns[index] = turn;
  return { ...model, turns };
}

export function turnSegments(turn: Turn): Segment[] {
  const segments: Segment[] = [];
  if (turn.speechEndMs !== null) {
    if (turn.eouDelayMs !== null) {
      segments.push({ kind: "eou", startMs: turn.speechEndMs, endMs: turn.speechEndMs + turn.eouDelayMs });
    }
    if (turn.sttLatencyMs !== null) {
      segments.push({ kind: "stt", startMs: turn.speechEndMs, endMs: turn.speechEndMs + turn.sttLatencyMs });
    }
  }
  if (turn.llmRequestStartMs !== null && turn.llmEndMs !== null) {
    segments.push({ kind: "llm", startMs: turn.llmRequestStartMs, endMs: turn.llmEndMs });
  }
  if (turn.ttsTtfbStartMs !== null && turn.ttsTtfbMs !== null) {
    segments.push({ kind: "tts", startMs: turn.ttsTtfbStartMs, endMs: turn.ttsTtfbStartMs + turn.ttsTtfbMs });
  }
  return segments;
}

export function turnMarkers(turn: Turn): Marker[] {
  const markers: Marker[] = [];
  const anchor = turn.speechEndMs ?? turn.startMs;
  if (turn.degraded) {
    markers.push({ kind: "degraded", tMs: anchor, label: `${turn.degraded.metric} ${turn.degraded.observedMs.toFixed(0)}ms` });
  }
  if (turn.failure) {
    markers.push({ kind: "failure", tMs: anchor, label: turn.failure.reason });
  }
  if (turn.failover) {
    markers.push({
      kind: "failover",
      tMs: turn.audioStartMs ?? anchor,
      label: `${turn.failover.fromProvider}→${turn.failover.toProvider} ${turn.failover.recoveryMs.toFixed(0)}ms`,
    });
  }
  if (turn.bargeInMs !== null) {
    markers.push({ kind: "barge_in", tMs: turn.bargeInMs, label: "barge-in" });
  }
  return markers;
}

export function sessionDurationMs(model: SessionModel): number {
  let max = model.startMs;
  for (const turn of model.turns) {
    for (const value of [turn.endMs, turn.audioStartMs, turn.llmEndMs, turn.speechEndMs]) {
      if (value !== null && value > max) max = value;
    }
  }
  return Math.max(1000, max - model.startMs + 300);
}

export function latestTurn(model: SessionModel): Turn | null {
  return model.turns.length > 0 ? (model.turns[model.turns.length - 1] as Turn) : null;
}

export function voiceToVoiceSeries(model: SessionModel): number[] {
  return model.turns
    .map((turn) => turn.voiceToVoiceMs)
    .filter((value): value is number => value !== null);
}
