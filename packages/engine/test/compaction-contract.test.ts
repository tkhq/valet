import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type MessageEntry, type SessionEntry } from "../src/index.js";
import { summarize } from "../src/compaction.js";
import { entriesToAgentMessages } from "../src/thread.js";
import { COMPLETE_SUMMARY } from "./fixtures/compaction-summary.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function modelFor(faux: ReturnType<typeof registerFauxProvider>, id?: string) {
  const model = faux.getModel(id);
  if (!model) throw new Error("Missing fixture model");
  return model;
}
const MODEL = { api: "anthropic-messages", provider: "contract", id: "model" };
function user(id: string, content: string, metadata?: Record<string, unknown>): MessageEntry {
  return { id, sessionId: "s", threadId: "t", parentId: null, type: "message", role: "user", content, queueItemId: `q-${id}`, metadata, createdAt: 1 };
}
function checkpoint(ids: string[], id = "checkpoint"): SessionEntry {
  return { id, sessionId: "s", threadId: "t", parentId: null, type: "compaction", summary: COMPLETE_SUMMARY,
    coveredEntryIds: ids, tokenCountBefore: 100, tokenCountAfter: 10, createdAt: 2 };
}
function render(entries: SessionEntry[]) { return JSON.stringify(entriesToAgentMessages(entries, MODEL)); }
function provider() {
  const faux = registerFauxProvider({ provider: `contract-${Math.random()}` });
  cleanups.push(() => faux.unregister());
  return faux;
}

describe("compaction summary acceptance", () => {
  it.each([
    ["missing section", COMPLETE_SUMMARY.replace("## Constraints & Preferences\n- Keep the user's qualification rules and report layout.\n\n", "")],
    ["truncated final section", COMPLETE_SUMMARY.slice(0, COMPLETE_SUMMARY.indexOf("## Relevant Files"))],
    ["empty section", COMPLETE_SUMMARY.replace("- Keep the user's qualification rules and report layout.", "")],
    ["reordered sections", COMPLETE_SUMMARY.replace("## Goal", "## Key Decisions").replace("## Key Decisions\n- Reuse", "## Goal\n- Reuse")],
    ["duplicate section", COMPLETE_SUMMARY + "\n## Goal\n- Another goal"],
    ["headings in a code fence", "```markdown\n" + COMPLETE_SUMMARY + "\n```"],
    ["unclosed code fence", COMPLETE_SUMMARY + "\n```text\nunfinished"],
  ])("rejects %s instead of committing a checkpoint", async (_name, text) => {
    const faux = provider();
    faux.setResponses([fauxAssistantMessage(text)]);
    await expect(summarize({ headEntries: [user("task", "Inspect qualifying records")], model: modelFor(faux) })).rejects.toThrow(/summary/i);
    expect(faux.state.callCount).toBe(1);
  });

  it("rejects a nonterminal tool completion even when its text looks complete", async () => {
    const faux = provider();
    faux.setResponses([fauxAssistantMessage(COMPLETE_SUMMARY, { stopReason: "toolUse" })]);
    await expect(summarize({ headEntries: [user("task", "Inspect qualifying records")], model: modelFor(faux) })).rejects.toThrow(/summarizer/i);
    expect(faux.state.callCount).toBe(1);
  });

  it("rejects a terminal response that still contains a tool call", async () => {
    const faux = provider();
    faux.setResponses([fauxAssistantMessage([{ type: "text", text: COMPLETE_SUMMARY },
      { type: "toolCall", id: "pending", name: "read", arguments: {} }])]);
    await expect(summarize({ headEntries: [user("task", "Inspect records")], model: modelFor(faux) })).rejects.toThrow(/summarizer/i);
    expect(faux.state.callCount).toBe(1);
  });

  it("accepts closed code fences without treating quoted headings as sections", async () => {
    const faux = provider();
    const summary = COMPLETE_SUMMARY.replace("## Relevant Files\n- (none)", "## Relevant Files\n- Error example:\n```text\n## Goal\nerror details\n```");
    faux.setResponses([fauxAssistantMessage(summary)]);
    expect((await summarize({ headEntries: [user("task", "Inspect records")], model: modelFor(faux) })).summary).toBe(summary);
  });

  it("accepts a complete terminal summary after stripping its scratchpad", async () => {
    const faux = provider();
    faux.setResponses([fauxAssistantMessage("<analysis>notes</analysis>\n" + COMPLETE_SUMMARY)]);
    expect((await summarize({ headEntries: [user("task", "Inspect qualifying records")], model: modelFor(faux) })).summary).toBe(COMPLETE_SUMMARY);
  });
});

