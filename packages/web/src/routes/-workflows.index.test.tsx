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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const workflowsData: {
  workflows: Array<{
    id: string;
    name: string;
    definition: unknown;
    createdAt: number;
    updatedAt: number;
  }>;
} = {
  workflows: [
    { id: "wf_1", name: "Deploy pipeline", definition: {}, createdAt: 1, updatedAt: 1 },
    { id: "wf_2", name: "Nightly digest", definition: {}, createdAt: 2, updatedAt: 2 },
  ],
};

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
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: workflowsData, isLoading: false, error: null }),
  useWorkflowRuns: () => ({ data: { runs: [] }, isLoading: false }),
  useStartRun: () => ({ mutateAsync: startMutateAsync, isPending: false }),
  useCreateWorkflow: () => ({ mutateAsync: createMutateAsync, isPending: false, error: null }),
  useDeleteWorkflow: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The gallery has its own suite; here it only has to be identifiable, so the
// page's placement rule can be asserted without a second templates fixture.
vi.mock("~/components/workflows/template-gallery", () => ({
  TemplateGallery: () => <div data-testid="template-gallery" />,
}));

import { WorkflowsIndexPage } from "./workflows.index";

const populated = [...workflowsData.workflows];

beforeEach(() => {
  workflowsData.workflows = [...populated];
});

describe("WorkflowsIndexPage", () => {
  it("renders each workflow definition's name as a link to its editor page", () => {
    render(<WorkflowsIndexPage />);
    const link = screen.getByText("Deploy pipeline").closest("a");
    expect(link?.getAttribute("href") ?? link?.getAttribute("to")).toBeTruthy();
    expect(screen.getByText("Nightly digest")).toBeTruthy();
  });

  it("starts a run and navigates to the run detail page when Run is clicked", async () => {
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

  it("puts templates behind a tab so an existing list stays the page", () => {
    render(<WorkflowsIndexPage />);

    expect(screen.getByText("Deploy pipeline")).toBeTruthy();
    expect(screen.queryByTestId("template-gallery")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));

    expect(screen.getByTestId("template-gallery")).toBeTruthy();
    expect(screen.queryByText("Deploy pipeline")).toBeNull();
  });

  it("makes the gallery the whole page when there are no workflows", () => {
    workflowsData.workflows = [];
    render(<WorkflowsIndexPage />);

    expect(screen.getByTestId("template-gallery")).toBeTruthy();
    // No tabs: with nothing to list, a "Your workflows" tab is chrome over
    // an empty list.
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByText(/no workflows yet/i)).toBeTruthy();
  });
});
