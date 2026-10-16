import { afterAll, beforeAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Type } from "typebox";
import type { TranscriptContext } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, VirtualSandboxProvider, type Session, type CreateSessionOptions } from "@valet/engine";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@valet/engine/test-helpers";
import { applyEngineMigrations, pgDbFromPglite, PgSessionStore, type PgDb } from "@valet/store-postgres";
import { driveUntilPark, InMemoryWorkflowStore, type WorkflowDefinition, type WorkflowEngineDeps } from "@valet/workflow";

let db: PgDb;
beforeAll(async () => { db = pgDbFromPglite(new PGlite()); await applyEngineMigrations(db); });
afterAll(async () => { await db.close(); });

const rule = "ORIGINAL_RULE: exclude internal repos; report the receipt and verified evidence.";
const failure = "ACTIONABLE_FAILURE: operation already submitted; read /workspace/receipt-719.json; do not submit it again";
const summary = `## Goal
- Complete the report.
## Constraints & Preferences
- Keep the original rules.
## User Messages
- Finish the report.
## Progress
### Done
- Submitted the operation once.
### In Progress
- Read its receipt.
### Blocked
- ${failure}
## Errors & Fixes
- ${failure}
## Key Decisions
- Reuse the receipt.
## Agreed Approach
- Read and verify.
## Active Tools & Skills
- receipt_read.
## Continuation Checkpoint
- Next Action: Read the receipt.
## Next Steps
- Read the receipt and finish.
## Critical Context
- Do not repeat the operation.
## Relevant Files
- /workspace/receipt-719.json`;

