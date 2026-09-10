// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionGate } from "@valet/api/wire";
import { WorkflowAgentApprovals } from "./agent-approvals";

const state = vi.hoisted(() => {
  const gates: DecisionGate[] = [];
  return { gates, loading: false, error: false };
});
vi.mock("~/api/queries", async (original) => ({
  ...await original<typeof import("~/api/queries")>(),
  useDecisions: () => ({ data: { gates: state.gates }, isLoading: state.loading, error: state.error }),
}));
vi.mock("~/api/workflows", async (original) => ({
  ...await original<typeof import("~/api/workflows")>(), useRunDetail: () => ({ data: undefined }),
}));
vi.mock("~/lib/workspace-scope", async (original) => ({
  ...await original<typeof import("~/lib/workspace-scope")>(), useAdoptWorkspaceScope: () => {},
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/components/session/decision-gate-card", () => ({
  DecisionGateCard: ({ gate }: { gate: DecisionGate }) => <div>{gate.title}</div>,
}));

beforeEach(() => { state.gates = []; state.loading = false; state.error = false; });
function gate(status: DecisionGate["status"]): DecisionGate {
  return { id: status, sessionId: "wf:run:triage", threadId: "thread", type: "approval", title: status,
    status, createdAt: 1, updatedAt: 1, actions: [{ id: "approve", label: "Approve" }] };
}
describe("WorkflowAgentApprovals", () => {
  it("shows only pending gates, including gates outside the default thread", () => {
    state.gates = [gate("pending"), gate("resolved"), gate("withdrawn")];
    render(<WorkflowAgentApprovals sessionId="wf:run:triage" />);
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.queryByText("resolved")).toBeNull();
    expect(screen.queryByText("withdrawn")).toBeNull();
  });
  it("shows a useful destination after the gate settles", () => {
    state.gates = [gate("resolved")];
    render(<WorkflowAgentApprovals sessionId="wf:run:triage" />);
    expect(screen.getByText(/No pending approvals/)).toBeTruthy();
    expect(screen.getByText("Open workflow run")).toBeTruthy();
  });
  it("explains access failures", () => {
    state.error = true;
    render(<WorkflowAgentApprovals sessionId="wf:run:triage" />);
    expect(screen.getByRole("alert").textContent).toContain("Check your access");
  });
});
