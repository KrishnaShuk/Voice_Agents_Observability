import { AgentSession, type JobContext } from "@livekit/agents";
import { createTracker, type Tracker, type TrackerSession } from "@voxobs/sdk";
import { Assistant } from "./agent.js";
import { buildProviders } from "./providers.js";

export async function startSession(ctx: JobContext): Promise<Tracker> {
  const providers = await buildProviders();

  const session = new AgentSession({
    stt: providers.stt,
    llm: providers.llm,
    tts: providers.tts,
    vad: providers.vad,
    turnHandling: { turnDetection: "vad" },
  });

  const tracker = createTracker({
    endpoint: process.env.INGEST_WS_URL ?? "ws://localhost:4000/ingest",
    apiKey: process.env.INGEST_API_KEY ?? "dev-key",
    agentVersion: process.env.AGENT_VERSION ?? "0.0.0",
    providers: providers.names,
  });

  tracker.attach(session as unknown as TrackerSession);

  await session.start({
    agent: new Assistant(),
    room: ctx.room,
  });

  return tracker;
}
