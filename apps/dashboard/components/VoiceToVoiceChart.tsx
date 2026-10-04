import { voiceToVoiceSeries, type SessionModel } from "../lib/model";

export function VoiceToVoiceChart({ model }: { model: SessionModel }) {
  const series = voiceToVoiceSeries(model);
  if (series.length === 0) {
    return <div className="chart-empty">no voice-to-voice samples yet</div>;
  }

  const width = 320;
  const height = 80;
  const pad = 6;
  const max = Math.max(...series, 1);
  const points = series
    .map((value, index) => {
      const x = series.length === 1 ? width / 2 : pad + (index / (series.length - 1)) * (width - 2 * pad);
      const y = height - pad - (value / max) * (height - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="voice-to-voice latency">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
