import { VoiceEventSchema, type VoiceEvent } from "@voxobs/schema";

export type LiveStatus = "connecting" | "open" | "closed";

export interface LiveConnection {
  close: () => void;
}

export function connectLive(
  url: string,
  onEvent: (event: VoiceEvent) => void,
  onStatus: (status: LiveStatus) => void,
): LiveConnection {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;

  const open = () => {
    if (closed) return;
    onStatus("connecting");
    socket = new WebSocket(url);

    socket.onopen = () => {
      attempt = 0;
      onStatus("open");
    };

    socket.onmessage = (message) => {
      try {
        const data = JSON.parse(String(message.data)) as { type?: string; event?: unknown };
        if (data.type !== "event" || data.event === undefined) return;
        const parsed = VoiceEventSchema.safeParse(data.event);
        if (parsed.success) onEvent(parsed.data);
      } catch {
        // ignore malformed frames
      }
    };

    socket.onclose = () => {
      onStatus("closed");
      if (!closed) {
        attempt += 1;
        setTimeout(open, Math.min(500 * 2 ** attempt, 5000));
      }
    };

    socket.onerror = () => socket?.close();
  };

  open();

  return {
    close: () => {
      closed = true;
      socket?.close();
    },
  };
}
