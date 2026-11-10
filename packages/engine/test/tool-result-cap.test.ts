/**
 * A tool result over its cap is saved to a file in the sandbox, and the
 * model gets a preview and the path (Claude Code's tool-result limits).
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type ToolDef } from "../src/index.js";
import { capToolResult, estimateResultTokens, TOOL_RESULT_PREVIEW_CHARS } from "../src/tool-result-cap.js";

const cap = (text: string, save: (text: string) => Promise<string | undefined>) =>
  capToolResult({ text, ok: true }, { toolName: "lookup", maxChars: 100_000, maxTokens: 25_000, save });

describe("capToolResult", () => {
  it("leaves a result under the cap unchanged", async () => {
    const result = { text: "x".repeat(100_000), ok: true };
    const capped = await capToolResult(result, { toolName: "lookup", maxChars: 100_000, maxTokens: 25_000, save: async () => "/unused" });
    expect(capped).toBe(result);
  });

  it("saves a long result and keeps a preview and the path", async () => {
    let saved = "";
    const text = "a".repeat(150_000);
    const capped = await cap(text, async (full) => { saved = full; return "/workspace/.valet/tool-results/lookup.txt"; });
    expect(saved).toBe(text);
    expect(capped.ok).toBe(true);
    expect(capped.text?.startsWith("a".repeat(TOOL_RESULT_PREVIEW_CHARS))).toBe(true);
    expect(capped.text).toContain("lookup output too large (150000 characters, about 37500 tokens)");
    expect(capped.text).toContain("/workspace/.valet/tool-results/lookup.txt");
    expect(capped.text!.length).toBeLessThan(TOOL_RESULT_PREVIEW_CHARS + 400);
  });

  it("counts JSON at 2 characters per token, so a 60,000-character JSON result is saved", async () => {
    const json = JSON.stringify(Array.from({ length: 3_000 }, (_, i) => ({ id: i, name: `row-${i}` })));
    expect(json.length).toBeLessThan(100_000);
    expect(estimateResultTokens(json)).toBe(Math.ceil(json.length / 2));
    const capped = await cap(json, async () => "/workspace/.valet/tool-results/rows.txt");
    expect(capped.text).toContain("/workspace/.valet/tool-results/rows.txt");
  });

  it("keeps the first part and says the rest was dropped when the save fails", async () => {
    const capped = await cap("b".repeat(150_000), async () => { throw new Error("read-only sandbox"); });
    expect(capped.text?.startsWith("b".repeat(100_000))).toBe(true);
    expect(capped.text).not.toContain("b".repeat(100_001));
    expect(capped.text).toContain("could not be saved. Only the first 100000 characters are shown");
  });
});

describe("tool result cap in a thread", () => {
  it("sends the model a preview, saves the full result in the sandbox, and leaves read alone", async () => {
    const faux = registerFauxProvider({ provider: "tool-result-cap" });
    const big = `${"line of output\n".repeat(10_000)}END`;
    const lookup: ToolDef = {
      name: "lookup", description: "Return a large result.", parameters: Type.Object({}),
      execute: async () => ({ text: big }),
    };
    const session = await new Engine({
      providers: { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() },
    }).createSession({ userId: "u", orgId: "o", workspace: "/workspace", sandbox: {}, model: faux.getModel(), tools: [lookup] });
    await session.sandbox.mkdir("/workspace");
    await session.sandbox.writeFile("/workspace/notes.txt", "n".repeat(40_000));
    const seen: string[] = [];
    const record = (context: { messages: Array<{ role: string; content?: unknown }> }) => {
      const last = context.messages.findLast((m) => m.role === "toolResult");
      if (last) seen.push(JSON.stringify(last.content));
    };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "tc-1" })]),
      (context) => { record(context); return fauxAssistantMessage([fauxToolCall("read", { path: "/workspace/notes.txt" }, { id: "tc-2" })]); },
      (context) => { record(context); return fauxAssistantMessage("done"); },
    ]);
    try {
      const thread = await session.ensureDefaultThread();
      const receipt = await thread.submitPrompt("look it up", {});
      await thread.awaitResult(receipt.queueItemId);
      // The note names the file from .valet/, which read and bash resolve
      // against the working directory.
      const path = /saved in the working directory at (\.valet\/tool-results\/[^ ]+\.txt)/.exec(seen[0] ?? "")?.[1];
      expect(path).toBeDefined();
      expect(seen[0]).toContain("lookup output too large");
      expect(seen[0]).not.toContain("END");
      expect(await session.sandbox.readFile(`/workspace/${path!}`)).toBe(big);
      // read pages its own output, so a 40,000-character file comes back whole.
      expect(seen[1]).toContain("n".repeat(40_000));
      expect(seen[1]).not.toContain("too large");
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });
});
