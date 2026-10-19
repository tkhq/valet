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
    ownerType: "user",
    ownerId: "u1",
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

// The sentences name the viewer and the org members; this suite names no one.
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u-001" } }),
  useOrgDirectory: () => ({ data: { users: [] } }),
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

/** The editor is its own suite. Here the panel only has to open it with the
 * right preselection, so a stub reads the mode it was given. */
vi.mock("~/components/presence/editor/line-editor", async () => (await import("~/components/presence/editor/test-editor-stub")).stubModule);

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
    const link = screen.getByText("Every day at 9:00, Nightly: run Deploy pipeline.").closest("a");
    expect(link?.getAttribute("data-to")).toBe("/presence/routines/$id");
    expect(link?.getAttribute("data-params")).toBe(JSON.stringify({ id: "sched_1" }));
  });

  it("renders a listener that runs this workflow as its sentence, linked to its page", () => {
    renderPanel(<TriggersPanel workflowId="wf_1" />);
    const rows = screen.getAllByText("When a pull request is opened on acme/api, run Deploy pipeline.");
    expect(rows).toHaveLength(1);
    const link = rows[0]!.closest("a");
    expect(link?.getAttribute("data-to")).toBe("/presence/rules/$id");
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

  it("opens the editor fixed on this workflow on Add", () => {
    renderPanel(<TriggersPanel workflowId="wf_1" />);
    expect(screen.queryByTestId("line-editor")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: create fixed workflow wf_1");
  });

  it("opens the editor on a routine when the new-workflow dialog asked for a schedule", () => {
    renderPanel(<TriggersPanel workflowId="wf_1" startNew="schedule" />);
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: create fixed workflow wf_1 schedule");
  });

  it("opens the editor on a line when the new-workflow dialog asked for an event", () => {
    renderPanel(<TriggersPanel workflowId="wf_1" startNew="event" />);
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: create fixed workflow wf_1");
  });
});
