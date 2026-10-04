import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FailureInjector, InjectionMode, InjectionRequest } from "@voxobs/failover";
import type { Stage } from "@voxobs/schema";

export const INJECTION_FILE =
  process.env.INJECTION_FILE ?? path.join(os.tmpdir(), "voxobs-injection.json");

interface InjectionFile {
  stage: Stage;
  mode: InjectionMode;
  delayMs?: number;
}

/** Write a one-shot fault request; the agent's injector consumes it on the next call. */
export function armInjection(
  stage: Stage,
  mode: InjectionMode,
  delayMs?: number,
  file: string = INJECTION_FILE,
): void {
  const payload: InjectionFile = { stage, mode, ...(delayMs === undefined ? {} : { delayMs }) };
  fs.writeFileSync(file, JSON.stringify(payload));
}

/**
 * Cross-process injector: the web server arms a fault, the agent job process reads
 * and consumes it. Keeps injected faults on the real `observe()` detection path.
 */
export class FileFailureInjector implements FailureInjector {
  constructor(private readonly file: string = INJECTION_FILE) {}

  next(_provider: string, stage: Stage): InjectionRequest | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as InjectionFile;
      if (parsed.stage !== stage) return null;
      fs.rmSync(this.file, { force: true });
      return { mode: parsed.mode, ...(parsed.delayMs === undefined ? {} : { delayMs: parsed.delayMs }) };
    } catch {
      return null;
    }
  }
}
