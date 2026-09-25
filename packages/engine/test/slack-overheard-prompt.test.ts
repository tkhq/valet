import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { describe, expect, it } from "vitest";
import { registerFauxProvider, type Context, type StreamOptions } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type PromptContent,
} from "../src/index.js";

const GUIDANCE = "## Slack overheard delivery";

async function promptSystemPrompt(content: PromptContent): Promise<string | undefined> {
  const faux = registerFauxProvider({ provider: `slack-overheard-${crypto.randomUUID()}` });
  let systemPrompt: string | undefined;
  faux.setResponses([
    (context: Context, _opts: StreamOptions | undefined, _state, model) => {
      systemPrompt = getCurrentSystemPrompt(context.messages);
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "ack" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
    },
  ]);
  const events: BusEvent[] = [];
  const stream = new InMemoryEventStream();
  stream.subscribe({}, (event) => events.push(event));
  const engine = new Engine({
    providers: {
      store: new InMemorySessionStore(),
      stream,
      sandboxProvider: new VirtualSandboxProvider(),
    },
  });
  const session = await engine.createSession({
    userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: faux.getModel(),
    // Models an assistant with no name or personality. The per-turn default
    // must not depend on an assistant-specific persona prefix.
    systemPrompt: "",
  });
  const receipt = await session.prompt(content);
  await waitForIdle(events, receipt.threadId);
  faux.unregister();
  return systemPrompt;
}

async function waitForIdle(events: BusEvent[], threadId: string): Promise<void> {
  const start = Date.now();
  while (!events.some((event) => event.event.type === "status" &&
    event.event.threadId === threadId && event.event.status === "idle")) {
    if (Date.now() - start > 2_000) throw new Error("timed out waiting for idle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Slack overheard delivery prompt", () => {
  it("injects the shared no-reply default for an overheard Slack signal", async () => {
    const prompt = await promptSystemPrompt({
      kind: "signal", signalType: "slack.message", body: "Any update?",
      origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "manual" },
    });

    expect(prompt).toContain(GUIDANCE);
    expect(prompt).toContain("Manual delivery prevents automatic posting.");
    expect(prompt).toContain("follow-up from the only other participant in the thread");
  });

  it("does not add the no-reply default to an addressed Slack signal", async () => {
    const prompt = await promptSystemPrompt({
      kind: "signal", signalType: "slack.app_mention", body: "<@bot> Any update?",
      origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" },
    });

    expect(prompt).not.toContain(GUIDANCE);
  });

  it("does not add the no-reply default to a child settlement with Slack origin", async () => {
    const prompt = await promptSystemPrompt({
      kind: "signal", signalType: "child.settled", body: "Child work completed.",
      origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "manual" },
    });

    expect(prompt).not.toContain(GUIDANCE);
  });

  it("does not constrain a non-Slack manual-reply signal", async () => {
    const prompt = await promptSystemPrompt({
      kind: "signal", signalType: "telegram.message", body: "Any update?",
      origin: { channelType: "telegram", threadKey: "telegram:C1:1.2", reply: "manual" },
    });

    expect(prompt).not.toContain(GUIDANCE);
  });
});
