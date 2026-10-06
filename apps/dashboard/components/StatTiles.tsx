import type { Turn } from "../lib/model";
import { lastValue, type SessionModel } from "../lib/model";

function value(input: number | null): string {
  return input === null ? "—" : String(Math.round(input));
}

function previousValue(model: SessionModel, pick: (turn: Turn) => number | null): number | null {
  let seenLatest = false;
  for (let i = model.turns.length - 1; i >= 0; i -= 1) {
    const candidate = pick(model.turns[i]!);
    if (candidate === null) continue;
    if (seenLatest) return candidate;
    seenLatest = true;
  }
  return null;
}

export function StatTiles({ model }: { model: SessionModel }) {
  const definitions = [
    { label: "STT latency", pick: (turn: Turn) => turn.sttLatencyMs },
    { label: "LLM TTFT", pick: (turn: Turn) => turn.llmTtftMs },
    { label: "TTS TTFB", pick: (turn: Turn) => turn.ttsTtfbMs },
    { label: "Voice→voice", pick: (turn: Turn) => turn.voiceToVoiceMs },
  ];

  return (
    <div className="tiles">
      {definitions.map((definition) => {
        const current = lastValue(model, definition.pick);
        const previous = previousValue(model, definition.pick);
        const delta = current !== null && previous !== null ? current - previous : null;
        return <div className="tile" key={definition.label}><div className="tile-label">{definition.label}</div><div className="tile-value">{value(current)}{current !== null ? <span className="tile-unit">ms</span> : null}</div><div className={`tile-delta ${delta !== null && delta > 0 ? "is-higher" : ""}`}>{delta === null ? "no previous turn" : `${delta > 0 ? "↑" : delta < 0 ? "↓" : "–"} ${Math.abs(Math.round(delta))} ms vs prior`}</div></div>;
      })}
    </div>
  );
}
