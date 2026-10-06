import type { Turn } from "../lib/model";
import { turnDomain, turnMarkers, turnSegments } from "../lib/model";

const SEGMENT_LABEL: Record<string, string> = { eou: "EOU", stt: "STT", llm: "LLM", tts: "TTS" };
const MARKER_SYMBOL: Record<string, string> = { barge_in: "◇", degraded: "!", failure: "×", failover: "↳" };

type TimelineProps = { turns: Turn[]; domainStartMs?: number; domainEndMs?: number; playheadMs?: number };

export function Timeline({ turns, domainStartMs, domainEndMs, playheadMs }: TimelineProps) {
  if (turns.length === 0) return <div className="chart-empty">waiting for the first turn…</div>;

  const domains = turns.map(turnDomain);
  const start = domainStartMs ?? Math.min(...domains.map((domain) => domain.startMs));
  const end = domainEndMs ?? Math.max(...domains.map((domain) => domain.endMs));
  const span = Math.max(300, end - start);
  const ticks = Array.from({ length: 5 }, (_, index) => start + (span * index) / 4);
  const position = (ms: number) => Math.min(100, Math.max(0, ((ms - start) / span) * 100));

  return (
    <div className="trace" aria-label="Turn trace">
      <div className="trace-axis" aria-hidden="true"><span className="trace-axis-label">TIME</span><div className="trace-axis-scale">{ticks.map((tick, index) => <span key={index} className="trace-tick" style={{ left: `${position(tick)}%` }}>{formatTime(tick - start)}</span>)}</div></div>
      <div className="trace-rows">{turns.map((turn, index) => <TurnRow key={turn.turnId} turn={turn} index={index} position={position} span={span} />)}</div>
      {playheadMs !== undefined ? <div className="trace-playhead" style={{ left: `calc(56px + (100% - 56px) * ${position(playheadMs) / 100})` }} aria-hidden="true" /> : null}
      <div className="trace-legend" aria-label="Timeline legend"><span className="l-eou">EOU</span><span className="l-stt">STT</span><span className="l-llm">LLM</span><span className="l-tts">TTS</span><span className="l-degraded">degraded</span><span className="l-failure">failure</span><span className="l-failover">failover</span></div>
    </div>
  );
}

function TurnRow({ turn, index, position, span }: { turn: Turn; index: number; position: (ms: number) => number; span: number }) {
  const segments = turnSegments(turn);
  const markers = turnMarkers(turn);
  const width = (a: number, b: number) => `${Math.max(0.75, ((b - a) / span) * 100)}%`;
  return <div className="trace-row"><div className="turn-label"><span>TURN</span>T{String(index + 1).padStart(2, "0")}</div><div className="turn-track"><div className="track-grid" aria-hidden="true" />
    {segments.map((segment, i) => { const duration = Math.round(segment.endMs - segment.startMs); return <div key={`${segment.kind}-${i}`} className={`seg seg-${segment.kind}`} style={{ left: `${position(segment.startMs)}%`, width: width(segment.startMs, segment.endMs) }} title={`${SEGMENT_LABEL[segment.kind]} · ${duration} ms`} aria-label={`${SEGMENT_LABEL[segment.kind]}, ${duration} milliseconds`}><span>{SEGMENT_LABEL[segment.kind]}</span></div>; })}
    {markers.map((marker, i) => <span key={`${marker.kind}-${i}`} className={`marker marker-${marker.kind}`} style={{ left: `${position(marker.tMs)}%` }} title={marker.label ?? marker.kind} role="img" aria-label={marker.label ?? marker.kind}>{MARKER_SYMBOL[marker.kind]}</span>)}
  </div></div>;
}

function formatTime(ms: number): string { return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`; }
