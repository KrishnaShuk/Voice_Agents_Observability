/**
 * Consecutive-observation guardrail used for STT turns: a single slow turn does
 * not trip it; `consecutive` slow turns in a row do.
 */
export class TurnGuardrail {
  private slow = 0;

  constructor(
    private readonly thresholdMs: number | undefined,
    private readonly consecutive: number,
  ) {}

  record(latencyMs: number): { degraded: boolean; observedMs: number } {
    if (this.thresholdMs === undefined) return { degraded: false, observedMs: latencyMs };

    if (latencyMs > this.thresholdMs) {
      this.slow += 1;
      if (this.slow >= Math.max(1, this.consecutive)) {
        return { degraded: true, observedMs: latencyMs };
      }
    } else {
      this.slow = 0;
    }
    return { degraded: false, observedMs: latencyMs };
  }

  reset(): void {
    this.slow = 0;
  }
}
