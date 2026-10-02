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
