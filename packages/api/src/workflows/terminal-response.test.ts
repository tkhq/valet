import { afterAll, beforeAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { Engine, InMemoryEventStream, VirtualSandboxProvider, type Session } from "@valet/engine";
import { fauxAssistantMessage, registerFauxProvider } from "@valet/engine/test-helpers";
import { applyEngineMigrations, pgDbFromPglite, PgSessionStore, type PgDb } from "@valet/store-postgres";
import { driveUntilPark, InMemoryWorkflowStore, type WorkflowDefinition, type WorkflowEngineDeps } from "@valet/workflow";
import { readNodeDiagnostics } from "./node-diagnostics.js";

let db: PgDb;
beforeAll(async () => {
  db = pgDbFromPglite(new PGlite());
  await applyEngineMigrations(db);
});
afterAll(async () => { await db.close(); });

const definition: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "t", type: "trigger" },
    { id: "s", type: "session", mode: "start", prompt: "Produce the answer.",
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } },
    { id: "end", type: "stop", outcome: "success" },
  ],
  edges: [{ from: "t", to: "s" }, { from: "s", to: "end" }],
};

it.each([
  { name: "recovered", responses: [fauxAssistantMessage([]), fauxAssistantMessage('{"answer":"recovered"}')], outcome: "completed", calls: 2 },
  { name: "empty-repair", responses: [fauxAssistantMessage([]), fauxAssistantMessage([])], outcome: "failed", calls: 2 },
  { name: "length", responses: [fauxAssistantMessage('{"answer":"partial"}', { stopReason: "length" })], outcome: "failed", calls: 1 },
  { name: "error", responses: [fauxAssistantMessage('{"answer":"partial"}', { stopReason: "error", errorMessage: "invalid request" })], outcome: "failed", calls: 1 },
  { name: "abort", responses: [fauxAssistantMessage('{"answer":"partial"}', { stopReason: "aborted" })], outcome: "failed", calls: 1 },
])("engine and workflow preserve the bounded output contract: $name", async test => {
  const faux = registerFauxProvider({ provider: `terminal-workflow-${test.name}` });
  faux.setResponses(test.responses);
  const store = new PgSessionStore(db);
  const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
  const sessions: Session[] = [];
  const dispatches: string[] = [];
  const sessionFor = (id: string) => {
    const session = engine.getSession(id);
    if (!session) throw new Error("missing workflow session");
    return session;
  };
  const unused = async (): Promise<never> => { throw new Error("unexpected workflow operation"); };
  const deps: WorkflowEngineDeps = {
    createSession: async opts => {
      const session = await engine.createSession({ ...opts, userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
      sessions.push(session);
      return { id: session.id };
    },
    prompt: async (id, text, opts) => {
      dispatches.push(opts.dispatchId);
      return sessionFor(id).thread("research").submitPrompt(text, opts);
    },
    awaitResult: async (id, threadId, queueItemId, opts) => {
      const thread = sessionFor(id).threadById(threadId);
      if (!thread) throw new Error("missing workflow thread");
      return thread.awaitResult(queueItemId, { ...opts, timeoutMs: 2000 });
    },
    isSettled: async (id, queueItemId) => (await store.getQueueItem(id, queueItemId))?.status === "settled",
    abort: unused, llmComplete: unused, promptOrchestrator: unused, invokeAction: unused,
  };
  const workflows = new InMemoryWorkflowStore();
  const runId = `terminal-${test.name}`;
  try {
    await workflows.createRun(runId, { workflowId: "wf", definitionVersionId: "v1" }, definition, "v1");
    // Original dispatch, at most one repair dispatch, then settlement. No polling or provider retries.
    for (let drive = 0; drive < 3; drive++) {
      const claim = await workflows.claimRun(runId, "owner", 30_000);
      if (!claim) throw new Error("workflow claim failed");
      const result = await driveUntilPark(runId, claim.attempt, { store: workflows, engine: deps, clock: Date.now });
      if (result.status === "settled") {
        expect(result.outcome).toBe(test.outcome);
        break;
      }
      if (result.status !== "parked") throw new Error("unexpected workflow drive state");
      for (const wait of result.waitingOn) {
        if (wait.kind !== "submission") throw new Error("unexpected workflow wait");
        await deps.awaitResult(wait.sessionId, wait.threadId, wait.queueItemId);
      }
    }
    const checkpoint = (await workflows.getCheckpoints(runId)).find(cp => cp.nodeId === "s");
    expect(checkpoint?.status).toBe(test.outcome);
    expect(checkpoint?.effects?.repairAttempted).toBe(test.calls === 2);
    expect(dispatches).toEqual(test.calls === 2 ? [`workflow:${runId}:s`, `workflow:${runId}:s:repair`] : [`workflow:${runId}:s`]);
    if (test.name === "recovered") expect(checkpoint?.result).toMatchObject({ output: { answer: "recovered" } });
    else expect(checkpoint?.result).toBeUndefined();
    if (!checkpoint) throw new Error("missing session checkpoint");
    const diagnostics = await readNodeDiagnostics(store, checkpoint);
    expect(diagnostics.submissions).toHaveLength(test.calls);
    if (test.calls === 2) {
      expect(diagnostics.submissions).toMatchObject([
        { phase: "original", outcome: "completed", textState: "empty", attemptCount: 1,
          selected: { modelResponse: { stopReason: "stop", textLength: 0 } } },
        { phase: "repair", outcome: "completed", textState: test.name === "recovered" ? "present" : "empty", attemptCount: 1,
          selected: { modelResponse: { stopReason: "stop" } } },
      ]);
      expect(diagnostics.firstQueueItemId).not.toBe(diagnostics.queueItemId);
      expect(diagnostics.schemaError).toBe("no JSON content found in result text");
    }
    for (const session of sessions) await session.reconcile();
    expect(faux.state.callCount).toBe(test.calls);
  } finally {
    for (const session of sessions) session.suspendTimers();
    faux.unregister();
  }
});

it.each(["orchestrator", "interactive", "workflow"] as const)("preserves intentional silence without an output schema: %s", async purpose => {
  const faux = registerFauxProvider({ provider: `terminal-silence-${purpose}` });
  let prompt: string | undefined;
  faux.setResponses([context => { prompt = getCurrentSystemPrompt(context.messages); return fauxAssistantMessage([]); }]);
  const store = new PgSessionStore(db);
  const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
  const session = await engine.createSession({ purpose, userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
  try {
    const receipt = await session.prompt(purpose === "orchestrator"
      ? { kind: "signal", signalType: "slack.message", body: "Alice: Thanks Bob, resolved.", attributes: { addressed: "false" },
          origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "manual" } }
      : "No reply is needed.");
    const thread = session.threadById(receipt.threadId);
    if (!thread) throw new Error("missing thread");
    const result = await thread.awaitResult(receipt.queueItemId);
    expect(result).toMatchObject({ outcome: "completed", text: "" });
    expect(result).not.toHaveProperty("error");
    expect(result.output).toBeUndefined();
    expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome).toEqual({ outcome: "completed" });
    const entries = await store.getEntries(session.id, receipt.threadId, { queueItemId: receipt.queueItemId });
    expect(entries.filter(e => e.type === "message" && e.role === "assistant")).toMatchObject([{ content: "", parts: [], stopReason: "end_turn" }]);
    if (purpose === "orchestrator") expect(prompt).toContain("Stay silent");
    await session.reconcile();
    await thread.awaitResult(receipt.queueItemId);
    expect(faux.state.callCount).toBe(1);
  } finally { session.suspendTimers(); faux.unregister(); }
});
