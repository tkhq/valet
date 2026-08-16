// @vitest-environment jsdom
/**
 * TriggerList — renders trigger rows, toggles enabled state, filters by
 * workflowId, and fires a schedule-now action. Mirrors the mock style from
 * `-workflows.index.test.tsx`.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { WorkflowTriggerItem } from "@valet/api/wire";

const triggersData: { triggers: WorkflowTriggerItem[] } = {
  triggers: [
    {
      kind: "schedule",
      id: "sch_1",
      workflowId: "wf_1",
      name: "Nightly build",
      enabled: true,
      detail: {
        cron: "0 3 * * *",
        timezone: "UTC",
        targetKind: "workflow",
        nextFireAt: Date.now() + 3_600_000,
        lastFiredAt: null,
      },
    },
    {
      kind: "schedule",
      id: "sch_2",
      name: "Morning digest",
      enabled: true,
      detail: {
        cron: "0 9 * * *",
        timezone: "UTC",
        targetKind: "orchestrator",
        prompt: "digest",
        nextFireAt: Date.now() + 60_000,
        lastFiredAt: null,
      },
    },
    {
      kind: "event",
      id: "ev_1",
      workflowId: "wf_1",
      name: "On PR open",
      enabled: false,
      detail: { eventKeys: ["github.pull_request.opened"], filters: [] },
    },
  ],
};

const updateScheduleMutateAsync = vi.fn().mockResolvedValue({});
const updateEventMutateAsync = vi.fn().mockResolvedValue({});
const deleteScheduleMutateAsync = vi.fn().mockResolvedValue({});
const deleteEventMutateAsync = vi.fn().mockResolvedValue({});
const runNowMutateAsync = vi.fn().mockResolvedValue({});
const createScheduleMutateAsync = vi.fn().mockResolvedValue({});
const createEventTriggerMutateAsync = vi.fn().mockResolvedValue({});
const useWorkflowTriggersMock = vi.fn((_workflowId?: string) => ({
  data: triggersData,
  isLoading: false,
  error: null,
}));

vi.mock("~/api/workflows", () => ({
  useWorkflowTriggers: (workflowId?: string) => useWorkflowTriggersMock(workflowId),
  useWorkflows: () => ({ data: { workflows: [] }, isLoading: false }),
  useUpdateSchedule: () => ({ mutateAsync: updateScheduleMutateAsync, isPending: false }),
  useUpdateEventTrigger: () => ({ mutateAsync: updateEventMutateAsync, isPending: false }),
  useDeleteSchedule: () => ({ mutateAsync: deleteScheduleMutateAsync, isPending: false }),
  useDeleteEventTrigger: () => ({ mutateAsync: deleteEventMutateAsync, isPending: false }),
  useRunScheduleNow: () => ({ mutateAsync: runNowMutateAsync, isPending: false }),
  useCreateSchedule: () => ({ mutateAsync: createScheduleMutateAsync, isPending: false, error: null }),
  useCreateEventTrigger: () => ({ mutateAsync: createEventTriggerMutateAsync, isPending: false, error: null }),
  useTriggerCatalog: () => ({ data: { catalog: [] } }),
}));

import { TriggerList } from "./trigger-list";

describe("TriggerList", () => {
  it("renders one row per trigger with kind-appropriate summaries", () => {
    render(<TriggerList />);
    expect(screen.getByText("Nightly build")).toBeTruthy();
    expect(screen.getByText(/0 3 \* \* \*/)).toBeTruthy();
    expect(screen.getByText(/github\.pull_request\.opened/)).toBeTruthy();
  });

  it("toggles enabled through the kind-specific update hook", () => {
    updateScheduleMutateAsync.mockClear();
    render(<TriggerList />);
    fireEvent.click(screen.getAllByRole("switch")[0]);
    expect(updateScheduleMutateAsync).toHaveBeenCalledWith({ id: "sch_1", body: { enabled: false } });
  });

  it("filters to a workflow when workflowId is passed (hook receives it)", () => {
    useWorkflowTriggersMock.mockClear();
    render(<TriggerList workflowId="wf_1" />);
    expect(useWorkflowTriggersMock).toHaveBeenCalledWith("wf_1");
  });

  it("fires a schedule now", () => {
    runNowMutateAsync.mockClear();
    render(<TriggerList />);
    fireEvent.click(screen.getAllByLabelText(/run now/i)[0]);
    expect(runNowMutateAsync).toHaveBeenCalledWith("sch_1");
  });

  it("shows global empty-state copy when no workflowId and no triggers", () => {
    useWorkflowTriggersMock.mockReturnValueOnce({ data: { triggers: [] }, isLoading: false, error: null });
    render(<TriggerList />);
    expect(screen.getByText(/run a workflow on a schedule or on an event/)).toBeTruthy();
  });

  it("shows scoped empty-state copy when workflowId is set and no triggers", () => {
    useWorkflowTriggersMock.mockReturnValueOnce({ data: { triggers: [] }, isLoading: false, error: null });
    render(<TriggerList workflowId="wf_1" />);
    expect(screen.getByText(/run this on a schedule or on an event/)).toBeTruthy();
  });
});
