import type { VoiceEvent } from "@voxobs/schema";

const HTTP = process.env.NEXT_PUBLIC_INGEST_HTTP_URL ?? "http://localhost:4000";

export interface SessionSummary {
  id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  turn_count: number;
  had_failover: boolean;
  providers: Record<string, string[]> | null;
}

interface RawEventRow {
  payload: VoiceEvent;
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  const res = await fetch(`${HTTP}/sessions`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /sessions -> ${res.status}`);
  const body = (await res.json()) as { sessions: SessionSummary[] };
  return body.sessions;
}

export async function fetchSessionEvents(id: string): Promise<VoiceEvent[]> {
  const res = await fetch(`${HTTP}/sessions/${encodeURIComponent(id)}/events`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /sessions/:id/events -> ${res.status}`);
  const body = (await res.json()) as { events: RawEventRow[] };
  return body.events.map((row) => row.payload).filter(Boolean);
}
