import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { WsTransport } from "@voxobs/sdk";
import { createPool, getSessionEvents, runMigrations, truncateAll } from "../src/db.js";
import { createIngestServer, type IngestServer } from "../src/server.js";
import * as h from "./helpers.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const suite = dbUrl ? describe : describe.skip;

suite("ingest e2e", () => {
  let pool: Pool;
  let server: IngestServer;
  let port: number;
  const apiKey = "test-key";

  beforeAll(async () => {
    pool = createPool(dbUrl as string, 4);
    await runMigrations(pool);
    server = createIngestServer({ pool, apiKey });
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  it("replays after a dropped connection without loss or duplication", async () => {
    const sessionId = "s-e2e";
    const transport = new WsTransport({
      url: `ws://127.0.0.1:${port}/ingest`,
      apiKey,
      sessionId,
      reconnectBaseMs: 5,
      reconnectMaxMs: 50,
    });
    transport.start();
    await h.waitUntil(() => transport.connected);

    const first = [
      h.sessionStart(sessionId, 0),
      h.turnStart(sessionId, 1, "t1"),
      h.turnEnd(sessionId, 2, "t1"),
    ];
    for (const event of first) transport.send(event);
    await h.waitUntil(async () => (await getSessionEvents(pool, sessionId)).length === 3);
    await h.waitUntil(() => transport.pendingCount === 0);

    for (const client of server.ingestWss.clients) client.terminate();

    const second = [
      h.turnStart(sessionId, 3, "t2"),
      h.turnEnd(sessionId, 4, "t2"),
      h.sessionEnd(sessionId, 5, "completed"),
    ];
    for (const event of second) transport.send(event);

    await h.waitUntil(async () => (await getSessionEvents(pool, sessionId)).length === 6, 5_000);
    await h.waitUntil(() => transport.pendingCount === 0, 5_000);

    const rows = await getSessionEvents(pool, sessionId);
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(rows.map((row) => row.seq)).size).toBe(rows.length);

    transport.close();
  });

  it("rejects bad payloads over HTTP", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ events: [{ type: "nope" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("requires an api key", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [h.turnStart("s1", 0, "t1")] }),
    });
    expect(res.status).toBe(401);
  });
});
