import { llm as llmNs, stt as sttNs, tts as ttsNs, VAD } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import type { Stage } from "@voxobs/schema";

export interface Providers {
  stt: sttNs.STT;
  llm: llmNs.LLM;
  tts: ttsNs.TTS;
  vad: VAD;
  names: Record<Stage, string[]>;
}

function buildTts(): { tts: ttsNs.TTS; name: string } {
  const provider = (process.env.TTS_PROVIDER ?? "deepgram").toLowerCase();
  if (provider === "elevenlabs") {
    return {
      tts: new elevenlabs.TTS({
        apiKey: process.env.ELEVEN_API_KEY,
        voiceId: process.env.ELEVEN_VOICE_ID,
      }),
      name: "elevenlabs",
    };
  }
  return {
    tts: new deepgram.TTS({ apiKey: process.env.DEEPGRAM_API_KEY }),
    name: "deepgram-aura",
  };
}

export async function buildProviders(): Promise<Providers> {
  const model = process.env.LLM_MODEL ?? "qwen/qwen3.8-27b";

  const stt = new deepgram.STT();
  const llm = new openai.LLM({
    model,
    baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
  });
  const { tts, name: ttsName } = buildTts();
  const vad = await silero.VAD.load();

  return {
    stt,
    llm,
    tts,
    vad,
    names: {
      stt: ["deepgram"],
      llm: [model],
      tts: [ttsName],
    },
  };
}
