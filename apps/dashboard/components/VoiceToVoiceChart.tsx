import { voiceToVoiceSeries, type SessionModel } from "../lib/model";

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))]!;
}

export function VoiceToVoiceChart({ model }: { model: SessionModel }) {
  const series = voiceToVoiceSeries(model).slice(-20);
  if (series.length === 0) {
    return <div className="chart-empty">no voice-to-voice samples yet</div>;
  }

  const width = 520;
  const height = 150;
  const left = 42;
  const right = 12;
  const top = 12;
  const bottom = 26;
  const max = Math.max(...series, 1);
  const min = Math.min(...series);
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const points = series.map((value, index) => {
    const x = series.length === 1 ? left + innerWidth / 2 : left + (index / (series.length - 1)) * innerWidth;
    const y = top + innerHeight - (value / max) * innerHeight;
    return { x, y };
  });
  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const p50 = percentile(series, 0.5);
  const p95 = percentile(series, 0.95);

  return (
    <figure className="chart-wrap">
      <div className="chart-summary"><span>last {series.length} turns</span><span>p50 {Math.round(p50)} ms</span><span>p95 {Math.round(p95)} ms</span></div>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Voice-to-voice latency for ${series.length} turns. Minimum ${Math.round(min)} milliseconds, maximum ${Math.round(max)} milliseconds.`}>
        {[0, 0.5, 1].map((ratio) => {
          const y = top + innerHeight * ratio;
          return <g key={ratio}><line className="chart-grid" x1={left} x2={width - right} y1={y} y2={y} /><text className="chart-axis" x="0" y={y + 4}>{Math.round(max * (1 - ratio))}ms</text></g>;
        })}
        <line className="chart-baseline" x1={left} x2={width - right} y1={top + innerHeight} y2={top + innerHeight} />
        {points.length > 1 ? <polyline points={polyline} fill="none" className="chart-line" /> : null}
        {points.map((point, index) => <g key={index}><circle cx={point.x} cy={point.y} r="3" className="chart-dot"><title>{`Turn ${index + 1}: ${Math.round(series[index]!)} ms`}</title></circle><text className="chart-axis chart-turn" x={point.x} y={height - 5}>T{index + 1}</text></g>)}
      </svg>
    </figure>
  );
}