describe("original task retention", () => {
  const contract = "UNIQUE_QUALIFICATION_RULE: exclude internal repos. Report columns: URL, owner, evidence.";
  it("keeps the rendered task exactly once when a checkpoint covers it", () => {
    const task = user("task", contract, { preserveTask: true });
    const entries = [task, checkpoint(["task"]), user("continue", "Continue", { synthetic: true, compaction_continue: true })];
    expect(render(entries).split("UNIQUE_QUALIFICATION_RULE")).toHaveLength(2);
  });

  it("repairs from the original entry even when an older submission predates task metadata", () => {
    const task = user("legacy-task", contract);
    const entries = [task, checkpoint([task.id]), user("repair", "Correct the JSON schema", { preserveTask: true, taskSourceQueueItemId: "q-legacy-task" })];
    const text = render(entries);
    expect(text).toContain(contract);
    expect(text.split("UNIQUE_QUALIFICATION_RULE")).toHaveLength(2);
    expect(text).toContain("Correct the JSON schema");
  });

  it("keeps the workflow signal envelope and restores the first user entry of a continued submission", () => {
    const task = { ...user("task", contract, { preserveTask: true }),
      signal: { signalType: "workflow.request", tagName: "signal", attributes: { runId: "run-1" } } };
    const continued = { ...user("continued", "Resume authorized work", { synthetic: true, compaction_continue: true }), queueItemId: "q-task" };
    const repair = user("repair", "Correct the JSON", { preserveTask: true, taskSourceQueueItemId: "q-task" });
    const text = render([task, continued, checkpoint([task.id, continued.id]), repair]);
    expect(text.split("UNIQUE_QUALIFICATION_RULE")).toHaveLength(2);
    expect(text).toContain("workflow.request");
    expect(text).toContain("run-1");
    expect(text).not.toContain("Resume authorized work");
  });

  it("does not duplicate an uncovered task or retain an earlier workflow's task", () => {
    const old = user("old", "OBSOLETE_TASK", { preserveTask: true });
    const current = user("current", contract, { preserveTask: true });
    const text = render([old, checkpoint([old.id]), current]);
    expect(text).not.toContain("OBSOLETE_TASK");
    expect(text.split("UNIQUE_QUALIFICATION_RULE")).toHaveLength(2);
  });

  it("retains one original after repeated compactions cover both task and repair", () => {
    const task = user("task", contract, { preserveTask: true });
    const repair = user("repair", "Correct the JSON schema", { preserveTask: true, taskSourceQueueItemId: "q-task" });
    const text = render([task, checkpoint([task.id]), repair, checkpoint([task.id, repair.id], "second")]);
    expect(text.split("UNIQUE_QUALIFICATION_RULE")).toHaveLength(2);
    expect(text).not.toContain("Correct the JSON schema");
  });

  it.each([false, true])("does not recover a source from an inactive branch (repair override=%s)", override => {
    const task = user("private", "INACTIVE_TASK");
    const current = { ...user("current", "Current task", { preserveTask: true, taskSourceQueueItemId: "q-private" }), parentId: "root" };
    const entries: SessionEntry[] = [user("root", "Shared root"), { ...task, parentId: "root" }, current, { ...checkpoint(["root", "current"]), parentId: "current" }];
    const text = JSON.stringify(entriesToAgentMessages(entries, MODEL, { activeLeafEntryId: "checkpoint", ...(override ? { taskSourceQueueItemId: "q-private" } : {}) }));
    expect(text).not.toContain("INACTIVE_TASK");
  });
});


