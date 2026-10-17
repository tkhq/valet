// @vitest-environment jsdom
/**
 * The `/workflows/runs` view (spec Part G step 1): every workflow run of
 * the workspace the switcher names, newest first, each linked to its run
 * page, with a pager when the list has more pages.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ListAllWorkflowRunsResponse } from "@valet/api/wire";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params, to }: { children: ReactNode; params?: unknown; to: string }) => (
    <a data-to={to} data-params={JSON.stringify(params)}>{children}</a>
  ),
  createFileRoute: () => (config: unknown) => config,
}));

let owner: { ownerType: "user" | "team"; ownerId: string } | undefined = { ownerType: "user", ownerId: "u1" };
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));

let page: ListAllWorkflowRunsResponse = { runs: [] };
const runsFor = vi.fn();
vi.mock("~/api/workflows", () => ({
  useAllWorkflowRuns: (...args: unknown[]) => {
    runsFor(...args);
    return { data: page, isPending: false, isError: false, isSuccess: true, error: null };
  },
}));

import { RunsTab } from "./workflows.runs.index";

beforeEach(() => {
  owner = { ownerType: "user", ownerId: "u1" };
  page = { runs: [] };
  runsFor.mockClear();
});

describe("RunsTab", () => {
  it("lists the workspace's runs, each linked to its run page", () => {
    page = {
      runs: [
        { runId: "wfrun_1", workflowId: "wf_1", workflowName: "Deploy pipeline", status: "settled", outcome: "completed", createdAt: 1, updatedAt: 1 },
      ],
    };
    render(<RunsTab />);
    expect(runsFor).toHaveBeenCalledWith(owner, undefined, { enabled: true });
    const link = screen.getByText("Deploy pipeline").closest("a");
    expect(link?.getAttribute("data-to")).toBe("/workflows/runs/$runId");
    expect(link?.getAttribute("data-params")).toBe(JSON.stringify({ runId: "wfrun_1" }));
    expect(screen.getByText("wfrun_1")).toBeTruthy();
  });

  it("says so when the workspace has no runs", () => {
    render(<RunsTab />);
    expect(screen.getByText(/No runs yet/)).toBeTruthy();
  });

  it("pages forward with the cursor the list returned", () => {
    page = {
      runs: [
        { runId: "wfrun_1", workflowId: "wf_1", workflowName: "Deploy pipeline", status: "running", createdAt: 1, updatedAt: 1 },
      ],
      nextCursor: "1:wfrun_1",
    };
    render(<RunsTab />);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(runsFor).toHaveBeenLastCalledWith(owner, { cursor: "1:wfrun_1" }, { enabled: true });
  });

  it("waits for the switcher's workspace before it reads", () => {
    owner = undefined;
    render(<RunsTab />);
    expect(runsFor).toHaveBeenCalledWith(undefined, undefined, { enabled: false });
  });
});
