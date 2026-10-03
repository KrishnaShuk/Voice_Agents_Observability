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

export async function buildProviders(): Promise<Providers> {
  const stt = new deepgram.STT();
  const llm = new openai.LLM({
    model: process.env.LLM_MODEL ?? "llama-3.1-8b-instant",
    baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
  });
  const tts = new elevenlabs.TTS({
    apiKey: process.env.ELEVEN_API_KEY,
    voiceId: process.env.ELEVEN_VOICE_ID,
  });
  const vad = await silero.VAD.load();

  return {
    stt,
    llm,
    tts,
    vad,
    names: {
      stt: ["deepgram"],
      llm: [process.env.LLM_MODEL ?? "groq"],
      tts: ["elevenlabs"],
    },
  };
}
