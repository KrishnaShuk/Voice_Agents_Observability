import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";

const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const livekitUrl = process.env.LIVEKIT_URL;
const agentName = process.env.LIVEKIT_AGENT_NAME ?? "voxobs";
const port = Number(process.env.WEB_PORT ?? 3001);

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");

const app = express();
app.use(express.static(publicDir));

app.get("/token", async (req, res) => {
  if (!apiKey || !apiSecret) {
    res.status(500).json({ error: "LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set" });
    return;
  }
  const room = String(req.query.room ?? "voxobs-demo");
  const identity = `user-${crypto.randomUUID().slice(0, 8)}`;
  const token = new AccessToken(apiKey, apiSecret, { identity, ttl: "15m" });
  token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  token.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName })],
  });
  res.json({ token: await token.toJwt(), url: livekitUrl ?? "", room });
});

app.listen(port, () => {
  console.log(`join page on http://localhost:${port}`);
});
