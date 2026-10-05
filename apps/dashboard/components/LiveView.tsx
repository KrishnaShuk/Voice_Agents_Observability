"use client";

import { useEffect, useState } from "react";
import type { VoiceEvent } from "@voxobs/schema";
import { applyEvent, createSession, sessionDurationMs, stubSession, type SessionModel } from "../lib/model";
import { connectLive, type LiveStatus } from "../lib/ws";
import { AppHeader } from "./AppHeader";
import { EmptyState } from "./EmptyState";
import { StatTiles } from "./StatTiles";
import { Timeline } from "./Timeline";
import { VoiceToVoiceChart } from "./VoiceToVoiceChart";

const LIVE_URL = process.env.NEXT_PUBLIC_INGEST_LIVE_URL ?? "ws://localhost:4000/live";

function reduce(prev: SessionModel | null, event: VoiceEvent): SessionModel {
  if (event.type === "session_start") return createSession(event);
  if (prev === null) return applyEvent(stubSession(event), event);
  if (event.sessionId !== prev.sessionId) return prev;
  return applyEvent(prev, event);
}

export function LiveView() {
  const [model, setModel] = useState<SessionModel | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");

  useEffect(() => {
    const connection = connectLive(
      LIVE_URL,
      (event) => setModel((prev) => reduce(prev, event)),
      setStatus,
    );
    return () => connection.close();
  }, []);

  if (model === null) return <EmptyState status={status} />;

  const duration = sessionDurationMs(model);

  return (
    <main>
      <AppHeader
        title="live"
        meta={
          <>
            <span className={`status-dot status-${status}`} />
            {status}
            {" · "}session {model.sessionId.slice(0, 8)}
            {" · "}
            {model.agentVersion}
            {" · "}
            {model.turns.length} turns
            {" · "}
            {(duration / 1000).toFixed(1)}s
            {model.endReason ? ` · ended (${model.endReason})` : ""}
          </>
        }
      />

      <div className="panel">
        <h2>turn timeline</h2>
        <Timeline turns={model.turns} />
      </div>

      <div className="panel">
        <h2>latest turn</h2>
        <StatTiles model={model} />
      </div>

      <div className="panel">
        <h2>voice-to-voice (rolling)</h2>
        <VoiceToVoiceChart model={model} />
      </div>
    </main>
  );
}
