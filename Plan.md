# Voice Agent Observability + Failover: Project Completion Plan

**One-liner:** Know exactly why a voice call was slow or broke, and prove your failover works.

**README anchor:** "Grafana for voice agents": provider-level latency attribution, latency-triggered failover, and cross-provider benchmarks, built on LiveKit agents-js.

**Name:** repo `Voice_Agents_Observability`, npm scope `@voxobs` (`@voxobs/schema`, `@voxobs/sdk`, `@voxobs/failover`).

**How to use this doc:** it is ordered by dependency, not by date. Each milestone has acceptance criteria. Do not start a milestone until the previous one's criteria pass.

---

## 1. Verified facts about agents-js (from the audit)

These are confirmed against source. Do not re-derive them.

| Topic | Fact |
|---|---|
| Metrics | `AgentSession` emits `metrics_collected` with STT, LLM, TTS, VAD, EOU, EOTInference, Realtime, Interruption, Avatar metrics. LLM and TTS metrics carry `speechId`; STT metrics carry only `requestId`. |
| Streaming STT | `STTMetrics.durationMs` is `0` for streaming. `stt_latency` cannot come from native metrics. |
| Voice-to-voice | Not emitted natively. Must be stitched. |
| FallbackAdapter | Exists for STT, LLM, TTS. Rotates on terminal errors (`APIError` with `retryable: false`) or after retries are exhausted. Runs background recovery probes through the same wrapped provider object. Emits `<stage>_availability_changed` with only `{ available: boolean }` (no error, no timestamp). |
| STT streams | One long-lived stream per session. `FallbackSpeechStream.run()` rotates mid-stream by creating child streams from each provider. |
| Latency failover | Not provided natively. This is the project's gap. |
| Telemetry | OpenTelemetry under `agents/src/telemetry/`. `setTracerProvider(...)` lets you attach your own provider/span processor. |
| Spans | `agent_turn` parents `llm_node`, `tts_node`, `function_tool`, `agent_speaking`. `llm_node` carries `gen_ai.request.model`, `gen_ai.provider.name`, `lk.response.ttft`, `lk.pii.response.text`. `tts_node` carries `gen_ai.request.model`, `gen_ai.provider.name`, `lk.response.ttfb`. All have real start/end times. |
| Job spans | `lk.job.accept_latency`, `lk.job.assignment_latency` (startup, not per-turn). |
| Audio start | Real hook is `onPlaybackStarted` in `room_io/_output.ts` (internal). External approximation: `agent_state_changed → 'speaking'`. |
| Clocks | Durations use `process.hrtime.bigint()`; `Date.now()` is wall clock; `performance.now()` is monotonic. |

---

## 2. Architecture

```
Agent (agents-js)
  ├─ observe()-wrapped providers inside FallbackAdapter   → failure/degraded/failover events
  ├─ OTel span processor (agent_turn, llm_node, tts_node) → turn + stage timing
  ├─ metrics_collected / state / VAD listeners            → tokens, EOU, speech_end, barge-in
  └─ SDK tracker ──WS──► Ingest API ──► Postgres
                              └──WS /live──► Dashboard (live + history + benchmarks)
```

Data flows one way. The agent never depends on ingest being up.

### Repo layout

```
<project>/
├── packages/
│   ├── schema/      # zod event types, shared by everything
│   ├── failover/    # observe() wrapper + guardrail + LatencyGuardrailError
│   └── sdk/         # tracker, span processor, listeners, WS transport
├── apps/
│   ├── agent/       # LiveKit voice agent + failure-injection endpoint
│   ├── ingest/      # Express: WS/POST in, Postgres, WS out, REST history
│   └── dashboard/   # Next.js
├── benchmarks/      # scripted calls, stats, README table generator
├── docs/
│   ├── livekit-audit.md
│   └── definitions.md   # exact meaning of every metric (README source)
├── docker-compose.yml   # local Postgres + ingest
└── README.md
```

Tooling: pnpm workspaces, TypeScript strict, zod, vitest, one shared tsconfig base.

---

## 3. Event schema (`packages/schema`)

Every event carries: `eventId` (uuid), `sessionId`, `seq` (per-session, monotonic, starts at 0), `tOffsetMs` (monotonic ms since `session_start`, at the moment the described thing began; for point events, when it happened), `timestamp` (wall clock, display only).

