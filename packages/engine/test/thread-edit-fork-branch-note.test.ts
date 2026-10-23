import { describe, expect, it } from "vitest";
import { branchNoteText, readBranchNote, summarizeBranchActions, type BranchNote } from "../src/branch-note.js";
import type { BranchSummaryEntry, MessageEntry, SessionEntry } from "../src/types.js";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider } from "../src/index.js";

const tools = { silent: new Set<string>(), files: new Set(["write_file"]), plugin: new Set(["call_tool"]) };
function call(id: string, toolName = "call_tool"): MessageEntry {
  return { id, sessionId: "s", threadId: "t", parentId: null, createdAt: 1, type: "message", role: "assistant", content: "",
    parts: [{ type: "tool_call", callId: id, toolName, args: toolName === "call_tool" ? { tool_id: "service.post", summary: "Post update" } : {},
      status: "completed", result: { outcome: { url: `https://example.test/${id}` } } }] };
}
function note(id: string, left: readonly SessionEntry[], extra: Partial<BranchNote> = {}): BranchSummaryEntry {
  const facts: BranchNote = { kind: "edit", ...summarizeBranchActions(left, tools), ...extra };
  return { id, sessionId: "s", threadId: "t", parentId: null, createdAt: 2, type: "branch_summary",
    branchRootId: left[0]?.id ?? "", branchLeafId: left.at(-1)?.id ?? "", summary: branchNoteText(facts), metadata: { branchNote: facts } };
}

describe("branch notes across later edits", () => {
  it("retains external actions, grants, overflow, and file coverage gaps across nested notes", () => {
    const first = note("first", Array.from({ length: 14 }, (_, i) => call(`action-${i}`)), {
      grants: ["Always allow: Post update"], filesChanged: true,
      files: [{ repo: ".", restored: [], removed: [], skipped: ["changed.txt"], failed: "snapshot unavailable" }],
    });
    const second = note("second", [first, call("later")]);
    const third = note("third", [second]);
    const facts = readBranchNote(third.metadata)!;
    expect(facts.actions).toHaveLength(12);
    expect(facts.moreActions).toBe(3);
    expect(facts.grants).toEqual(["Always allow: Post update"]);
    expect(facts.filesChanged).toBe(true);
    expect(third.summary).toContain("https://example.test/action-0");
    expect(third.summary).toContain("changed.txt");
    expect(third.summary).toContain("snapshot unavailable");
    expect(third.summary).toContain("Hidden files");
  });

  it("does not count originals or an older note again when a later note already carries them", () => {
    const original = call("original");
    const first = note("first", [original]);
    const second = note("second", [first, call("later")]);
    const facts = summarizeBranchActions([original, first, second], tools);
    expect(facts.actions.map((action) => action.urls)).toEqual([["https://example.test/original"], ["https://example.test/later"]]);
    expect(facts.moreActions).toBe(0);
  });

  it("does not count originals again for a stored note without provenance", () => {
    const original = call("original");
    const stored = note("stored", [original]);
    const facts = readBranchNote(stored.metadata)!;
    delete facts.summarizedEntryIds;
    stored.metadata = { branchNote: facts };
    expect(summarizeBranchActions([original, stored], tools).actions).toHaveLength(1);
  });

  it("remaps carried action provenance when a fork copies originals and their branch note", async () => {
    const faux = registerFauxProvider({ provider: "fork-branch-note-provenance" });
    const engine = new Engine({ providers: {
      store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider(),
    } });
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
    const destination = await session.createThread("web:copied-note");
    const original = call("source-action");
    const carried = note("source-note", [original], { summarizedEntryIds: [original.id, "off-path-entry"] });
    carried.parentId = original.id;

    await destination.copyPath([original, carried], { source: { sessionId: "s", threadId: "t" } });

    const copied = await destination.readEntries();
    const copiedAction = copied.find((entry) => entry.type === "message");
    const copiedNote = copied.find((entry) => entry.type === "branch_summary" && readBranchNote(entry.metadata)?.kind === "edit");
    expect(copiedAction).toBeDefined();
    expect(copiedAction?.id).not.toBe(original.id);
    expect(copiedNote).toBeDefined();
    expect(copiedNote?.id).not.toBe(carried.id);
    expect(readBranchNote(copiedNote?.metadata)?.summarizedEntryIds).toEqual([copiedAction?.id, "off-path-entry"]);
    const facts = summarizeBranchActions(copied, tools);
    expect(facts.actions).toEqual([{ tool: "service.post", label: "service.post: Post update", count: 1,
      urls: ["https://example.test/source-action"] }]);
    expect(facts.moreActions).toBe(0);
  });

  it("shows a completed external action to the model after an edit crosses an earlier edit note", async () => {
    const faux = registerFauxProvider({ provider: "nested-branch-note" });
    let modelNote = "";
    faux.setResponses([
      fauxAssistantMessage("ready"),
      fauxAssistantMessage([fauxToolCall("call_tool", {}, { id: "post" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("posted"),
      fauxAssistantMessage("revised"),
      (context) => {
        modelNote = JSON.stringify(context.messages);
        return fauxAssistantMessage("kept the existing action");
      },
    ]);
    const store = new InMemorySessionStore();
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(), tools: [{
      name: "call_tool", description: "Posts an update", parameters: Type.Object({}), policyChecked: true,
      execute: async () => ({ text: "posted", outcome: { url: "https://example.test/posted" } }),
    }] });
    const thread = await session.ensureDefaultThread();
    const author = { id: "u", name: "Owner", interactive: true };
    const settled = async (receipt: { queueItemId: string }) => {
      await expect.poll(async () => (await store.getQueueItem(session.id, receipt.queueItemId))?.status).toBe("settled");
    };
    await settled(await thread.submitPrompt("start", { author }));
    await settled(await thread.submitPrompt("post", { author }));
    const entries = await thread.readEntries();
    const start = entries.find((entry) => entry.type === "message" && entry.content === "start")!;
    const post = entries.find((entry) => entry.type === "message" && entry.content === "post")!;
    await settled(await thread.editMessage(post.id, "revise post", { author }));
    await settled(await thread.editMessage(start.id, "restart", { author }));
    expect(modelNote).toContain("https://example.test/posted");
    expect(modelNote).toContain("Before you repeat one of these actions");
    const latest = (await thread.readEntries()).find((entry) => entry.type === "branch_summary")!;
    expect(readBranchNote(latest.metadata)?.actions).toHaveLength(1);
  });
});
