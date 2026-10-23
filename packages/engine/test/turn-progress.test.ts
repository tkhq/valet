import { describe, expect, it, vi } from "vitest";
import { projectTurnProgress } from "../src/turn-progress.js";
import type { QueueItem, MessageEntry, DecisionGate } from "../src/types.js";

const item: QueueItem = { id: "turn", threadId: "thread", content: "Work", status: "running", attemptCount: 1, maxAttempts: 10, timeoutAt: 0, createdAt: 1, updatedAt: 2 };
const entry: MessageEntry = { id: "entry", sessionId: "session", threadId: "thread", queueItemId: "turn", parentId: null, createdAt: 3, type: "message", role: "assistant", content: "secret reasoning", parts: [{ type: "tool_call", callId: "call", toolName: "exec", status: "completed", args: { secret: "args" }, result: { ok: false, text: "secret result" } }] };
describe("turn progress", () => {
  it("uses safe labels and detects failed tool results", () => {
    const progress = projectTurnProgress(item, [entry], []);
    expect(progress?.tasks).toEqual([{ id: "tool:call", title: "Run command", status: "error" }]);
    expect(JSON.stringify(progress)).not.toContain("secret");
  });
  it("detects ok:false in durable tool details", () => {
    const durable = { ...entry, parts: [{ type: "tool_call" as const, callId: "call", toolName: "exec", status: "completed" as const, result: { details: { ok: false }, text: "secret" } }] };
    expect(projectTurnProgress(item, [durable], [])?.tasks[0]?.status).toBe("error");
  });
  it.each(["approval", "question"] as const)("shows a pending %s gate as waiting", (type) => {
    const gate: DecisionGate = { id: "gate", sessionId: "session", threadId: "thread", queueItemId: "turn", resumeKey: "key", ordinal: 0, type, title: "secret title", body: "secret body", status: "pending", actions: [], createdAt: 3, updatedAt: 4 };
    const progress = projectTurnProgress(item, [entry], [gate]);
    expect(progress?.status).toBe("waiting");
    expect(progress?.tasks.at(-1)?.status).toBe("waiting");
    expect(JSON.stringify(progress)).not.toContain("secret");
    expect(projectTurnProgress({ ...item, status: "settled", outcome: { outcome: "aborted" } }, [], [gate])?.status).toBe("interrupted");
  });
  it("uses a safe label for prototype property names", () => {
    const tools = { ...entry, parts: [{ type: "tool_call" as const, callId: "call", toolName: "constructor", status: "running" as const }] };
    expect(projectTurnProgress(item, [tools], [])?.tasks[0]?.title).toBe("Run tool");
  });
  it("changes revision when a task changes without a timestamp change", () => {
    const first = projectTurnProgress(item, [], [], { turnId: "turn", updatedAt: 2, items: [{ id: "step", text: "Step", status: "pending" }] });
    const second = projectTurnProgress(item, [], [], { turnId: "turn", updatedAt: 2, items: [{ id: "step", text: "Step", status: "done" }] });
    expect(second?.revision).not.toBe(first?.revision);
  });
  it("keeps a failed root even when every task is complete", () => {
    const progress = projectTurnProgress({ ...item, status: "settled", outcome: { outcome: "failed" } }, [], [], { turnId: "turn", updatedAt: 3, items: [{ id: "step", text: "Step", status: "done" }] });
    expect(progress?.status).toBe("error");
    expect(progress?.tasks[0]?.status).toBe("complete");
  });
  it.each([
    ["slack_user.search_messages", "Search Slack"],
    ["slack.search_channels", "Search Slack"],
    ["slack.read_thread", "Read Slack"],
    ["github.get_issue", "Read GitHub"],
    ["github.search_code", "Search GitHub"],
    ["linear.update_issue", "Update Linear"],
    ["linear.get_issue", "Read Linear"],
    ["unknown.search_messages", "Run tool"],
    ["slack.search_secret", "Run tool"],
    ["slack.search_channels secret", "Run tool"],
    ["slack.__proto__", "Run tool"],
    [42, "Run tool"],
    [null, "Run tool"],
  ])("labels only recognized static action IDs: %s", (tool_id, title) => {
    const action = { ...entry, parts: [{ type: "tool_call" as const, callId: "call", toolName: "call_tool", status: "completed" as const, args: { tool_id, summary: "secret summary", params: { query: "secret query", token: "secret token" }, title: "secret title", service: "secret service" }, result: { text: "secret result" } }] };
    const progress = projectTurnProgress(item, [action], []);
    expect(progress?.tasks[0]?.title).toBe(title);
    expect(JSON.stringify(progress)).not.toContain("secret");
  });
  it.each([undefined, null, "secret args", [], { params: { tool_id: "slack.search_channels" } }])("rejects malformed action arguments: %j", (args) => {
    const action = { ...entry, parts: [{ type: "tool_call" as const, callId: "call", toolName: "call_tool", status: "completed" as const, args }] };
    expect(projectTurnProgress(item, [action], [])?.tasks[0]?.title).toBe("Run tool");
  });
  it("keeps running and failed tasks visible after many completed calls", () => {
    const parts = Array.from({ length: 27 }, (_, index) => ({ type: "tool_call" as const, callId: String(index), toolName: "exec", status: index === 25 ? "running" as const : index === 26 ? "error" as const : "completed" as const }));
    const progress = projectTurnProgress(item, [{ ...entry, parts }], []);
    expect(progress?.tasks).toHaveLength(20);
    expect(progress?.omittedTasks).toBe(7);
    expect(progress?.tasks.map((task) => task.id)).toContain("tool:25");
    expect(progress?.tasks.map((task) => task.id)).toContain("tool:26");
    expect(progress?.tasks.map((task) => task.id)).not.toContain("tool:0");
  });
  it("uses only the three plan steps while waiting for a question", () => {
    const gate: DecisionGate = { id: "gate", sessionId: "session", threadId: "thread", queueItemId: "turn", resumeKey: "key", ordinal: 0, type: "question", title: "secret", status: "pending", actions: [], createdAt: 3, updatedAt: 4 };
    const plan = { turnId: "turn", updatedAt: 3, items: [
      { id: "first", text: "Inspect files", status: "done" as const },
      { id: "second", text: "Confirm the approach", status: "in_progress" as const },
      { id: "third", text: "Apply changes", status: "pending" as const },
    ] };
    const tools = { ...entry, parts: [
      { type: "tool_call" as const, callId: "pwd", toolName: "exec", status: "completed" as const, args: { command: "pwd secret" } },
      { type: "tool_call" as const, callId: "ask", toolName: "ask_question", status: "running" as const, args: { question: "secret" } },
    ] };
    const progress = projectTurnProgress(item, [tools], [gate], plan);
    expect(progress?.status).toBe("waiting");
    expect(progress?.tasks).toEqual([
      { id: "first", title: "Inspect files", status: "complete" },
      { id: "second", title: "Confirm the approach", status: "waiting" },
      { id: "third", title: "Apply changes", status: "pending" },
    ]);
    expect(progress?.tasks.filter((task) => task.status === "complete")).toHaveLength(1);
    expect(progress?.omittedTasks).toBe(0);
    expect(JSON.stringify(progress)).not.toContain("secret");
  });
  it("marks only the current plan step as failed when the root fails", () => {
    const plan = { turnId: "turn", updatedAt: 3, items: [
      { id: "first", text: "Inspect files", status: "done" as const },
      { id: "second", text: "Apply changes", status: "in_progress" as const },
      { id: "third", text: "Run tests", status: "pending" as const },
    ] };
    const progress = projectTurnProgress({ ...item, status: "settled", outcome: { outcome: "failed" } }, [entry], [], plan);
    expect(progress?.status).toBe("error");
    expect(progress?.tasks.map((task) => task.status)).toEqual(["complete", "error", "pending"]);
    expect(progress?.omittedTasks).toBe(0);
  });
  it("uses tool rows if the plan is empty or belongs to another turn", () => {
    for (const plan of [{ turnId: "turn", updatedAt: 3, items: [] }, { turnId: "other", updatedAt: 3, items: [{ id: "old", text: "Old", status: "pending" as const }] }]) {
      expect(projectTurnProgress(item, [entry], [], plan)?.tasks).toEqual([{ id: "tool:call", title: "Run command", status: "error" }]);
    }
  });
  it("does not complete unfinished plan steps after settlement", () => {
    const progress = projectTurnProgress({ ...item, status: "settled", outcome: { outcome: "completed" } }, [], [], { turnId: "turn", updatedAt: 3, items: [{ id: "step", text: "Run tests", status: "pending" }] });
    expect(progress?.tasks[0]?.status).toBe("pending");
  });
  it("keeps interruption on unfinished tasks", () => {
    const progress = projectTurnProgress({ ...item, status: "settled", outcome: { outcome: "aborted" } }, [], [], { turnId: "turn", updatedAt: 3, items: [{ id: "step", text: "Run tests", status: "in_progress" }] });
    expect(progress?.status).toBe("interrupted");
    expect(progress?.tasks[0]?.status).toBe("interrupted");
  });
  it("ignores record-only submissions and inherited plans", () => {
    expect(projectTurnProgress({ ...item, metadata: { recordOnly: true } }, [entry], [])).toBeNull();
    expect(projectTurnProgress(item, [], [], { turnId: "other", updatedAt: 3, items: [{ text: "Old", status: "pending" }] })?.tasks).toEqual([]);
  });
  it("bounds tasks and uses a stable revision", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({ ...entry, id: String(i), parts: [{ type: "tool_call" as const, callId: String(i), toolName: "unknown secret", status: "running" as const }] }));
    const progress = projectTurnProgress(item, entries, []);
    expect(progress?.tasks).toHaveLength(20);
    expect(progress?.omittedTasks).toBe(5);
    expect(progress?.revision).toBe(projectTurnProgress(item, entries, [])?.revision);
    expect(JSON.stringify(progress)).not.toContain("secret");
  });
});

