import { Pool } from "pg";
import type { VoiceEvent } from "@voxobs/schema";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  event_id uuid PRIMARY KEY,
  session_id text NOT NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  t_offset_ms double precision NOT NULL,
  ts bigint NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_session_seq_key UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS events_session_seq_idx ON events (session_id, seq);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text,
  turn_count integer NOT NULL DEFAULT 0,
  had_failover boolean NOT NULL DEFAULT false,
  providers jsonb
);
`;

export interface SessionRow {
  id: string;
  started_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
  turn_count: number;
  had_failover: boolean;
  providers: Record<string, string[]> | null;
}

export interface EventRow {
  event_id: string;
  session_id: string;
  seq: number;
  type: string;
  payload: VoiceEvent;
  t_offset_ms: number;
  ts: number;
}

export interface LatencyStats {
  provider: string;
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface StatsResult {
  stt: LatencyStats[];
  llm: LatencyStats[];
  tts: LatencyStats[];
  failover: { n: number; p50: number | null; p95: number | null };
}

export function createPool(connectionString: string, max = 10): Pool {
  return new Pool({ connectionString, max });
}

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE events, sessions");
}

export async function insertEvents(pool: Pool, events: VoiceEvent[]): Promise<number> {
  if (events.length === 0) return 0;

  const columns = 7;
  const values: unknown[] = [];
  const tuples = events.map((event, index) => {
    const base = index * columns;
    values.push(
      event.eventId,
      event.sessionId,
      event.seq,
      event.type,
      JSON.stringify(event),
      event.tOffsetMs,
      event.timestamp,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });

  const result = await pool.query(
    `INSERT INTO events (event_id, session_id, seq, type, payload, t_offset_ms, ts)
     VALUES ${tuples.join(", ")}
     ON CONFLICT DO NOTHING`,
    values,
  );
  return result.rowCount ?? 0;
}

export async function refreshSessions(pool: Pool, sessionIds: string[]): Promise<void> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return;

  await pool.query(
    `INSERT INTO sessions (id)
     SELECT unnest($1::text[])
     ON CONFLICT (id) DO NOTHING`,
    [ids],
  );

  await pool.query(
    `UPDATE sessions s SET
       started_at = COALESCE(to_timestamp((sub.start_ts / 1000.0)::double precision), s.started_at),
       ended_at = COALESCE(to_timestamp((sub.end_ts / 1000.0)::double precision), s.ended_at),
       end_reason = COALESCE(sub.end_reason, s.end_reason),
       turn_count = sub.turn_count,
       had_failover = sub.had_failover,
       providers = COALESCE(sub.providers, s.providers)
     FROM (
       SELECT
         e.session_id,
         min(e.ts) FILTER (WHERE e.type = 'session_start') AS start_ts,
         min(e.ts) FILTER (WHERE e.type = 'session_end') AS end_ts,
         (array_agg(e.payload->>'reason') FILTER (WHERE e.type = 'session_end'))[1] AS end_reason,
         count(*) FILTER (WHERE e.type = 'turn_end')::int AS turn_count,
         bool_or(e.type = 'failover') AS had_failover,
         (array_agg(e.payload->'providers') FILTER (WHERE e.type = 'session_start'))[1] AS providers
       FROM events e
       WHERE e.session_id = ANY($1::text[])
       GROUP BY e.session_id
     ) sub
     WHERE s.id = sub.session_id`,
    [ids],
  );
}

export async function ingestEvents(pool: Pool, events: VoiceEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const inserted = await insertEvents(pool, events);
  await refreshSessions(
    pool,
    events.map((event) => event.sessionId),
  );
  return inserted;
}

export async function listSessions(pool: Pool, limit = 50): Promise<SessionRow[]> {
  const result = await pool.query<SessionRow>(
    `SELECT id, started_at, ended_at, end_reason, turn_count, had_failover, providers
     FROM sessions
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function getSessionEvents(
  pool: Pool,
  sessionId: string,
  afterSeq = -1,
): Promise<EventRow[]> {
  const result = await pool.query<EventRow>(
    `SELECT event_id, session_id, seq, type, payload, t_offset_ms, ts::double precision AS ts
     FROM events
     WHERE session_id = $1 AND seq > $2
     ORDER BY seq ASC`,
    [sessionId, afterSeq],
  );
  return result.rows;
}

async function latencyByProvider(pool: Pool, type: string): Promise<LatencyStats[]> {
  const result = await pool.query<LatencyStats>(
    `SELECT
       payload->>'provider' AS provider,
       count(*)::int AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY (payload->>'latencyMs')::double precision) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY (payload->>'latencyMs')::double precision) AS p95,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY (payload->>'latencyMs')::double precision) AS p99
     FROM events
     WHERE type = $1
     GROUP BY 1
     ORDER BY 1`,
    [type],
  );
  return result.rows;
}

export async function getStats(pool: Pool): Promise<StatsResult> {
  const [stt, llm, tts] = await Promise.all([
    latencyByProvider(pool, "stt_latency"),
    latencyByProvider(pool, "llm_ttft"),
    latencyByProvider(pool, "tts_ttfb"),
  ]);

  const failover = await pool.query<{ n: number; p50: number | null; p95: number | null }>(
    `SELECT
       count(*)::int AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY (payload->>'recoveryMs')::double precision) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY (payload->>'recoveryMs')::double precision) AS p95
     FROM events
     WHERE type = 'failover'`,
  );

  return { stt, llm, tts, failover: failover.rows[0] ?? { n: 0, p50: null, p95: null } };
}

export async function finalizeTimedOutSessions(pool: Pool, timeoutMs: number): Promise<number> {
  const cutoff = Date.now() - timeoutMs;
  const result = await pool.query(
    `UPDATE sessions s
     SET ended_at = now(), end_reason = 'timeout'
     WHERE s.ended_at IS NULL
       AND s.id IN (
         SELECT e.session_id
         FROM events e
         GROUP BY e.session_id
         HAVING max(e.ts) < $1
       )`,
    [cutoff],
  );
  return result.rowCount ?? 0;
}
