import type {
  AgentMetrics,
  AgentStateChangedEvent,
  MetricsCollectedEvent,
  UserInputTranscribedEvent,
  UserStateChangedEvent,
} from "@livekit/agents";
import type { EmittableDraft, Stage, VoiceEvent, VoiceEventDraft } from "@voxobs/schema";
import { WsTransport, type WsFactory } from "./transport.js";
import { monotonicNow, wallNow, type MonotonicClock, type WallClock } from "./clock.js";

export interface TrackerSession {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off?(event: string, listener: (...args: never[]) => void): unknown;
}

export interface TrackerSink {
  emit(draft: EmittableDraft): VoiceEvent;
}

export interface TrackerOptions {
  endpoint: string;
  apiKey: string;
  agentVersion: string;
  sessionId?: string;
  providers?: Partial<Record<Stage, string[]>>;
  transport?: WsTransport;
  socketFactory?: WsFactory;
  monotonic?: MonotonicClock;
  wallClock?: WallClock;
  installTracing?: boolean;
  logger?: (message: string) => void;
}

const DEFAULT_PROVIDERS: Record<Stage, string[]> = { stt: [], llm: [], tts: [] };

const TURN_SCOPED = new Set<string>([
  "turn_start",
  "speech_end",
  "eou_delay",
  "stt_latency",
  "llm_ttft",
  "llm_end",
  "tts_ttfb",
  "agent_audio_start",
  "turn_end",
  "barge_in",
  "provider_degraded",
  "provider_failure",
  "failover",
]);

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteInt(value: unknown, fallback = 0): number {
  return Math.max(0, Math.trunc(finite(value, fallback)));
}

export class Tracker {
  readonly sink: TrackerSink;

  private readonly transport: WsTransport;
  private readonly sessionId: string;
  private readonly agentVersion: string;
  private readonly providers: Record<Stage, string[]>;
  private readonly monotonic: MonotonicClock;
  private readonly wall: WallClock;
  private readonly installTracing: boolean;
  private readonly logger?: (message: string) => void;

  private readonly t0: number;
  private seq = 0;
  private attached = false;
  private closed = false;

  private currentTurnId: string | null = null;
  private speechEndOffsetMs: number | null = null;
  private pendingTranscriptOffset: number | null = null;
  private bargeInAtMs: number | null = null;
  private turnStartOffsetMs = 0;
  private readonly speechToTurn = new Map<string, string>();
  private lastAgentState = "idle";

  private readonly listeners: Array<[string, (...args: never[]) => void]> = [];

  constructor(options: TrackerOptions) {
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this.agentVersion = options.agentVersion;
    this.providers = {
      stt: options.providers?.stt ?? DEFAULT_PROVIDERS.stt,
      llm: options.providers?.llm ?? DEFAULT_PROVIDERS.llm,
      tts: options.providers?.tts ?? DEFAULT_PROVIDERS.tts,
    };
    this.monotonic = options.monotonic ?? monotonicNow;
    this.wall = options.wallClock ?? wallNow;
    this.installTracing = options.installTracing ?? true;
    this.logger = options.logger;
    this.t0 = this.monotonic();

    this.transport =
      options.transport ??
      new WsTransport({
        url: options.endpoint,
        apiKey: options.apiKey,
        sessionId: this.sessionId,
        socketFactory: options.socketFactory,
      });

    this.sink = { emit: (draft) => this.emit(draft) };
  }

  get id(): string {
    return this.sessionId;
  }

  attach(session: TrackerSession): void {
    if (this.attached) return;
    this.attached = true;

    this.transport.start();
    this.emit({
      type: "session_start",
      agentVersion: this.agentVersion,
      providers: this.providers,
    });

    this.bind(session, "user_state_changed", (event) =>
      this.onUserState(event as UserStateChangedEvent),
    );
    this.bind(session, "user_input_transcribed", (event) =>
      this.onUserInputTranscribed(event as UserInputTranscribedEvent),
    );
    this.bind(session, "metrics_collected", (event) =>
      this.onMetricsCollected(event as MetricsCollectedEvent),
    );
    this.bind(session, "agent_state_changed", (event) =>
      this.onAgentState(event as AgentStateChangedEvent),
    );
    this.bind(session, "overlapping_speech", (event) => this.onOverlappingSpeech(event));
    this.bind(session, "agent_false_interruption", () => this.onFalseInterruption());

    if (this.installTracing) {
      void import("./span_processor.js")
        .then(({ installLiveKitTracing, createSpanProcessor }) =>
          installLiveKitTracing(createSpanProcessor()),
        )
        .catch((err) => this.logger?.(`tracing install failed: ${String(err)}`));
    }
  }

