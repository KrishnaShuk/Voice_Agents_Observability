import { latestTurn, type SessionModel } from "../lib/model";

function value(input: number | null | undefined): string {
  return input === null || input === undefined ? "—" : String(Math.round(input));
}

export function StatTiles({ model }: { model: SessionModel }) {
  const turn = latestTurn(model);
  const tiles = [
    { label: "STT latency", value: turn?.sttLatencyMs },
    { label: "LLM TTFT", value: turn?.llmTtftMs },
    { label: "TTS TTFB", value: turn?.ttsTtfbMs },
    { label: "Voice→voice", value: turn?.voiceToVoiceMs },
  ];

  return (
    <div className="tiles">
      {tiles.map((tile) => (
        <div className="tile" key={tile.label}>
          <div className="tile-label">{tile.label}</div>
          <div className="tile-value">
            {value(tile.value)}
            {tile.value !== null && tile.value !== undefined ? <span className="tile-unit">ms</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
