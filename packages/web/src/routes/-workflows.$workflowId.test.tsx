// @vitest-environment jsdom
/**
 * `/workflows/$workflowId` editor page (plan decision 11): loads the
 * fetched definition into the `Editor` (Task 8-10), Save fires the update
 * mutation with the edited definition, and Run starts a run then navigates
 * to its detail page. `WorkflowEditorPage` takes `workflowId` as a plain
 * prop (the route component just forwards `Route.useParams()`), so this
 * renders it directly without exercising the router's param matching —
 * `<Link>`/`useNavigate` are still mocked since the page renders a back
 * link and calls `useNavigate` on Run.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const navigate = vi.fn();
const updateMutateAsync = vi.fn().mockResolvedValue({});
const startMutateAsync = vi.fn().mockResolvedValue({ runId: "wfrun_1" });

const workflowData = {
  id: "wf_1",
  name: "Deploy pipeline",
  definition: {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "stop", type: "stop", outcome: "success" },
    ],
    edges: [{ from: "trigger", to: "stop" }],
  },
  createdAt: 1,
  updatedAt: 1,
};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/workflows", () => ({
  useWorkflow: () => ({ data: workflowData, isLoading: false, error: null }),
  useUpdateWorkflow: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
  useStartRun: () => ({ mutateAsync: startMutateAsync, isPending: false }),
  useWorkflowRuns: () => ({ data: { runs: [{ runId: "wfrun_0", workflowId: "wf_1", status: "settled", outcome: "completed", createdAt: 1, updatedAt: 1 }] }, isLoading: false }),
}));

import { WorkflowEditorPage } from "./workflows.$workflowId";

describe("WorkflowEditorPage", () => {
  it("loads the fetched definition into the editor", () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);
    expect(screen.getByTestId("workflow-editor")).toBeTruthy();
    expect(screen.getByText("Deploy pipeline")).toBeTruthy();
  });

  it("Save fires the update mutation with the edited definition", async () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Edit JSON" }));
    const textarea = screen.getByLabelText("Definition (JSON)") as HTMLTextAreaElement;
    const updatedText = textarea.value.replace('"Deploy pipeline"', '"Deploy pipeline"').replace(
      '"outcome": "success"',
      '"outcome": "failure"',
    );
    fireEvent.change(textarea, { target: { value: updatedText } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));

    const saveButton = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const call = updateMutateAsync.mock.calls[0]![0] as {
      definition: { nodes: Array<{ id: string; outcome?: string }> };
    };
    const stop = call.definition.nodes.find((n) => n.id === "stop");
    expect(stop?.outcome).toBe("failure");
  });

  it("starts a run and navigates to the run detail page when Run is clicked", async () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(startMutateAsync).toHaveBeenCalled());
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/workflows/runs/$runId",
        params: { runId: "wfrun_1" },
      }),
    );
  });

  it("lists runs in the collapsible runs section once expanded", () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);
    fireEvent.click(screen.getByRole("button", { name: /Runs/ }));
    expect(screen.getByText("wfrun_0")).toBeTruthy();
  });
});
