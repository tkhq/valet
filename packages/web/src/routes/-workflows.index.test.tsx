// @vitest-environment jsdom
/**
 * `/workflows` definitions list (plan decision 19): renders each
 * definition's name and clicking "Run" fires `useStartRun`'s mutation. The
 * row's inline run list stays collapsed by default (no `<Link>` render), so
 * this doesn't need router context.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const workflowsData = {
  workflows: [
    { id: "wf_1", name: "Deploy pipeline", definition: {}, createdAt: 1, updatedAt: 1 },
    { id: "wf_2", name: "Nightly digest", definition: {}, createdAt: 2, updatedAt: 2 },
  ],
};

const startMutate = vi.fn();

vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: workflowsData, isLoading: false, error: null }),
  useWorkflowRuns: () => ({ data: { runs: [] }, isLoading: false }),
  useStartRun: () => ({ mutate: startMutate, isPending: false }),
  useCreateWorkflow: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateWorkflow: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { WorkflowsIndexPage } from "./workflows.index";

describe("WorkflowsIndexPage", () => {
  it("renders each workflow definition's name", () => {
    render(<WorkflowsIndexPage />);
    expect(screen.getByText("Deploy pipeline")).toBeTruthy();
    expect(screen.getByText("Nightly digest")).toBeTruthy();
  });

  it("fires the start-run mutation when Run is clicked", () => {
    render(<WorkflowsIndexPage />);
    const runButtons = screen.getAllByRole("button", { name: "Run" });
    fireEvent.click(runButtons[0]);
    expect(startMutate).toHaveBeenCalled();
  });

  it("opens the create form with a name input and definition textarea", () => {
    render(<WorkflowsIndexPage />);
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    expect(screen.getByPlaceholderText("Workflow name")).toBeTruthy();
    expect(screen.getByPlaceholderText(/version.*dag\/v1/)).toBeTruthy();
  });
});
