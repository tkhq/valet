import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type MessageEntry, type SessionEntry } from "../src/index.js";
import { entriesToSummaryMessages, summarize } from "../src/compaction.js";
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
function render(entries: SessionEntry[], taskSourceQueueItemId?: string) { return JSON.stringify(entriesToAgentMessages(entries, MODEL, { taskSourceQueueItemId })); }
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
    expect(render(entries, "q-task").split("UNIQUE_QUALIFICATION_RULE")).toHaveLength(2);
  });

  it("repairs from the original entry even when an older submission predates task metadata", () => {
    const task = user("legacy-task", contract);
    const entries = [task, checkpoint([task.id]), user("repair", "Correct the JSON schema", { preserveTask: true, taskSourceQueueItemId: "q-legacy-task" })];
    const text = render(entries, "q-legacy-task");
    expect(text).toContain(contract);
    expect(text.split("UNIQUE_QUALIFICATION_RULE")).toHaveLength(2);
    expect(text).toContain("Correct the JSON schema");
  });

  it("keeps the workflow signal envelope and restores the first user entry of a continued submission", () => {
    const task = { ...user("task", contract, { preserveTask: true }),
      signal: { signalType: "workflow.request", tagName: "signal", attributes: { runId: "run-1" } } };
    const continued = { ...user("continued", "Resume authorized work", { synthetic: true, compaction_continue: true }), queueItemId: "q-task" };
    const repair = user("repair", "Correct the JSON", { preserveTask: true, taskSourceQueueItemId: "q-task" });
    const text = render([task, continued, checkpoint([task.id, continued.id]), repair], "q-task");
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
    const text = render([task, checkpoint([task.id]), repair, checkpoint([task.id, repair.id], "second")], "q-task");
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


describe("failed-tool evidence across context reconstruction", () => {
  const diagnostic = "ACTIONABLE_FAILURE: receipt is /workspace/receipt-719.json; do not retry the external operation";
  it.each([
    { restart: false, compact: false }, { restart: true, compact: false },
    { restart: false, compact: true }, { restart: true, compact: true },
  ])("keeps failure evidence and executes the operation once (restart=$restart, compact=$compact)", async ({ restart, compact }) => {
    const faux = registerFauxProvider({ provider: `failure-evidence-${restart}-${compact}`,
      models: [{ id: "tiny", name: "tiny", contextWindow: 20_000, maxTokens: 5 }] });
    cleanups.push(() => faux.unregister());
    let operations = 0;
    let repairContext = "";
    const summary = COMPLETE_SUMMARY.replace("## Errors & Fixes\n- (none)", `## Errors & Fixes\n- ${diagnostic}`);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("receipt_probe", {}, { id: "receipt-call" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("The task is blocked; no JSON."),
      ...(compact ? [fauxAssistantMessage(summary)] : []),
      context => { repairContext = JSON.stringify(context.messages); return fauxAssistantMessage('{"report":"blocked"}'); },
    ]);
    const providers = { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
    const options = { userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: modelFor(faux, "tiny"),
      compaction: { tailTurns: 1, autoContinue: false },
      tools: [{ name: "receipt_probe", description: "Read the operation receipt", parameters: Type.Object({}), execute: async () => {
        operations++; throw new Error(diagnostic);
      } }],
    };
    const engine = new Engine({ providers });
    const session = await engine.createSession(options);
    const primary = await session.prompt("QUALIFICATION_RULE: exclude internal repos. Report receipt and blocker.", { metadata: { preserveTask: true } });
    expect((await session.thread().awaitResult(primary.queueItemId)).outcome).toBe("completed");
    if (compact) {
      const thread = session.thread();
      const prior = await providers.store.getEntries(session.id, thread.id);
      const last = prior.at(-1);
      if (!last) throw new Error("Missing prior transcript");
      await providers.store.appendEntries(session.id, thread.id, [
        { id: "evidence", parentId: last.id, sessionId: session.id, threadId: thread.id, type: "message", role: "assistant", content: "collected evidence ".repeat(5_000), createdAt: Date.now() },
        { id: "progress", parentId: "evidence", sessionId: session.id, threadId: thread.id, type: "message", role: "user", content: "Finish the report", createdAt: Date.now() + 1 },
      ]);
      thread.rehydrateTranscript(await providers.store.getEntries(session.id, thread.id));
      expect(await thread.compactThread({ mode: "manual" })).toBe("compacted");
    }
    const active = restart ? await new Engine({ providers }).restoreSession({ sessionId: session.id, options }) : session;
    const repair = await active.prompt("Correct the final JSON", { metadata: { preserveTask: true, taskSourceQueueItemId: primary.queueItemId } });
    expect((await active.thread().awaitResult(repair.queueItemId)).outcome).toBe("completed");
    expect(repairContext).toContain(diagnostic);
    expect(repairContext.split("QUALIFICATION_RULE")).toHaveLength(2);
    expect(repairContext.split("Correct the final JSON")).toHaveLength(2);
    expect(operations).toBe(1);
  });

  it.each([
    { result: { text: diagnostic }, error: undefined },
    { result: { content: [{ type: "text", text: diagnostic }] }, error: undefined },
    { result: diagnostic, error: undefined },
    { result: { text: diagnostic }, error: "The tool failed after recording the receipt." },
    { result: undefined, error: diagnostic },
  ])("keeps persisted failure details in both summary input and provider context: %j", part => {
    const entry: MessageEntry = { ...user("failure", ""), role: "assistant", parts: [
      { type: "tool_call", callId: "failed", toolName: "read", args: {}, status: "error", ...part },
    ] };
    expect(render([entry])).toContain(diagnostic);
    expect(JSON.stringify(entriesToSummaryMessages([entry], { toolOutputMaxChars: 2_000 }))).toContain(diagnostic);
  });
});


it("does not resurrect a completed workflow contract in later ordinary context", () => {
  const task = { ...user("completed-task", "POST_REPORT_AGAIN", { preserveTask: true }), signal: { signalType: "workflow.request", tagName: "signal" } };
  const answer: MessageEntry = { ...user("answer", "Posted the report"), role: "assistant" };
  const text = render([task, answer, user("unrelated", "Explain this unrelated topic"), checkpoint([task.id, answer.id, "unrelated"]), user("next", "Continue the unrelated topic")]);
  expect(text).not.toContain("POST_REPORT_AGAIN");
  expect(text).toContain("Continue the unrelated topic");
});

it("does not pin a large completed signal task into later ordinary requests", async () => {
  const faux = registerFauxProvider({ provider: "expired-large-task", models: [{ id: "tiny", name: "tiny", contextWindow: 20_000, maxTokens: 5 }] });
  cleanups.push(() => faux.unregister());
  let later = "";
  faux.setResponses([fauxAssistantMessage("Report posted"), fauxAssistantMessage(COMPLETE_SUMMARY), context => {
    later = JSON.stringify(context.messages); return fauxAssistantMessage("Unrelated question answered");
  }]);
  const providers = { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
  const compaction = { enabled: false, tailTurns: 1, autoContinue: false as const };
  const session = await new Engine({ providers }).createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: modelFor(faux, "tiny"), compaction });
  const primary = await session.prompt({ kind: "signal", signalType: "workflow.request", body: "COMPLETED_LARGE_TASK " + "x".repeat(60_000) }, { metadata: { preserveTask: true } });
  expect((await session.thread().awaitResult(primary.queueItemId)).outcome).toBe("completed");
  compaction.enabled = true;
  const prior = await providers.store.getEntries(session.id, session.thread().id);
  const last = prior.at(-1);
  if (!last) throw new Error("Missing original transcript");
  await providers.store.appendEntries(session.id, session.thread().id, [{ id: "other-topic", parentId: last.id, sessionId: session.id, threadId: session.thread().id, type: "message", role: "user", content: "Unrelated topic", createdAt: Date.now() }]);
  session.thread().rehydrateTranscript(await providers.store.getEntries(session.id, session.thread().id));
  expect(await session.thread().compactThread({ mode: "manual" })).toBe("compacted");
  const next = await session.prompt("Please explain this unrelated topic " + "y".repeat(10_000));
  expect((await session.thread().awaitResult(next.queueItemId)).outcome).toBe("completed");
  expect(later).not.toContain("COMPLETED_LARGE_TASK");
});


it("does not accept a checkpoint whose summary plus active task cannot fit", async () => {
  const faux = registerFauxProvider({ provider: "retained-task-budget", models: [{ id: "tiny", name: "tiny", contextWindow: 20_000, maxTokens: 5 }] });
  cleanups.push(() => faux.unregister());
  const providers = { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
  const engine = new Engine({ providers });
  const compaction = { enabled: true, tailTurns: 1, autoContinue: false as const };
  let outcome: string | undefined;
  let sessionId = "";
  const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: modelFor(faux, "tiny"), compaction,
    tools: [{ name: "compact_probe", description: "Compact after collecting evidence", parameters: Type.Object({}), execute: async () => {
      const active = engine.getSession(sessionId);
      if (!active) throw new Error("Missing active session");
      const thread = active.thread();
      const entries = await providers.store.getEntries(active.id, thread.id);
      const last = entries.at(-1);
      if (!last) throw new Error("Missing active task");
      await providers.store.appendEntries(active.id, thread.id, [
        { id: "budget-evidence", parentId: last.id, sessionId: active.id, threadId: thread.id, type: "message", role: "assistant", content: "evidence ".repeat(12_000), createdAt: Date.now() },
        { id: "budget-progress", parentId: "budget-evidence", sessionId: active.id, threadId: thread.id, type: "message", role: "user", content: "Continue authorized work", createdAt: Date.now() + 1 },
      ]);
      thread.rehydrateTranscript(await providers.store.getEntries(active.id, thread.id));
      outcome = await thread.compactThread({ mode: "manual" });
      compaction.enabled = false;
      return { text: "Compaction budget checked" };
    } }],
  });
  sessionId = session.id;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("compact_probe", {}, { id: "compact-once" })], { stopReason: "toolUse" }),
    fauxAssistantMessage(COMPLETE_SUMMARY + "\n- " + "x".repeat(80_000)),
    fauxAssistantMessage("Budget check finished"),
  ]);
  const receipt = await session.prompt("ACTIVE_CONTRACT: preserve this task", { metadata: { preserveTask: true } });
  await session.thread().awaitResult(receipt.queueItemId);
  expect(outcome).toBe("insufficient");
  expect((await providers.store.getEntries(session.id, session.thread().id)).some(entry => entry.type === "compaction")).toBe(false);
  expect(faux.state.callCount).toBe(3);
});


