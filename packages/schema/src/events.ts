import { z } from "zod";

export const Stage = z.enum(["stt", "llm", "tts"]);
export type Stage = z.infer<typeof Stage>;

export const FailReason = z.enum([
  "timeout",
  "5xx",
  "rate_limit",
  "conn_error",
  "guardrail_latency",
]);
export type FailReason = z.infer<typeof FailReason>;

export const Metric = z.enum(["ttft", "ttfb", "stt_final"]);
export type Metric = z.infer<typeof Metric>;

export const FailoverTrigger = z.enum(["error", "degraded"]);
export type FailoverTrigger = z.infer<typeof FailoverTrigger>;

export const AudioStartSource = z.enum(["state_change", "playback_hook"]);
export type AudioStartSource = z.infer<typeof AudioStartSource>;

const BaseSchema = z.object({
  eventId: z.string().uuid(),
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  tOffsetMs: z.number().nonnegative(),
  timestamp: z.number().nonnegative(),
});

const ProvidersSchema = z.object({
  stt: z.array(z.string()),
  llm: z.array(z.string()),
  tts: z.array(z.string()),
});

export const VoiceEventSchema = z.discriminatedUnion("type", [
  BaseSchema.extend({
    type: z.literal("session_start"),
    agentVersion: z.string().min(1),
    providers: ProvidersSchema,
    acceptLatencyMs: z.number().nonnegative().optional(),
    assignmentLatencyMs: z.number().nonnegative().optional(),
  }),
  BaseSchema.extend({
    type: z.literal("session_end"),
    reason: z.string().min(1),
  }),
  BaseSchema.extend({
    type: z.literal("turn_start"),
    turnId: z.string().min(1),
  }),
  BaseSchema.extend({
    type: z.literal("speech_end"),
    turnId: z.string().min(1),
  }),
  BaseSchema.extend({
    type: z.literal("eou_delay"),
    turnId: z.string().min(1),
    delayMs: z.number().nonnegative(),
  }),
  BaseSchema.extend({
    type: z.literal("stt_latency"),
    turnId: z.string().min(1),
    provider: z.string().min(1),
    latencyMs: z.number().nonnegative(),
  }),
  BaseSchema.extend({
    type: z.literal("llm_ttft"),
    turnId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    promptTokens: z.number().int().nonnegative(),
    latencyMs: z.number().nonnegative(),
  }),
  BaseSchema.extend({
    type: z.literal("llm_end"),
    turnId: z.string().min(1),
    provider: z.string().min(1),
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
  }),
  BaseSchema.extend({
    type: z.literal("tts_ttfb"),
    turnId: z.string().min(1),
    provider: z.string().min(1),
    latencyMs: z.number().nonnegative(),
  }),
  BaseSchema.extend({
    type: z.literal("agent_audio_start"),
    turnId: z.string().min(1),
    voiceToVoiceMs: z.number().nonnegative(),
    source: AudioStartSource,
  }),
  BaseSchema.extend({
    type: z.literal("turn_end"),
    turnId: z.string().min(1),
  }),
  BaseSchema.extend({
    type: z.literal("barge_in"),
    turnId: z.string().min(1),
    yieldMs: z.number().nonnegative(),
  }),
  BaseSchema.extend({
    type: z.literal("provider_degraded"),
    turnId: z.string().min(1),
    stage: Stage,
    provider: z.string().min(1),
    metric: Metric,
    thresholdMs: z.number().nonnegative(),
    observedMs: z.number().nonnegative(),
  }),
  BaseSchema.extend({
    type: z.literal("provider_failure"),
    turnId: z.string().min(1),
    stage: Stage,
    provider: z.string().min(1),
    reason: FailReason,
    message: z.string().optional(),
  }),
  BaseSchema.extend({
    type: z.literal("failover"),
    turnId: z.string().min(1),
    stage: Stage,
    fromProvider: z.string().min(1),
    toProvider: z.string().min(1),
    trigger: FailoverTrigger,
    recoveryMs: z.number().nonnegative(),
  }),
  BaseSchema.extend({
    type: z.literal("provider_recovered"),
    stage: Stage,
    provider: z.string().min(1),
  }),
]);

export type VoiceEvent = z.infer<typeof VoiceEventSchema>;

export function parseEvent(data: unknown): VoiceEvent {
  return VoiceEventSchema.parse(data);
}
