import { APIError } from "@livekit/agents";
import type { FailReason } from "@voxobs/schema";

/** Terminal error thrown when a latency guardrail trips; forces the FallbackAdapter to rotate. */
export class LatencyGuardrailError extends APIError {
  constructor(message: string) {
    super(message, { retryable: false });
    this.name = "LatencyGuardrailError";
  }
}

export function terminalError(message: string): APIError {
  return new APIError(message, { retryable: false });
}

function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const nested = (key: string): unknown =>
    record[key] && typeof record[key] === "object"
      ? (record[key] as Record<string, unknown>).status
      : undefined;
  for (const candidate of [
    record.status,
    record.statusCode,
    nested("response"),
    nested("body"),
  ]) {
    if (typeof candidate === "number") return candidate;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export { messageOf };

export function classifyError(error: unknown): FailReason {
  if (error instanceof LatencyGuardrailError) return "guardrail_latency";

  const status = statusOf(error);
  if (status === 429) return "rate_limit";
  if (typeof status === "number" && status >= 500 && status < 600) return "5xx";

  const name = error instanceof Error ? error.name : "";
  const message = messageOf(error);
  if (status === 408 || name === "AbortError" || /timeout|timed out|deadline/i.test(message)) {
    return "timeout";
  }
  return "conn_error";
}
