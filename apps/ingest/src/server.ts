import http from "node:http";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { WebSocketServer, WebSocket } from "ws";
import { parseIngestClientMessage, LiveSubscribeSchema, type VoiceEvent } from "@voxobs/schema";
import type { Pool } from "pg";
import {
  finalizeTimedOutSessions,
  getSessionEvents,
  getStats,
  ingestEvents,
  listSessions,
} from "./db.js";
import { validateEvent } from "./validate.js";
import { LiveBroadcaster } from "./live.js";

export interface IngestLogger {
  info: (message: string) => void;
  error: (error: unknown) => void;
}

export interface IngestServerOptions {
  pool: Pool;
  apiKey: string;
  logger?: IngestLogger;
}

export interface IngestServer {
  app: Express;
  server: http.Server;
  live: LiveBroadcaster;
  ingestWss: WebSocketServer;
  liveWss: WebSocketServer;
  close: () => Promise<void>;
}

const silentLogger: IngestLogger = { info: () => {}, error: () => {} };

export function createIngestServer(options: IngestServerOptions): IngestServer {
  const { pool, apiKey } = options;
  const logger = options.logger ?? silentLogger;

  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, res, next) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, x-api-key, x-injection-token");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  const live = new LiveBroadcaster();
  const ingestWss = new WebSocketServer({ noServer: true });
  const liveWss = new WebSocketServer({ noServer: true });
  const server = http.createServer(app);

  const requireApiKey = (req: Request, res: Response, next: NextFunction): void => {
    if (req.header("x-api-key") !== apiKey) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post(
    "/events",
    requireApiKey,
    asyncHandler(async (req: Request, res: Response) => {
      const raw = extractRawEvents(req.body);
      if (raw === null) {
        res.status(400).json({ error: "expected an event, { event }, or { events: [...] }" });
        return;
      }

      const events: VoiceEvent[] = [];
      const errors: string[] = [];
      for (const item of raw) {
        const result = validateEvent(item);
        if (result.ok) events.push(result.event);
        else errors.push(result.error);
      }

      if (errors.length > 0) {
        res.status(400).json({ error: "invalid payload", details: errors });
        return;
      }

      const inserted = await ingestEvents(pool, events);
      for (const event of events) live.broadcast(event);
      res.status(202).json({ received: events.length, inserted });
    }),
  );

  app.get(
    "/sessions",
    asyncHandler(async (req: Request, res: Response) => {
      const limit = clampLimit(req.query.limit);
      res.json({ sessions: await listSessions(pool, limit) });
    }),
  );

  app.get(
    "/sessions/:id/events",
    asyncHandler(async (req: Request, res: Response) => {
      const afterSeq = Number(req.query.afterSeq ?? -1);
      res.json({ events: await getSessionEvents(pool, req.params.id, afterSeq) });
    }),
  );

  app.get(
    "/stats",
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await getStats(pool));
    }),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/ingest") {
      if (req.headers["x-api-key"] !== apiKey) {
        socket.destroy();
        return;
      }
      ingestWss.handleUpgrade(req, socket, head, (ws) => ingestWss.emit("connection", ws, req));
    } else if (pathname === "/live") {
      liveWss.handleUpgrade(req, socket, head, (ws) => liveWss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  ingestWss.on("connection", (socket) => {
    socket.on("message", (data) => {
      void handleIngestMessage(socket, data.toString(), pool, live, logger);
    });
  });

  liveWss.on("connection", (socket) => {
    live.add(socket, null);
    socket.on("message", (data) => {
      try {
        const parsed = LiveSubscribeSchema.safeParse(JSON.parse(data.toString()));
        if (parsed.success) live.subscribe(socket, parsed.data.sessionId ?? null);
      } catch {
        // ignore malformed subscribe messages
      }
    });
    socket.on("close", () => live.remove(socket));
  });

  const close = async (): Promise<void> => {
    for (const client of ingestWss.clients) client.terminate();
    for (const client of liveWss.clients) client.terminate();
    ingestWss.close();
    liveWss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  };

  return { app, server, live, ingestWss, liveWss, close };
}

export { finalizeTimedOutSessions };

async function handleIngestMessage(
  socket: WebSocket,
  text: string,
  pool: Pool,
  live: LiveBroadcaster,
  logger: IngestLogger,
): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    socket.send(JSON.stringify({ type: "error", message: "malformed JSON" }));
    return;
  }

  let clientMessage;
  try {
    clientMessage = parseIngestClientMessage(message);
  } catch {
    socket.send(JSON.stringify({ type: "error", message: "invalid message" }));
    return;
  }

  const incoming = "event" in clientMessage ? [clientMessage.event] : clientMessage.events;
  const events: VoiceEvent[] = [];

  for (const item of incoming) {
    const result = validateEvent(item);
    if (result.ok) {
      events.push(result.event);
    } else {
      socket.send(JSON.stringify({ type: "error", message: result.error }));
    }
  }

  if (events.length === 0) return;

  try {
    await ingestEvents(pool, events);
  } catch (err) {
    logger.error(err);
    socket.send(JSON.stringify({ type: "error", message: "ingest failed" }));
    return;
  }

  for (const event of events) {
    live.broadcast(event);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ack", sessionId: event.sessionId, seq: event.seq }));
    }
  }
}

function extractRawEvents(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.events)) return record.events;
    if (record.event !== undefined) return [record.event];
    if (record.type !== undefined) return [body];
  }
  return null;
}

function clampLimit(value: unknown): number {
  const parsed = Number(value ?? 50);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(Math.trunc(parsed), 1), 500);
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;

function asyncHandler(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
