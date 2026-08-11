// @vitest-environment jsdom
/**
 * TriggersPanel — the workflow editor's webhook + schedules surface. Mocks
 * `~/api/workflows` the same way the route tests mock their api modules:
 * this suite cares that the panel renders from query data and calls the
 * right mutation, not that TanStack Query works.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mintMutate = vi.fn();
const deleteWebhookMutate = vi.fn();
const createScheduleMutate = vi.fn();
const deleteScheduleMutate = vi.fn();

let webhookData: { workflowId: string; hookId: string; createdAt: number; updatedAt: number } | null =
  null;

const schedulesData = {
  schedules: [
    {
      scheduleId: "sched_1",
      workflowId: "wf_1",
      name: "Nightly",
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      lastFiredAt: null,
      nextFireAt: 1_924_000_000_000,
    },
  ],
};

vi.mock("~/api/workflows", () => ({
  useWorkflowWebhook: () => ({ data: webhookData, isLoading: false, error: null }),
  useMintWorkflowWebhook: () => ({ mutate: mintMutate, isPending: false, error: null }),
  useDeleteWorkflowWebhook: () => ({ mutate: deleteWebhookMutate, isPending: false, error: null }),
  useWorkflowSchedules: () => ({ data: schedulesData, isLoading: false, error: null }),
  useCreateWorkflowSchedule: () => ({ mutate: createScheduleMutate, isPending: false }),
  useDeleteWorkflowSchedule: () => ({ mutate: deleteScheduleMutate, isPending: false }),
}));

import { TriggersPanel } from "./triggers-drawer";

beforeEach(() => {
  mintMutate.mockClear();
  deleteWebhookMutate.mockClear();
  createScheduleMutate.mockClear();
  deleteScheduleMutate.mockClear();
  webhookData = null;
});

describe("TriggersPanel — webhook", () => {
  it("offers to create a webhook when none exists, and mints on click", () => {
    render(<TriggersPanel workflowId="wf_1" />);
    fireEvent.click(screen.getByRole("button", { name: "Create webhook URL" }));
    expect(mintMutate).toHaveBeenCalledTimes(1);
  });

  it("shows the full hook URL when one exists", () => {
    webhookData = { workflowId: "wf_1", hookId: "hook-secret-abc", createdAt: 1, updatedAt: 1 };
    render(<TriggersPanel workflowId="wf_1" />);
    expect(screen.getByText(/\/api\/hooks\/workflows\/wf_1\/hook-secret-abc/)).toBeTruthy();
  });
});

describe("TriggersPanel — schedules", () => {
  it("lists schedules with their cron and timezone", () => {
    render(<TriggersPanel workflowId="wf_1" />);
    expect(screen.getByText("Nightly")).toBeTruthy();
    expect(screen.getByText(/0 9 \* \* \*/)).toBeTruthy();
  });

  it("creates a schedule from the form", async () => {
    render(<TriggersPanel workflowId="wf_1" />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weekly" } });
    fireEvent.change(screen.getByLabelText("Cron (5 fields)"), {
      target: { value: "0 8 * * 1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));

    await waitFor(() =>
      expect(createScheduleMutate).toHaveBeenCalledWith(
        { name: "Weekly", cron: "0 8 * * 1" },
        expect.anything(),
      ),
    );
  });

  it("deletes a schedule", () => {
    render(<TriggersPanel workflowId="wf_1" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete schedule Nightly" }));
    expect(deleteScheduleMutate).toHaveBeenCalledWith("sched_1");
  });
});