**Rules**
- Durations come from monotonic sources or span start/end times. Never subtract wall-clock timestamps.
- The dashboard positions blocks and drives replay from `tOffsetMs`. Never sum durations (stages overlap).
- `turnId` is owned by the SDK, opened on `turn_start`. LLM/TTS `speechId` maps to it on first sight. STT attaches by the open turn's time window.

```ts
type Stage = "stt" | "llm" | "tts"
type FailReason = "timeout" | "5xx" | "rate_limit" | "conn_error" | "guardrail_latency"
type Base = { eventId: string; sessionId: string; seq: number; tOffsetMs: number; timestamp: number }

type VoiceEvent = Base & (
  | { type: "session_start"; agentVersion: string; providers: Record<Stage, string[]>;
      acceptLatencyMs?: number; assignmentLatencyMs?: number }
  | { type: "session_end"; reason: string }
  | { type: "turn_start"; turnId: string }
  | { type: "speech_end"; turnId: string }
  | { type: "eou_delay"; turnId: string; delayMs: number }
  | { type: "stt_latency"; turnId: string; provider: string; latencyMs: number }
  | { type: "llm_ttft"; turnId: string; provider: string; model: string;
      promptTokens: number; latencyMs: number }
  | { type: "llm_end"; turnId: string; provider: string; outputTokens: number; durationMs: number }
  | { type: "tts_ttfb"; turnId: string; provider: string; latencyMs: number }
  | { type: "agent_audio_start"; turnId: string; voiceToVoiceMs: number;
      source: "state_change" | "playback_hook" }
  | { type: "turn_end"; turnId: string }
  | { type: "barge_in"; turnId: string; yieldMs: number }
  | { type: "provider_degraded"; turnId: string; stage: Stage; provider: string;
      metric: "ttft" | "ttfb" | "stt_final"; thresholdMs: number; observedMs: number }
  | { type: "provider_failure"; turnId: string; stage: Stage; provider: string;
      reason: FailReason; message?: string }
  | { type: "failover"; turnId: string; stage: Stage; fromProvider: string; toProvider: string;
      trigger: "error" | "degraded"; recoveryMs: number }
  | { type: "provider_recovered"; stage: Stage; provider: string }
)
```

### Definitions (go verbatim into `docs/definitions.md` and the README)

- `speech_end`: VAD end-of-speech for the user's turn.
- `eou_delay`: native EOU metric: end of speech → end-of-utterance decision.
- `stt_latency`: `speech_end` → final transcript. Computed by the SDK.
- `llm_ttft`: LLM request start → first token (from `llm_node` span / native metric).
- `tts_ttfb`: text sent → first audio frame from the provider (native).
- `agent_audio_start`: agent state changes to `speaking`. Approximation of first frame published to the room; `source` says which hook produced it.
- `voiceToVoiceMs`: `speech_end` → `agent_audio_start`.
- `recoveryMs`: failure or degradation detected in the wrapper → first successful chunk from the fallback provider.
- `barge_in.yieldMs`: user interrupts → agent audio stops (from `InterruptionMetrics`).

### Source per field (one source each, no overlap)

| Field | Source |
|---|---|
| `turn_start`, `turn_end`, turn `tOffsetMs` | `agent_turn` span |
| LLM stage offset, `llm_end.durationMs`, `llm_ttft` | `llm_node` span (start/end, `lk.response.ttft`) |
| TTS stage offset, `tts_ttfb` | `tts_node` span (start/end, `lk.response.ttfb`) |
| `provider`, `model` | span attributes |
| `promptTokens`, `outputTokens`, `eou_delay` | native metrics |
| `speech_end` | VAD end-of-speech event |
| `stt_latency` | SDK: `speech_end` → final transcript |
| `agent_audio_start` | `agent_state_changed → speaking` |
| `barge_in` | `InterruptionMetrics` |
| `provider_recovered` | `availability_changed` with `available: true`, stamped `performance.now()` on receipt |
| `provider_failure`, `provider_degraded`, `failover` | `observe()` wrapper |
| `session_start` startup fields | job spans |

Span times are absolute: convert to `tOffsetMs` by subtracting the session start. Spans arrive when they end; use `onStart` too if blocks should appear while running.

