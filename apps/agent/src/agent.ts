import { Agent } from "@livekit/agents";

export class Assistant extends Agent {
  constructor() {
    super({
      instructions:
        "You are a helpful, concise voice assistant. Reply in one or two short sentences " +
        "and avoid lists or markdown, since your answer is spoken aloud.",
    });
  }
}
