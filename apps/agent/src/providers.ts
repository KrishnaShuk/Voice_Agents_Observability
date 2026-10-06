import { llm as llmNs, stt as sttNs, tts as ttsNs, VAD } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
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

/** Opt-in. Default off: the single-provider path is stable; the failover
 *  wrapper's stream guardrail is not yet tuned for live calls. */
const FAILOVER_ENABLED = process.env.FAILOVER === "1";

const GUARDRAIL: GuardrailConfig = {
  ttftMs: num(process.env.GUARDRAIL_TTFT_MS, 8000),
  ttfbMs: num(process.env.GUARDRAIL_TTFB_MS, 8000),
  sttFinalMs: num(process.env.GUARDRAIL_STT_FINAL_MS, 4000),
  consecutive: num(process.env.GUARDRAIL_CONSECUTIVE, 2),
  recoverAfter: num(process.env.GUARDRAIL_RECOVER_AFTER, 3),
};

function primaryModel(): string {
  return process.env.LLM_MODEL ?? "qwen/qwen3.8-27b";
}

function fallbackModel(): string {
  return process.env.LLM_FALLBACK_MODEL ?? "openai/gpt-oss-20b";
}

export function providerNames(): Record<Stage, string[]> {
  const stt = process.env.STT_MODEL ?? "deepgram";
  const tts = process.env.TTS_PROVIDER === "elevenlabs" ? "elevenlabs" : "deepgram-aura";
  if (!FAILOVER_ENABLED) {
    return { stt: [stt], llm: [primaryModel()], tts: [tts] };
  }
  return {
    stt: [stt, process.env.STT_FALLBACK_MODEL ?? "deepgram-nova-2"],
    llm: [primaryModel(), fallbackModel()],
    tts: [tts, process.env.TTS_FALLBACK_MODEL ?? "deepgram-aura-orpheus"],
  };
}

function groqLLM(model: string): openai.LLM {
  return new openai.LLM({
    model,
    baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
  });
}

function buildTts(): ttsNs.TTS {
  if (process.env.TTS_PROVIDER === "elevenlabs") {
    return new elevenlabs.TTS({
      apiKey: process.env.ELEVEN_API_KEY,
      voiceId: process.env.ELEVEN_VOICE_ID,
    });
  }
  return new deepgram.TTS({ apiKey: process.env.DEEPGRAM_API_KEY });
}

export async function buildProviders(
  sink: FailoverSink,
  injector: FailureInjector,
): Promise<Providers> {
  const names = providerNames();
  const vad = await silero.VAD.load();

  if (!FAILOVER_ENABLED) {
    return {
      stt: new deepgram.STT(),
      llm: groqLLM(primaryModel()),
      tts: buildTts(),
      vad,
      names,
    };
  }

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