**Privacy:** strip `lk.pii.*` attributes (including `lk.pii.response.text`) in the span processor. Never ship transcript or response text to ingest.

---

## 4. Package specs

### 4.1 `packages/schema`
- Zod schemas for every event, inferred TS types, `parseEvent()`.
- Export `Stage`, `FailReason`, `VoiceEvent`.
- Tests: valid and invalid sample of each event type.

### 4.2 `packages/failover`
Hard dependency on `@livekit/agents` (peer). Not framework-agnostic; do not claim it is.

```ts
export class LatencyGuardrailError extends APIError {
  constructor(msg: string) { super(msg, { retryable: false }) }
}
export interface GuardrailConfig {
  ttftMs?: number; ttfbMs?: number; sttFinalMs?: number
  consecutive?: number     // trips before degraded (default 1; STT use 2+)
  recoverAfter?: number    // fast probes needed to be considered healthy
}
export function observe<T extends LLM | TTS | STT>(
  provider: T,
  opts: { stage: Stage; name: string; sink: { emit(e: VoiceEvent): void };
          guardrail?: GuardrailConfig; injector?: FailureInjector }
): T
// usage: new FallbackAdapter({ llms: [observe(a, ...), observe(b, ...)] })
```

Behavior:
- Sits under the FallbackAdapter, wrapping one provider each.
- Catches errors, classifies into `FailReason` (status code mapping), emits `provider_failure`.
- LLM/TTS: races first chunk against the threshold; on breach emits `provider_degraded` and throws `LatencyGuardrailError` in flight.
- STT: measures per turn (`speech_end` → final). After `consecutive` slow turns, emits `provider_degraded`; at the next turn boundary (after `turn_end`, before next speech) errors the running child stream with `LatencyGuardrailError`. Never cuts an utterance.
- Records detection time per stage; the fallback wrapper's first successful chunk emits `failover` with `recoveryMs`.
- Recovery probes pass through the wrapper, so the guardrail applies to probes. A slow primary must fail the probe and stay out.
- Tests (unit, with fake providers): error classification, guardrail trip, consecutive counting, failover event contents, probe behavior, no event on healthy path.

### 4.3 `packages/sdk`
```ts
const tracker = createTracker({ endpoint, apiKey, sessionId?, agentVersion })
tracker.attach(session)      // subscribes listeners + installs span processor
tracker.sink                 // pass to observe()
tracker.shutdown()
```
- Owns `seq`, `turnId`, session clock, and event assembly.
- Span processor: maps `agent_turn`/`llm_node`/`tts_node` to events, strips PII attributes. Calls `setTracerProvider` at init; check this does not break Agent Insights when deployed.
- Listeners: `metrics_collected`, VAD end-of-speech, final transcript, `agent_state_changed`, `*_availability_changed`, interruption events.
- Transport: WebSocket to ingest with an in-memory buffer; reconnect with backoff; replay unsent events by `seq`; bounded buffer (drop oldest, count drops, emit a `dropped` counter in `session_end`).
- Never throws into the agent. All SDK errors are caught and logged.
- Tests: ordering/seq, turn stitching (STT by time window, LLM/TTS by `speechId`), buffer replay after disconnect, no-throw guarantee, PII stripped.

### 4.4 `apps/agent`
- agents-js, Node/TypeScript, simple assistant (conversation content is not the point).
- STT: Deepgram → AssemblyAI. LLM: two providers (e.g. Groq + Gemini, both free-tier friendly). TTS: ElevenLabs → Cartesia.
- Each provider wrapped with `observe()` inside its FallbackAdapter; tracker attached to the session.
- Failure injection endpoint (below).
- Browser-mic join page. Phone is out of scope.

### 4.5 `apps/ingest`
- `WS /ingest` (API key auth) and `POST /events` (batch).
- Validate with the shared schema. Reject unknown types. Reject payloads containing `lk.pii.*`.
- Idempotent insert: unique `(session_id, seq)`, `ON CONFLICT DO NOTHING`.
- Tables:
  - `events(event_id, session_id, seq, type, payload jsonb, t_offset_ms, ts)` with index on `(session_id, seq)`.
  - `sessions(id, started_at, ended_at, turn_count, had_failover, providers jsonb)`, updated as events arrive and finalized on `session_end`. Mark sessions with no events for a timeout period as ended (`reason: "timeout"`).
