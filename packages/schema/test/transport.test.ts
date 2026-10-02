import { describe, it, expect } from "vitest";
import {
  IngestServerMessageSchema,
  parseIngestClientMessage,
} from "../src/index.js";

const event = {
  eventId: "550e8400-e29b-41d4-a716-446655440000",
  sessionId: "s1",
  seq: 0,
  tOffsetMs: 0,
  timestamp: 1,
  type: "turn_start",
  turnId: "t1",
};

describe("wire protocol", () => {
  it("parses a single-event client message", () => {
    const message = parseIngestClientMessage({ event });
    expect("event" in message).toBe(true);
  });

  it("parses a batched client message", () => {
    const message = parseIngestClientMessage({ events: [event] });
    expect("events" in message).toBe(true);
  });

  it("rejects an empty batch", () => {
    expect(() => parseIngestClientMessage({ events: [] })).toThrow();
  });

  it("parses ack and error server messages", () => {
    expect(IngestServerMessageSchema.safeParse({ type: "ack", sessionId: "s1", seq: 3 }).success).toBe(true);
    expect(IngestServerMessageSchema.safeParse({ type: "error", message: "bad" }).success).toBe(true);
    expect(IngestServerMessageSchema.safeParse({ type: "other" }).success).toBe(false);
  });
});
