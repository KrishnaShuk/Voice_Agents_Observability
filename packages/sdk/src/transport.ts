import { IngestServerMessageSchema, type VoiceEvent } from "@voxobs/schema";
import { WebSocket } from "ws";

export interface WsSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code: number, reason: unknown) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export type WsFactory = (url: string, headers: Record<string, string>) => WsSocket;

export interface TransportOptions {
  url: string;
  apiKey: string;
  sessionId: string;
  socketFactory?: WsFactory;
  maxBuffer?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onDrop?: (event: VoiceEvent) => void;
  logger?: (message: string) => void;
}

const OPEN = 1;

export class WsTransport {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly sessionId: string;
  private readonly socketFactory: WsFactory;
  private readonly maxBuffer: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly onDrop?: (event: VoiceEvent) => void;
  private readonly logger?: (message: string) => void;

  private pending: VoiceEvent[] = [];
  private socket: WsSocket | null = null;
  private closed = false;
  private connecting = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private droppedCount = 0;

  constructor(options: TransportOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.sessionId = options.sessionId;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.maxBuffer = options.maxBuffer ?? 10_000;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 250;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5_000;
    this.onDrop = options.onDrop;
    this.logger = options.logger;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get connected(): boolean {
    return this.isOpen();
  }

  start(): void {
    if (this.closed) return;
    this.connect();
  }

  send(event: VoiceEvent): void {
    if (this.closed) return;
    this.pending.push(event);
    this.enforceBound();
    this.flush();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private enforceBound(): void {
    if (this.pending.length <= this.maxBuffer) return;
    const overflow = this.pending.length - this.maxBuffer;
    const dropped = this.pending.splice(0, overflow);
    for (const event of dropped) {
      this.droppedCount += 1;
      this.onDrop?.(event);
    }
  }

  private isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === OPEN;
  }

  private connect(): void {
    if (this.closed || this.connecting || this.isOpen()) return;
    this.connecting = true;

    let socket: WsSocket;
    try {
      socket = this.socketFactory(this.url, { "x-api-key": this.apiKey });
    } catch (err) {
      this.connecting = false;
      this.logger?.(`socket factory threw: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.on("open", () => {
      this.connecting = false;
      this.attempts = 0;
      this.flush();
    });

    socket.on("message", (data) => this.handleMessage(data));

    socket.on("close", () => {
      this.connecting = false;
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    });

    socket.on("error", (err) => {
      this.logger?.(`socket error: ${String(err)}`);
    });
  }

  private flush(): void {
    if (!this.isOpen() || !this.socket) return;
    const socket = this.socket;
    for (const event of this.pending) {
      socket.send(JSON.stringify({ event }));
    }
  }

  private handleMessage(data: unknown): void {
    const text = toText(data);
    if (text === null) return;

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }

    const parsed = IngestServerMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type !== "ack" || message.sessionId !== this.sessionId) return;

    this.pending = this.pending.filter((event) => event.seq > message.seq);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.attempts, this.reconnectMaxMs);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

function toText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return null;
}

export const defaultSocketFactory: WsFactory = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as WsSocket;
