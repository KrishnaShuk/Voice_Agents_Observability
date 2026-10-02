import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createPool,
  finalizeTimedOutSessions,
  getSessionEvents,
  getStats,
  ingestEvents,
  listSessions,
  runMigrations,
  truncateAll,
} from "../src/db.js";
import * as h from "./helpers.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const suite = dbUrl ? describe : describe.skip;

suite("db", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(dbUrl as string, 4);
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  it("dedups repeated (sessionId, seq) inserts", async () => {
    const events = [h.turnStart("s1", 0, "t1"), h.turnEnd("s1", 1, "t1")];
    expect(await ingestEvents(pool, events)).toBe(2);
    expect(await ingestEvents(pool, events)).toBe(0);
    const rows = await getSessionEvents(pool, "s1");
    expect(rows.map((row) => row.seq)).toEqual([0, 1]);
  });

  it("rebuilds session aggregates regardless of arrival order", async () => {
    await ingestEvents(pool, [h.turnEnd("s1", 5, "t1")]);
    await ingestEvents(pool, [h.turnStart("s1", 0, "t1"), h.sessionStart("s1", 1)]);

    const [session] = await listSessions(pool);
    expect(session.turn_count).toBe(1);
    expect(session.providers).toMatchObject({ llm: ["groq"] });

    const rows = await getSessionEvents(pool, "s1");
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 5]);
  });

  it("finalizes a session on session_end", async () => {
    await ingestEvents(pool, [
      h.sessionStart("s1", 0),
      h.turnEnd("s1", 1, "t1"),
      h.sessionEnd("s1", 2, "completed"),
    ]);

    const [session] = await listSessions(pool);
    expect(session.ended_at).not.toBeNull();
    expect(session.end_reason).toBe("completed");
    expect(session.turn_count).toBe(1);
  });

  it("marks sessions with stale events as timed out", async () => {
    await ingestEvents(pool, [h.sessionStart("s1", 0)]);
    expect(await finalizeTimedOutSessions(pool, 0)).toBe(1);
    const [session] = await listSessions(pool);
    expect(session.end_reason).toBe("timeout");
  });

  it("flags failover and computes per-provider percentiles", async () => {
    await ingestEvents(pool, [
      h.sessionStart("s1", 0),
      h.turnStart("s1", 1, "t1"),
      h.failover("s1", 2, "t1"),
      h.turnEnd("s1", 3, "t1"),
      h.sttLatency("s1", 4, "t1", 300),
      h.sttLatency("s1", 5, "t2", 500),
    ]);

    const [session] = await listSessions(pool);
    expect(session.had_failover).toBe(true);

    const stats = await getStats(pool);
    expect(stats.stt).toHaveLength(1);
    expect(stats.stt[0].provider).toBe("deepgram");
    expect(stats.stt[0].n).toBe(2);
    expect(stats.stt[0].p50).toBe(400);
    expect(stats.failover.n).toBe(1);
    expect(stats.failover.p50).toBe(300);
  });
});
