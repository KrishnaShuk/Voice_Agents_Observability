import { WebSocket } from "ws";
import type { VoiceEvent } from "@voxobs/schema";

export class LiveBroadcaster {
  private readonly subscribers = new Map<WebSocket, string | null>();

  add(socket: WebSocket, sessionId: string | null): void {
    this.subscribers.set(socket, sessionId);
  }

  subscribe(socket: WebSocket, sessionId: string | null): void {
    if (this.subscribers.has(socket)) this.subscribers.set(socket, sessionId);
  }

  remove(socket: WebSocket): void {
    this.subscribers.delete(socket);
  }

  broadcast(event: VoiceEvent): void {
    const payload = JSON.stringify({ type: "event", event });
    for (const [socket, sessionId] of this.subscribers) {
      if (sessionId !== null && sessionId !== event.sessionId) continue;
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  get size(): number {
    return this.subscribers.size;
  }
}
