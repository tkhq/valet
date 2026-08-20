// @vitest-environment jsdom
/**
 * `LatestRunLine` — the settled result on the workflow row. The component's
 * one job is choosing what one line says: the stop message for a settled
 * run, the empty-state phrase when the run recorded nothing, and a status
 * word (with no detail fetch) while a run is still moving.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorkflowRunSummary } from "@valet/api/wire";

const useRunDetail = vi.fn();

vi.mock("~/api/workflows", () => ({
  useRunDetail: (runId: string, opts?: { enabled?: boolean }) => useRunDetail(runId, opts),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { LatestRunLine } from "./latest-run-line";

const NOW = Date.now();

function summary(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    runId: "wfrun_1",
    workflowId: "wf_1",
    status: "settled",
    outcome: "completed",
    createdAt: NOW - 34_000,
    updatedAt: NOW - 10_000,
    ...over,
  };
}

/** A settled detail payload whose stop checkpoint carries `message`. */
function detailWithMessage(message?: string) {
  return {
    data: {
      run: {
        status: "settled",
        outcome: "completed",
        definition: { nodes: [{ id: "stop", type: "stop" }], edges: [] },
      },
      checkpoints: [
        {
          nodeId: "stop",
          iteration: 0,
          status: "completed",
          result: message === undefined ? {} : { message },
          createdAt: NOW,
        },
      ],
    },
    isLoading: false,
  };
}

describe("LatestRunLine", () => {
  it("shows the stop node's message with when and how long", () => {
    useRunDetail.mockReturnValue(detailWithMessage("Summarized 14 PRs; 3 need review"));
    render(<LatestRunLine run={summary()} />);

    expect(screen.getByText("Summarized 14 PRs; 3 need review")).toBeTruthy();
    expect(screen.getByText(/just now · 24\.0s/)).toBeTruthy();
    expect(screen.getByText("✓")).toBeTruthy();
  });

  it("names the empty state instead of rendering a blank line", () => {
    useRunDetail.mockReturnValue(detailWithMessage(undefined));
    render(<LatestRunLine run={summary()} />);

    expect(screen.getByText("Finished without a result message")).toBeTruthy();
  });

  it("links to the run's detail page", () => {
    useRunDetail.mockReturnValue(detailWithMessage("done"));
    render(<LatestRunLine run={summary()} />);

    const link = screen.getByText("done").closest("a");
    expect(link?.getAttribute("to")).toBe("/workflows/runs/$runId");
  });

  it("does not fetch detail for a run still in flight, and says its status", () => {
    useRunDetail.mockReturnValue({ data: undefined, isLoading: false });
    render(<LatestRunLine run={summary({ status: "running", outcome: undefined })} />);

    expect(useRunDetail).toHaveBeenCalledWith("wfrun_1", { enabled: false });
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("says a parked run is waiting for approval when the summary flags it", () => {
    useRunDetail.mockReturnValue({ data: undefined, isLoading: false });
    render(
      <LatestRunLine
        run={summary({ status: "parked", outcome: undefined, needsApproval: true })}
      />,
    );

    expect(screen.getByText("Waiting for approval")).toBeTruthy();
  });

  it("keeps the failed glyph honest while detail is still loading", () => {
    useRunDetail.mockReturnValue({ data: undefined, isLoading: true });
    render(<LatestRunLine run={summary({ outcome: "failed" })} />);

    expect(screen.getByText("✕")).toBeTruthy();
    expect(screen.getByText("…")).toBeTruthy();
  });
});