describe("checkpoint replacement safety", () => {
  it("leaves the accepted checkpoint and unsummarized task usable after a malformed completion", async () => {
    const faux = registerFauxProvider({ provider: "contract-failed-checkpoint", models: [{ id: "tiny", name: "tiny", contextWindow: 20_000, maxTokens: 5 }] });
    cleanups.push(() => faux.unregister());
    faux.setResponses([fauxAssistantMessage("## Goal\n- Interrupted handoff")]);
    const store = new InMemorySessionStore();
    const stream = new InMemoryEventStream();
    const events: string[] = [];
    stream.subscribe({}, event => events.push(event.event.type));
    const engine = new Engine({ providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() } });
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: modelFor(faux, "tiny"), compaction: { tailTurns: 1, autoContinue: false } });
    const thread = session.thread();
    const input: SessionEntry[] = [user("intro", "Initial context"), checkpoint(["intro"], "accepted"),
      user("task", "ORIGINAL_RULE: exclude internal repos", { preserveTask: true }),
      { ...user("work", "collected evidence ".repeat(5_000)), role: "assistant" }, user("recent", "Continue inspecting")];
    let parentId: string | null = null;
    const entries = input.map((entry, index) => {
      const value = { ...entry, sessionId: session.id, threadId: thread.id, parentId, createdAt: index + 1 };
      parentId = entry.id;
      return value;
    });
    await store.appendEntries(session.id, thread.id, entries);
    thread.rehydrateTranscript(entries);
    await expect(thread.compactThread({ mode: "manual" })).rejects.toThrow(/summary/i);
    const saved = await store.getEntries(session.id, thread.id);
    expect(saved.filter(entry => entry.type === "compaction").map(entry => entry.id)).toEqual(["accepted"]);
    const context = render(saved);
    expect(context).toContain("ORIGINAL_RULE");
    expect(context).toContain("collected evidence");
    expect(context).not.toContain("Interrupted handoff");
    expect(events.filter(event => event === "compaction_start")).toHaveLength(1);
    expect(events.filter(event => event === "compaction_end")).toHaveLength(1);
    expect(faux.state.callCount).toBe(1);
  });
});


it.each([
  { preserveOriginal: true, restart: true }, { preserveOriginal: true, restart: false },
  { preserveOriginal: false, restart: true }, { preserveOriginal: false, restart: false },
])("restores the original task once through repair (metadata=$preserveOriginal, restart=$restart)", async ({ preserveOriginal, restart }) => {
  const faux = registerFauxProvider({ provider: `contract-restart-${preserveOriginal}-${restart}`, models: [{ id: "tiny", name: "tiny", contextWindow: 20_000, maxTokens: 5 }] });
  cleanups.push(() => faux.unregister());
  const requests: string[] = [];
  faux.setResponses([fauxAssistantMessage("Initial evidence collected"), fauxAssistantMessage(COMPLETE_SUMMARY), context => {
    requests.push(JSON.stringify(context.messages));
    return fauxAssistantMessage('{"report":"verified"}');
  }]);
  const providers = { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
  const engine = new Engine({ providers });
  const options = { userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: modelFor(faux, "tiny"), compaction: { tailTurns: 1, autoContinue: false } };
  const session = await engine.createSession(options);
  const task = "PERSISTED_RULE: exclude internal repos. Columns: URL, owner, evidence. Trigger: 2026-10-16.";
  const primary = await session.prompt(task, { metadata: preserveOriginal ? { preserveTask: true } : undefined });
  const thread = session.thread();
  expect((await thread.awaitResult(primary.queueItemId)).outcome).toBe("completed");
  const prior = await providers.store.getEntries(session.id, thread.id);
  const original = prior.find(entry => entry.type === "message" && entry.role === "user" && entry.queueItemId === primary.queueItemId);
  if (!original) throw new Error("Missing initial task entry");
  const lastEntry = prior.at(-1);
  if (!lastEntry) throw new Error("Missing prior transcript");
  const history: SessionEntry[] = [
    { id: "large-evidence", sessionId: session.id, threadId: thread.id, parentId: lastEntry.id, type: "message", role: "assistant", content: "Evidence already inspected. ".repeat(3_000), createdAt: Date.now() },
    { id: "progress", sessionId: session.id, threadId: thread.id, parentId: "large-evidence", type: "message", role: "user", content: "Finish the remaining records", createdAt: Date.now() + 1 },
  ];
  await providers.store.appendEntries(session.id, thread.id, history);
  thread.rehydrateTranscript(await providers.store.getEntries(session.id, thread.id));
  expect(await thread.compactThread({ mode: "manual" })).toBe("compacted");
  const saved = await providers.store.getEntries(session.id, thread.id);
  expect(saved.find(entry => entry.type === "compaction" && entry.coveredEntryIds.includes(original.id))).toBeDefined();
  const restored = restart ? await new Engine({ providers }).restoreSession({ sessionId: session.id, options }) : session;
  const repair = await restored.prompt("Correct the final JSON schema", { metadata: { preserveTask: true, taskSourceQueueItemId: primary.queueItemId } });
  expect((await restored.thread().awaitResult(repair.queueItemId)).outcome).toBe("completed");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain(task);
  expect(requests[0].split("PERSISTED_RULE")).toHaveLength(2);
  expect(requests[0]).toContain("Correct the final JSON schema");
  expect(faux.state.callCount).toBe(3);
});
