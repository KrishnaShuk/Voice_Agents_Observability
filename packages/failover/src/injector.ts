import type { Stage } from "@voxobs/schema";
import type { FailureInjector, InjectionMode, InjectionRequest } from "./types.js";

/**
 * Arms a one-shot fault for the next call to a given provider/stage. Used by the
 * agent's token-gated `/simulate-failure` endpoint. Faults travel through the real
 * `observe()` detection path.
 */
export class InMemoryFailureInjector implements FailureInjector {
  private readonly pending = new Map<Stage, InjectionRequest>();

  /** Arm a one-shot fault for the next call to any provider in `stage`. */
  arm(stage: Stage, mode: InjectionMode, delayMs?: number): void {
    this.pending.set(stage, { mode, delayMs });
  }

  next(_provider: string, stage: Stage): InjectionRequest | null {
    const request = this.pending.get(stage);
    if (request) this.pending.delete(stage);
    return request ?? null;
  }

  clear(): void {
    this.pending.clear();
  }
}
