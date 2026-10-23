/**
 * A child that stops at a gate tells its parent thread (TKAI-564). Before
 * this, the parent heard about a child only when it settled, so a child
 * waiting on an approval looked like silent work.
 */
import { randomUUID } from "node:crypto";
import type { DecisionGate } from "@valet/engine";
import { afterEach, expect, it, vi } from "vitest";
import { agentSessions, childWatches } from "../schema/index.js";
import { parentDelegationMetadata, wireChildGateReports } from "../orchestrator/children.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import { bootTestApi, type TestApi } from "./_setup.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

it("signals the parent thread once when its child opens a gate", async () => {
  api = await bootTestApi();
  const p = api.providers;
  const parent = await defaultAssistantSessionFor({ db: p.db, engineHost: p.engineHost }, { type: "user", id: "local-user" }, { actorUserId: "local-user", orgId: "local-org" });
  const parentThread = parent.thread("slack:C1:1.2");
  const childId = `child-gate-${randomUUID()}`;
  await p.db.insert(agentSessions).values({
    id: childId, userId: "local-user", orgId: "local-org", workspace: "/tmp/child-gate",
    ownerType: "user", ownerId: "local-user", createdAt: Date.now(), updatedAt: Date.now(),
  });
  const child = await p.engineHost.childSessionFor(childId, {
    parentSessionId: parent.id, parentThreadId: parentThread.id,
    actorUserId: "local-user", orgId: "local-org", owner: parent.owner, workspace: "/tmp/child-gate",
    toolScope: { tools: ["ask_question"], actions: ["workflows.get_run"] },
  });
  await child.pause();
  const receipt = await child.prompt("Wait for a question", { metadata: {
    ...parentDelegationMetadata(parent.id, parentThread.id, { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" }),
    toolScope: { actions: [] },
  } });
  await p.db.insert(childWatches).values({
    childSessionId: childId, queueItemId: receipt.queueItemId, parentSessionId: parent.id, parentThreadId: parentThread.id,
    actorUserId: "local-user", orgId: "local-org", settled: false,
    originJson: JSON.stringify({ channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" }), createdAt: Date.now(),
  });
  const unwire = wireChildGateReports(p.eventStream, p.childWatcher);
  try {
    const gate: DecisionGate = {
      id: "child-gate-1", sessionId: childId, threadId: child.thread().id, queueItemId: receipt.queueItemId,
      resumeKey: "rk", ordinal: 0, type: "approval", title: "Push to main?",
      actions: [{ id: "approve", label: "Approve" }], status: "pending", createdAt: Date.now(), updatedAt: Date.now(),
    };
    await p.engineStore.saveDecisionGate(childId, gate.threadId, gate);
    for (const attempt of ["first", "repeat"]) {
      await p.eventStream.append(
        { sessionId: childId, threadId: gate.threadId, timestamp: Date.now(), event: { type: "decision_gate", threadId: gate.threadId, gate } },
        `child-gate-${attempt}`,
      );
    }
    // The signal is a queued submission on the parent thread. Whether the
    // parent has run it yet depends on its model, so read the queue itself.
    await vi.waitFor(async () => {
      await p.wakeWatcher.sweep();
      const items = [
        ...await p.engineStore.listUnsettledSubmissions(parent.id),
        ...await p.engineStore.listSettledSubmissionsBefore(parent.id, Date.now() + 1),
        // The engine prefixes an internal sender's dispatch id with its session.
      ].filter((item) => item.dispatchId === `${childId}:gate-opened:${childId}:${gate.id}`);
      expect(items).toHaveLength(1);
      const [item] = items;
      expect(item?.threadId).toBe(parentThread.id);
      expect(item?.metadata?.toolScope).toEqual({ tools: ["ask_question"], actions: [] });
      expect(item?.content).toMatchObject({
        kind: "signal", signalType: "child.gate_opened",
        attributes: { child_session_id: childId, gate_id: gate.id },
        origin: { threadKey: "slack:C1:1.2", reply: "manual" },
      });
    }, { timeout: 5000 });
  } finally {
    unwire();
  }
});
