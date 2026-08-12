// @vitest-environment jsdom
/**
 * `/workflows/runs/$runId` body rendering (plan decision 19): a parked run
 * waiting on an approval signal shows the approval card; a settled run
 * hides the Cancel button. `RunDetailBody` is props-driven (see
 * `workflows.runs.$runId.tsx`) so this renders it directly without router
 * wiring — only `ApprovalCard`'s `useResolveApproval` needs mocking.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WorkflowRunDetail } from "@valet/api/wire";
import { RunDetailBody } from "./workflows.runs.$runId";

vi.mock("~/api/workflows", () => ({
  useResolveApproval: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

function baseRun(overrides: Partial<WorkflowRunDetail["run"]> = {}): WorkflowRunDetail {
  return {
    run: {
      runId: "wfrun_1",
      workflowId: "wf_1",
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      waitingOn: [],
      definition: { version: "dag/v1", nodes: [], edges: [] },
      params: {},
      ...overrides,
    },
    checkpoints: [],
  };
}

describe("RunDetailBody", () => {
  it("shows the approval card when parked on an approval signal", () => {
    const data = baseRun({
      status: "parked",
      waitingOn: [{ kind: "signal", nodeId: "deploy", signalType: "approval:deploy" }],
      definition: {
        version: "dag/v1",
        nodes: [{ id: "deploy", type: "approval", prompt: "Ship it?" }],
        edges: [],
      },
    });
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} />);
    expect(screen.getByText("Ship it?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("does not show the approval card when parked on a timer", () => {
    const data = baseRun({
      status: "parked",
      waitingOn: [{ kind: "timer", nodeId: "wait1", wakeAt: Date.now() }],
    });
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows the Cancel button while the run is non-terminal", () => {
    const data = baseRun({ status: "running" });
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} />);
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeTruthy();
  });

  it("hides the Cancel button once the run has settled", () => {
    const data = baseRun({ status: "settled", outcome: "completed" });
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} />);
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    expect(screen.getByText("completed")).toBeTruthy();
  });

  it("renders checkpoints with status and a result preview", () => {
    const data = baseRun({ status: "settled", outcome: "completed" });
    data.checkpoints = [
      { nodeId: "set1", iteration: 0, status: "completed", result: { ok: true }, createdAt: Date.now() },
    ];
    render(<RunDetailBody runId="wfrun_1" data={data} onCancel={vi.fn()} cancelPending={false} />);
    expect(screen.getByText("set1")).toBeTruthy();
    expect(screen.getByText(/"ok": true/)).toBeTruthy();
  });
});
