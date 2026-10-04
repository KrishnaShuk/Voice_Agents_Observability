import { AgentSession, type JobContext } from "@livekit/agents";
import { createTracker, type Tracker, type TrackerSession } from "@voxobs/sdk";
import { Assistant } from "./agent.js";
import { buildProviders, providerNames } from "./providers.js";
import { FileFailureInjector } from "./injection.js";

export async function startSession(ctx: JobContext): Promise<Tracker> {
  const tracker = createTracker({
    endpoint: process.env.INGEST_WS_URL ?? "ws://localhost:4000/ingest",
    apiKey: process.env.INGEST_API_KEY ?? "dev-key",
    agentVersion: process.env.AGENT_VERSION ?? "0.0.0",
    providers: providerNames(),
  });

  const providers = await buildProviders(tracker.sink, new FileFailureInjector());

  const session = new AgentSession({
    stt: providers.stt,
    llm: providers.llm,
    tts: providers.tts,
    vad: providers.vad,
    turnHandling: { turnDetection: "vad" },
  });

  tracker.attach(session as unknown as TrackerSession);

  await session.start({
    agent: new Assistant(),
    room: ctx.room,
  });

  return tracker;
}