it("retires an actively retained contract before the next ordinary hot turn", async () => {
  const faux = registerFauxProvider({ provider: "retire-hot-contract", models: [{ id: "tiny", name: "tiny", contextWindow: 20_000, maxTokens: 5 }] });
  cleanups.push(() => faux.unregister());
  const providers = { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
  const engine = new Engine({ providers });
  let sessionId = "";
  let nextContext = "";
  const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: modelFor(faux, "tiny"), compaction: { tailTurns: 1, autoContinue: false },
    tools: [{ name: "compact_task", description: "Compact the active task", parameters: Type.Object({}), execute: async () => {
      const active = engine.getSession(sessionId);
      if (!active) throw new Error("Missing task session");
      const thread = active.thread();
      const entries = await providers.store.getEntries(active.id, thread.id);
      const last = entries.at(-1);
      if (!last) throw new Error("Missing task transcript");
      await providers.store.appendEntries(active.id, thread.id, [
        { id: "hot-evidence", parentId: last.id, sessionId: active.id, threadId: thread.id, type: "message", role: "assistant", content: "evidence ".repeat(12_000), createdAt: Date.now() },
        { id: "hot-progress", parentId: "hot-evidence", sessionId: active.id, threadId: thread.id, type: "message", role: "user", content: "Finish the report", createdAt: Date.now() + 1 },
      ]);
      thread.rehydrateTranscript(await providers.store.getEntries(active.id, thread.id));
      expect(await thread.compactThread({ mode: "manual" })).toBe("compacted");
      return { text: "Context prepared" };
    } }],
  });
  sessionId = session.id;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("compact_task", {}, { id: "active-compact" })], { stopReason: "toolUse" }),
    fauxAssistantMessage(COMPLETE_SUMMARY), fauxAssistantMessage("Report posted"),
    context => { nextContext = JSON.stringify(context.messages); return fauxAssistantMessage("Unrelated answer"); },
  ]);
  const original = await session.prompt("OLD_COMPLETED_TASK: post the report", { metadata: { preserveTask: true } });
  expect((await session.thread().awaitResult(original.queueItemId)).outcome).toBe("completed");
  const next = await session.prompt("Now discuss an unrelated topic");
  expect((await session.thread().awaitResult(next.queueItemId)).outcome).toBe("completed");
  expect(nextContext).not.toContain("OLD_COMPLETED_TASK");
});
