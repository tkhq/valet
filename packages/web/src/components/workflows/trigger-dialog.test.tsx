// @vitest-environment jsdom
/**
 * TriggerDialog — creates schedules and event triggers, shows server errors
 * verbatim, and picks event keys from the catalog.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const createScheduleMutateAsync = vi.fn().mockResolvedValue({});
const createEventTriggerMutateAsync = vi.fn().mockResolvedValue({});
const updateScheduleMutateAsync = vi.fn().mockResolvedValue({});
const updateEventMutateAsync = vi.fn().mockResolvedValue({});

vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: { workflows: [] }, isLoading: false }),
  useCreateSchedule: () => ({
    mutateAsync: createScheduleMutateAsync,
    isPending: false,
    error: null,
  }),
  useCreateEventTrigger: () => ({
    mutateAsync: createEventTriggerMutateAsync,
    isPending: false,
    error: null,
  }),
  useUpdateSchedule: () => ({
    mutateAsync: updateScheduleMutateAsync,
    isPending: false,
    error: null,
  }),
  useUpdateEventTrigger: () => ({
    mutateAsync: updateEventMutateAsync,
    isPending: false,
    error: null,
  }),
  useTriggerCatalog: () => ({
    data: {
      catalog: [
        {
          service: "github",
          entries: [
            {
              key: "github.pull_request.opened",
              description: "A pull request was opened",
              filters: [{ field: "branch", description: "Base branch" }],
            },
          ],
        },
      ],
    },
  }),
  useWorkflowTriggers: () => ({ data: { triggers: [] }, isLoading: false, error: null }),
}));

import { TriggerDialog } from "./trigger-dialog";

describe("TriggerDialog", () => {
  it("creates an orchestrator schedule from the form", async () => {
    createScheduleMutateAsync.mockClear().mockResolvedValue({});
    render(<TriggerDialog open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText(/^Schedule$/));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "digest" } });
    fireEvent.change(screen.getByLabelText(/cron/i), { target: { value: "0 9 * * *" } });
    fireEvent.click(screen.getByLabelText(/orchestrator/i));
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "summarize" } });
    fireEvent.click(screen.getByText(/^Create$/));
    await waitFor(() =>
      expect(createScheduleMutateAsync).toHaveBeenCalledWith({
        name: "digest",
        cron: "0 9 * * *",
        timezone: expect.any(String),
        target: { kind: "orchestrator", prompt: "summarize" },
      }),
    );
  });

  it("shows the server's corrective error on failure", async () => {
    createScheduleMutateAsync
      .mockClear()
      .mockRejectedValueOnce(
        new Error('invalid cron "x". Use 5 fields, for example "0 9 * * 1-5".'),
      );
    // Provide workflowId prop so the client-side workflow-required check is bypassed.
    render(<TriggerDialog open onOpenChange={() => {}} workflowId="wf_test" />);
    fireEvent.click(screen.getByText(/^Schedule$/));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "bad" } });
    fireEvent.change(screen.getByLabelText(/cron/i), { target: { value: "x" } });
    fireEvent.click(screen.getByText(/^Create$/));
    await waitFor(() => expect(screen.getByText(/Use 5 fields/)).toBeTruthy());
  });

  it("disables the workflow select when editing a schedule trigger", async () => {
    const editingSchedule = {
      kind: "schedule" as const,
      id: "sch_edit",
      workflowId: "wf_existing",
      name: "digest",
      enabled: true,
      detail: {
        cron: "0 9 * * *",
        timezone: "UTC",
        targetKind: "workflow" as const,
        nextFireAt: Date.now() + 3_600_000,
        lastFiredAt: null,
      },
    };
    render(<TriggerDialog open onOpenChange={() => {}} editing={editingSchedule} />);
    const select = screen.getByLabelText(/workflow/i) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it("disables the workflow select when editing an event trigger", async () => {
    const editingEvent = {
      kind: "event" as const,
      id: "ev_edit",
      workflowId: "wf_existing",
      name: "on pr",
      enabled: true,
      detail: {
        eventKeys: ["github.pull_request.opened"],
        filters: [],
      },
    };
    render(<TriggerDialog open onOpenChange={() => {}} editing={editingEvent} />);
    const select = screen.getByLabelText(/workflow/i) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it("creates an event trigger with a catalog-picked key", async () => {
    createEventTriggerMutateAsync.mockClear().mockResolvedValue({});
    render(<TriggerDialog open onOpenChange={() => {}} workflowId="wf_1" />);
    fireEvent.click(screen.getByText(/^Event$/));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "on pr" } });
    fireEvent.change(screen.getByLabelText(/event/i), {
      target: { value: "github.pull_request.opened" },
    });
    fireEvent.click(screen.getByText(/^Create$/));
    await waitFor(() =>
      expect(createEventTriggerMutateAsync).toHaveBeenCalledWith({
        workflowId: "wf_1",
        name: "on pr",
        eventKeys: ["github.pull_request.opened"],
        filters: [],
      }),
    );
  });

  // ── Item 3: workflow-required check ─────────────────────────────────────

  it("shows 'Select a workflow.' error and skips create mutation when no workflow is selected (schedule + workflow target)", async () => {
    createScheduleMutateAsync.mockClear();
    // No workflowId prop — dialog shows the workflow select. Leave it empty.
    render(<TriggerDialog open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText(/^Schedule$/));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "no wf" } });
    fireEvent.change(screen.getByLabelText(/cron/i), { target: { value: "0 9 * * *" } });
    // targetKind defaults to "workflow" and no workflow is selected.
    fireEvent.click(screen.getByText(/^Create$/));
    await waitFor(() => expect(screen.getByText("Select a workflow.")).toBeTruthy());
    expect(createScheduleMutateAsync).not.toHaveBeenCalled();
  });

  it("builds a filter from the picker on create", async () => {
    createEventTriggerMutateAsync.mockClear().mockResolvedValue({});
    render(<TriggerDialog open onOpenChange={() => {}} workflowId="wf_1" />);
    fireEvent.click(screen.getByText(/^Event$/));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "on pr" } });
    fireEvent.change(screen.getByLabelText(/event/i), {
      target: { value: "github.pull_request.opened" },
    });
    // Add one filter row (field defaults to the event's first field: branch),
    // then type a value.
    fireEvent.click(screen.getByText(/^Add filter$/));
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "main" } });
    fireEvent.click(screen.getByText(/^Create$/));
    await waitFor(() =>
      expect(createEventTriggerMutateAsync).toHaveBeenCalledWith({
        workflowId: "wf_1",
        name: "on pr",
        eventKeys: ["github.pull_request.opened"],
        filters: [{ field: "branch", op: "eq", value: "main" }],
      }),
    );
  });

  // ── Item 4: removing the last filter row on EDIT clears the stored value ──

  it("sends filters: [] when the pre-filled filter row is removed on EDIT", async () => {
    updateEventMutateAsync.mockClear().mockResolvedValue({});
    const editingEvent = {
      kind: "event" as const,
      id: "ev_edit_clear",
      workflowId: "wf_1",
      name: "on pr",
      enabled: true,
      detail: {
        eventKeys: ["github.pull_request.opened"],
        filters: [{ field: "branch", op: "eq" as const, value: "main" }],
      },
    };
    render(<TriggerDialog open onOpenChange={() => {}} editing={editingEvent} />);
    // The picker renders the pre-filled branch=main row; remove it.
    fireEvent.click(screen.getByRole("button", { name: /remove filter/i }));
    fireEvent.click(screen.getByText(/^Save$/));
    await waitFor(() => expect(updateEventMutateAsync).toHaveBeenCalled());
    const callArg = updateEventMutateAsync.mock.calls[updateEventMutateAsync.mock.calls.length - 1][0];
    expect(callArg.body.filters).toEqual([]);
  });
});