- `WS /live`: subscribe by session or "latest active"; broadcast validated events.
- REST: `GET /sessions`, `GET /sessions/:id/events`, `GET /stats` (percentiles per provider per stage, `recoveryMs` stats).
- Tests: duplicate events, out-of-order delivery, bad payloads, session finalization.

### 4.6 `apps/dashboard`
Next.js, dark mode, monospace, Grafana-style (tool look, not product look).
- **Live view:** turn timeline strip (blocks per turn segmented by EOU / STT / LLM / TTS, positioned by `tOffsetMs`), four stat tiles (STT latency, LLM TTFT, TTS TTFB, voice-to-voice), rolling voice-to-voice line chart, markers: barge-in (icon), degraded (amber), failure (red), failover (green, labeled with `recoveryMs`). Empty state: "no live session — start a call to see it here" with link/QR to the agent.
- **History:** table (date, duration, turns, providers, failover badge). Detail view reuses the timeline component, replayed from stored events with play/scrub, driven by `tOffsetMs`.
- **Benchmarks:** p50/p95/p99 per provider per stage; failover `recoveryMs` distribution.
- One shared timeline component used by live and replay.

### 4.7 `benchmarks/`
- Drives scripted calls into the agent using pre-recorded audio.
- Matrix: each provider per stage, normal runs plus injected `error`, `timeout`, `slow` runs.
- Stores results through the normal pipeline (same events, tagged `benchmark: true`), then computes stats from the database.
- Generates the README table (markdown) and a raw CSV.
- Record: run counts, region, time of run, provider model/version, so the results are reproducible and honest.

---

## 5. Failure injection

`POST /simulate-failure?stage=stt|llm|tts&mode=timeout|error|slow[&delayMs=...]` on the agent service, protected by a secret token header. Never public.

- Implemented as a flag read inside `observe()` (`injector`), so injected failures travel through the real detection path and produce real events. Do not fake events.
- Applies to the next primary call for that stage, then clears.
- `slow` adds latency to the primary so the guardrail trips: demonstrates "degraded, not failed."
- STT note: injection applies per turn; rotation happens at the next boundary.

---

## 6. Milestones (dependency order, with acceptance criteria)

**M0: Foundations**
- Monorepo scaffold, tooling, CI (lint, typecheck, test), local Postgres via Docker Compose, project name chosen.
- `docs/livekit-audit.md` committed.
- *Done when:* `pnpm install && pnpm test` passes on a clean clone.

**M1: Schema**
- `packages/schema` complete with tests, `docs/definitions.md` drafted.
- *Done when:* every event type has valid/invalid tests and definitions are written.

**M2: Pipe**
- Ingest API + Postgres; minimal SDK transport; a fake-event script.
- *Done when:* duplicate and out-of-order events are handled correctly and a disconnect/reconnect test replays without loss or duplication.

**M3: Real events from a real call**
- Agent with one provider per stage; SDK attached; span processor and listeners mapping to schema.
- *Done when:* a real browser-mic call writes a correct event sequence, every turn has `turn_start … turn_end` with plausible `stt_latency`, `llm_ttft`, `tts_ttfb`, `voiceToVoiceMs`, and no PII is present in stored payloads.

**M4: Failover**
- `packages/failover`; second provider per stage; injection endpoint.
- *Done when:* for each stage and each mode (`timeout`, `error`, `slow`), an injected fault produces the expected `provider_failure`/`provider_degraded` then `failover` with a sane `recoveryMs`, the call continues, and the primary is restored after recovery probes pass.

**M5: Live dashboard**
- Live view fed by `WS /live`.
- *Done when:* one real call, including a forced failover, renders live with correct block positions and markers, and you can record a clean 30-second GIF of it.

**M6: History and replay**
- History table, session detail replay, session finalization.
- *Done when:* a past session replays identically to how it looked live.

**M7: Barge-in**
- `barge_in` events from `InterruptionMetrics`, marker on the timeline.
- *Done when:* a real interruption produces one `barge_in` with plausible `yieldMs`, and false interruptions do not.

**M8: Benchmarks**
- Benchmark runner, stats endpoint, benchmarks page, README table generator.
- *Done when:* the full matrix has run with enough samples for stable p95 per provider, results are reproducible from stored data, and the table is generated by script, not by hand.

