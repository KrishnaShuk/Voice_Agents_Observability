Voice Agent Observability + Failover: Net Plan
One-liner: Know exactly why a voice call was slow or broke, and prove your failover works.

README anchor: "Grafana for voice agents": provider-level latency, failover timing, and cross-provider benchmarks.

Name: TBD (pick something memorable before the first commit; it becomes the npm scope and repo name).

1. Before you write code (day 1 checklist)
Read agents-js source: which metrics does it already emit (STT, LLM TTFT, TTS TTFB, end-of-utterance delay)? Does it ship a FallbackAdapter, and what does it cover (errors only, or also slowness)?
Decide the SDK's role from the answer: an adapter over LiveKit's metrics where they exist, and manual timers only for gaps.
Decide whether packages/failover is a real engine (adds slow-degradation detection and a circuit breaker beyond what LiveKit has) or a thin event-emitting layer over the existing adapter.
Write one README line on how this differs from LiveKit Cloud's own observability (Agent Insights): provider-level failover timing and cross-provider benchmarks.
2. Repo layout
voice-observability/
├── packages/
│   ├── schema/      # event types + zod validators
│   ├── sdk/         # tracker (publish to npm)
│   └── failover/    # provider list + timeouts + degradation detection; emits failure/failover events
├── apps/
│   ├── agent/       # LiveKit agents-js voice agent
│   ├── ingest/      # Express: WS/POST in, Postgres, WS out
│   └── dashboard/   # Next.js: live + history + benchmarks
├── benchmarks/      # scripted calls, p50/p95 computation
└── README.md
3. Event schema (packages/schema)
Common fields on every event: eventId, sessionId, seq (per-session, monotonic), tOffsetMs (agent monotonic ms since session_start), timestamp (wall clock, display only).

Rule: durations come from monotonic clocks. The dashboard positions blocks and drives replay from tOffsetMs, never from wall-clock timestamps and never by summing durations (stages overlap, so sums lie).

Event	Extra fields	Definition
session_start	agentVersion, providers	Call connected
session_end	reason	Call ended
turn_start	turnId	New turn begins
speech_end	turnId	VAD detects user stopped speaking (anchor for the next three)
eou_delay	turnId, delayMs	speech_end → end-of-utterance decision
stt_latency	turnId, provider, latencyMs	speech_end → final transcript
llm_ttft	turnId, provider, model, promptTokens, latencyMs	Request sent → first token
llm_end	turnId, provider, outputTokens, durationMs	First → last token
tts_ttfb	turnId, provider, latencyMs	Text sent → first audio chunk from provider
agent_audio_start	turnId, voiceToVoiceMs	First agent audio frame published to the room. voiceToVoiceMs = speech_end → this event
turn_end	turnId	Turn complete
barge_in	turnId, yieldMs	User interrupts → agent audio stops
provider_degraded	turnId, stage, provider, metric, thresholdMs, observedMs	Latency crossed the degradation threshold
provider_failure	turnId, stage, provider, reason	reason: timeout | 5xx | rate_limit | conn_error
failover	turnId, stage, fromProvider, toProvider, recoveryMs	recoveryMs = failure detected → first successful response from the fallback
Attribution: an optional typed attrs object (audioMs, cacheHit, isFirstTurn, ...) instead of a free-form context field.

TTS measurement, defined precisely:

tts_ttfb: text sent to the first audio chunk from the provider.
agent_audio_start: first frame actually published to the room.
The gap between them is buffering plus WebRTC time. Document both.
4. Components
Agent (apps/agent)
agents-js, Node/TypeScript, simple assistant.
STT: Deepgram → AssemblyAI. LLM: two of your choice (Groq + Gemini fit the free tiers). TTS: ElevenLabs → Cartesia.
Uses packages/failover for all provider switching.
Browser-mic deployment on LiveKit Cloud.
Failover (packages/failover)
Input: ordered provider list per stage, per-call timeouts, degradation thresholds.
Behavior: timeout/error handling, circuit breaker, degradation detection (e.g. TTFT above N ms for M consecutive turns).
Emits provider_degraded, provider_failure, failover. recoveryMs is measured by the real fallback request succeeding, not a timer expiring.
Failure injection
POST /simulate-failure?stage=stt|llm|tts&mode=timeout|error|slow, protected by a secret token header. slow adds latency to the primary so you can show "primary got slow → failed over before the user noticed."

