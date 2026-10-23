/**
 * Thread edit, return, and fork (docs/specs/2026-10-22-thread-edit-fork-design.md).
 * An edit moves the active leaf to a new branch at claim time and writes a
 * branch note; the old branch stays in the store. A return moves the leaf
 * back. A fork copies the active path into an empty thread.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as checkpoints from "../src/checkpoints.js";
afterEach(() => vi.restoreAllMocks());
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  Type,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  readBranchNote,
  type BranchSummaryEntry,
  type BusEvent,
  type MessageEntry,
  type SessionEntry,
  type Thread,
  type ToolDef,
} from "../src/index.js";
import { COMPLETE_SUMMARY } from "./fixtures/compaction-summary.js";

const PERSON = { id: "u1", name: "Owner", interactive: true };
const TEAMMATE = { id: "u2", name: "Teammate", interactive: true };

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

/** A tool that parks until the test releases it or the turn is stopped. */
function blockingTool(): { tool: ToolDef; entered: Promise<void>; release: () => void } {
  const entered = latch();
  const gate = latch();
  const tool: ToolDef = {
    name: "block",
    description: "blocks until released",
    parameters: Type.Object({}),
    execute: async (_args, ctx) => {
      entered.open();
      await Promise.race([
        gate.promise,
        new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true })),
      ]);
      return { text: "released" };
    },
  };
  return { tool, entered: entered.promise, release: gate.open };
}

const writeTool: ToolDef = {
  name: "write_file",
  description: "writes a file",
  sideEffect: "files",
  parameters: Type.Object({ path: Type.String() }),
  execute: async () => ({ text: "wrote" }),
};

const peekTool: ToolDef = {
  name: "peek",
  description: "reads",
  parameters: Type.Object({}),
  concurrencySafe: true,
  execute: async () => ({ text: "contents" }),
};

const actionTool: ToolDef = {
  name: "call_tool",
  description: "runs a plugin action",
  parameters: Type.Object({ tool_id: Type.String(), summary: Type.Optional(Type.String()) }),
  policyChecked: true,
  execute: async () => ({ text: "posted", outcome: { kind: "pull_request_created", url: "https://example.test/pr/7" } }),
};

/** The user-message texts the model received, in order. */
function userTexts(context: { messages: Array<{ role: string; content: unknown }> }): string[] {
  return context.messages.filter((m) => m.role === "user").map((m) =>
    typeof m.content === "string"
      ? m.content
      : (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text).join(""));
}

/** One transcript entry as a short line: `role:text`, a note as `note:<kind>`. */
function line(entry: SessionEntry): string {
  if (entry.type === "branch_summary") return `note:${readBranchNote(entry.metadata)?.kind ?? "?"}`;
  if (entry.type !== "message") return entry.type;
  if (entry.role !== "assistant") return `${entry.role}:${entry.content}`;
  const text = (entry.parts ?? [])
    .map((p) => (p.type === "text" ? p.text : p.type === "tool_call" ? `[${p.toolName}]` : ""))
    .join("");
  return `assistant:${text || entry.content}`;
}

async function setup(provider: string, responses: FauxResponseStep[], tools: ToolDef[] = []) {
  const faux = registerFauxProvider({ provider });
  faux.setResponses(responses);
  const store = new InMemorySessionStore();
  const stream = new InMemoryEventStream();
  const events: BusEvent[] = [];
  stream.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() } });
  const session = await engine.createSession({ userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: faux.getModel(), tools });
  const thread = await session.ensureDefaultThread();
  const settled = async (id: string) => (await store.getQueueItem(session.id, id))?.status === "settled";
  const outcome = async (id: string) => (await store.getQueueItem(session.id, id))?.outcome?.outcome;
  const path = async (t: Thread = thread) => (await t.readEntries()).map(line);
  const send = async (text: string, author = PERSON) => {
    const receipt = await thread.submitPrompt(text, { author });
    await waitFor(() => settled(receipt.queueItemId));
    return receipt;
  };
  const edit = async (text: string, replacement: string, author = PERSON) => {
    const target = await userEntry(text);
    const receipt = await thread.editMessage(target.id, replacement, { author });
    await waitFor(() => settled(receipt.queueItemId));
    return receipt;
  };
  const userEntry = async (text: string) => {
    const entry = (await thread.readEntries()).find(
      (e): e is MessageEntry => e.type === "message" && e.role === "user" && e.content === text,
    );
    if (!entry) throw new Error(`no user entry "${text}"`);
    return entry;
  };
  const note = async (t: Thread = thread) => {
    const found = (await t.readEntries()).filter((e): e is BranchSummaryEntry => e.type === "branch_summary").pop();
    if (!found) throw new Error("no branch note");
    return found;
  };
  return { faux, store, session, thread, settled, outcome, path, send, edit, userEntry, note, events };
}

