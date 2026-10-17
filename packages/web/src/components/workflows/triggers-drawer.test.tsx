// @vitest-environment jsdom
/**
 * TriggersPanel: the workflow editor's webhook, listeners, and routines
 * (docs/specs/2026-10-16-presence-hub-design.md Part F step 2). A listener
 * and a routine read as their Part C and Part D sentences, and **Add** opens
 * the wizard with this workflow preselected. The api modules are mocked:
 * this suite cares what the panel renders from query data, not that
 * TanStack Query works.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { EventSubscriptionWire, WorkflowTriggerItem } from "@valet/api/wire";

const mintMutate = vi.fn();
const deleteWebhookMutate = vi.fn();
const triggersFor = vi.fn((_workflowId?: string) => ({
  data: { triggers: triggers },
  isLoading: false,
  isPending: false,
  isError: false,
  isSuccess: true,
  error: null,
}));

let webhookData:
  | { workflowId: string; hookId: string; url: string; createdAt: number; updatedAt: number }
  | null = null;

let triggers: WorkflowTriggerItem[] = [];
let subscriptions: EventSubscriptionWire[] = [];

function listener(id: string, workflowId: string): EventSubscriptionWire {
  return {
    id,
    name: `Listener ${id}`,
    ownerType: "user",
    ownerId: "u1",
    eventKeys: ["github.pull_request.opened"],
    filters: [{ field: "repo", op: "eq", value: "acme/api" }],
    target: { kind: "workflow", workflowId },
    enabled: true,
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 1,
  };
}

const nightly: WorkflowTriggerItem = {
  kind: "schedule",
  id: "sched_1",
  workflowId: "wf_1",
  name: "Nightly",
  enabled: true,
  detail: {
    cron: "0 9 * * *",
    timezone: "UTC",
    targetKind: "workflow",
    nextFireAt: 1_924_000_000_000,
    lastFiredAt: null,
  },
};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params, search, to }: { children: ReactNode; params?: unknown; search?: unknown; to: string }) => (
    <a data-to={to} data-params={JSON.stringify(params)} data-search={JSON.stringify(search)}>{children}</a>
  ),
}));

vi.mock("~/api/workflows", () => ({
  useWorkflowWebhook: () => ({ data: webhookData, isLoading: false, error: null }),
  useMintWorkflowWebhook: () => ({ mutate: mintMutate, isPending: false, error: null }),
  useDeleteWorkflowWebhook: () => ({ mutate: deleteWebhookMutate, isPending: false, error: null }),
  useWorkflowTriggers: (workflowId?: string) => triggersFor(workflowId),
  useWorkflows: () => ({ data: { workflows: [{ id: "wf_1", name: "Deploy pipeline" }] }, isLoading: false, error: null }),
  useTriggerCatalog: () => ({ data: { catalog: [] }, isLoading: false, error: null }),
}));

vi.mock("~/api/events", () => ({
  useEventSubscriptions: () => ({
    data: { subscriptions },
    isPending: false,
    isError: false,
    isSuccess: true,
    error: null,
  }),
}));

/** The wizard is its own suite. Here the panel only has to open it with the
 * right preselection, so a stub records the props it was given. */
const wizardProps = vi.fn();
vi.mock("~/components/events/automation-wizard", () => ({
  AutomationWizard: (props: { open: boolean; preselectedWorkflowId?: string; startOn?: string }) => {
    wizardProps(props);
    return props.open ? <div role="dialog" aria-label="Wizard" /> : null;
  },
}));

import { TriggersPanel } from "./triggers-drawer";

function renderPanel(ui: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  mintMutate.mockClear();
  deleteWebhookMutate.mockClear();
  triggersFor.mockClear();
  wizardProps.mockClear();
  webhookData = null;
  triggers = [nightly];
  subscriptions = [listener("sub_1", "wf_1"), listener("sub_other", "wf_2")];
});

describe("TriggersPanel: webhook", () => {
  it("offers to create a webhook when none exists, and mints on click", () => {
    renderPanel(<TriggersPanel workflowId="wf_1" />);
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
    renderPanel(<TriggersPanel workflowId="wf_1" />);
    expect(screen.getByText(/\/api\/hooks\/workflows\/wf_1\/hook-secret-abc/)).toBeTruthy();
  });
});

describe("TriggersPanel: listeners and routines", () => {
  it("reads this workflow's routines", () => {
    renderPanel(<TriggersPanel workflowId="wf_1" />);
    expect(triggersFor).toHaveBeenCalledWith("wf_1");
  });

  it("renders a routine as its sentence, linked to its page", () => {
    renderPanel(<TriggersPanel workflowId="wf_1" />);
    const link = screen.getByText("Every day at 9:00 · Nightly · runs Deploy pipeline").closest("a");
    expect(link?.getAttribute("data-to")).toBe("/presence/routines");
    expect(link?.getAttribute("data-search")).toBe(JSON.stringify({ routine: "sched_1" }));
  });

  it("renders a listener that runs this workflow as its sentence, linked to its page", () => {
    renderPanel(<TriggersPanel workflowId="wf_1" />);
    const rows = screen.getAllByText("Listens on acme/api for opened pull requests · runs Deploy pipeline");
    expect(rows).toHaveLength(1);
    const link = rows[0]!.closest("a");
    expect(link?.getAttribute("data-to")).toBe("/presence/listeners/$id");
    expect(link?.getAttribute("data-params")).toBe(JSON.stringify({ id: "sub_1" }));
  });

  it("says so when the workflow has no listener and no routine", () => {
    triggers = [];
    subscriptions = [];
    renderPanel(<TriggersPanel workflowId="wf_1" />);
    expect(screen.getByText(/Nothing starts this workflow yet/)).toBeTruthy();
  });

  it("never uses the retired words", () => {
    const { container } = renderPanel(<TriggersPanel workflowId="wf_1" />);
    expect(container.textContent ?? "").not.toMatch(/trigger|subscription|automation/i);
  });

  it("opens the wizard with this workflow preselected on Add", () => {
    renderPanel(<TriggersPanel workflowId="wf_1" />);
    expect(screen.queryByRole("dialog", { name: "Wizard" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("dialog", { name: "Wizard" })).toBeTruthy();
    expect(wizardProps).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, preselectedWorkflowId: "wf_1" }));
  });

  it("opens the wizard on a routine when the new-workflow dialog asked for a schedule", () => {
    renderPanel(<TriggersPanel workflowId="wf_1" startNew="schedule" />);
    expect(wizardProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, preselectedWorkflowId: "wf_1", startOn: "routine" }),
    );
  });

  it("opens the wizard on a listener when the new-workflow dialog asked for an event", () => {
    renderPanel(<TriggersPanel workflowId="wf_1" startNew="event" />);
    expect(wizardProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, preselectedWorkflowId: "wf_1", startOn: "listener" }),
    );
  });
});