  shutdown(reason = "shutdown"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.attached) this.emit({ type: "session_end", reason });
    this.transport.close();
  }

  emit(draft: EmittableDraft | VoiceEventDraft, atOffset?: number): VoiceEvent {
    const needsTurn = TURN_SCOPED.has(draft.type) && !("turnId" in draft);
    const withTurn = needsTurn
      ? { ...(draft as object), turnId: this.currentTurnId ?? this.openTurn() }
      : draft;
    const event = {
      eventId: crypto.randomUUID(),
      sessionId: this.sessionId,
      seq: this.seq,
      tOffsetMs: atOffset ?? this.offset(),
      timestamp: this.wall(),
      ...withTurn,
    } as VoiceEvent;
    this.seq += 1;
    this.transport.send(event);
    return event;
  }

  private offset(): number {
    return this.monotonic() - this.t0;
  }

  private bind(
    session: TrackerSession,
    event: string,
    handler: (...args: never[]) => void,
  ): void {
    session.on(event, handler);
    this.listeners.push([event, handler]);
  }

  private openTurn(): string {
    if (this.currentTurnId) return this.currentTurnId;
    this.currentTurnId = crypto.randomUUID();
    this.turnStartOffsetMs = this.offset();
    this.emit({ type: "turn_start", turnId: this.currentTurnId });
    return this.currentTurnId;
  }

  private closeTurn(): void {
    if (!this.currentTurnId) return;
    this.emit({ type: "turn_end", turnId: this.currentTurnId });
    this.currentTurnId = null;
    this.speechEndOffsetMs = null;
    this.pendingTranscriptOffset = null;
    this.bargeInAtMs = null;
  }

  private turnForSpeech(speechId: string | undefined): string {
    if (speechId) {
      const existing = this.speechToTurn.get(speechId);
      if (existing) return existing;
    }
    const turnId = this.openTurn();
    if (speechId) this.speechToTurn.set(speechId, turnId);
    return turnId;
  }

  private onUserState(event: UserStateChangedEvent): void {
    if (event.newState === "speaking") {
      // VAD-based barge-in: the user starts talking while the agent is speaking.
      if (this.lastAgentState === "speaking" && this.bargeInAtMs === null) {
        this.bargeInAtMs = this.offset();
      }
      if (!this.currentTurnId) this.openTurn();
    }
  }

  private onOverlappingSpeech(event: { isInterruption?: boolean }): void {
    // Adaptive interruption detector (cloud) — authoritative when available.
    if (event.isInterruption && this.bargeInAtMs === null) {
      this.bargeInAtMs = this.offset();
    }
  }

  private onFalseInterruption(): void {
    // The "interruption" was noise; do not emit a barge-in.
    this.bargeInAtMs = null;
  }

  private onUserInputTranscribed(event: UserInputTranscribedEvent): void {
    if (!event.isFinal || event.transcript.length === 0) return;
    this.pendingTranscriptOffset = this.offset();
  }

  private onAgentState(event: AgentStateChangedEvent): void {
    const wasSpeaking = this.lastAgentState === "speaking";
    this.lastAgentState = event.newState;

    if (event.newState === "speaking" && event.oldState !== "speaking") {
      const turnId = this.openTurn();
      const from = this.speechEndOffsetMs ?? this.turnStartOffsetMs;
      this.emit({
        type: "agent_audio_start",
        turnId,
        voiceToVoiceMs: Math.max(0, this.offset() - from),
        source: "state_change",
      });
    } else if (wasSpeaking && event.newState !== "speaking") {
      if (this.bargeInAtMs !== null) {
        const turnId = this.currentTurnId ?? this.openTurn();
        this.emit({ type: "barge_in", turnId, yieldMs: Math.max(0, this.offset() - this.bargeInAtMs) });
        this.bargeInAtMs = null;
      }
      this.closeTurn();
    }
  }

  private onMetricsCollected(event: MetricsCollectedEvent): void {
    this.onMetric(event.metrics);
  }

  private onMetric(metrics: AgentMetrics): void {
    switch (metrics.type) {
      case "eou_metrics": {
        const turnId = this.turnForSpeech(metrics.speechId);
        const eouDelay = finite(metrics.endOfUtteranceDelayMs);
        const speechEndOffset = Math.max(0, this.offset() - eouDelay);
        this.speechEndOffsetMs = speechEndOffset;

        let sttDelay = finite(metrics.transcriptionDelayMs);
        if (sttDelay <= 0 && this.pendingTranscriptOffset !== null) {
          sttDelay = Math.max(0, this.pendingTranscriptOffset - speechEndOffset);
        }

        this.emit({ type: "speech_end", turnId }, speechEndOffset);
        this.emit(
          {
            type: "stt_latency",
            turnId,
            provider: this.providers.stt[0] ?? "unknown",
            latencyMs: sttDelay,
          },
          speechEndOffset + sttDelay,
        );
        this.emit({ type: "eou_delay", turnId, delayMs: eouDelay });
        this.pendingTranscriptOffset = null;
        break;
      }
      case "llm_metrics": {
        const turnId = this.turnForSpeech(metrics.speechId);
        const provider = metrics.metadata?.modelProvider ?? this.providers.llm[0] ?? "unknown";
        const model = metrics.metadata?.modelName ?? "unknown";
        this.emit({
          type: "llm_ttft",
          turnId,
          provider,
          model,
          promptTokens: finiteInt(metrics.promptTokens),
          latencyMs: finite(metrics.ttftMs),
        });
        this.emit({
          type: "llm_end",
          turnId,
          provider,
          outputTokens: finiteInt(metrics.completionTokens),
          durationMs: finite(metrics.durationMs),
        });
        break;
      }
      case "tts_metrics": {
        const turnId = this.turnForSpeech(metrics.speechId);
        this.emit({
          type: "tts_ttfb",
          turnId,
          provider: metrics.metadata?.modelProvider ?? this.providers.tts[0] ?? "unknown",
          latencyMs: finite(metrics.ttfbMs),
        });
        break;
      }
      default:
        break;
    }
  }
}

export function createTracker(options: TrackerOptions): Tracker {
  return new Tracker(options);
}
