# LiveKit `agents-js` Technical Audit Report

## 1. Metrics & Data Tracking

**What are all the metrics emitted by the framework?**
The framework natively defines 9 core metric types in `agents/src/metrics/base.ts`:
- `STTMetrics`: Latency, text recognition durations, processing durations, and request IDs.
- `LLMMetrics`: TTFT (Time To First Token), duration, completion vs prompt tokens, cache tokens, reasoning tokens, stream flags.
- `TTSMetrics`: TTFB (Time To First Byte / Audio), total duration, characters count, audio duration, token metrics.
- `VADMetrics`, `EOUMetrics`, `EOTInferenceMetrics`: Speech detection latencies, endpointing delays, turn boundaries, model inference times.
- `RealtimeModelMetrics`, `InterruptionMetrics`, `AvatarMetrics`.

All these metrics extend an `AgentMetrics` base type containing a timestamp (`Date.now()`), an optional `sequenceId`, and session correlation metadata.

**How does user code access these metrics?**
All metrics are localized internally in the components (e.g. `LLMStream`) and routed out via a unified `metrics_collected` event listener loop. An observer hooks into `AgentSession` event pipeline which fires `AgentSessionEventTypes.MetricsCollected`. 

User code can intercept metrics in one place:
```typescript
agent.on('metrics_collected', (metrics: AgentMetrics) => {
  // Switch on metrics.type
});
```
Additionally, `SessionUsageUpdated` events are automatically aggregated by the `ModelUsageCollector` to provide totals per provider.

**STT Metrics details**
`STTMetrics` mainly tracks recognition latency (`durationMs`) per event stream, differentiating final versus interim bursts, exposing `requestId`. Token counts for pure speech-to-text aren't broken down per chunk natively, only trackable via usage events for cloud-provider billing logs.

**LLM Metrics details**
The LLM stream (`agents/src/llm/llm.ts`) evaluates `ttftMs` (Time To First Token) via `process.hrtime.bigint()`. It rigorously calculates time offsets from the start of the chat generator request to the very first chunk containing textual message payload (`hasResponse()`). Usage tokens are automatically appended: prompt, completion, input cache, and reasoning.

**TTS Metrics details**
The TTS stream (`agents/src/tts/tts.ts`) defines both `startedTime` and `startedHrTime`. The TTFB evaluates to the exact time the provider returned the *first audio frame* packet and the byte stream is validated. `audioDuration` calculates natively from the audio sample rate and lengths, minimizing codec variance reporting.

**Event Timestamps & Clocks**
LiveKit combines two distinct clock methodologies:
- **Monotonic clock (`process.hrtime.bigint()`)**: Strictly used for durations like TTFT and TTFB inside the Node.js event loop to avoid leap second / NTP drift variances.
- **Wall clock (`Date.now()` / `performance.now()`)**: Used for absolute timestamps on `startedTime` for userdata audio frames and `AgentEvent.createdAt` so that log aggregations match cloud-provider spans. 

**Voice-to-Voice Latency**
End-to-End Voice-to-Voice latency (Agent turn turnaround: User Speech Stop -> Agent TTS Audio Start) is *not* emitted natively as a single event struct. The framework emits EOU, LLM, and TTS metrics independently per component. However, all components carry a correlated `speechId` and OpenTelemetry span references (like `lk.agent_turn_id`) that allow the metrics to be perfectly reconstructed external to the framework.

**Barge-in / Interruption Events**
Barge-ins / Overlapping user-audio naturally terminates TTS dispatch. `AgentSessionEventTypes.AgentFalseInterruption` fires if the VAD determined sudden noise wasn't speech. If an interruption is real, `AgentSession` evaluates barge-in yield and fires `OverlappingSpeech` alongside `InterruptionMetrics` referencing the played tokens vs truncated tokens.

---

## 2. Fallover & Reliability

**How failover is implemented**
Failover handles explicitly via the `FallbackAdapter` classes inside the STT, LLM, and TTS submodules. These adapters implement the exact same interfaces (e.g. extending `LLM` class), but internally accept an array array of providers: `[primary, fallback]`. They act as proxies, masking underlying exceptions. 

If the primary provider throws a terminal exception (`APIConnectionError`) or exhausts retries, the fallback adapter rotates index, spinning up the secondary `LLMStream` mid-conversation context.

**Recovery Probes (Circuit Breaking)**
Failover adapters are dynamic circuit breakers with self-healing functionality. Background recovery probe routines (`tryRecoverRecognize`, `tryRecoverChat`) manage health checks. When failed over, adapters fire lightweight queries (`prewarm` requests) against the degraded provider. Once it restores, traffic rotates immediately back into the primary provider.

**Failover Events**
The fallback adapters natively emit `<stt|llm|tts>_availability_changed` events natively. 

**Retry logic vs Failover**
In `LLMStream` and `ChunkedStream`, explicit internal retry loops are provided (`for (let i = 0; i < maxRetries; i++)`), governed by an `APIConnectOptions` property. A failover only executes if the active stream returns `error.retryable=false` (like auth limits) or strictly exhausts its native retry backoff pool.

---

## 3. Built-in Observability & Telemetry

