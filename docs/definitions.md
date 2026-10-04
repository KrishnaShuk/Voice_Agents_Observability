# Metric Definitions

Every metric that appears in the dashboard is defined here. No metric may be
rendered before it has an entry in this file.

## Event envelope

Every event carries these fields:

| Field | Meaning |
|---|---|
| `eventId` | Unique UUID for this event (idempotency + dedup). |
| `sessionId` | The voice session this event belongs to. |
| `seq` | Per-session, monotonic, starts at 0. Ordering and replay key. |
| `tOffsetMs` | Monotonic ms since `session_start`, at the moment the described thing began (for point events, when it happened). Drives timeline positioning and replay. |
| `timestamp` | Wall-clock time (display only; never used for durations). |

## Timing definitions

- `speech_end`: VAD end-of-speech for the user's turn.
- `eou_delay`: native EOU metric: end of speech → end-of-utterance decision.
- `stt_latency`: `speech_end` → final transcript. Computed by the SDK.
- `llm_ttft`: LLM request start → first token (from `llm_node` span / native metric).
- `tts_ttfb`: text sent → first audio frame from the provider (native).
- `agent_audio_start`: agent state changes to `speaking`. Approximation of first frame published to the room; `source` says which hook produced it.
- `voiceToVoiceMs`: `speech_end` → `agent_audio_start`.
- `recoveryMs`: failure or degradation detected in the wrapper → first successful chunk from the fallback provider.
- `barge_in.yieldMs`: user interrupts → agent audio stops (from `InterruptionMetrics`).

## Event types

| Type | Meaning |
|---|---|
| `session_start` | Session began. Carries `agentVersion` and the provider list per stage (`providers`), plus optional startup latencies. |
| `session_end` | Session ended, with a `reason`. |
| `turn_start` | A turn opened. `turnId` is SDK-owned. |
| `speech_end` | VAD end-of-speech for the user's turn. |
| `eou_delay` | Native end-of-utterance decision delay. |
| `stt_latency` | Speech-end → final transcript, computed by the SDK. |
| `llm_ttft` | LLM time-to-first-token, with provider, model, and prompt token count. |
| `llm_end` | LLM response finished, with output tokens and total duration. |
| `tts_ttfb` | TTS time-to-first-audio-frame. |
| `agent_audio_start` | Agent began speaking (approximation of first published frame), with `voiceToVoiceMs` and the producing hook (`source`). |
| `turn_end` | The turn closed. |
| `barge_in` | The user interrupted; `yieldMs` is how long until agent audio stopped. |
| `provider_degraded` | A provider breached a latency guardrail (`metric` vs `thresholdMs`, observed `observedMs`). |
| `provider_failure` | A provider failed with a classified `reason`. |
| `failover` | A stage failed over from one provider to another, with `trigger` and `recoveryMs`. |
| `provider_recovered` | A previously-failed provider passed recovery probes and is healthy again. |

## Stages

- `stt`: speech-to-text (transcription)
- `llm`: language model (response generation)
- `tts`: text-to-speech (audio synthesis)

## Failure reasons

- `timeout` — the provider did not respond in time.
- `5xx` — the provider returned a server error.
- `rate_limit` — the provider throttled the request.
- `conn_error` — connection could not be established or was dropped.
- `guardrail_latency` — a latency guardrail tripped (slow provider, treated as terminal for failover).

## Notes

- Durations come from monotonic sources or span start/end times. Never subtract
  wall-clock timestamps.
- The dashboard positions blocks and drives replay from `tOffsetMs`. Never sum
  durations (stages overlap).
- Transcript and response text are never shipped to the pipeline; `lk.pii.*`
  attributes are stripped at the span processor.

## Turn definition (operational)

A **turn** is one user utterance plus the agent's reply. `turn_start` is emitted
when VAD detects the start of user speech (`user_state_changed → speaking`) and
`turn_end` when the agent stops speaking (`agent_state_changed → listening|idle`
after `speaking`). `speech_end`, `eou_delay`, `stt_latency`, `llm_ttft`,
`llm_end`, `tts_ttfb`, and `agent_audio_start` all attach to that open turn.

> **Deviation from Plan §3 source table.** The Plan says `turn_start`/`turn_end`
> come from the `agent_turn` span. The real `agents-js@1.9.1` `agent_turn` span
> covers the agent's *reply* generation, which starts *after* the user finishes
> speaking and EOU is decided — but the Plan's event order is
> `turn_start → speech_end → … → turn_end`, which requires the turn to open at or
> before user speech end. The two cannot both hold. M3 therefore derives turn
> boundaries from user/agent state (fully event-driven and unit-testable) and uses
> the span processor for PII stripping and provider/model enrichment. Reconcile
> against real spans in M9.

## Sources actually used (M3)

| Field | Source in M3 |
|---|---|
| `session_start.agentVersion`, `providers` | tracker options |
| `turn_start`, `turn_end` | user/agent state transitions |
| `speech_end` | `eou_metrics`: emit time − `endOfUtteranceDelayMs` (backdated VAD speech end) |
| `stt_latency` | `eou_metrics.transcriptionDelayMs` (fallback: transcript arrival − `speech_end`) |
| `eou_delay` | `eou_metrics.endOfUtteranceDelayMs` |
| `llm_ttft`, `promptTokens` | `llm_metrics.ttftMs`, `.promptTokens` |
| `llm_end`, `outputTokens` | `llm_metrics.durationMs`, `.completionTokens` |
| `tts_ttfb` | `tts_metrics.ttfbMs` |
| `provider`, `model` | `metrics.metadata` (fallback: configured providers) |
| `agent_audio_start` | `agent_state_changed → speaking` |
| PII stripping | span processor dropping `lk.pii.*` attributes |

> **Deviation (stt_latency).** The Plan defines `stt_latency` as an SDK-computed
> `speech_end → final transcript`. In `agents-js@1.9.1` the `user_state_changed →
> listening` signal fires *after* the final transcript, so the SDK-computed value
> was always 0. The native `EOUMetrics.transcriptionDelayMs` measures exactly
> "time to obtain the transcript after end of speech", so we use it, and backdate
> `speech_end` from `endOfUtteranceDelayMs`. Reconcile in M9.

