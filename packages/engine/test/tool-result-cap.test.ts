/**
 * A tool result over its cap is saved to a file in the sandbox, and the
 * model gets a preview and the path (Claude Code's tool-result limits).
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type ToolDef } from "../src/index.js";
import { capToolError, capToolResult, estimateResultTokens, TOOL_RESULT_PREVIEW_CHARS } from "../src/tool-result-cap.js";

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
    expect(capped.text).toContain("it is not saved to a file. Only 100000 characters are shown");
    expect(capped.fullText).toBe("b".repeat(150_000));
  });
});

describe("head-tail preview", () => {
  it("keeps the end of bash-style output, so the exit status stays last", async () => {
    const text = `${"passing test\n".repeat(10_000)}FAILED: 1 test\n[exit 1]`;
    const capped = await capToolResult({ text }, { toolName: "bash", maxChars: 30_000, maxTokens: 25_000, preview: "head-tail", save: async () => ".valet/tool-results/bash.txt" });
    expect(capped.text.startsWith("passing test")).toBe(true);
    expect(capped.text.endsWith("FAILED: 1 test\n[exit 1]")).toBe(true);
    expect(capped.text).toContain("The first and last parts are shown.");
    expect(capped.text.length).toBeLessThan(TOOL_RESULT_PREVIEW_CHARS + 500);
    expect(capped.fullText).toBe(text);
  });

  it("caps a thrown string like an error message", async () => {
    const capped = await capToolError("s".repeat(150_000), { toolName: "lookup", maxChars: 100_000, maxTokens: 25_000, save: async () => ".valet/tool-results/x.txt" });
    expect(capped).toBeInstanceOf(Error);
    expect((capped as Error).message).toContain(".valet/tool-results/x.txt");
  });
});

describe("text attachments and thrown errors", () => {
  const opts = (save: (text: string) => Promise<string | undefined>) => ({ toolName: "lookup", maxChars: 100_000, maxTokens: 25_000, save });

  it("counts text attachments toward the cap and folds them into the saved text", async () => {
    let saved = "";
    const image = { type: "image" as const, data: new Uint8Array([1]), mimeType: "image/png" };
    const capped = await capToolResult(
      { text: "t".repeat(60_000), attachments: [{ type: "text", name: "log.txt", content: "a".repeat(60_000) }, image] },
      opts(async (full) => { saved = full; return ".valet/tool-results/lookup.txt"; }),
    );
    expect(saved).toContain("--- log.txt ---\n" + "a".repeat(60_000));
    expect(capped.text).toContain("saved in the working directory at .valet/tool-results/lookup.txt");
    // The text attachment is in the saved file now; the image stays.
    expect(capped.attachments).toEqual([image]);
  });

  it("leaves a result with small text attachments unchanged", async () => {
    const result = { text: "short", attachments: [{ type: "text" as const, content: "also short" }] };
    expect(await capToolResult(result, opts(async () => "/unused"))).toBe(result);
  });

  it("returns a short thrown error unchanged and caps a long one", async () => {
    const short = new Error("not found");
    expect(await capToolError(short, opts(async () => "/unused"))).toBe(short);
    const long = new Error("e".repeat(150_000));
    const capped = await capToolError(long, opts(async () => ".valet/tool-results/lookup.txt"));
    expect(capped).toBeInstanceOf(Error);
    expect((capped as Error).message.length).toBeLessThan(TOOL_RESULT_PREVIEW_CHARS + 400);
    expect((capped as Error).message).toContain(".valet/tool-results/lookup.txt");
    expect((capped as Error).cause).toBe(long);
    expect(await capToolError("plain string", opts(async () => "/unused"))).toBe("plain string");
    expect(await capToolError({ code: 1 }, opts(async () => "/unused"))).toEqual({ code: 1 });
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
    const fail: ToolDef = {
      name: "fail", description: "Throw a large error.", parameters: Type.Object({}),
      execute: async () => { throw new Error(`upstream said: ${"z".repeat(150_000)}`); },
    };
    const session = await new Engine({
      providers: { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() },
    }).createSession({ userId: "u", orgId: "o", workspace: "/workspace", sandbox: {}, model: faux.getModel(), tools: [lookup, fail] });
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
      (context) => { record(context); return fauxAssistantMessage([fauxToolCall("fail", {}, { id: "tc-3" })]); },
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
      // The folder ignores itself, so a git add in a checkout never picks it up.
      expect(await session.sandbox.readFile("/workspace/.valet/tool-results/.gitignore")).toBe("*\n");
      // read pages its own output, so a 40,000-character file comes back whole.
      expect(seen[1]).toContain("n".repeat(40_000));
      expect(seen[1]).not.toContain("too large");
      // A thrown error reaches the model capped, with the full message saved.
      expect(seen[2]).toContain("upstream said:");
      expect(seen[2]).toContain("fail output too large");
      expect(seen[2]).not.toContain("z".repeat(TOOL_RESULT_PREVIEW_CHARS + 100));
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });
});