**LiveKit Telemetry & OpenTelemetry integration**
LiveKit operates a tight OpenTelemetry (OTel) stack under `agents/src/telemetry/`. The module instruments OTel traces for generative AI conforming to latest Semantic Conventions (`gen_ai.usage.text.input_tokens`, `gen_ai.invoke_agent.duration`). All `metrics_collected` objects serialize natively into span attributes before completion. By default, traces flow to LiveKit Cloud (Agent Insights).

**Custom OTel Exporters / Extensibility**
The framework manages tracers using a custom `ProxyTracerProvider`. Integrators *can* invoke `telemetry.setTracerProvider(new NodeTracerProvider())` at launch, forcing LiveKit to multiplex all span attributes to standard `OTLP` exporters (Jaeger, Datadog) completely external to LiveKit cloud.

---

## 4. Extensibility & Integration Recommendations

### Gap Analysis for Observability Platform

| Feature | LiveKit Native Support | Gap Addressed by SDK / Platform |
|---------|------------------------|---------------------------|
| **Turn-Based Durations** | Monotonic TTFB / TTFT isolated per provider | No single E2E pipeline metric evaluating Voice-to-Voice end-to-end accumulation natively. |
| **Failover Visibility** | Emits `availability_changed` to listeners | Missing correlation of fallback switches affecting system TTFT averages or tracking prompt loss. |
| **Degraded Slow Provider** | Retries/errors on hard explicit timeouts | Native framework timeouts are rigid. It lacks preemptive Fallback switching based on latency triggers (e.g., tripwire TTFT > 1.5s). |
| **Barge-in Alignment** | Generates localized `InterruptionMetrics` | Cloud dashboards needed to visualize barge-in collision ratios for conversational quality indexes. |

### Recommended Platform Adapter Strategy

To build a failover and observability adapter SDK on top of `livekit/agents-js`, you **do not** need to fork the repo.
Using the **Plugin Decorator Pattern** mixed with **OTel Provider injection**:

1. **Observability Sync**: Invoke `telemetry.setTracerProvider` at agent initialization to steal semantic span data logic. Hook a listener to `agent.on('metrics_collected')` to pipe low-latency structured JSON via WebSockets/REST straight to your backend without manipulating the spans directly.
2. **Advanced Failover Proxy**: Extend the native `LLM/TTS` components by publishing custom `ObservabilityLLMAdapter`. Intercept the `.chat()` stream iterators, enforce configurable P99 Latency Guardrails (e.g. failing to an OpenAI fallback if Anthropic’s first token chunk exceeds 600ms latency limits - independent of connection faults). 
3. **Turn Stitching**: Consume the `speechId` parameter locally into memory buffers bridging `User Transcription End -> LLM Start -> TTS Start` to artificially compute the final aggregated E2E Voice-To-Voice timings for the client without touching core internal `gen_ai` span generation mechanisms.

---

## 5. Specific FAQ & Deep Dives

**Q1: What is the exact payload of `<stt|llm|tts>_availability_changed`? Does it include the error, provider, and timestamp?**
The payload is very minimal. It takes the form: `{ stt: STT, available: boolean }`. 
It does **not** include the error that caused the failure, nor does it include a native timestamp field inside the object. To get the timestamp, you must rely on `Date.now()` at the moment your event listener fires. The provider is accessible via the instance passed in the payload (e.g., `event.llm.provider`). The underlying exception is swallowed by the `FallbackAdapter` and can only be seen if you trace the individual component's stream execution.

**Q2: Is `speechId` present on every metric type, including STT?**
No, `speechId` is **not** present on `STTMetrics`. It is only attached natively to `LLMMetrics` and `TTSMetrics`. `STTMetrics` exposes a `requestId`, which is the correlated provider context string, but to tie STT reliably to a downstream Agent `speechId` generation, you must cross-reference OpenTelemetry `lk.generation_id` spans or intercept the `AgentSession` loop where the STT final transcript triggers the LLM turn.

**Q3: How should a guardrail failure be raised to ensure the `FallbackAdapter` treats it as terminal and rotates?**
If you implement a custom proxy stream (or custom fallback condition), you must throw a subclass of `APIError` and explicitly pass `{ retryable: false }`.
Example:
```typescript
throw new APIError('Guardrail failed: P99 latency exceeded', { retryable: false });
```
The internal streams (like `LLMStream`) catch exceptions. If `error.retryable` is true, they will loop locally up to `connOptions.maxRetry`. If `error.retryable` is set to `false`, the base stream immediately terminates, bubbling the exception out to the `FallbackAdapter`, which catches it and rotates immediately to the secondary provider index.

**Q4: Does the span processor see the stage boundaries for the job lifecycle (for a timeline)?**
Yes, absolutely. The framework exports explicit delay fields tracking the `job_entrypoint` dispatch timeline in `agents/src/telemetry/trace_types.ts`. The span processor will see the seconds elapsed between every discrete stage boundary:
- `lk.job.accept_latency`: Availability request → Worker accepts.
- `lk.job.assignment_latency`: Accept → Server assignment.
- `lk.job.launch_latency`: Assignment → Process takes the job.
- `lk.job.entrypoint_latency`: Process takes job → User entrypoint starts running.
- `lk.job.dispatch_latency`: The aggregate sum of the entire dispatch chain.
