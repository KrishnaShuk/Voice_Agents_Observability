import { llm as llmNs, stt as sttNs, tts as ttsNs, VAD } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import {
  observe,
  type FailureInjector,
  type FailoverSink,
  type GuardrailConfig,
} from "@voxobs/failover";
import type { Stage } from "@voxobs/schema";

export interface Providers {
  stt: sttNs.STT;
  llm: llmNs.LLM;
  tts: ttsNs.TTS;
  vad: VAD;
  names: Record<Stage, string[]>;
}

const num = (value: string | undefined, fallback: number): number =>
  value === undefined ? fallback : Number(value);

const GUARDRAIL: GuardrailConfig = {
  ttftMs: num(process.env.GUARDRAIL_TTFT_MS, 2500),
  ttfbMs: num(process.env.GUARDRAIL_TTFB_MS, 2500),
  sttFinalMs: num(process.env.GUARDRAIL_STT_FINAL_MS, 2000),
  consecutive: num(process.env.GUARDRAIL_CONSECUTIVE, 2),
  recoverAfter: num(process.env.GUARDRAIL_RECOVER_AFTER, 2),
};

export function providerNames(): Record<Stage, string[]> {
  return {
    stt: [process.env.STT_MODEL ?? "deepgram", process.env.STT_FALLBACK_MODEL ?? "deepgram-nova-2"],
    llm: [primaryModel(), fallbackModel()],
    tts: ["deepgram-aura", process.env.TTS_FALLBACK_MODEL ?? "deepgram-aura-orpheus"],
  };
}

function primaryModel(): string {
  return process.env.LLM_MODEL ?? "qwen/qwen3.8-27b";
}

function fallbackModel(): string {
  return process.env.LLM_FALLBACK_MODEL ?? "openai/gpt-oss-20b";
}

function groqLLM(model: string): openai.LLM {
  return new openai.LLM({
    model,
    baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
  });
}

export async function buildProviders(
  sink: FailoverSink,
  injector: FailureInjector,
): Promise<Providers> {
  const names = providerNames();
  const vad = await silero.VAD.load();

  const stt = new sttNs.FallbackAdapter({
    vad,
    sttInstances: [
      observe(new deepgram.STT(), {
        stage: "stt",
        name: names.stt[0] as string,
        sink,
        guardrail: GUARDRAIL,
        injector,
      }),
      observe(new deepgram.STT({ model: process.env.STT_FALLBACK_MODEL ?? "nova-2-general" }), {
        stage: "stt",
        name: names.stt[1] as string,
        sink,
        guardrail: GUARDRAIL,
        injector,
      }),
    ],
  });

  const llm = new llmNs.FallbackAdapter({
    llms: [
      observe(groqLLM(primaryModel()), {
        stage: "llm",
        name: names.llm[0] as string,
        sink,
        guardrail: GUARDRAIL,
        injector,
      }),
      observe(groqLLM(fallbackModel()), {
        stage: "llm",
        name: names.llm[1] as string,
        sink,
        guardrail: GUARDRAIL,
        injector,
      }),
    ],
  });

  const tts = new ttsNs.FallbackAdapter({
    ttsInstances: [
      observe(new deepgram.TTS({ apiKey: process.env.DEEPGRAM_API_KEY }), {
        stage: "tts",
        name: names.tts[0] as string,
        sink,
        guardrail: GUARDRAIL,
        injector,
      }),
      observe(
        new deepgram.TTS({
          apiKey: process.env.DEEPGRAM_API_KEY,
          model: process.env.TTS_FALLBACK_MODEL ?? "aura-2-orpheus-en",
        }),
        {
          stage: "tts",
          name: names.tts[1] as string,
          sink,
          guardrail: GUARDRAIL,
          injector,
        },
      ),
    ],
  });

  return { stt, llm, tts, vad, names };
}
