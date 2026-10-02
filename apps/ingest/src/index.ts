import { createPool, runMigrations } from "./db.js";
import { createIngestServer, finalizeTimedOutSessions } from "./server.js";

const port = Number(process.env.PORT ?? 4000);
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://vox:vox@localhost:5432/vox_observability";
const apiKey = process.env.INGEST_API_KEY ?? "dev-key";
const sessionTimeoutMs = Number(process.env.SESSION_TIMEOUT_MS ?? 120_000);
const sweepIntervalMs = Number(process.env.SWEEP_INTERVAL_MS ?? 30_000);

const pool = createPool(databaseUrl);
await runMigrations(pool);

const ingest = createIngestServer({
  pool,
  apiKey,
  logger: {
    info: (message) => console.log(message),
    error: (error) => console.error(error),
  },
});

ingest.server.listen(port, () => {
  console.log(`ingest listening on ${port}`);
});

const sweep = setInterval(() => {
  finalizeTimedOutSessions(pool, sessionTimeoutMs).catch((err) => console.error(err));
}, sweepIntervalMs);

async function shutdown(): Promise<void> {
  clearInterval(sweep);
  await ingest.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
