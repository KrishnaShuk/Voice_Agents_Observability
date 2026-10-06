# Frontend Agent Brief — `apps/dashboard` (voxobs)

You are a senior frontend engineer + design engineer. You are improving the UI of
`apps/dashboard`, a Next.js 15 (App Router) tool that visualises LiveKit voice-agent
calls. Work inside this repo. The human you report to will give creative direction;
follow it, and propose a concrete design direction before large changes.

---

## 1. What the product is

"Grafana for voice agents." A **dense, dark, monospace, information-first tool** —
not a marketing page, not a consumer app. The user is an engineer watching a live
voice call: they need to see, at a glance, where latency went and whether a provider
failed over.

Surfaces:

- **Live view** (`/`): fed by `WS /live`. Turn timeline (EOU/STT/LLM/TTS blocks
  positioned by time), four stat tiles (STT latency, LLM TTFT, TTS TTFB,
  voice→voice), a rolling voice→voice chart, and markers: barge-in (icon),
  degraded (amber), failure (red), failover (green, labelled with `recoveryMs`).
  Empty state: "no live session — start a call to see it here" + join link.
- **History** (`/history`): table — date, duration, turns, providers, failover badge.
- **Replay** (`/history/[id]`): the same timeline component, replayed from stored
  events with play / pause / scrub / reset, driven by `tOffsetMs`.

## 2. What you must NOT change

- **The event contract**: `@voxobs/schema` `VoiceEvent`. Do not edit it.
- **The backend**: `apps/ingest`, `apps/agent`, `packages/*`. UI-only changes.
- **The model semantics**: `apps/dashboard/lib/model.ts` decides what a turn is and
  where blocks/markers go. You may extend it for presentation (selectors, formatting)
  but do not change what an event means or the segment/domain logic without saying so.
- Required Next config (leave intact): `transpilePackages: ["@voxobs/schema"]` and the
  webpack `.js`→`.ts` extension alias in `next.config.mjs` (needed to consume the
  workspace TS package).

## 3. Where things live

```
apps/dashboard/
  app/layout.tsx            root layout (imports globals.css)
  app/page.tsx              → LiveView
  app/history/page.tsx      → HistoryTable
  app/history/[id]/page.tsx → SessionReplay (awaits params)
  app/globals.css           design tokens + component styles (CSS vars)
  components/
    AppHeader.tsx           title + live/history nav + right meta slot
    LiveView.tsx            "use client"; WS /live → model reduce
    Timeline.tsx            shared timeline (per-turn rows, segments + markers + legend)
    StatTiles.tsx           latest non-null metric per tile
    VoiceToVoiceChart.tsx   inline-SVG sparkline
    EmptyState.tsx
    HistoryTable.tsx        "use client"; GET /sessions
    SessionReplay.tsx       "use client"; GET /sessions/:id/events + replay controls
  lib/
    model.ts                pure: event → SessionModel (turn folding, segments, markers)
    ws.ts                   reconnecting WS /live client (schema-validated)
    api.ts                  REST client (sessions + events)
  test/model.test.ts        unit tests for the model (keep green)
```

## 4. Data you render

- **Live**: `WS /live` sends `{ type: "event", event: VoiceEvent }`. Fold with
  `applyEvent(prev, event)`; a new `session_start` starts a new session.
- **History**: `GET /sessions` → `{ sessions: SessionSummary[] }`;
  `GET /sessions/:id/events` → `{ events: { payload: VoiceEvent }[] }`.
- `lib/model.ts` exports: `applyEvent`, `createSession`, `stubSession`, `buildSession`,
  `sortByTime`, `turnSegments`, `turnMarkers`, `turnDomain`, `sessionDurationMs`,
  `latestTurn`, `lastValue`, `voiceToVoiceSeries`.
- Event types you'll display: `session_start/end`, `turn_start/end`, `speech_end`,
  `eou_delay`, `stt_latency`, `llm_ttft`, `llm_end`, `tts_ttfb`, `agent_audio_start`,
  `barge_in`, `provider_degraded`, `provider_failure`, `failover`, `provider_recovered`.