**M9: Measurement honesty**
- Local agents-js patch to log `onPlaybackStarted` alongside the state-change approximation across a few dozen turns; record the measured gap.
- Answer two open unknowns (section 8).
- *Done when:* the gap number is in `docs/definitions.md`.

**M10: Deploy**
- Agent on LiveKit Cloud, ingest on Render, Postgres on Neon, dashboard on Vercel.
- *Done when:* a call from the public join page shows up live on the deployed dashboard, with warm-up handling in place (section 7).

**M11: Launch**
- README, demo GIF/video, blog post with real numbers, npm publish of `schema`, `sdk`, `failover`.
- *Done when:* a stranger can clone, run locally, and reproduce a failover from the README alone.

---

## 7. Free deployment

| Piece | Where | Catch |
|---|---|---|
| Agent | LiveKit Cloud Build plan | 1,000 agent minutes/month, 5 concurrent sessions; scales to zero when idle (cold start) |
| Ingest | Render free web service | WebSockets work; sleeps after 15 min idle (~1 min cold start) |
| Database | Neon (or Supabase) | Neon compute suspends after 5 min idle; Supabase pauses after 1 week idle. Do not use Render's free Postgres (deleted after 30 days) |
| Dashboard | Vercel Hobby | Personal use only |
| STT | Deepgram credit; AssemblyAI credit | One-time credits |
| TTS | ElevenLabs (~10 min audio/month); Cartesia (20K credits/month) | ElevenLabs limits the benchmark |
| LLM | Groq free tier; Gemini via Google AI Studio | Rate-limited |

Operational rules:
- Wake ingest from the join page and ping it on a schedule; the SDK's buffer and replay covers cold starts, but record demos with everything warm.
- Keep the injection endpoint token-gated.
- Keep benchmark replies short and spread runs out so TTS credits last; check the current limits at signup, they change often.
- Free-tier figures in this doc come from pages dated April to September 2026 and some sources disagreed. Verify before relying on them.

---

## 8. Open unknowns (resolve during the build, do not guess)

1. Does a mid-turn failover produce a second `llm_node`/`tts_node` span or one span covering both? This decides how `failover` aligns on the strip.
2. Does the STT adapter replay or drop audio frames during rotation? Assert behavior with a test.
3. Does `setTracerProvider` affect LiveKit Cloud Agent Insights when deployed?
4. The measured gap between `agent_state_changed → speaking` and `onPlaybackStarted` (M9).
5. Whether the probe call truly passes through `observe()` in the STT path as well as LLM/TTS.

---

## 9. Launch artifacts

**README must contain:** the one-liner, a 30-second GIF of one call failing over, the benchmark table, metric definitions, local quickstart, architecture diagram, and the honesty list below.

**Honesty list (copy into README):**
1. `agent_audio_start` is a state-change approximation; measured gap: X ms.
2. STT slowness failover is proactive: it needs N slow turns and rotates at a turn boundary.
3. LLM/TTS guardrail failover costs the user threshold + fallback TTFT, because the request restarts on the fallback.
4. LiveKit Cloud's Agent Insights already shows turn traces. This project differs in provider-level failover timing, latency-triggered failover, and cross-provider benchmarks.
5. Benchmarks are from specific regions, times and model versions; they are measurements, not rankings.
6. `packages/failover` depends on `@livekit/agents`.

**Blog post:** "Voice-agent failover: what X ms recovery looks like across provider pairs." Only claim metrics that are defined in `definitions.md` and measured. Do not claim a cost overhead number unless it is defined and measured.

**npm:** publish `schema`, `sdk`, `failover` with a short README each.

---

## 10. Rules for the coding agent

- Follow milestone order and acceptance criteria. Do not skip ahead.
- One source per field (section 3 table). If two sources disagree, report it instead of picking silently.
- Never ship transcript or response text anywhere. Strip `lk.pii.*` at the span processor.
- Never fake events in production paths; injection goes through `observe()`.
- The SDK must never throw into the agent.
- Every metric must have a definition in `docs/definitions.md` before it appears in the dashboard.
- When something in this doc conflicts with what the code does, stop and flag it. Do not guess.
- Write tests with each package; do not defer them.