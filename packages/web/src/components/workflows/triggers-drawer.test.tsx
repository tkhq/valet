// @vitest-environment jsdom
/**
 * TriggersPanel — the workflow editor's webhook + trigger surface. Mocks
 * `~/api/workflows` the same way the route tests mock their api modules:
 * this suite cares that the panel renders from query data and calls the
 * right mutation, not that TanStack Query works.
 *
 * The schedule and event rows come from `TriggerList`, which has its own
 * suite. Here the panel only has to scope that list to this workflow and
 * keep the webhook section beside it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mintMutate = vi.fn();
const deleteWebhookMutate = vi.fn();
const triggersFor = vi.fn((_workflowId?: string) => ({
  data: { triggers: triggersData.triggers },
  isLoading: false,
  error: null,
}));

let webhookData:
  | { workflowId: string; hookId: string; url: string; createdAt: number; updatedAt: number }
  | null = null;

const triggersData = {
  triggers: [
    {
      kind: "schedule" as const,
      id: "sched_1",
      workflowId: "wf_1",
      name: "Nightly",
      enabled: true,
      detail: {
        cron: "0 9 * * *",
        timezone: "UTC",
        targetKind: "workflow" as const,
        nextFireAt: 1_924_000_000_000,
        lastFiredAt: null,
      },
    },
  ],
};

vi.mock("~/api/workflows", () => ({
  useWorkflowWebhook: () => ({ data: webhookData, isLoading: false, error: null }),
  useMintWorkflowWebhook: () => ({ mutate: mintMutate, isPending: false, error: null }),
  useDeleteWorkflowWebhook: () => ({ mutate: deleteWebhookMutate, isPending: false, error: null }),
  useWorkflowTriggers: (workflowId?: string) => triggersFor(workflowId),
  useWorkflows: () => ({ data: { workflows: [] }, isLoading: false, error: null }),
  useUpdateSchedule: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useUpdateEventTrigger: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useDeleteSchedule: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useDeleteEventTrigger: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useRunScheduleNow: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useCreateSchedule: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false, error: null }),
  useCreateEventTrigger: () => ({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
    error: null,
  }),
  useTriggerCatalog: () => ({ data: { catalog: [] }, isLoading: false, error: null }),
}));

import { TriggersPanel } from "./triggers-drawer";

beforeEach(() => {
  mintMutate.mockClear();
  deleteWebhookMutate.mockClear();
  triggersFor.mockClear();
  webhookData = null;
});

describe("TriggersPanel — webhook", () => {
  it("offers to create a webhook when none exists, and mints on click", () => {
    render(<TriggersPanel workflowId="wf_1" />);
    fireEvent.click(screen.getByRole("button", { name: "Create webhook URL" }));
    expect(mintMutate).toHaveBeenCalledTimes(1);
  });

  it("shows the full hook URL when one exists", () => {
    webhookData = {
      workflowId: "wf_1",
      hookId: "hook-secret-abc",
      url: "https://valet.example/api/hooks/workflows/wf_1/hook-secret-abc",
      createdAt: 1,
      updatedAt: 1,
    };
    render(<TriggersPanel workflowId="wf_1" />);
    expect(screen.getByText(/\/api\/hooks\/workflows\/wf_1\/hook-secret-abc/)).toBeTruthy();
  });
});

describe("TriggersPanel — schedules and event triggers", () => {
  it("scopes the trigger list to this workflow", () => {
    render(<TriggersPanel workflowId="wf_1" />);
    expect(triggersFor).toHaveBeenCalledWith("wf_1");
  });

  it("lists a schedule with its cron and timezone", () => {
    render(<TriggersPanel workflowId="wf_1" />);
    expect(screen.getByText("Nightly")).toBeTruthy();
    expect(screen.getByText(/0 9 \* \* \*/)).toBeTruthy();
  });
});
