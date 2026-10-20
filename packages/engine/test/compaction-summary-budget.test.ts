import { afterEach, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type SessionEntry } from "../src/index.js";
import { entriesToAgentMessages } from "../src/thread.js";
import { COMPLETE_SUMMARY } from "./fixtures/compaction-summary.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

it("defers an older tail turn when the generated summary needs its space", async () => {
  // The window leaves about 1k tokens of headroom over the system prompt and
  // tool definitions. The bash and task tools describe background processes
  // (wakeups), so the fixture is 21k; at 24k the older tail fits and nothing
  // is deferred.
  const faux = registerFauxProvider({ provider: "summary-tail-budget", models: [{ id: "tiny", name: "tiny", contextWindow: 21_000, maxTokens: 5 }] });
  cleanups.push(() => faux.unregister());
  const model = faux.getModel("tiny");
  if (!model) throw new Error("Missing fixture model");
  const providers = { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
  const engine = new Engine({ providers });
  let sessionId = "";
  let firstOutcome: string | undefined;
  let finalRequest = "";
  let firstCoverage: string[] = [];
  let firstContext = "";
  const summaryInputs: string[] = [];
  const task = "ACTIVE_WORKFLOW_RULE " + "x".repeat(52_000);
  const oldTurn = "OLDER_TURN_EVIDENCE " + "y".repeat(17_000);
  const summary = COMPLETE_SUMMARY + "\n- " + "s".repeat(12_000);
  const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model,
    compaction: { autoContinue: false },
    tools: [{ name: "prepare_history", description: "Collect evidence and compact the active workflow", parameters: Type.Object({}), execute: async () => {
      const active = engine.getSession(sessionId);
      if (!active) throw new Error("Missing active session");
      const thread = active.thread();
      const entries = await providers.store.getEntries(active.id, thread.id);
      const last = entries.at(-1);
      if (!last) throw new Error("Missing active task");
      const history: SessionEntry[] = [
        { id: "head-evidence", parentId: last.id, sessionId: active.id, threadId: thread.id, type: "message", role: "assistant", content: "h".repeat(20_000), createdAt: Date.now() },
        { id: "older-tail", parentId: "head-evidence", sessionId: active.id, threadId: thread.id, type: "message", role: "user", content: oldTurn, createdAt: Date.now() + 1 },
        { id: "newest-turn", parentId: "older-tail", sessionId: active.id, threadId: thread.id, type: "message", role: "user", content: "Finish the authorized workflow", createdAt: Date.now() + 2 },
      ];
      await providers.store.appendEntries(active.id, thread.id, history);
      thread.rehydrateTranscript(await providers.store.getEntries(active.id, thread.id));
      firstOutcome = await thread.compactThread({ mode: "manual" });
      const saved = await providers.store.getEntries(active.id, thread.id);
      const checkpoint = saved.find(entry => entry.type === "compaction");
      firstCoverage = checkpoint?.type === "compaction" ? checkpoint.coveredEntryIds : [];
      firstContext = JSON.stringify(entriesToAgentMessages(saved, model, { threadKey: thread.key,
        taskSourceQueueItemId: entries.find(entry => entry.type === "message" && entry.role === "user")?.queueItemId }));
      return { text: "Evidence collected" };
    } }],
  });
  sessionId = session.id;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("prepare_history", {}, { id: "prepare-once" })], { stopReason: "toolUse" }),
    context => { summaryInputs.push(JSON.stringify(context.messages)); return fauxAssistantMessage(summary); },
    context => { summaryInputs.push(JSON.stringify(context.messages)); return fauxAssistantMessage(summary); },
    context => { finalRequest = JSON.stringify(context.messages); return fauxAssistantMessage("Workflow completed"); },
  ]);
  const receipt = await session.prompt({ kind: "signal", signalType: "workflow.request", body: task }, { metadata: { preserveTask: true } });
  const result = await session.thread().awaitResult(receipt.queueItemId);
  expect(firstOutcome).toBe("compacted");
  expect(firstCoverage).toContain("head-evidence");
  expect(firstCoverage).not.toContain("older-tail");
  expect(firstContext).toContain(oldTurn);
  expect(result.outcome).toBe("completed");
  expect(summaryInputs).toHaveLength(2);
  expect(summaryInputs[1]).toContain("OLDER_TURN_EVIDENCE");
  expect(finalRequest).toContain(task);
  expect(finalRequest.split("ACTIVE_WORKFLOW_RULE")).toHaveLength(2);
  expect(finalRequest).not.toContain(oldTurn);
  expect(finalRequest).toContain("Finish the authorized workflow");
  const saved = await providers.store.getEntries(session.id, session.thread().id);
  const checkpoints = saved.filter(entry => entry.type === "compaction");
  expect(checkpoints).toHaveLength(2);
  expect(checkpoints[1].coveredEntryIds).toContain("older-tail");
  expect(faux.state.callCount).toBe(4);
});
