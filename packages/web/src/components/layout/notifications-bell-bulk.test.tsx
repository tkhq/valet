// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { DecisionGate, ListNotificationDecisionsResponse, WorkflowActionRequiredItem, WorkflowPendingGate } from "@valet/api/wire";
import { ApiError } from "~/api/client";
import { NotificationsBell } from "./notifications-bell";

type DecisionItem = ListNotificationDecisionsResponse["items"][number];

const state = vi.hoisted(() => ({
  decisions: [] as ListNotificationDecisionsResponse["items"],
  nextPage: [] as ListNotificationDecisionsResponse["items"],
  nextCursor: undefined as string | undefined,
  workflows: [] as WorkflowActionRequiredItem[],
  resolveDecision: vi.fn(),
  resolveWorkflow: vi.fn(),
  // The "server" lists: a refetch returns what is still waiting.
  refetchWorkflows: vi.fn(),
  refetchDecisions: vi.fn(),
}));
vi.mock("~/api/queries", () => ({
  useNotifications: () => ({ data: { notifications: [] }, refetch: vi.fn() }),
  useNotificationDecisions: (cursor?: string) => ({
    data: { items: cursor ? state.nextPage : state.decisions, nextCursor: cursor ? null : state.nextCursor },
    refetch: () => state.refetchDecisions(cursor),
  }),
  useMarkNotificationRead: () => ({ mutateAsync: vi.fn() }),
  useMarkAllNotificationsRead: () => ({ mutate: vi.fn() }),
  useResolveDecisions: () => ({ mutateAsync: state.resolveDecision }),
}));
vi.mock("~/api/workflows", () => ({
  useWorkflowActionRequired: () => ({ data: { count: state.workflows.length, items: state.workflows }, refetch: state.refetchWorkflows }),
  useResolveWorkflowApprovals: () => ({ mutateAsync: state.resolveWorkflow }),
}));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: "me" } }) }));
vi.mock("~/components/session/decision-gate-card", () => ({ DecisionGateCard: () => null }));
vi.mock("~/components/workflows/workflow-approval-item", () => ({ WorkflowApprovalItem: () => null }));

function decision(id: string, gate: Partial<DecisionGate> = {}): DecisionItem {
  return {
    sessionId: `session-${id}`, title: `Thread ${id}`,
    gate: { id, sessionId: `session-${id}`, threadId: `thread-${id}`, type: "approval", title: `Approve ${id}?`, status: "pending", oneShot: true,
      createdAt: 1, updatedAt: 1, actions: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }, { id: "always_allow", label: "Always allow (org)" }], ...gate },
  };
}

function workflow(id: string, gate: Partial<WorkflowPendingGate> = {}): WorkflowActionRequiredItem {
  return {
    id, runId: `run-${id}`, workflowId: "wf", workflowName: `Workflow ${id}`, runCreatedAt: 1,
    owner: { type: "user", id: "me" }, trigger: { type: "manual" },
    gate: { kind: "approval", nodeId: `node-${id}`, prompt: `Ship ${id}?`, ...gate },
  };
}

/** The server stops listing a gate once it is answered or gone. */
function removeDecision(gateId: string) {
  state.decisions = state.decisions.filter(d => d.gate.id !== gateId);
}
function removeWorkflow(runId: string) {
  state.workflows = state.workflows.filter(w => w.runId !== runId);
}

beforeEach(() => {
  state.decisions = []; state.nextPage = []; state.nextCursor = undefined; state.workflows = [];
  state.resolveDecision.mockReset().mockImplementation(async ({ gateId }: { gateId: string }) => { removeDecision(gateId); return { ok: true }; });
  state.resolveWorkflow.mockReset().mockImplementation(async ({ runId }: { runId: string }) => { removeWorkflow(runId); return { ok: true }; });
  state.refetchWorkflows.mockReset().mockImplementation(async () => ({ isError: false, data: { count: state.workflows.length, items: state.workflows } }));
  state.refetchDecisions.mockReset().mockImplementation(async (cursor?: string) => ({ isError: false, data: { items: cursor ? state.nextPage : state.decisions } }));
});

async function openBell() {
  const view = render(<NotificationsBell />);
  await userEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
  return view;
}

