import type { LiveStatus } from "../lib/ws";

export function EmptyState({ status }: { status: LiveStatus }) {
  const joinUrl = process.env.NEXT_PUBLIC_JOIN_URL ?? "http://localhost:3001";
  return (
    <main>
      <div className="app-header">
        <h1>voxobs — live</h1>
        <div className="meta">
          <span className={`status-dot status-${status}`} />
          {status}
        </div>
      </div>
      <div className="panel">
        <div className="empty">
          <p>no live session — start a call to see it here</p>
          <p>
            <a href={joinUrl}>{joinUrl}</a>
          </p>
        </div>
      </div>
    </main>
  );
}
