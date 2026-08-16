// @vitest-environment jsdom
/**
 * `/workflows` definitions list (plan decision 11): each row's name links
 * to `/workflows/$workflowId` (the editor), Run starts a run and navigates
 * to the run detail page, and "New workflow" opens `NewWorkflowDialog`
 * (review fix 1), which POSTs the entered name + a minimal trigger→stop
 * definition then navigates to its editor page. `<Link>`/`useNavigate` need
 * router context — mocked the same way `thread-tree-new-thread.test.tsx`
 * does, since this suite only cares that navigation was requested, not
 * that the router actually resolved it.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const workflowsData = {
  workflows: [
    { id: "wf_1", name: "Deploy pipeline", definition: {}, createdAt: 1, updatedAt: 1 },
    { id: "wf_2", name: "Nightly digest", definition: {}, createdAt: 2, updatedAt: 2 },
  ],
};

const triggersData = {
  triggers: [
    {
      kind: "schedule" as const,
      id: "sched_1",
      workflowId: "wf_1",
      name: "Nightly build",
      enabled: true,
      detail: {
        cron: "0 2 * * *",
        timezone: "UTC",
        targetKind: "workflow" as const,
        nextFireAt: Date.now() + 86400000,
        lastFiredAt: null,
      },
    },
  ],
};

const allRunsData = {
  runs: [
    {
      runId: "wfrun_1",
      workflowId: "wf_1",
      workflowName: "Deploy pipeline",
      status: "settled" as const,
      outcome: "completed" as const,
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 5000,
    },
  ],
};

let searchState: Record<string, unknown> = {};

const navigate = vi.fn();
const startMutateAsync = vi.fn().mockResolvedValue({ runId: "wfrun_new" });
const createMutateAsync = vi.fn().mockResolvedValue({
  id: "wf_new",
  name: "My new workflow",
  definition: { version: "dag/v1", nodes: [], edges: [] },
  createdAt: 1,
  updatedAt: 1,
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
  useSearch: () => searchState,
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: workflowsData, isLoading: false, error: null }),
  useWorkflowRuns: () => ({ data: { runs: [] }, isLoading: false }),
  useStartRun: () => ({ mutateAsync: startMutateAsync, isPending: false }),
  useCreateWorkflow: () => ({ mutateAsync: createMutateAsync, isPending: false, error: null }),
  useDeleteWorkflow: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useWorkflowTriggers: () => ({ data: triggersData, isLoading: false, error: null }),
  useAllWorkflowRuns: () => ({ data: allRunsData, isLoading: false, error: null }),
  useUpdateSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateEventTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteEventTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRunScheduleNow: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTriggerCatalog: () => ({ data: { catalog: [] }, isLoading: false, error: null }),
  useCreateSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateEventTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { WorkflowsIndexPage } from "./workflows.index";

describe("WorkflowsIndexPage", () => {
  it("renders each workflow definition's name as a link to its editor page", () => {
    searchState = {};
    render(<WorkflowsIndexPage />);
    const link = screen.getByText("Deploy pipeline").closest("a");
    expect(link?.getAttribute("href") ?? link?.getAttribute("to")).toBeTruthy();
    expect(screen.getByText("Nightly digest")).toBeTruthy();
  });

  it("starts a run and navigates to the run detail page when Run is clicked", async () => {
    searchState = {};
    render(<WorkflowsIndexPage />);
    const runButtons = screen.getAllByRole("button", { name: "Run" });
    fireEvent.click(runButtons[0]);

    await waitFor(() => expect(startMutateAsync).toHaveBeenCalled());
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/workflows/runs/$runId",
        params: { runId: "wfrun_new" },
      }),
    );
  });

  it("opens the New workflow dialog, defaults the name field, and posts the entered name on Create", async () => {
    searchState = {};
    render(<WorkflowsIndexPage />);
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));

    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.value).toBe("Untitled workflow");
    fireEvent.change(nameInput, { target: { value: "My new workflow" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const call = createMutateAsync.mock.calls[0]![0] as {
      name: string;
      definition: { nodes: Array<{ id: string; type: string }>; edges: Array<{ from: string; to: string }> };
    };
    expect(call.name).toBe("My new workflow");
    expect(call.definition.nodes.map((n) => n.type)).toEqual(["trigger", "stop"]);
    expect(call.definition.edges).toEqual([{ from: "trigger", to: "stop" }]);

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_new" },
      }),
    );
  });

  it("shows the Workflows tab by default with per-workflow trigger badges", () => {
    searchState = {};
    render(<WorkflowsIndexPage />);
    expect(screen.getByText("Deploy pipeline")).toBeTruthy();
    expect(screen.getByLabelText(/1 schedule/)).toBeTruthy();
  });

  it("renders the Runs tab from the global runs feed", () => {
    searchState = { tab: "runs" };
    render(<WorkflowsIndexPage />);
    expect(screen.getByText("Deploy pipeline")).toBeTruthy(); // workflowName column
    expect(screen.getByText("completed")).toBeTruthy(); // RunStatusChip label
  });

  it("renders the Triggers tab with the unified list", () => {
    searchState = { tab: "triggers" };
    render(<WorkflowsIndexPage />);
    expect(screen.getByText("Nightly build")).toBeTruthy();
  });

  it("tab buttons navigate via search params", () => {
    searchState = {};
    render(<WorkflowsIndexPage />);
    fireEvent.click(screen.getByRole("tab", { name: /Triggers/ }));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { tab: "triggers" } }));
  });
});