it("hides the bulk buttons until a listed item is eligible", async () => {
  state.decisions = [decision("q", { type: "question" }), decision("c", { type: "credential_request" }),
    decision("other", { approver: { userId: "someone", name: "Teammate" } })];
  const { rerender } = await openBell();
  expect(screen.queryByRole("button", { name: /^Approve all/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Deny all/ })).toBeNull();
  state.decisions = [...state.decisions, decision("a")];
  rerender(<NotificationsBell />);
  expect(screen.getByRole("button", { name: "Approve all 1 request" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Deny all 1 request" })).toBeTruthy();
});

it("lists each covered request and each skipped request with its reason", async () => {
  state.workflows = [workflow("node"), workflow("policy", { kind: "policy_gate", service: "github", action: "create_issue" })];
  state.decisions = [decision("a"), decision("q", { type: "question", title: "Which branch?" }),
    decision("other", { title: "Use the shared account?", approver: { userId: "someone" } })];
  await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Approve all 3 requests" }));
  const dialog = screen.getByRole("dialog", { name: "Approve 3 requests?" });
  const covered = within(dialog).getByRole("list", { name: "Requests to approve" });
  expect(within(covered).getAllByRole("listitem").map(li => li.textContent)).toEqual([
    "Workflow node: Ship node?", "Workflow policy: github.create_issue", "Approve a?Thread a",
  ]);
  const skipped = within(dialog).getByRole("list", { name: "Not included" });
  expect(within(skipped).getAllByRole("listitem").map(li => li.textContent)).toEqual([
    "Which branch?: Needs a typed answer.", "Use the shared account?: Waits on another member.",
  ]);
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(state.resolveDecision).not.toHaveBeenCalled();
  expect(state.resolveWorkflow).not.toHaveBeenCalled();
});

it("approves each listed item once through its own endpoint and reports the result", async () => {
  state.workflows = [workflow("node", { iteration: 2 }), workflow("policy", { kind: "policy_gate", service: "github", action: "create_issue" })];
  state.decisions = [decision("a")];
  await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Approve all 3 requests" }));
  // Approving is not destructive, so the confirm button uses the primary style.
  expect(screen.getByRole("button", { name: "Approve 3" }).className).toContain("bg-moss");
  await userEvent.click(screen.getByRole("button", { name: "Approve 3" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Approved 3."));
  expect(state.resolveWorkflow.mock.calls.map(c => c[0])).toEqual([
    { runId: "run-node", nodeId: "node-node", body: { approved: true, iteration: 2 } },
    { runId: "run-policy", nodeId: "node-policy", body: { approved: true, scope: "once", iteration: undefined } },
  ]);
  expect(state.resolveDecision.mock.calls.map(c => c[0])).toEqual([{ sessionId: "session-a", gateId: "a", body: { actionId: "approve" } }]);
  expect(screen.getByRole("status")).toBe(document.activeElement);
});

it("denies each listed item through its own endpoint", async () => {
  state.workflows = [workflow("policy", { kind: "policy_gate", service: "github", action: "create_issue", iteration: 1 })];
  state.decisions = [decision("a")];
  await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Deny all 2 requests" }));
  await userEvent.click(screen.getByRole("button", { name: "Deny 2" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Denied 2."));
  expect(state.resolveWorkflow.mock.calls.map(c => c[0])).toEqual([{ runId: "run-policy", nodeId: "node-policy", body: { approved: false, iteration: 1 } }]);
  expect(state.resolveDecision.mock.calls.map(c => c[0])).toEqual([{ sessionId: "session-a", gateId: "a", body: { actionId: "deny" } }]);
});

it("keeps going after a failure and names the failed request", async () => {
  state.decisions = [decision("a"), decision("b"), decision("c")];
  state.resolveDecision.mockImplementation(async ({ gateId }: { gateId: string }) => {
    if (gateId === "b") throw new ApiError(403, "POST → 403", { error: "Only the session owner can resolve this approval." });
    removeDecision(gateId);
    return { ok: true };
  });
  await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Approve all 3 requests" }));
  await userEvent.click(screen.getByRole("button", { name: "Approve 3" }));
  await waitFor(() => expect(screen.getByRole("status").textContent)
    .toBe("Approved 2. 1 failed: Approve b?: Only the session owner can resolve this approval."));
  expect(state.resolveDecision).toHaveBeenCalledTimes(3);
});

it("reports a request that is gone as no longer waiting, not answered or failed", async () => {
  state.decisions = [decision("a"), decision("gone")];
  state.workflows = [workflow("raced")];
  state.resolveDecision.mockImplementation(async ({ gateId }: { gateId: string }) => {
    removeDecision(gateId);
    if (gateId === "gone") throw new ApiError(404, "POST → 404", { error: "gate not pending" });
    return { ok: true };
  });
  state.resolveWorkflow.mockImplementation(async ({ runId }: { runId: string }) => {
    removeWorkflow(runId);
    throw new ApiError(409, "POST → 409", { error: "this approval gate has already been resolved" });
  });
  await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Deny all 3 requests" }));
  await userEvent.click(screen.getByRole("button", { name: "Deny 3" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Denied 1. 2 were no longer waiting."));
});

it("reports a request that the refetched list still shows as still waiting", async () => {
  state.workflows = [workflow("first", { iteration: 0 }), workflow("second")];
  // The server answers 409 for the second gate, but the run still waits on it.
  state.resolveWorkflow.mockImplementation(async ({ runId }: { runId: string }) => {
    if (runId === "run-second") throw new ApiError(409, "POST → 409", { error: "run is not parked on this approval gate" });
    removeWorkflow(runId);
    return { ok: true };
  });
  await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Approve all 2 requests" }));
  await userEvent.click(screen.getByRole("button", { name: "Approve 2" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Approved 1. 1 still waiting: Workflow second: Ship second?"));
  expect(state.refetchWorkflows).toHaveBeenCalled();
  expect(state.refetchDecisions).toHaveBeenCalledWith(undefined);
});

it("covers only the listed page when more approvals exist", async () => {
  state.decisions = [decision("a"), decision("q", { type: "question" })];
  state.nextCursor = "sealed-cursor";
  state.nextPage = [decision("unseen")];
  await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Approve 1 listed request" }));
  const dialog = screen.getByRole("dialog", { name: "Approve 1 request?" });
  expect(dialog.textContent).toContain("This covers only the requests listed in the bell. Other pages are not included.");
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve 1" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Approved 1."));
  expect(state.resolveDecision.mock.calls.map(c => c[0].gateId)).toEqual(["a"]);
});

it("keeps a run, its progress, and its summary when the bell closes and reopens", async () => {
  state.decisions = [decision("a"), decision("b")];
  const settle: Array<() => void> = [];
  state.resolveDecision.mockImplementation(({ gateId }: { gateId: string }) =>
    new Promise(resolve => settle.push(() => { removeDecision(gateId); resolve({ ok: true }); })));
  await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Approve all 2 requests" }));
  await userEvent.click(screen.getByRole("button", { name: "Approve 2" }));
  await waitFor(() => expect(settle).toHaveLength(2));
  await userEvent.click(screen.getByRole("button", { name: "Close notifications" }));
  await userEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
  expect(screen.getByRole("status").textContent).toBe("Approving 1 of 2…");
  expect(screen.getByRole("button", { name: "Approve all 2 requests" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Deny all 2 requests" })).toHaveProperty("disabled", true);
  settle.forEach(done => done());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Approved 2."));
  expect(state.resolveDecision.mock.calls.map(c => c[0].gateId)).toEqual(["a", "b"]);
});

it("answers the items listed when the dialog opened, not items that arrive later", async () => {
  state.decisions = [decision("a")];
  const { rerender } = await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Approve all 1 request" }));
  state.decisions = [decision("a"), decision("late")];
  rerender(<NotificationsBell />);
  await userEvent.click(screen.getByRole("button", { name: "Approve 1" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Approved 1."));
  expect(state.resolveDecision.mock.calls.map(c => c[0].gateId)).toEqual(["a"]);
});

it("clears a settled summary when the bell closes", async () => {
  state.decisions = [decision("a")];
  await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Approve all 1 request" }));
  await userEvent.click(screen.getByRole("button", { name: "Approve 1" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Approved 1."));
  await userEvent.click(screen.getByRole("button", { name: "Close notifications" }));
  await userEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
  expect(screen.getByRole("status").textContent).toBe("");
});

it("labels the buttons by the listed count on a later page", async () => {
  state.decisions = [decision("a")];
  state.nextCursor = "sealed-cursor";
  state.nextPage = [decision("b"), decision("c")];
  await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Next approvals" }));
  await userEvent.click(screen.getByRole("button", { name: "Deny 2 listed requests" }));
  const dialog = screen.getByRole("dialog", { name: "Deny 2 requests?" });
  expect(dialog.textContent).toContain("Other pages are not included.");
  // Denying is destructive, so its confirm button keeps the danger style.
  expect(within(dialog).getByRole("button", { name: "Deny 2" }).className).toContain("bg-danger-600");
});

it("returns focus to the button that opened the dialog after Cancel", async () => {
  state.decisions = [decision("a")];
  await openBell();
  const trigger = screen.getByRole("button", { name: "Deny all 1 request" });
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("says what approval does for tool actions and for workflow steps", async () => {
  state.workflows = [workflow("node")];
  state.decisions = [decision("a")];
  await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Approve all 2 requests" }));
  const text = screen.getByRole("dialog", { name: "Approve 2 requests?" }).textContent;
  expect(text).toContain("Each tool action runs once. Valet saves no rule and allows no later calls.");
  expect(text).toContain("Each workflow approval lets its run continue to the next steps.");
  expect(text).not.toContain("does not save a rule or allow later calls");
});