## 5. Current design tokens (`app/globals.css`)

```
--bg #0b0e14  --panel #11151d  --border #1e2430  --text #d5dbe5  --muted #7b8794
--eou #a78bfa  --stt #22d3ee  --llm #60a5fa  --tts #34d399
--amber #fbbf24  --red #f87171  --green #4ade80
font: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace
```

Keep the **color semantics** (stage → hue, marker → severity). You may refine the
exact values, add a type/spacing scale, and introduce a light mode only if the human
asks.

## 6. Design direction (fill in with the human's direction)

> **Human's direction:** _«write your direction here — e.g. "warmer, more premium,
> less bare-bones; keep it dense but add a sense of craft; a subtle grid background;
> better typography hierarchy; a real observability feel"»_

Work within that. If direction is broad, first produce **2–3 short visual proposals**
(palette + layout + one annotated mock/description), let the human pick, then execute.
Do not silently redesign the information architecture.

## 7. Where to focus (current weaknesses)

1. **Timeline legibility** — EOU and STT overlap (both start at speech-end); LLM/TTS
   can overlap. Consider lanes/stacking, minimum block width, hover detail, tooltips,
   a time axis/ruler, and zoom for long sessions.
2. **Markers** — currently thin 2–3px lines; add distinct shapes/icons for barge-in,
   and hover labels (already have `title=`); consider stacking the failover label.
3. **Stat tiles** — add deltas vs previous turn, units, and a subtle good/warn scale.
4. **Chart** — the sparkline needs an axis, min/max, and a rolling window; handle 1
   sample (dot) and many (`VoiceToVoiceChart` currently does the dot).
5. **Hierarchy & density** — spacing scale, panel headers, section rhythm, alignment.
6. **States** — loading skeletons, empty states (live + history), error states (WS
   down, REST failure), "session ended" affordance.
7. **Replay polish** — the scrubber (keyboard a11y, focus ring), speed, a playhead
   on the timeline synced to the cursor, current-time readout.
8. **Responsive** — it should work on a laptop and a narrow window; tiles wrap.
9. **A11y** — contrast, focus-visible, aria labels on the chart/markers, keyboard on
   the scrubber and nav.
10. **Anti-slop** — no generic purple gradient hero, no emoji, no oversized rounded
    cards. Precise, technical, restrained. (See the repo's frontend-design guidance if
    available.)

## 8. Constraints & tech

- Next.js 15 App Router, React 19, TypeScript **strict**. Respect `"use client"` vs
  server components; page params are async.
- Tailwind is **not** installed. Prefer the existing CSS-variable + classes approach
  in `globals.css` (CSS Modules are fine). If you add a dependency (chart lib, icon
  set), justify it and keep the bundle small; the inline SVG chart is acceptable to keep.
- No new runtime deps in other packages. UI-only.
- Ports: dashboard `3100` (3000 is taken by Rocket.Chat in the dev env).

## 9. How to run and verify

```bash
docker compose up -d postgres livekit           # infra
pnpm --filter ingest dev                        # :4000
pnpm --filter dashboard dev                     # :3100
pnpm --filter ingest fake-events                # pushes a 2-turn session live
```

Verification gates (must all pass):

```bash
pnpm --filter dashboard typecheck
pnpm --filter dashboard test
pnpm --filter dashboard build
pnpm lint
```

## 10. Deliverables

- Polished live, history, and replay views consistent with the human's direction.
- A small, documented design system: tokens (color/space/type), shared primitives
  (panel, tile, badge, button, marker), in `globals.css` (or CSS modules).
- Before/after screenshots or a short GIF.
- A note in the PR/commit describing the direction and any model/API additions.

## 11. References

- `Plan.md` §4.6 — the original dashboard spec.
- `docs/definitions.md` — exact meaning of every metric (don't display a metric that
  isn't defined there; if you need a new one, flag it).
- Existing tests in `apps/dashboard/test/model.test.ts` — keep them green and add
  tests for any new pure presentation logic.