SDK (packages/sdk)
const tracker = createTracker({ endpoint, apiKey, sessionId })
tracker.startSession(meta)
tracker.startTurn() → turnId
tracker.recordSpeechEnd(turnId)
tracker.recordEOU / recordSTT / recordLLM / recordTTS / recordAgentAudioStart
tracker.recordBargeIn(turnId, yieldMs)
tracker.recordDegraded / recordFailure / recordFailover
tracker.endTurn(turnId)
tracker.endSession(reason)
WebSocket stream with in-memory buffer; reconnect and replay unsent events by seq.
Never throws into the agent.
Optional adapter: attachToAgent(session, tracker) mapping LiveKit metrics to events.
Ingest API (apps/ingest)
WS /ingest (API key) and POST /events (batch fallback).
Zod validation, dedupe on (sessionId, seq).
Postgres: events(event_id, session_id, seq, type, payload jsonb, t_offset_ms, ts) and sessions(id, started_at, ended_at, turn_count, had_failover).
WS /live broadcast; GET /sessions, GET /sessions/:id/events.
Dashboard (apps/dashboard)
Dark, monospace, Grafana-style.

Live view: turn strip (blocks segmented by EOU / STT / LLM / TTS), four stat tiles (STT, LLM TTFT, TTS TTFB, voice-to-voice), rolling voice-to-voice chart, markers for barge-in, degraded, failure (red), failover (green with recoveryMs). Empty state with link/QR to the agent.
History: table (date, duration, turns, providers, failover flag). Session detail replays from stored tOffsetMs with a scrub control.
Benchmarks: p50/p95/p99 per provider per stage, plus recoveryMs stats.
Benchmarks (benchmarks/)
Script drives 100+ scripted calls with pre-recorded audio.
Runs each provider pairing plus forced-failure runs (error, timeout, slow).
Outputs the README table.
5. Build order
Week 1: vertical slice, real data

Schema package, minimal SDK, ingest + Postgres.
Agent emitting real latency events from a real call.
Done when: a live call writes correct events into the DB.
Week 2: the attention magnet

packages/failover, failure injection (error/timeout/slow), failover events.
Dashboard live view rendering one call end to end, including a failover.
Done when: you can record a clean GIF of one call failing over.
Week 3: depth and ship

Session history + replay, barge-in, benchmarks page and run.
Deploy everything, record demo video, README, npm publish, blog post.
6. Free deployment
Piece	Where	Catch
Agent	LiveKit Cloud Build plan	1,000 agent minutes/month, 5 concurrent sessions; scales to zero when idle (cold start)
Ingest	Render free web service	WebSockets work; sleeps after 15 min idle (~1 min cold start)
Database	Neon (or Supabase)	Neon compute suspends after 5 min idle; Supabase pauses after 1 week idle. Do not use Render's free Postgres (deleted after 30 days)
Dashboard	Vercel Hobby	Personal use only
STT	Deepgram $200 credit; AssemblyAI signup credit	One-time credits
TTS	ElevenLabs ~10 min audio/month; Cartesia 20K credits/month	ElevenLabs is the benchmark bottleneck
LLM	Groq free tier; Gemini via Google AI Studio	Rate-limited
Operational rules:

Wake ingest from the join page and ping it on a schedule; record the demo with everything warm.
Keep the failure-injection endpoint token-gated.
Keep benchmark replies short and spread runs out, or hit provider APIs directly, to stay inside free TTS credits.
Re-check every free-tier figure at signup; they change often.
7. Launch artifacts
README: one-liner, 30-second GIF of one call failing over, benchmark table, schema definitions (what each latency means), honest scope section, and the line on how this differs from LiveKit's own metrics.
Blog post: "Voice-agent failover: X ms recovery across provider pairs", with the real p50/p95 numbers. Only claim metrics you actually define and measure.
npm: publish schema, sdk, and failover.
8. Open decisions
Does packages/failover add something agents-js lacks, or wrap it? (Answer from day-1 check.)
Degradation threshold values (N ms, M turns).
Final project name.
Phone support: out unless you add it later.