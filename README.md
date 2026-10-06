# voxobs — Voice Agent Observability + Failover

**Know exactly why a voice call was slow or broke — and prove failover works.**

`voxobs` instruments a [LiveKit `agents-js`](https://github.com/livekit/agents-js) voice agent,
streams a typed event per turn over WebSockets into Postgres, and renders a
Grafana-style timeline: provider-level latency attribution, latency-triggered
failover, and session replay.

<!--
Demo: record ~30s — a live call with a barge-in, then a forced degraded→failover
marker — and drop it at docs/demo.gif, then uncomment the line below.

![demo](docs/demo.gif)
-->

## What it does

- **Attributes latency per stage and provider** — STT, LLM, TTS, EOU, and end-to-end
  voice-to-voice — from the framework's native metrics and OTel spans.
- **Schema-first events** — every turn emits a typed `VoiceEvent` (zod), validated at
  ingest; transcript/response text is stripped (`lk.pii.*`) before it leaves the agent.
- **Live timeline** — EOU / STT / LLM / TTS blocks positioned by monotonic time, with
  `degraded`, `failure`, `failover`, and `barge_in` markers.
- **History + replay** — every session is stored and can be replayed with play/scrub.
- **Failover** — a per-stage latency guardrail that rotates to a fallback provider
  (see [Status](#status--roadmap)).

## Architecture

```
Agent (agents-js)
  ├─ observe()-wrapped providers (per-stage guardrail)   → provider_degraded / failover
  ├─ OTel span processor (agent_turn, llm_node, tts_node) → turn + stage timing, PII strip
  ├─ metrics / state / VAD listeners                       → tokens, EOU, speech_end, barge-in
  └─ SDK tracker ──WS──► Ingest (Express + ws) ──► Postgres
                                    └──WS /live──► Dashboard (live · history · replay)
```

Data flows one way. The agent never depends on ingest being up: the SDK buffers
events, reconnects with backoff, and replays by `seq`; ingest dedups idempotently.

## Repo layout

```
packages/
  schema/    zod VoiceEvent union (shared contract) + docs/definitions.md source
  sdk/       tracker (turn assembly), OTel span processor, WS transport with replay
  failover/  observe() wrapper, latency guardrail, failure injection
apps/
  agent/     LiveKit voice agent (Deepgram STT, Groq LLM, Deepgram Aura TTS, Silero VAD)
  ingest/    Express + ws + Postgres; REST history; WS /ingest and /live; fake-events script
  dashboard/ Next.js live view + history + replay (shared timeline component)
docs/
  definitions.md         exact meaning of every metric
  frontend-agent-brief.md handoff prompt for UI polish
docker-compose.yml       Postgres + a local LiveKit dev server
```

## Quickstart

Requirements: Node 20+, pnpm, Docker.

```bash
# 1. config — LiveKit local dev defaults are pre-filled; add your provider keys
cp .env.example .env
#   DEEPGRAM_API_KEY=...        (STT + TTS)
#   GROQ_API_KEY=...            (LLM)   — model default is qwen/qwen3.8-27b

# 2. infrastructure (Postgres + local LiveKit server)
docker compose up -d

# 3. install
pnpm install

# 4. run (one per terminal)
pnpm --filter ingest dev        # http://localhost:4000
pnpm --filter agent dev         # worker connects to the local LiveKit server
pnpm --filter agent web         # join page on http://localhost:3001
pnpm --filter dashboard dev     # dashboard on http://localhost:3100
```

Open **http://localhost:3001**, click **Join call**, allow the mic, and speak.
The dashboard at **http://localhost:3100** updates live.

**No call needed to see it working** — generate a synthetic session:

```bash
pnpm --filter ingest fake-events   # 2 turns incl. a degraded→failure→failover sequence
```

## Event model

A turn is one user utterance plus the agent's reply. Events (see
[`docs/definitions.md`](docs/definitions.md)):

```
session_start · turn_start · speech_end · eou_delay · stt_latency · llm_ttft ·
llm_end · tts_ttfb · agent_audio_start · turn_end · barge_in ·
provider_degraded · provider_failure · failover · provider_recovered · session_end
```

Every event carries `eventId`, `sessionId`, `seq` (monotonic), `tOffsetMs` (monotonic
ms since session start — drives the timeline and replay), and `timestamp` (display only).

## Tests

```bash
pnpm lint && pnpm typecheck
TEST_DATABASE_URL=postgres://vox:vox@localhost:5432/vox_observability pnpm test
```

65 tests across schema, SDK, failover, ingest (DB-backed), and the dashboard model.
CI runs the same with a Postgres service.

## Status & roadmap

**Working and verified:** real-call event capture (M3), live dashboard (M5), history +
replay (M6), barge-in with `yieldMs` (M7).

**Honest caveats:**

- **Failover is opt-in** (`FAILOVER=1`). The guardrail tripped on a slow first TTS
  request and cascaded into a recovery-probe storm, so the default is a single
  provider per stage. The `@voxobs/failover` package and its 22 tests are complete;
  the live stream integration needs tuning.
- **TTS is Deepgram Aura** (the ElevenLabs key was scoped and the free plan blocks
  library voices via the API). Switchable with `TTS_PROVIDER=elevenlabs`.
- Per-field source deviations are documented in [`docs/definitions.md`](docs/definitions.md).

**Roadmap:** benchmarks (p50/p95/p99 per provider/stage, `recoveryMs` distribution),
mainnet-style deploy, published packages.

## Tech stack

pnpm workspaces · TypeScript (strict) · zod · vitest · Express · ws · Postgres (`pg`) ·
Next.js 15 (App Router) · React 19 · LiveKit `agents-js` 1.9 · OpenTelemetry ·
Deepgram (STT/TTS) · Groq (LLM) · Silero VAD.
