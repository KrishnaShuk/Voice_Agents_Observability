"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchSessions, type SessionSummary } from "../lib/api";
import { AppHeader } from "./AppHeader";

function formatDuration(session: SessionSummary): string {
  if (!session.ended_at) return "—";
  const ms = new Date(session.ended_at).getTime() - new Date(session.started_at).getTime();
  return `${(ms / 1000).toFixed(1)}s`;
}

function providers(session: SessionSummary): string {
  const llm = session.providers?.llm ?? [];
  const tts = session.providers?.tts ?? [];
  const parts = [...llm, ...tts];
  return parts.length > 0 ? parts.join(", ") : "—";
}

export function HistoryTable() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    setSessions(null);
    fetchSessions().then(setSessions).catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main>
      <AppHeader title="history" />
      <div className="panel">
        {error ? (
          <div className="empty"><p>couldn’t load sessions</p><p className="dim">check the ingest service, then try again.</p><button type="button" className="button" onClick={load}>retry</button></div>
        ) : sessions === null ? (
          <div className="table-skeleton" aria-label="Loading sessions"><span /><span /><span /><span /><span /></div>
        ) : sessions.length === 0 ? (
          <div className="empty"><p>no sessions recorded yet</p><p className="dim">start a call to populate this history.</p></div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>date</th>
                <th>duration</th>
                <th>turns</th>
                <th>providers</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>
                    <Link href={`/history/${session.id}`}>
                      {new Date(session.started_at).toLocaleString()}
                    </Link>
                  </td>
                  <td>{formatDuration(session)}</td>
                  <td>{session.turn_count}</td>
                  <td className="dim">{providers(session)}</td>
                  <td>
                    {session.had_failover ? <span className="badge badge-failover">failover</span> : null}
                    {session.end_reason ? <span className="badge">{session.end_reason}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
