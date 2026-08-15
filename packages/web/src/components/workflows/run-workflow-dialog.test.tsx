// @vitest-environment jsdom
/**
 * Run dialog: renders one field per trigger dataSchema entry, pre-fills
 * declared defaults, blocks submit while a required field is empty, and
 * submits typed values (number stays a number, boolean a boolean) through
 * `useStartRun`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { WorkflowInputDefinition } from "@valet/workflow";
import { RunWorkflowDialog } from "./run-workflow-dialog";

const mutateAsync = vi.fn();

vi.mock("~/api/workflows", () => ({
  useStartRun: () => ({ mutateAsync, isPending: false }),
}));

const schema: Record<string, WorkflowInputDefinition> = {
  name: { type: "string", required: true, description: "Deployment name" },
  retries: { type: "number", default: 3 },
  dryRun: { type: "boolean", default: true },
  mode: { type: "string", enum: ["fast", "safe"], default: "safe" },
};

function renderDialog(onStarted = vi.fn()) {
  render(
    <RunWorkflowDialog
      workflowId="wf_1"
      workflowName="deploy-thing"
      schema={schema}
      open
      onOpenChange={() => {}}
      onStarted={onStarted}
    />,
  );
  return onStarted;
}

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ runId: "wfrun_test" });
});

describe("RunWorkflowDialog", () => {
  it("renders a field per schema entry with defaults pre-filled", () => {
    renderDialog();
    expect(screen.getByLabelText(/name/i)).toBeTruthy();
    const retries = screen.getByLabelText(/retries/i) as HTMLInputElement;
    expect(retries.value).toBe("3");
    const dryRun = screen.getByLabelText(/dryRun/i) as HTMLInputElement;
    expect(dryRun.checked).toBe(true);
    const mode = screen.getByLabelText(/mode/i) as HTMLSelectElement;
    expect(mode.value).toBe("safe");
  });

  it("shows the field description as help text", () => {
    renderDialog();
    expect(screen.getByText("Deployment name")).toBeTruthy();
  });

  it("blocks submit and names the missing required field", async () => {
    const onStarted = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => {
      expect(screen.getByText(/name/i, { selector: "[role=alert]" })).toBeTruthy();
    });
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("submits typed values and reports the started run", async () => {
    const onStarted = renderDialog();
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "deploy" } });
    fireEvent.change(screen.getByLabelText(/retries/i), { target: { value: "5" } });
    fireEvent.click(screen.getByLabelText(/dryRun/i));
    fireEvent.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({
      name: "deploy",
      retries: 5,
      dryRun: false,
      mode: "safe",
    });
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("wfrun_test"));
  });
});