describe("thread edit", () => {
  it("rewrites a middle message: the model never sees the old branch, and the store keeps it", async () => {
    let seen: string[] = [];
    const h = await setup("edit-middle", [
      fauxAssistantMessage("a"),
      fauxAssistantMessage("b"),
      (context) => { seen = userTexts(context); return fauxAssistantMessage("b2"); },
    ]);
    await h.send("first");
    await h.send("second");

    await h.edit("second", "second, edited");

    expect(await h.path()).toEqual(["user:first", "assistant:a", "note:edit", "user:second, edited", "assistant:b2"]);
    expect(seen).toEqual(["first", expect.stringContaining("<branch-note>"), "second, edited"]);
    expect(seen[1]).toContain("edited an earlier message");
    // Nothing is deleted, and the note points at the branch it left.
    const all = await h.thread.readEntries({ allBranches: true });
    expect(all.map(line)).toEqual(expect.arrayContaining(["user:second", "assistant:b"]));
    const branchNote = await h.note();
    expect(branchNote.branchRootId).toBe(all.find((e) => line(e) === "user:second")?.id);
    expect(branchNote.branchLeafId).toBe(all.find((e) => line(e) === "assistant:b")?.id);
    expect(h.events.some((e) => e.event.type === "branch_switched" && e.event.noteEntryId === branchNote.id)).toBe(true);
  });

  it("ends the read path before the edited message while the edit waits to start", async () => {
    const h = await setup("edit-pending", [fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("b2")]);
    await h.send("first");
    await h.send("second");
    await h.thread.pause();
    const target = await h.userEntry("second");

    const receipt = await h.thread.editMessage(target.id, "second, edited", { author: PERSON });

    expect(await h.path()).toEqual(["user:first", "assistant:a"]);
    await h.thread.resume();
    await waitFor(() => h.settled(receipt.queueItemId));
    expect(await h.path()).toEqual(["user:first", "assistant:a", "note:edit", "user:second, edited", "assistant:b2"]);
  });

  it("edits the first message: the old root stays out of the new path", async () => {
    let seen: string[] = [];
    const h = await setup("edit-first", [
      fauxAssistantMessage("a"),
      (context) => { seen = userTexts(context); return fauxAssistantMessage("a2"); },
    ]);
    await h.send("first");

    await h.edit("first", "first, edited");

    expect(await h.path()).toEqual(["note:edit", "user:first, edited", "assistant:a2"]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe("first, edited");
  });

  it("stops a running turn and runs the edit before queued messages", async () => {
    const { tool, entered } = blockingTool();
    const order: string[] = [];
    // The stopped turn may make one more call after its tool returns, so
    // answer by content, not by position.
    const respond: FauxResponseStep = (context) => {
      const last = context.messages[context.messages.length - 1];
      if (last?.role === "toolResult") return fauxAssistantMessage("stopped");
      const text = userTexts(context).at(-1) ?? "";
      if (text === "long job") return fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" });
      order.push(text);
      return fauxAssistantMessage(text === "short job" ? "did the edit" : "did the follow-up");
    };
    const h = await setup("edit-running", Array.from({ length: 6 }, () => respond), [tool]);

    const first = await h.thread.submitPrompt("long job", { author: PERSON });
    await entered;
    const queued = await h.thread.submitPrompt("and then this", { author: PERSON });
    const target = await h.userEntry("long job");
    const receipt = await h.thread.editMessage(target.id, "short job", { author: PERSON });
    await waitFor(() => h.settled(queued.queueItemId));

    expect(await h.outcome(first.queueItemId)).toBe("superseded");
    expect(await h.outcome(receipt.queueItemId)).toBe("completed");
    expect(await h.outcome(queued.queueItemId)).toBe("completed");
    expect(order).toEqual(["short job", "and then this"]);
    expect(await h.path()).toEqual([
      "note:edit", "user:short job", "assistant:did the edit", "user:and then this", "assistant:did the follow-up",
    ]);
  });

  it("withdraws the stopped turn's pending approval card", async () => {
    const approval: ToolDef = {
      name: "do_thing",
      description: "gated",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        const resolution = await ctx.requestDecision({ type: "approval", title: "approve?", body: "", resumeKey: "do_thing" });
        return { text: resolution.actionId === "approve" ? "did it" : "denied" };
      },
    };
    const h = await setup("edit-gate", [
      fauxAssistantMessage([fauxToolCall("do_thing", {}, { id: "g1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("stopped"),
      fauxAssistantMessage("did the edit"),
      fauxAssistantMessage("spare"),
    ], [approval]);
    const first = await h.thread.submitPrompt("do the gated thing", { author: PERSON });
    await waitFor(() => h.events.some((e) => e.event.type === "decision_gate"));
    const target = await h.userEntry("do the gated thing");

    const receipt = await h.thread.editMessage(target.id, "never mind, say hi", { author: PERSON });
    await waitFor(() => h.settled(receipt.queueItemId));

    expect(h.events.some((e) => e.event.type === "decision_gate_withdrawn" && e.event.reason === "steer")).toBe(true);
    expect(h.thread.pendingDecisionGates()).toEqual([]);
    expect(await h.outcome(first.queueItemId)).toBe("superseded");
    expect((await h.path()).slice(0, 2)).toEqual(["note:edit", "user:never mind, say hi"]);
  });

  it("edits a transcript written before parent links, and keeps the earlier messages", async () => {
    let seen: string[] = [];
    const h = await setup("edit-legacy", [
      (context) => { seen = userTexts(context); return fauxAssistantMessage("2b"); },
    ]);
    const legacy = (id: string, role: "user" | "assistant", content: string, at: number): MessageEntry => ({
      id, sessionId: h.session.id, threadId: h.thread.id, parentId: null, type: "message", role, content,
      ...(role === "user" ? { author: PERSON } : { stopReason: "end_turn" }), createdAt: at,
    });
    await h.store.appendEntries(h.session.id, h.thread.id, [
      legacy("l1", "user", "one", 1), legacy("l2", "assistant", "1", 2),
      legacy("l3", "user", "two", 3), legacy("l4", "assistant", "2", 4),
    ]);

    const receipt = await h.thread.editMessage("l3", "two, edited", { author: PERSON });
    await waitFor(() => h.settled(receipt.queueItemId));

    expect(await h.path()).toEqual(["user:one", "assistant:1", "note:edit", "user:two, edited", "assistant:2b"]);
    expect(seen).toEqual(["one", expect.stringContaining("<branch-note>"), "two, edited"]);
  });

  it("lists what still stands from the left branch, without read-only tools", async () => {
    const h = await setup("edit-note", [
      fauxAssistantMessage([
        fauxToolCall("write_file", { path: "a.txt" }, { id: "w1" }),
        fauxToolCall("peek", {}, { id: "p1" }),
        fauxToolCall("call_tool", { tool_id: "github.create_pull_request", summary: "Open the fix" }, { id: "c1" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
      fauxAssistantMessage("again"),
    ], [writeTool, peekTool, actionTool]);
    await h.send("do it");

    await h.edit("do it", "do it differently");

    const branchNote = await h.note();
    const facts = readBranchNote(branchNote.metadata);
    expect(facts?.actions.map((a) => a.label)).toEqual(["write_file a.txt", "github.create_pull_request: Open the fix"]);
    expect(facts?.actions[1]?.urls).toEqual(["https://example.test/pr/7"]);
    expect(facts?.filesChanged).toBe(true);
    expect(branchNote.summary).toContain("github.create_pull_request: Open the fix (https://example.test/pr/7)");
    expect(branchNote.summary).toContain("working directory keeps any file changes");
    expect(branchNote.summary).not.toContain("peek");
  });

  it("lists lasting approval choices from the replaced turns, and not one-time approvals", async () => {
    const approval: ToolDef = {
      name: "open_pr",
      description: "gated",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        const resolution = await ctx.requestDecision({
          type: "approval",
          title: "Create a pull request",
          body: "",
          resumeKey: "open_pr",
          actions: [
            { id: "approve", label: "Approve once", style: "primary", approves: true },
            { id: "always_allow_owner", label: "Always allow for me", approves: true },
            { id: "deny", label: "Deny", style: "danger" },
          ],
        });
        return { text: resolution.actionId === "deny" ? "denied" : "opened" };
      },
    };
    const h = await setup("edit-grants", [
      fauxAssistantMessage([fauxToolCall("open_pr", {}, { id: "g1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("opened it"),
      fauxAssistantMessage("again"),
    ], [approval]);
    const first = await h.thread.submitPrompt("open the pr", { author: PERSON });
    await waitFor(() => h.thread.pendingDecisionGates().length > 0);
    const gate = h.thread.pendingDecisionGates()[0]!;
    h.thread.resolveDecision(gate.id, { actionId: "always_allow_owner", resolvedBy: PERSON.id, resolvedAt: Date.now() });
    await waitFor(() => h.settled(first.queueItemId));

    await h.edit("open the pr", "open a draft pr");

    const branchNote = await h.note();
    expect(readBranchNote(branchNote.metadata)?.grants).toEqual(["Always allow for me: Create a pull request"]);
    expect(branchNote.summary).toContain("Approval choices made in the earlier version still apply: Always allow for me: Create a pull request.");
  });

  it("keeps the system prompt and the rendered prefix up to the edit point the same, so the prompt cache can serve it", async () => {
    type Context = { messages: Array<{ role: string; content: unknown }> };
    // The provider folds system messages into its system prompt; the rest is the message list.
    const system = (context: Context) => JSON.stringify(getCurrentSystemMessage(context.messages as Parameters<typeof getCurrentSystemMessage>[0]));
    const list = (context: Context) => context.messages.filter((m) => m.role !== "system").map((m) => JSON.stringify({ role: m.role, content: m.content }));
    let beforeEdit: { system: string; list: string[] } = { system: "", list: [] };
    let afterEdit: { system: string; list: string[] } = { system: "", list: [] };
    const h = await setup("edit-cache-prefix", [
      fauxAssistantMessage([fauxToolCall("peek", {}, { id: "p1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("a"),
      (context) => { beforeEdit = { system: system(context), list: list(context) }; return fauxAssistantMessage("b"); },
      (context) => { afterEdit = { system: system(context), list: list(context) }; return fauxAssistantMessage("b2"); },
    ], [peekTool]);
    await h.send("first");
    await h.send("second");

    await h.edit("second", "second, edited");

    expect(afterEdit.system).toBe(beforeEdit.system);
    // [first, tool call, tool result, a] is shared; the note and the edited text follow it.
    expect(afterEdit.list.slice(0, 4)).toEqual(beforeEdit.list.slice(0, 4));
    expect(beforeEdit.list[4]).toContain("second");
    expect(afterEdit.list[4]).toContain("branch-note");
  });

  it("lists a tool that acts elsewhere without claiming files changed, and leaves out a question", async () => {
    const remember: ToolDef = { name: "remember", description: "saves memory", parameters: Type.Object({}), execute: async () => ({ text: "saved" }) };
    const ask: ToolDef = { name: "ask", description: "asks", parameters: Type.Object({}), sideEffect: "none", execute: async () => ({ text: "yes" }) };
    const h = await setup("edit-note-elsewhere", [
      fauxAssistantMessage([fauxToolCall("remember", {}, { id: "r1" }), fauxToolCall("ask", {}, { id: "q1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
      fauxAssistantMessage("again"),
    ], [remember, ask]);
    await h.send("remember this");

    await h.edit("remember this", "remember that");

    const facts = readBranchNote((await h.note()).metadata);
    expect(facts?.actions.map((a) => a.label)).toEqual(["remember"]);
    expect(facts?.filesChanged).toBe(false);
  });

  it("refuses an edit by someone other than the author, and an edit that would remove someone else's message", async () => {
    const h = await setup("edit-rules", [fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    await h.send("mine");
    await h.send("theirs", TEAMMATE);
    const mine = await h.userEntry("mine");
    const theirs = await h.userEntry("theirs");

    await expect(h.thread.editMessage(theirs.id, "x", { author: PERSON })).rejects.toThrow(/Only the person who wrote/);
    await expect(h.thread.editMessage(mine.id, "x", { author: PERSON })).rejects.toThrow(/Teammate wrote after this message/);
    // The teammate may edit their own latest message.
    await expect(h.thread.editMessage(theirs.id, "theirs, edited", { author: TEAMMATE })).resolves.toMatchObject({ threadId: h.thread.id });
  });

  it("rechecks other authors when a queued edit starts", async () => {
    const h = await setup("edit-ownership-race", [fauxAssistantMessage("reply")]);
    await h.send("mine");
    const mine = await h.userEntry("mine");
    await h.thread.pause();
    const receipt = await h.thread.editMessage(mine.id, "replacement", { author: PERSON });
    const snapshot = await h.store.getThreadSnapshot(h.session.id, h.thread.id);
    if (!snapshot) throw new Error("Missing snapshot");
    await h.store.appendEntries(h.session.id, h.thread.id, [{
      ...mine, id: "other-author-race", content: "new teammate message", author: TEAMMATE,
      parentId: snapshot.thread.activeLeafEntryId ?? null,
    }]);
    await h.thread.resume();
    await waitFor(() => h.settled(receipt.queueItemId));
    expect(await h.outcome(receipt.queueItemId)).toBe("failed");
    expect(await h.path()).toContain("user:new teammate message");
    expect(await h.path()).not.toContain("note:edit");
  });

  it("does not restore files when the edit branch CAS fails", async () => {
    const h = await setup("edit-file-cas-race", [fauxAssistantMessage("reply")]);
    await h.send("mine");
    const mine = await h.userEntry("mine");
    await h.store.updateEntry(h.session.id, h.thread.id, {
      ...mine, metadata: { fileCheckpoint: { repos: [{ repo: ".", before: "a".repeat(40), after: "b".repeat(40), changed: ["note.txt"] }] } },
    });
    const append = h.store.appendBranch.bind(h.store);
    vi.spyOn(h.store, "appendBranch").mockImplementation(async (...args) =>
      args[2].some((entry) => entry.type === "branch_summary") ? false : append(...args));
    const exec = vi.spyOn(h.session.sandbox, "exec");
    const receipt = await h.thread.editMessage(mine.id, "replacement", { author: PERSON }, { undoFiles: true });
    await waitFor(() => h.settled(receipt.queueItemId));
    expect(await h.outcome(receipt.queueItemId)).toBe("failed");
    expect(exec).not.toHaveBeenCalled();
    expect(await h.path()).toContain("user:mine");
  });

  it("refuses a message that came from a channel, and a second edit while one waits", async () => {
    const { tool, entered } = blockingTool();
    const h = await setup("edit-channel", [
      fauxAssistantMessage("a"),
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("c"),
    ], [tool]);
    const fromSlack = await h.thread.submitPrompt("from slack", {
      author: PERSON,
      channel: { channelType: "slack", channelId: "C1" },
    });
    await waitFor(() => h.settled(fromSlack.queueItemId));
    const slackEntry = await h.userEntry("from slack");
    await expect(h.thread.editMessage(slackEntry.id, "x", { author: PERSON })).rejects.toThrow(/came from Slack/);

    await h.thread.submitPrompt("busy", { author: PERSON });
    await entered;
    const busy = await h.userEntry("busy");
    await h.thread.editMessage(busy.id, "busy, edited", { author: PERSON });
    await expect(h.thread.editMessage(busy.id, "busy, again", { author: PERSON })).rejects.toThrow(/Another edit is waiting/);
  });

  it("takes a second edit while the first edit's turn still runs", async () => {
    const { tool, entered } = blockingTool();
    const respond: FauxResponseStep = (context) => {
      const last = context.messages[context.messages.length - 1];
      if (last?.role === "toolResult") return fauxAssistantMessage("stopped");
      const text = userTexts(context).at(-1) ?? "";
      if (text === "v2") return fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-2" })], { stopReason: "toolUse" });
      return fauxAssistantMessage(`did ${text}`);
    };
    const h = await setup("edit-twice", Array.from({ length: 6 }, () => respond), [tool]);
    await h.send("v1");
    const second = await h.thread.editMessage((await h.userEntry("v1")).id, "v2", { author: PERSON });
    // The first edit started: its note is written and its turn waits in a tool.
    await entered;
    const third = await h.thread.editMessage((await h.userEntry("v2")).id, "v3", { author: PERSON });
    await waitFor(() => h.settled(third.queueItemId));

    expect(await h.outcome(second.queueItemId)).toBe("superseded");
    const path = await h.path();
    expect(path.slice(-2)).toEqual(["user:v3", "assistant:did v3"]);
    expect(path).not.toContain("user:v2");
  });
});

describe("compaction during a branch switch", () => {
  it("drops a summary of the branch an edit left", async () => {
    const summarizing = latch();
    const finish = latch();
    const faux = registerFauxProvider({ provider: "compact-edit" });
    faux.setResponses([
      fauxAssistantMessage("old answer"),
      fauxAssistantMessage("second answer"),
      async () => {
        summarizing.open();
        await finish.promise;
        return fauxAssistantMessage(COMPLETE_SUMMARY);
      },
      fauxAssistantMessage("new answer"),
    ]);
    const store = new InMemorySessionStore();
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    const session = await engine.createSession({
      userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: faux.getModel(),
      compaction: { tailTurns: 1, autoContinue: false },
    });
    const thread = await session.ensureDefaultThread();
    const settled = async (id: string) => (await store.getQueueItem(session.id, id))?.status === "settled";
    for (const text of ["old topic", "second"]) {
      const receipt = await thread.submitPrompt(text, { author: PERSON });
      await waitFor(() => settled(receipt.queueItemId));
    }

    const compacting = thread.compactThread({ mode: "manual" });
    await summarizing.promise;
    const target = (await thread.readEntries()).find((e) => e.type === "message" && e.role === "user" && e.content === "old topic")!;
    const edit = await thread.editMessage(target.id, "new topic", { author: PERSON });
    await waitFor(() => settled(edit.queueItemId));
    finish.open();

    expect(await compacting).toBe("noop");
    expect((await thread.readEntries({ allBranches: true })).some((e) => e.type === "compaction")).toBe(false);
    expect((await thread.readEntries()).map(line)).toEqual(["note:edit", "user:new topic", "assistant:new answer"]);
    faux.unregister();
  });
});

describe("record-only signals", () => {
  it("adds a Slack edit note without a model call, and the next turn reads it", async () => {
    let seen: string[] = [];
    const h = await setup("record-only", [
      fauxAssistantMessage("a"),
      (context) => { seen = userTexts(context); return fauxAssistantMessage("b"); },
    ]);
    await h.send("first");
    const calls = h.faux.state.callCount;

    const noted = await h.thread.recordSignal(
      { kind: "signal", signalType: "slack.message_changed", tagName: "slack-edit", body: "Edited in Slack. Before: first. After: first, fixed." },
      { author: PERSON },
    );
    await waitFor(() => h.settled(noted.queueItemId));

    expect(await h.outcome(noted.queueItemId)).toBe("completed");
    expect(h.faux.state.callCount).toBe(calls);
    await h.send("next");
    expect(seen.join("\n")).toContain("Edited in Slack. Before: first. After: first, fixed.");
    expect(seen.at(-1)).toBe("next");
  });
});

describe("thread return", () => {
  it("goes back to the earlier version and notes the edited one", async () => {
    let seen: string[] = [];
    const h = await setup("return", [
      fauxAssistantMessage("a"),
      fauxAssistantMessage("b"),
      fauxAssistantMessage("b2"),
      (context) => { seen = userTexts(context); return fauxAssistantMessage("c"); },
    ]);
    await h.send("first");
    await h.send("second");
    await h.edit("second", "second, edited");
    const editNote = await h.note();

    await h.thread.returnToBranch(editNote.id, PERSON);

    expect(await h.path()).toEqual(["user:first", "assistant:a", "user:second", "assistant:b", "note:return"]);
    await h.send("third");
    expect(seen).toEqual(["first", "second", expect.stringContaining("went back to an earlier version"), "third"]);
    expect(await h.path()).toEqual([
      "user:first", "assistant:a", "user:second", "assistant:b", "note:return", "user:third", "assistant:c",
    ]);
  });

  it("refuses to go back while a turn runs", async () => {
    const { tool, entered, release } = blockingTool();
    const h = await setup("return-busy", [
      fauxAssistantMessage("a"),
      fauxAssistantMessage("a2"),
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ], [tool]);
    await h.send("first");
    await h.edit("first", "first, edited");
    const editNote = await h.note();
    const running = await h.thread.submitPrompt("long", { author: PERSON });
    await entered;

    await expect(h.thread.returnToBranch(editNote.id, PERSON)).rejects.toThrow(/Stop it, then go back/);
    release();
    await waitFor(() => h.settled(running.queueItemId));
  });
});

describe("thread fork", () => {
  it("copies the active path through a reply into an empty thread", async () => {
    let seen: string[] = [];
    const h = await setup("fork", [
      fauxAssistantMessage("a"),
      fauxAssistantMessage("b"),
      (context) => { seen = userTexts(context); return fauxAssistantMessage("forked reply"); },
    ]);
    await h.send("first");
    await h.send("second");
    const reply = (await h.thread.readEntries()).find((e) => line(e) === "assistant:a");
    if (!reply) throw new Error("no reply");
    const fork = await h.session.createThread("web:fork");

    await fork.copyPath(await h.thread.forkPath(reply.id), { source: { sessionId: h.session.id, threadId: h.thread.id }, actorId: PERSON.id });

    expect(await h.path(fork)).toEqual(["user:first", "assistant:a", "note:fork"]);
    const copied = await fork.readEntries();
    expect(copied.every((e) => e.threadId === fork.id && e.queueItemId === undefined)).toBe(true);
    expect(copied[0]?.id).not.toBe((await h.thread.readEntries())[0]?.id);
    expect(copied[1]?.parentId).toBe(copied[0]?.id);
    const facts = readBranchNote(copied[2]?.metadata);
    expect(facts?.source).toEqual({ sessionId: h.session.id, threadId: h.thread.id, sameWorkingDirectory: true });

    const receipt = await fork.submitPrompt("try another way", { author: PERSON });
    await waitFor(() => h.settled(receipt.queueItemId));
    expect(seen).toEqual(["first", expect.stringContaining("branch of another thread"), "try another way"]);
    // The source thread is unchanged.
    expect(await h.path()).toEqual(["user:first", "assistant:a", "user:second", "assistant:b"]);
  });

  it("refuses a thread that already has messages", async () => {
    const h = await setup("fork-full", [fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    await h.send("first");
    const fork = await h.session.createThread("web:fork");
    const source = { sessionId: h.session.id, threadId: h.thread.id };
    await fork.copyPath(await h.thread.forkPath(null), { source });
    await expect(fork.copyPath([], { source })).rejects.toThrow(/already has messages/);
  });
});

it("does not restore files when the return branch CAS fails", async () => {
  const h = await setup("return-file-cas-race", [fauxAssistantMessage("first"), fauxAssistantMessage("replacement reply")]);
  await h.send("mine");
  await h.edit("mine", "replacement");
  const note = await h.note();
  const replacement = await h.userEntry("replacement");
  await h.store.updateEntry(h.session.id, h.thread.id, {
    ...replacement, metadata: { fileCheckpoint: { repos: [{ repo: ".", before: "a".repeat(40), after: "b".repeat(40), changed: ["note.txt"] }] } },
  });
  vi.spyOn(h.store, "appendBranch").mockResolvedValue(false);
  const exec = vi.spyOn(h.session.sandbox, "exec");
  await expect(h.thread.returnToBranch(note.id, PERSON, { restoreFiles: true })).rejects.toThrow(/thread changed/i);
  expect(exec).not.toHaveBeenCalled();
  expect(await h.path()).toContain("user:replacement");
});

it.each([false, true])("journals recovery before changing files and retains uncertain results (%s)", async (uncertain) => {
  const h = await setup("edit-restore-journal", [fauxAssistantMessage("first"), fauxAssistantMessage("replacement reply")]);
  await h.send("mine");
  const target = await h.userEntry("mine");
  vi.spyOn(checkpoints, "planFileUndo").mockReturnValue([{ repo: ".", paths: [{ path: "note.txt", source: "a".repeat(40), expected: "b".repeat(40) }] }]);
  vi.spyOn(checkpoints, "restorePaths").mockImplementation(async (_sandbox, _workspace, _plan, _ref, onPrepared) => {
    const before = await h.store.getThreadSnapshot(h.session.id, h.thread.id);
    expect(before?.entries.some((entry) => entry.type === "branch_summary")).toBe(true);
    if (!onPrepared) throw new Error("Restore journal callback missing");
    await onPrepared(".", "c".repeat(40));
    const snapshot = await h.store.getThreadSnapshot(h.session.id, h.thread.id);
    const note = snapshot?.entries.find((entry) => entry.type === "branch_summary");
    const journal = readBranchNote(note?.metadata)?.files?.[0];
    expect(journal?.restorePoint).toBe("c".repeat(40));
    expect(journal?.bases).toEqual({ "note.txt": "a".repeat(40) });
    expect(journal?.failed).toContain("not completed");
    return [{ repo: ".", restored: uncertain ? [] : ["note.txt"], removed: [], skipped: [], restorePoint: "c".repeat(40),
      ...(uncertain ? { failed: "Command failed after writing, before reporting its result" } : {}) }];
  });
  const receipt = await h.thread.editMessage(target.id, "replacement", { author: PERSON }, { undoFiles: true });
  await waitFor(() => h.settled(receipt.queueItemId));
  expect(await h.outcome(receipt.queueItemId)).toBe("completed");
  const files = readBranchNote((await h.note()).metadata)?.files?.[0];
  expect(files?.bases).toEqual({ "note.txt": "a".repeat(40) });
  expect(files?.restored).toEqual(uncertain ? [] : ["note.txt"]);
  if (uncertain) expect(files?.failed).toContain("after writing");
  else expect(files?.failed).toBeUndefined();
});

it("queues an edit on a retiring owner without superseding its active turn", async () => {
  const held = latch();
  const entered = latch();
  const h = await setup("edit-config-fence", [fauxAssistantMessage("first"), async () => {
    entered.open(); await held.promise; return fauxAssistantMessage("active finished");
  }]);
  try {
    await h.send("original");
    const target = await h.userEntry("original");
    const active = await h.thread.submitPrompt("active", { author: PERSON });
    await entered.promise;
    h.session.retireExecution(async () => {});
    const edit = await h.thread.editMessage(target.id, "replacement", { author: PERSON });
    expect(await h.store.getQueueItem(h.session.id, active.queueItemId)).toMatchObject({ status: "running", attemptCount: 1 });
    expect((await h.store.getQueueItem(h.session.id, active.queueItemId))?.supersededByItemId).toBeUndefined();
    expect(await h.store.getQueueItem(h.session.id, edit.queueItemId)).toMatchObject({ status: "queued", attemptCount: 0 });
    held.open();
    await waitFor(() => h.settled(active.queueItemId));
    expect(await h.outcome(active.queueItemId)).toBe("completed");
  } finally { held.open(); await h.session.destroy(); h.faux.unregister(); }
});

it("refuses branch return on a reclaim-fenced owner without moving the leaf", async () => {
  const h = await setup("return-reclaim-fence", [fauxAssistantMessage("first"), fauxAssistantMessage("edited")]);
  try {
    await h.send("original");
    await h.edit("original", "replacement");
    const note = await h.note();
    const before = await h.store.getThread(h.session.id, h.thread.id);
    expect(await h.session.beginReclaim()).toBe(true);
    await expect(h.thread.returnToBranch(note.id, PERSON, { restoreFiles: true })).rejects.toThrow(/changing/);
    expect((await h.store.getThread(h.session.id, h.thread.id))?.activeLeafEntryId).toBe(before?.activeLeafEntryId);
  } finally { h.session.cancelReclaim(); await h.session.destroy(); h.faux.unregister(); }
});

it("reserves branch return before store awaits so reclaim cannot destroy its compute", async () => {
  const h = await setup("return-reservation", [fauxAssistantMessage("first"), fauxAssistantMessage("edited")]);
  const held = latch();
  const entered = latch();
  try {
    await h.send("original");
    await h.edit("original", "replacement");
    const note = await h.note();
    const get = h.store.getThreadSnapshot.bind(h.store);
    const reading = vi.spyOn(h.store, "getThreadSnapshot").mockImplementationOnce(async (...args) => {
      entered.open(); await held.promise; return get(...args);
    });
    const returning = h.thread.returnToBranch(note.id, PERSON);
    try {
      await entered.promise;
      expect(await h.session.beginReclaim()).toBe(false);
      held.open();
      await returning;
      expect(await h.path()).toContain("user:original");
    } finally { held.open(); await returning; reading.mockRestore(); }
  } finally { h.session.cancelReclaim(); await h.session.destroy(); h.faux.unregister(); }
});
