import type { DecisionGate, ListNotificationDecisionsResponse, WorkflowActionRequiredItem, WorkflowPendingGate } from "@valet/api/wire";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "~/api/client";
import { answerAll, decisionRequest, planBulkAnswers, summarizeBulkAnswers, workflowRequest, type BulkTarget, type WorkflowTarget } from "./bulk-answers";

type DecisionItem = ListNotificationDecisionsResponse["items"][number];

function decision(id: string, gate: Partial<DecisionGate> = {}): DecisionItem {
  return {
    sessionId: `session-${id}`, title: `Thread ${id}`,
    gate: { id, sessionId: `session-${id}`, threadId: `thread-${id}`, type: "approval", title: `Approve ${id}?`, status: "pending",
      createdAt: 1, updatedAt: 1, actions: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }], ...gate },
  };
}

function workflow(id: string, gate: Partial<WorkflowPendingGate> = {}): WorkflowActionRequiredItem {
  return {
    id, runId: `run-${id}`, workflowId: "wf", workflowName: `Workflow ${id}`, runCreatedAt: 1,
    owner: { type: "user", id: "me" }, trigger: { type: "manual" },
    gate: { kind: "approval", nodeId: `node-${id}`, prompt: `Ship ${id}?`, ...gate },
  };
}

describe("planBulkAnswers", () => {
  it("includes approval gates with a one-time approve and a deny action", () => {
    const plan = planBulkAnswers([], [decision("a")], "me");
    expect(plan.targets).toEqual([{ kind: "decision", key: "decision:a", title: "Approve a?", context: "Thread a", sessionId: "session-a", gateId: "a" }]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips questions and credential requests because they need an answer or a credential", () => {
    const plan = planBulkAnswers([], [decision("q", { type: "question" }), decision("c", { type: "credential_request" })], "me");
    expect(plan.targets).toEqual([]);
    expect(plan.skipped.map(s => [s.key, s.reason])).toEqual([["decision:q", "needs_answer"], ["decision:c", "needs_credential"]]);
  });

  it("skips a gate that waits on another member and a gate that lends your own account", () => {
    const plan = planBulkAnswers([], [
      decision("other", { approver: { userId: "someone", name: "Teammate" } }),
      decision("mine", { approver: { userId: "me" } }),
    ], "me");
    expect(plan.targets).toEqual([]);
    expect(plan.skipped.map(s => [s.key, s.reason])).toEqual([["decision:other", "waiting_on_other"], ["decision:mine", "shares_your_account"]]);
  });

  it("never selects always_allow or approve_session, and skips a gate without a one-time approve or a deny", () => {
    const lasting = [{ id: "approve_session", label: "Approve for this session" }, { id: "always_allow", label: "Always allow (org)" }];
    const plan = planBulkAnswers([], [
      decision("full", { actions: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }, ...lasting] }),
      decision("no-once", { actions: [...lasting, { id: "deny", label: "Deny" }] }),
      decision("no-deny", { actions: [{ id: "approve", label: "Approve" }, ...lasting] }),
    ], "me");
    expect(plan.targets.map(t => t.key)).toEqual(["decision:full"]);
    expect(plan.skipped.map(s => [s.key, s.reason])).toEqual([["decision:no-once", "no_one_time_action"], ["decision:no-deny", "no_one_time_action"]]);
    expect(decisionRequest("approve")).toEqual({ actionId: "approve" });
    expect(decisionRequest("deny")).toEqual({ actionId: "deny" });
  });

  it("skips a gate that is no longer pending", () => {
    expect(planBulkAnswers([], [decision("old", { status: "resolved" })], "me").skipped.map(s => s.reason)).toEqual(["not_pending"]);
  });

  it("includes workflow approval nodes and policy gates, and skips policy gates that use a shared account", () => {
    const plan = planBulkAnswers([
      workflow("node", { iteration: 2 }),
      workflow("policy", { kind: "policy_gate", service: "github", action: "create_issue", prompt: undefined }),
      workflow("borrow", { kind: "policy_gate", service: "slack", action: "post", approver: { userId: "me" } }),
      workflow("lent", { kind: "policy_gate", service: "slack", action: "post", approver: { userId: "someone" } }),
    ], [], "me");
    expect(plan.targets).toEqual([
      { kind: "workflow", key: "workflow:node", title: "Workflow node: Ship node?", runId: "run-node", nodeId: "node-node", iteration: 2, policy: false },
      { kind: "workflow", key: "workflow:policy", title: "Workflow policy: github.create_issue", runId: "run-policy", nodeId: "node-policy", iteration: undefined, policy: true },
    ]);
    expect(plan.skipped.map(s => [s.key, s.reason])).toEqual([["workflow:borrow", "shares_your_account"], ["workflow:lent", "waiting_on_other"]]);
  });
});

describe("workflowRequest", () => {
  const node: WorkflowTarget = { kind: "workflow", key: "k", title: "t", runId: "r", nodeId: "n", iteration: 3, policy: false };
  const policy: WorkflowTarget = { ...node, policy: true };
  it("answers approval nodes with approved and the iteration, without a note", () => {
    expect(workflowRequest(node, "approve")).toEqual({ approved: true, iteration: 3 });
    expect(workflowRequest(node, "deny")).toEqual({ approved: false, iteration: 3 });
  });
  it("approves policy gates once only, and denies them plainly", () => {
    expect(workflowRequest(policy, "approve")).toEqual({ approved: true, scope: "once", iteration: 3 });
    expect(workflowRequest(policy, "deny")).toEqual({ approved: false, iteration: 3 });
  });
});

describe("answerAll", () => {
  const targets: BulkTarget[] = ["a", "b", "c", "d", "e", "f"].map(id => ({ kind: "decision", key: id, title: `Gate ${id}`, sessionId: "s", gateId: id }));

  it("answers every target with at most four in flight and reports progress", async () => {
    let inFlight = 0; let peak = 0;
    const progress = vi.fn();
    const outcome = await answerAll(targets, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 1));
      inFlight--;
    }, progress);
    expect(peak).toBe(4);
    expect(outcome.done).toHaveLength(6);
    expect(progress).toHaveBeenLastCalledWith(6);
  });

  it("keeps going after a failure and counts vanished gates as skipped", async () => {
    const outcome = await answerAll(targets, async (t) => {
      if (t.key === "b") throw new ApiError(403, "POST → 403", { error: "Only the owner can answer." });
      if (t.key === "c") throw new ApiError(404, "POST → 404", { error: "gate not pending" });
      if (t.key === "d") throw new ApiError(409, "POST → 409", { error: "this approval gate has already been resolved" });
    }, () => {});
    expect(outcome.done.map(t => t.key)).toEqual(["a", "e", "f"]);
    expect(outcome.vanished.map(t => t.key)).toEqual(["c", "d"]);
    expect(outcome.failed).toEqual([{ target: targets[1], error: "Only the owner can answer." }]);
  });
});

describe("summarizeBulkAnswers", () => {
  const t = (title: string): BulkTarget => ({ kind: "decision", key: title, title, sessionId: "s", gateId: title });
  it("names each failure with its title and error", () => {
    expect(summarizeBulkAnswers("approve", { done: [t("a"), t("b")], vanished: [], failed: [{ target: t("Deploy"), error: "Forbidden." }] }))
      .toBe("Approved 2. 1 failed: Deploy: Forbidden.");
  });
  it("counts already answered requests as skipped", () => {
    expect(summarizeBulkAnswers("deny", { done: [t("a")], vanished: [t("b")], failed: [] }))
      .toBe("Denied 1. Skipped 1 that was already answered.");
  });
});
