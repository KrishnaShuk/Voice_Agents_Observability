"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { VoiceEvent } from "@voxobs/schema";
import { buildSession, sessionDurationMs } from "../lib/model";
import { fetchSessionEvents } from "../lib/api";
import { AppHeader } from "./AppHeader";
import { StatTiles } from "./StatTiles";
import { Timeline } from "./Timeline";
import { VoiceToVoiceChart } from "./VoiceToVoiceChart";

export function SessionReplay({ id }: { id: string }) {
  const [events, setEvents] = useState<VoiceEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const lastTick = useRef<number | null>(null);

  useEffect(() => {
    setEvents(null);
    setCursor(0);
    setPlaying(false);
    fetchSessionEvents(id)
      .then(setEvents)
      .catch((err) => setError(String(err)));
  }, [id]);

  const full = useMemo(() => (events ? buildSession(events) : null), [events]);
  const duration = full ? sessionDurationMs(full) : 0;
  const model = useMemo(() => (events ? buildSession(events, cursor) : null), [events, cursor]);

  useEffect(() => {
    if (!playing || duration === 0) return;
    lastTick.current = null;
    let frame = 0;
    const step = (now: number) => {
      if (lastTick.current === null) lastTick.current = now;
      const dt = now - lastTick.current;
      lastTick.current = now;
      setCursor((current) => {
        const next = current + dt;
        if (next >= duration) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration]);

  if (error) {
    return (
      <main>
        <AppHeader title="replay" />
        <div className="panel">
          <div className="empty">failed to load session: {error}</div>
        </div>
      </main>
    );
  }

  if (!events || !model) {
    return (
      <main>
        <AppHeader title="replay" />
        <div className="panel">
          <div className="empty">loading…</div>
        </div>
      </main>
    );
  }

  return (
    <main>
      <AppHeader title={`replay · ${id.slice(0, 8)}`} meta={model.endReason ?? "open"} />
      <div className="panel">
        <div className="replay-controls">
          <button type="button" onClick={() => setPlaying((value) => !value)}>
            {playing ? "pause" : "play"}
          </button>
          <input
            type="range"
            min={0}
            max={Math.round(duration)}
            value={Math.min(Math.round(cursor), Math.round(duration))}
            onChange={(event) => {
              setPlaying(false);
              setCursor(Number(event.target.value));
            }}
          />
          <span className="dim">
            {(cursor / 1000).toFixed(1)}s / {(duration / 1000).toFixed(1)}s
          </span>
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              setCursor(0);
            }}
          >
            reset
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>turn timeline</h2>
        <Timeline turns={model.turns} />
      </div>

      <div className="panel">
        <h2>metrics</h2>
        <StatTiles model={model} />
      </div>

      <div className="panel">
        <h2>voice-to-voice (rolling)</h2>
        <VoiceToVoiceChart model={model} />
      </div>
    </main>
  );
}
