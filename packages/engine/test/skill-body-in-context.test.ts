import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
import {
  Engine, FRESH_CONTEXT_KEY, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider,
  type SkillSource, type ToolDef,
} from "../src/index.js";

describe("skillBodyInContext", () => {
  it("reports a skill body as loaded after a recorded read, and not for a changed version", async () => {
    const faux = registerFauxProvider({ provider: "skill-body-in-context" });
    const store = new InMemorySessionStore();
    const versionParams = Type.Object({ version: Type.String() });
    const probe: ToolDef<typeof versionParams> = {
      name: "probe", description: "Read a skill.", parameters: versionParams,
      execute: async (args, ctx) => {
        const skill: SkillSource = { name: "deploy", content: "Deploy body.", source: "plugin", key: "plugin:x:deploy", contentSha: args.version };
        const loaded = ctx.skillBodyInContext?.(skill) ?? false;
        if (!loaded) await ctx.recordSkillInvocation?.(skill, "model_tool", skill.content);
        return { text: loaded ? "already loaded" : skill.content };
      },
    };
    const session = await new Engine({
      providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() },
    }).createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(),
      tools: [probe],
    });
    const results: string[] = [];
    const call = (id: string, version: string) => fauxAssistantMessage([fauxToolCall("probe", { version }, { id })]);
    const record = (context: { messages: Array<{ role: string; content?: unknown }> }) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") results.push(JSON.stringify(last.content));
    };
    faux.setResponses([
      call("tc-1", "v1"),
      (context) => { record(context); return call("tc-2", "v1"); },
      (context) => { record(context); return call("tc-3", "v2"); },
      (context) => { record(context); return fauxAssistantMessage("done"); },
    ]);
    try {
      const thread = await session.ensureDefaultThread();
      const receipt = await thread.submitPrompt("read the deploy skill", {});
      await thread.awaitResult(receipt.queueItemId);
      expect(results[0]).toContain("Deploy body.");
      expect(results[1]).toContain("already loaded");
      // A new version is new text, so it loads again.
      expect(results[2]).toContain("Deploy body.");
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("loads the body again in a fresh-context turn, which does not send the earlier read", async () => {
    const faux = registerFauxProvider({ provider: "skill-body-fresh-context" });
    const store = new InMemorySessionStore();
    const probe: ToolDef = {
      name: "probe", description: "Read a skill.", parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        const skill: SkillSource = { name: "deploy", content: "Deploy body.", source: "plugin", key: "plugin:x:deploy", contentSha: "v1" };
        const loaded = ctx.skillBodyInContext?.(skill) ?? false;
        if (!loaded) await ctx.recordSkillInvocation?.(skill, "model_tool", skill.content);
        return { text: loaded ? "already loaded" : skill.content };
      },
    };
    const session = await new Engine({
      providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() },
    }).createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(),
      tools: [probe],
    });
    const results: string[] = [];
    const record = (context: { messages: Array<{ role: string; content?: unknown }> }) => {
      const last = context.messages.findLast((m) => m.role === "toolResult");
      if (last) results.push(JSON.stringify(last.content));
    };
    const call = (id: string) => fauxAssistantMessage([fauxToolCall("probe", {}, { id })]);
    faux.setResponses([
      call("tc-1"),
      (context) => { record(context); return fauxAssistantMessage("first run done"); },
      call("tc-2"),
      (context) => { record(context); return fauxAssistantMessage("second run done"); },
    ]);
    try {
      const thread = await session.ensureDefaultThread();
      for (const prompt of ["run the routine", "run the routine again"]) {
        const receipt = await thread.submitPrompt(prompt, { metadata: { [FRESH_CONTEXT_KEY]: true } });
        await thread.awaitResult(receipt.queueItemId);
      }
      expect(results[0]).toContain("Deploy body.");
      expect(results[1]).toContain("Deploy body.");
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });
});
