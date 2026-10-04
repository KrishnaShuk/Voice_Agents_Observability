import { fileURLToPath } from "node:url";
import { cli, defineAgent, ServerOptions, type JobContext } from "@livekit/agents";
import { startSession } from "./session.js";

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const tracker = await startSession(ctx);
    ctx.addShutdownCallback(async () => {
      tracker.shutdown("participant_disconnected");
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.LIVEKIT_AGENT_NAME ?? "voxobs",
  }),
);
