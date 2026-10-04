import type { Stage } from "@voxobs/schema";

export interface GuardrailConfig {
  /** Max time-to-first-token before the LLM trips (ms). */
  ttftMs?: number;
  /** Max time-to-first-audio-byte before the TTS trips (ms). */
  ttfbMs?: number;
  /** Max speech-end -> final transcript before an STT turn counts as slow (ms). */
  sttFinalMs?: number;
  /** Slow observations before declaring a provider degraded (default 1; use 2+ for STT). */
  consecutive?: number;
  /** Fast observations needed before a degraded provider is healthy again (default 1). */
  recoverAfter?: number;
}

export type InjectionMode = "timeout" | "error" | "slow";

export interface InjectionRequest {
  mode: InjectionMode;
  delayMs?: number;
}

/** Decides whether the next call to a provider should be faulted. */
export interface FailureInjector {
  next(provider: string, stage: Stage): InjectionRequest | null;
}
