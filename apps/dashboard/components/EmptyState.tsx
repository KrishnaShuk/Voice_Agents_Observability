import { AppHeader } from "./AppHeader";
import type { LiveStatus } from "../lib/ws";

export function EmptyState({ status }: { status: LiveStatus }) {
  const joinUrl = process.env.NEXT_PUBLIC_JOIN_URL ?? "http://localhost:3001";
  return (
    <main>
      <AppHeader
        title="live"
        meta={
          <>
            <span className={`status-dot status-${status}`} />
            {status}
          </>
        }
      />
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