describe("progress store readers", () => {
  async function setup() {
    const { InMemorySessionStore } = await import("../src/providers/in-memory/store.js");
    const store = new InMemorySessionStore();
    await store.saveSession({ id: "session", owner: { type: "user", id: "user" }, userId: "user", orgId: "org", workspace: "/", purpose: "interactive", status: "running", createdAt: 1, updatedAt: 1 });
    await store.saveThread("session", { id: "thread", sessionId: "session", key: "web:default", status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 });
    return store;
  }
  it("reads only the requested thread and turn plan", async () => {
    const { readTurnProgress } = await import("../src/turn-progress.js");
    const store = await setup();
    await store.admitSubmission("session", "thread", item);
    await store.appendEntries("session", "thread", [entry]);
    const thread = (await store.getThread("session", "thread"))!;
    await store.saveThread("session", { ...thread, metadata: { plan: { turnId: "newer", updatedAt: 9, items: [{ text: "New step", status: "pending" }] }, turnPlans: [{ turnId: "turn", updatedAt: 3, items: [{ id: "step", text: "Retained step", status: "pending" }] }] } });
    expect((await readTurnProgress(store, "session", "thread", "turn"))?.tasks[0]?.title).toBe("Retained step");
    expect(await readTurnProgress(store, "session", "other", "turn")).toBeNull();
    expect(await readTurnProgress(store, "session", "thread", "missing")).toBeNull();
  });
  it("follows the active DAG rather than the newest abandoned entry", async () => {
    const { readLatestTurnProgress } = await import("../src/turn-progress.js");
    const store = await setup();
    for (const id of ["turn", "abandoned"]) {
      await store.admitSubmission("session", "thread", { ...item, id, status: "settled", outcome: { outcome: "completed" } });
    }
    await store.appendEntries("session", "thread", [entry, { ...entry, id: "abandoned-entry", queueItemId: "abandoned", createdAt: 20 }]);
    await store.appendBranch("session", "thread", [{ ...entry, id: "active-leaf", parentId: "entry", queueItemId: undefined }], { expectedLeafId: "abandoned-entry" });
    expect((await readLatestTurnProgress(store, "session", "thread"))?.turnId).toBe("turn");
  });
  it("skips record-only entries while walking predecessors", async () => {
    const { readLatestTurnProgress } = await import("../src/turn-progress.js");
    const store = await setup();
    await store.admitSubmission("session", "thread", { ...item, status: "settled", outcome: { outcome: "completed" } });
    await store.admitSubmission("session", "thread", { ...item, id: "record", status: "settled", outcome: { outcome: "completed" }, metadata: { recordOnly: true } });
    await store.appendEntries("session", "thread", [entry, { ...entry, id: "record-entry", queueItemId: "record", parentId: "entry" }]);
    expect((await readLatestTurnProgress(store, "session", "thread"))?.turnId).toBe("turn");
  });
  it("reads legacy threads without an active leaf", async () => {
    const { readLatestTurnProgress } = await import("../src/turn-progress.js");
    const store = await setup();
    await store.admitSubmission("session", "thread", { ...item, status: "settled", outcome: { outcome: "completed" } });
    await store.appendEntries("session", "thread", [entry]);
    await store.admitSubmission("session", "thread", { ...item, id: "legacy-record", status: "settled", outcome: { outcome: "completed" }, metadata: { recordOnly: true } });
    await store.appendEntries("session", "thread", [{ ...entry, id: "legacy-record-entry", queueItemId: "legacy-record", parentId: null }]);
    const getThread = store.getThread.bind(store);
    vi.spyOn(store, "getThread").mockImplementation(async (sessionId, threadId) => {
      const thread = await getThread(sessionId, threadId);
      return thread ? { ...thread, activeLeafEntryId: undefined } : null;
    });
    expect((await readLatestTurnProgress(store, "session", "thread"))?.turnId).toBe("turn");
  });
  it("reads only active turn entries while work is running", async () => {
    const { readLatestTurnProgress } = await import("../src/turn-progress.js");
    const store = await setup();
    await store.admitSubmission("session", "thread", item);
    await store.appendEntries("session", "thread", [entry]);
    const reads = vi.spyOn(store, "getEntries");
    const snapshots = vi.spyOn(store, "getThreadSnapshot");
    expect((await readLatestTurnProgress(store, "session", "thread"))?.turnId).toBe("turn");
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(reads.mock.calls.every(([, , opts]) => opts?.queueItemId === "turn")).toBe(true);
    expect(snapshots).not.toHaveBeenCalled();
  });
  it("uses a bounded tail for idle reads and loads a snapshot only for older ancestry", async () => {
    const { readLatestTurnProgress } = await import("../src/turn-progress.js");
    const store = await setup();
    await store.admitSubmission("session", "thread", { ...item, status: "settled", outcome: { outcome: "completed" } });
    await store.appendEntries("session", "thread", [entry]);
    const reads = vi.spyOn(store, "getEntries");
    const snapshots = vi.spyOn(store, "getThreadSnapshot");
    expect((await readLatestTurnProgress(store, "session", "thread"))?.turnId).toBe("turn");
    expect(reads.mock.calls.filter(([, , opts]) => !opts?.queueItemId).every(([, , opts]) => typeof opts?.limit === "number" && opts.limit <= 100)).toBe(true);
    expect(snapshots).not.toHaveBeenCalled();
    const branches = Array.from({ length: 100 }, (_, index) => ({ ...entry, id: `branch:${index}`, queueItemId: undefined, parentId: null }));
    await store.appendEntries("session", "thread", branches);
    await store.appendBranch("session", "thread", [{ ...entry, id: "leaf", parentId: "entry", queueItemId: undefined }], { expectedLeafId: "branch:99" });
    expect((await readLatestTurnProgress(store, "session", "thread"))?.turnId).toBe("turn");
    expect(snapshots).toHaveBeenCalledTimes(1);
  });
  it("prefers running work and skips record-only queued work", async () => {
    const { readLatestTurnProgress } = await import("../src/turn-progress.js");
    const store = await setup();
    await store.admitSubmission("session", "thread", item);
    await store.admitSubmission("session", "thread", { ...item, id: "record", status: "queued", createdAt: 20, metadata: { recordOnly: true } });
    await store.admitSubmission("session", "thread", { ...item, id: "queued", status: "queued", createdAt: 10 });
    expect((await readLatestTurnProgress(store, "session", "thread"))?.turnId).toBe("turn");
  });
});
