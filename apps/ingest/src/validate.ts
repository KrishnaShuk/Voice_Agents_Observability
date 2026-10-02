import { VoiceEventSchema, type VoiceEvent } from "@voxobs/schema";

const PII_KEY = /^lk\.pii\./i;

export function containsPii(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPii);
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (PII_KEY.test(key)) return true;
      if (containsPii(child)) return true;
    }
  }
  return false;
}

export type ValidationResult =
  | { ok: true; event: VoiceEvent }
  | { ok: false; error: string };

export function validateEvent(input: unknown): ValidationResult {
  if (containsPii(input)) {
    return { ok: false, error: "payload contains lk.pii.* fields" };
  }

  const parsed = VoiceEventSchema.safeParse(input);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error };
  }

  return { ok: true, event: parsed.data };
}
