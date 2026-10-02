import { z } from "zod";
import { VoiceEventSchema } from "./events.js";

export const IngestClientMessageSchema = z.union([
  z.object({ event: VoiceEventSchema }),
  z.object({ events: z.array(VoiceEventSchema).min(1) }),
]);
export type IngestClientMessage = z.infer<typeof IngestClientMessageSchema>;

export function parseIngestClientMessage(data: unknown): IngestClientMessage {
  return IngestClientMessageSchema.parse(data);
}

export const IngestAckSchema = z.object({
  type: z.literal("ack"),
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
});
export type IngestAck = z.infer<typeof IngestAckSchema>;

export const IngestErrorSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});
export type IngestError = z.infer<typeof IngestErrorSchema>;

export const IngestServerMessageSchema = z.discriminatedUnion("type", [
  IngestAckSchema,
  IngestErrorSchema,
]);
export type IngestServerMessage = z.infer<typeof IngestServerMessageSchema>;

export const LiveSubscribeSchema = z.object({
  type: z.literal("subscribe"),
  sessionId: z.string().min(1).nullable().optional(),
});
export type LiveSubscribe = z.infer<typeof LiveSubscribeSchema>;

export const LiveMessageSchema = z.object({
  type: z.literal("event"),
  event: VoiceEventSchema,
});
export type LiveMessage = z.infer<typeof LiveMessageSchema>;
