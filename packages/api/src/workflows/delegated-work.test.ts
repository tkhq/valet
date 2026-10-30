import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { QueueItem } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { childWatches } from "../schema/index.js";
import { delegatedWorkOpen, openStepWork } from "./delegated-work.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("delegated work of a workflow step", () => {
  it("counts only the children that the step's own turns spawned", async () => {
    // Two steps can share one run thread (`thread: "run"`). Step B's child
    // must not keep step A open, and B's report must not become A's result.
    api = await bootTestApi();
    const { db, engineStore } = api.providers;
    const root = await ensureDefaultAssistantSession(api.providers, { type: "user", id: LOCAL_USER.id },
      { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id });
    const sessionId = root.sessionId;
    const thread = await root.session.createThread("signal:workflow:shared_run");
    const base = Date.now();
    const admit = async (id: string, at: number, content: QueueItem["content"], status: QueueItem["status"]): Promise<QueueItem> => {
      await engineStore.admitSubmission(sessionId, thread.id, { id, threadId: thread.id, dispatchId: `d:${id}`, content,
        status, attemptCount: 0, maxAttempts: 10, timeoutAt: at + 60_000, createdAt: at, updatedAt: at });
      const item = await engineStore.getQueueItem(sessionId, id);
      if (!item) throw new Error(`queue item ${id} was not admitted`);
      return item;
    };
    const request = (body: string): QueueItem["content"] =>
      ({ kind: "signal", signalType: "workflow.request", body, attributes: { runId: "shared_run" } });
    const report = (child: string): QueueItem["content"] =>
      ({ kind: "signal", signalType: "child.settled", body: "done", attributes: { child_session_id: child, outcome: "completed" } });
    const watch = (child: string, parentQueueItemId: string, at: number, settled: boolean) => db.insert(childWatches).values({
      childSessionId: child, queueItemId: `${child}-item`, parentSessionId: sessionId, parentThreadId: thread.id,
      parentQueueItemId, actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id, settled, createdAt: at });

    const stepA = await admit("step-a", base, request("A"), "settled");
    const stepB = await admit("step-b", base + 10, request("B"), "settled");
    await watch("child-b", stepB.id, base + 20, false);

    // B's child runs: B owes work, A does not.
    expect(await delegatedWorkOpen(db, engineStore, sessionId, stepB)).toBe(true);
    expect(await delegatedWorkOpen(db, engineStore, sessionId, stepA)).toBe(false);

    // B's child reports. The report turn belongs to B only.
    await db.update(childWatches).set({ settled: true }).where(eq(childWatches.childSessionId, "child-b"));
    const reportB = await admit("report-b", base + 30, report("child-b"), "queued");
    expect((await openStepWork(db, engineStore, sessionId, stepB)).reportTurn?.id).toBe(reportB.id);
    expect(await openStepWork(db, engineStore, sessionId, stepA)).toEqual({ childPending: false });

    // A delegates; A's report turn delegates again. The grandchild is A's work.
    await watch("child-a", stepA.id, base + 40, true);
    const reportA = await admit("report-a", base + 50, report("child-a"), "settled");
    await watch("grandchild-a", reportA.id, base + 60, false);
    expect(await openStepWork(db, engineStore, sessionId, stepA)).toEqual({ childPending: true });
    expect((await openStepWork(db, engineStore, sessionId, stepB)).childPending).toBe(false);
  });
});
