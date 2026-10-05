import type { Turn } from "../lib/model";
import { turnDomain, turnMarkers, turnSegments } from "../lib/model";

const SEGMENT_LABEL: Record<string, string> = { eou: "EOU", stt: "STT", llm: "LLM", tts: "TTS" };

export function Timeline({ turns }: { turns: Turn[] }) {
  if (turns.length === 0) {
    return <div className="chart-empty">waiting for the first turn…</div>;
  }
  return (
    <div className="timeline">
      {turns.map((turn, index) => (
        <TurnRow key={turn.turnId} turn={turn} index={index} />
      ))}
      <div className="legend">
        <span className="l-eou">EOU</span>
        <span className="l-stt">STT</span>
        <span className="l-llm">LLM</span>
        <span className="l-tts">TTS</span>
        <span className="l-degraded">degraded</span>
        <span className="l-failure">failure</span>
        <span className="l-failover">failover</span>
      </div>
    </div>
  );
}

function TurnRow({ turn, index }: { turn: Turn; index: number }) {
  const segments = turnSegments(turn);
  const markers = turnMarkers(turn);
  const { startMs: start, endMs: end } = turnDomain(turn);
  const span = Math.max(1, end - start);

  const left = (ms: number) => `${Math.min(100, Math.max(0, ((ms - start) / span) * 100))}%`;
  const width = (a: number, b: number) =>
    `${Math.min(100, Math.max(0.75, ((b - a) / span) * 100))}%`;

  return (
    <div className="turn-row">
      <div className="turn-label">T{index + 1}</div>
      <div className="turn-track">
        {segments.map((segment, i) => (
          <div
            key={`${segment.kind}-${i}`}
            className={`seg seg-${segment.kind}`}
            style={{ left: left(segment.startMs), width: width(segment.startMs, segment.endMs) }}
            title={`${SEGMENT_LABEL[segment.kind]} ${Math.round(segment.endMs - segment.startMs)}ms`}
          >
            <span>{SEGMENT_LABEL[segment.kind]}</span>
          </div>
        ))}
        {markers.map((marker, i) => (
          <div
            key={`${marker.kind}-${i}`}
            className={`marker marker-${marker.kind}`}
            style={{ left: left(marker.tMs) }}
            title={marker.label ?? marker.kind}
          />
        ))}
      </div>
    </div>
  );
}