it.each([
  { kind: "session", compact: false, restart: false },
  { kind: "orchestrator", compact: false, restart: true },
  { kind: "session", compact: true, restart: true },
  { kind: "orchestrator", compact: true, restart: false },
].flatMap(test => [true, false].map(recover => ({ ...test, recover }))))(
  "preserves task and evidence through durable workflow repair: %j", async test => {
    const runId = `context-${test.kind}-${test.compact}-${test.restart}-${test.recover}`;
    const faux = registerFauxProvider({ provider: runId, models: [{ id: "tiny", name: "tiny", contextWindow: 20_000, maxTokens: 5 }] });
    const model = faux.getModel("tiny");
    if (!model) throw new Error("Missing fixture model");
    const store = new PgSessionStore(db);
    const providers = { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
    let runtime = new Engine({ providers });
    const sessions: Session[] = [];
    const options = new Map<string, CreateSessionOptions>();
    const workflows = new InMemoryWorkflowStore();
    let operations = 0;
    let reads = 0;
    const posts: unknown[] = [];
    const requests: string[] = [];
    const submissions: string[] = [];
    const getSession = (id: string) => {
      const session = runtime.getSession(id);
      if (!session) throw new Error("Missing workflow session");
      return session;
    };
    const ensureSession = async (id: string) => {
      if (runtime.getSession(id)) return getSession(id);
      const value: CreateSessionOptions = { id, userId: "u", orgId: "o", owner: { type: test.kind === "orchestrator" ? "team" : "user", id: test.kind === "orchestrator" ? "owner" : "u" },
        purpose: test.kind === "orchestrator" ? "orchestrator" : "workflow", workspace: "/", sandbox: {}, model,
        compaction: { tailTurns: 1, autoContinue: false },
        tools: [
          { name: "submit_probe", description: "Submit the operation", parameters: Type.Object({}), execute: async () => { operations++; throw new Error(failure); } },
          { name: "receipt_read", description: "Read its receipt", parameters: Type.Object({}), execute: async () => { reads++; return { text: "Receipt 719: external repo; verified evidence" }; } },
        ],
      };
      options.set(id, value);
      const session = await runtime.createSession(value);
      sessions.push(session);
      return session;
    };
    const submit = async (id: string, text: string, opts: Parameters<WorkflowEngineDeps["prompt"]>[2]) => {
      submissions.push(opts.dispatchId);
      const session = await ensureSession(id);
      // The host admission contract is also checked in engine-deps.test.ts.
      return session.thread("research").submitPrompt(text, { ...opts, metadata: { preserveTask: true,
        ...(opts.taskSourceQueueItemId ? { taskSourceQueueItemId: opts.taskSourceQueueItemId } : {}) } });
    };
    const unused = async (): Promise<never> => { throw new Error("Unexpected workflow operation"); };
    const deps: WorkflowEngineDeps = {
      createSession: async opts => ({ id: (await ensureSession(opts.id)).id }), prompt: submit,
      promptOrchestrator: async (text, opts) => {
        const id = `wf:${runId}:thread`;
        return { ...await submit(id, text, opts), sessionId: id };
      },
      isSettled: async (id, queueItemId) => (await store.getQueueItem(id, queueItemId))?.status === "settled",
      awaitResult: async (id, threadId, queueItemId, opts) => {
        const thread = getSession(id).threadById(threadId);
        if (!thread) throw new Error("Missing workflow thread");
        return thread.awaitResult(queueItemId, { ...opts, timeoutMs: 3000 });
      },
      invokeAction: async request => { posts.push(request.params); return { ok: true, result: { receipt: "post-1" } }; },
      abort: unused, llmComplete: unused,
    };
    const outputSchema = { type: "object", properties: { report: { type: "string" } }, required: ["report"] };
    const definition: WorkflowDefinition = { version: "dag/v1", nodes: [
      { id: "start", type: "trigger" },
      ...(test.kind === "session" ? [{ id: "research", type: "session", mode: "start", prompt: rule, outputSchema } as const]
        : [{ id: "research", type: "orchestrator", prompt: rule, outputSchema } as const]),
      { id: "post", type: "tool", service: "slack", action: "post_message", params: { text: "{{nodes.research.result.output.report}}" } },
      { id: "end", type: "stop" },
    ], edges: [{ from: "start", to: "research" }, { from: "research", to: "post" }, { from: "post", to: "end" }] };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("submit_probe", {}, { id: "submit-once" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("The report needs the operation receipt. It is not complete."),
      ...(test.compact ? [(context: TranscriptContext) => { expect(JSON.stringify(context.messages)).toContain(failure); return fauxAssistantMessage(summary); }] : []),
      context => {
        const text = JSON.stringify(context.messages);
        requests.push(text);
        return text.includes(rule) && text.includes(failure) && test.recover
          ? fauxAssistantMessage([fauxToolCall("receipt_read", {}, { id: "read-receipt" })], { stopReason: "toolUse" })
          : fauxAssistantMessage("Cannot complete the report: receipt access is blocked.");
      },
      ...(test.recover ? [fauxAssistantMessage('{"report":"Receipt 719: external repo; verified evidence"}')] : []),
    ]);
    const drive = async () => {
      const claim = await workflows.claimRun(runId, "test-owner", 30_000);
      if (!claim) throw new Error("Cannot claim workflow run");
      return driveUntilPark(runId, claim.attempt, { store: workflows, engine: deps, clock: Date.now });
    };
    const awaitParked = async (result: Awaited<ReturnType<typeof drive>>) => {
      if (result.status !== "parked") throw new Error("Expected parked workflow");
      const wait = result.waitingOn[0];
      if (wait?.kind !== "submission") throw new Error("Expected submission receipt");
      await deps.awaitResult(wait.sessionId, wait.threadId, wait.queueItemId);
      return wait;
    };
    try {
      await workflows.createRun(runId, { workflowId: "wf", definitionVersionId: "v1" }, definition, "v1", { ownerType: test.kind === "orchestrator" ? "team" : "user", ownerId: test.kind === "orchestrator" ? "owner" : "u" });
      const primary = await awaitParked(await drive());
      const session = getSession(primary.sessionId);
      if (test.compact) {
        const entries = await store.getEntries(session.id, primary.threadId);
        const last = entries.at(-1);
        if (!last) throw new Error("Missing original transcript");
        await store.appendEntries(session.id, primary.threadId, [
          { id: `${runId}:evidence`, parentId: last.id, sessionId: session.id, threadId: primary.threadId, type: "message", role: "assistant", content: "collected evidence ".repeat(5_000), createdAt: Date.now() },
          { id: `${runId}:progress`, parentId: `${runId}:evidence`, sessionId: session.id, threadId: primary.threadId, type: "message", role: "user", content: "Finish the report", createdAt: Date.now() + 1 },
        ]);
        const thread = session.thread("research");
        thread.rehydrateTranscript(await store.getEntries(session.id, thread.id));
        expect(await thread.compactThread({ mode: "manual" })).toBe("compacted");
      }
      if (test.restart) {
        session.suspendTimers();
        runtime = new Engine({ providers });
        const savedOptions = options.get(primary.sessionId);
        if (!savedOptions) throw new Error("Missing session options");
        sessions.push(await runtime.restoreSession({ sessionId: primary.sessionId, options: savedOptions }));
      }
      expect(posts).toHaveLength(0);
      const repair = await awaitParked(await drive());
      expect(repair.queueItemId).not.toBe(primary.queueItemId);
      expect((await store.getQueueItem(primary.sessionId, repair.queueItemId))?.metadata?.taskSourceQueueItemId).toBe(primary.queueItemId);
      expect(await drive()).toMatchObject({ status: "settled", outcome: test.recover ? "completed" : "failed" });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain(failure);
      expect(requests[0].split("ORIGINAL_RULE")).toHaveLength(2);
      expect(operations).toBe(1);
      expect(reads).toBe(test.recover ? 1 : 0);
      expect(posts).toEqual(test.recover ? [{ text: "Receipt 719: external repo; verified evidence" }] : []);
      expect(submissions).toEqual([`workflow:${runId}:research`, `workflow:${runId}:research:repair`]);
    } finally { for (const session of sessions) session.suspendTimers(); faux.unregister(); }
  });
