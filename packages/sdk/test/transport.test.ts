import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { VoiceEvent } from "@voxobs/schema";
import { WsTransport, type WsFactory, type WsSocket } from "../src/index.js";

class MockServer {
  private wss!: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  readonly deliveries: string[] = [];
  readonly persisted = new Set<string>();
  suppressAcks = false;
  port = 0;

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => this.wss.once("listening", () => resolve()));
    this.port = (this.wss.address() as AddressInfo).port;

    this.wss.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { event: VoiceEvent };
        const event = message.event;
        const key = `${event.sessionId}:${event.seq}`;
        this.deliveries.push(key);
        this.persisted.add(key);
        if (!this.suppressAcks) {
          socket.send(JSON.stringify({ type: "ack", sessionId: event.sessionId, seq: event.seq }));
        }
      });
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  drop(): void {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
  }

  async stop(): Promise<void> {
    this.drop();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

function event(sessionId: string, seq: number): VoiceEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId,
    seq,
    tOffsetMs: seq,
    timestamp: 1_700_000_000_000 + seq,
    type: "turn_start",
    turnId: `t${seq}`,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitUntil timed out");
}

const servers: MockServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("WsTransport", () => {
  it("buffers events while disconnected and flushes on connect", async () => {
    const server = new MockServer();
    servers.push(server);
    await server.start();

    const sessionId = "s1";
    const transport = new WsTransport({
      url: `ws://127.0.0.1:${server.port}`,
      apiKey: "k",
      sessionId,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
    });

    transport.send(event(sessionId, 0));
    transport.send(event(sessionId, 1));
    expect(transport.pendingCount).toBe(2);

    transport.start();
    await waitUntil(() => server.persisted.size === 2);
    await waitUntil(() => transport.pendingCount === 0);

    expect(transport.connected).toBe(true);
    transport.close();
  });

  it("replays after a disconnect without loss and without duplicate persistence", async () => {
    const server = new MockServer();
    servers.push(server);
    await server.start();

    const sessionId = "s2";
    const transport = new WsTransport({
      url: `ws://127.0.0.1:${server.port}`,
      apiKey: "k",
      sessionId,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
    });
    transport.start();
    await waitUntil(() => transport.connected);

    for (const seq of [0, 1, 2]) transport.send(event(sessionId, seq));
    await waitUntil(() => server.persisted.size === 3);
    await waitUntil(() => transport.pendingCount === 0);

    server.suppressAcks = true;
    for (const seq of [3, 4, 5]) transport.send(event(sessionId, seq));
    await waitUntil(() => server.persisted.size === 6);
    expect(transport.pendingCount).toBe(3);

    server.drop();

    for (const seq of [6, 7, 8]) transport.send(event(sessionId, seq));

    server.suppressAcks = false;
    await waitUntil(() => server.persisted.size === 9);
    await waitUntil(() => transport.pendingCount === 0);

    expect(server.persisted.size).toBe(9);
    for (let seq = 0; seq < 9; seq += 1) {
      expect(server.persisted.has(`${sessionId}:${seq}`)).toBe(true);
    }
    expect(server.deliveries.length).toBeGreaterThan(9);

    transport.close();
  });

  it("drops the oldest events when the buffer overflows", () => {
    const neverConnect: WsFactory = () =>
      ({
        readyState: 0,
        send: () => {},
        close: () => {},
        on: () => {},
      }) as unknown as WsSocket;

    const sessionId = "s3";
    const transport = new WsTransport({
      url: "ws://127.0.0.1:1",
      apiKey: "k",
      sessionId,
      maxBuffer: 2,
      socketFactory: neverConnect,
    });

    transport.start();
    for (const seq of [0, 1, 2]) transport.send(event(sessionId, seq));

    expect(transport.dropped).toBe(1);
    expect(transport.pendingCount).toBe(2);
    transport.close();
  });

  it("ignores acks for other sessions", async () => {
    const server = new MockServer();
    servers.push(server);
    await server.start();

    const sessionId = "s4";
    const transport = new WsTransport({
      url: `ws://127.0.0.1:${server.port}`,
      apiKey: "k",
      sessionId,
      reconnectBaseMs: 5,
    });
    transport.start();
    await waitUntil(() => transport.connected);

    transport.send(event(sessionId, 0));
    await waitUntil(() => transport.pendingCount === 0);
    transport.close();
  });
});
