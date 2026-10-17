// @vitest-environment jsdom
/**
 * The Routines pane (docs/specs/2026-10-16-presence-hub-design.md Part E
 * step 1; acceptance P6): each routine as one sentence with its timezone when
 * not UTC, `Next:` or `Off`, an on/off switch, Fire now, and the problem
 * badge.
 *
 * The api client is mocked at the transport, so the real query hooks run.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ListThreadsResponse,
  ListWorkflowRunsResponse,
  ListWorkflowTriggersResponse,
  ListWorkflowsResponse,
  UpdateWorkflowScheduleRequest,
  WorkflowScheduleResponse,
  WorkflowTriggerItem,
} from "@valet/api/wire";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, search, children, className, "aria-label": label }: {
    to: string; params?: Record<string, string>; search?: Record<string, string>; children: ReactNode; className?: string; "aria-label"?: string;
  }) => {
    const path = Object.entries(params ?? {}).reduce((p, [key, value]) => p.replace(`$${key}`, value), to);
    const query = new URLSearchParams(search ?? {}).toString();
    return <a href={query ? `${path}?${query}` : path} className={className} aria-label={label}>{children}</a>;
  },
}));

const listWorkflowTriggers = vi.fn<(owner?: { ownerType: string; ownerId: string }) => Promise<ListWorkflowTriggersResponse>>();
const listWorkflows = vi.fn<() => Promise<ListWorkflowsResponse>>();
const listWorkflowRuns = vi.fn<(id: string) => Promise<ListWorkflowRunsResponse>>();
const runWorkflowScheduleNow = vi.fn<(id: string) => Promise<{ ok: true }>>();
const updateWorkflowSchedule = vi.fn<(id: string, body: UpdateWorkflowScheduleRequest) => Promise<WorkflowScheduleResponse>>();
const listThreads = vi.fn<(sessionId: string, opts?: { threadId?: string; archived?: boolean }) => Promise<ListThreadsResponse>>();
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listWorkflowTriggers: (owner?: { ownerType: string; ownerId: string }) => listWorkflowTriggers(owner),
      listWorkflows: () => listWorkflows(),
      listWorkflowRuns: (id: string) => listWorkflowRuns(id),
      runWorkflowScheduleNow: (id: string) => runWorkflowScheduleNow(id),
      updateWorkflowSchedule: (id: string, body: UpdateWorkflowScheduleRequest) => updateWorkflowSchedule(id, body),
      listThreads: (sessionId: string, opts?: { threadId?: string; archived?: boolean }) => listThreads(sessionId, opts),
    },
  };
});

let teamsData: { teams: { id: string; callerRole: "admin" | "member" | null }[] } | undefined = {
  teams: [{ id: "team-sre", callerRole: "member" }],
};
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u-001", orgId: "acme", orgRole: "member" } }),
  useTeams: () => ({ data: teamsData }),
}));

vi.mock("~/lib/workspace-scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/workspace-scope")>(),
  useWorkspaceScope: () => ({ key: "user", teamId: undefined, available: ["user"], setKey: () => {} }),
}));

/** The dialog is its own suite's; here it records what it opened on. */
vi.mock("~/components/events/automation-wizard", () => ({
  AutomationWizard: ({ startOn }: { startOn?: string }) => <p>{startOn === "routine" ? "New routine dialog" : "Other dialog"}</p>,
}));

import { RoutinesPane } from "./routines-pane";

const PIN_TEXT = "Pick another thread for this rule in Presence.";

type Schedule = Extract<WorkflowTriggerItem, { kind: "schedule" }>;

function routine(id: string, over: Partial<Omit<Schedule, "kind" | "detail">> & { detail?: Partial<Schedule["detail"]> } = {}): Schedule {
  const { detail, ...rest } = over;
  return {
    kind: "schedule",
    id,
    name: "Morning summary",
    enabled: true,
    ...rest,
    detail: {
      cron: "0 9 * * *",
      timezone: "UTC",
      targetKind: "assistant",
      prompt: "Summarize",
      nextFireAt: Date.now() + 3_600_000,
      lastFiredAt: null,
      ownerType: "user",
      ownerId: "u-001",
      ...detail,
    },
  };
}

const S1 = routine("S1");
const DENVER = routine("S2", { name: "Standup", detail: { cron: "30 8 * * 1-5", timezone: "America/Denver", thread: { mode: "new" } } });
const NIGHTLY = routine("S3", { name: "Nightly build", workflowId: "wf-1", detail: { cron: "0 2 * * *", targetKind: "workflow" } });
const EVENT_TRIGGER: WorkflowTriggerItem = {
  kind: "event", id: "E1", workflowId: "wf-1", name: "On push", enabled: true, detail: { eventKeys: ["github.push"], filters: [] },
};

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  teamsData = { teams: [{ id: "team-sre", callerRole: "member" }] };
  for (const mock of [listWorkflowTriggers, listWorkflows, listWorkflowRuns, runWorkflowScheduleNow, updateWorkflowSchedule, listThreads]) {
    mock.mockReset();
  }
  listWorkflowTriggers.mockResolvedValue({ triggers: [S1, DENVER, NIGHTLY, EVENT_TRIGGER] });
  listWorkflows.mockResolvedValue({
    workflows: [{ id: "wf-1", name: "Build", definition: {}, createdAt: 1, updatedAt: 1, ownerType: "user", ownerId: "u-001" }],
  });
  listWorkflowRuns.mockResolvedValue({ runs: [] });
  runWorkflowScheduleNow.mockResolvedValue({ ok: true });
  updateWorkflowSchedule.mockImplementation(async (id) => ({
    schedule: { scheduleId: id, targetKind: "assistant", name: "x", cron: "0 9 * * *", timezone: "UTC", enabled: true, lastFiredAt: null, nextFireAt: 1 },
  }));
  listThreads.mockResolvedValue({ threads: [] });
});

describe("RoutinesPane", () => {
  it("lists routines as sentences, with the timezone when not UTC, and no listeners (H8)", async () => {
    wrap(<RoutinesPane />);
    expect(await screen.findByRole("link", { name: "Every day at 9:00, Morning summary: work in its own thread." })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Every weekday at 8:30 (America/Denver), Standup: work in a new thread each time." })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Every day at 2:00, Nightly build: run Build." })).toBeTruthy();
    expect(screen.queryByText(/On push/)).toBeNull();
    expect(screen.getByRole("link", { name: "Every day at 9:00, Morning summary: work in its own thread." }).getAttribute("href"))
      .toBe("/presence/routines?routine=S1");
    expect(listWorkflowTriggers).toHaveBeenCalledWith({ ownerType: "user", ownerId: "u-001" });
  });

  it("fires a routine now from its row", async () => {
    wrap(<RoutinesPane />);
    fireEvent.click(await screen.findByRole("button", { name: "Fire Morning summary now" }));
    await waitFor(() => expect(runWorkflowScheduleNow).toHaveBeenCalledWith("S1"));
  });

  it("badges a routine the scheduler turned off for an archived thread", async () => {
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { enabled: false, detail: { disabledReason: PIN_TEXT } })] });
    wrap(<RoutinesPane />);
    expect(await screen.findByText("Thread archived")).toBeTruthy();
    // The row says Off once, on its second line.
    expect(screen.getAllByText("Off")).toHaveLength(1);
  });

  it("shows Next:, the switch, and Fire now on a row; the switch turns the routine off (P6)", async () => {
    listWorkflowTriggers.mockResolvedValue({ triggers: [S1] });
    wrap(<RoutinesPane />);
    expect(await screen.findByText(`Next: ${new Date(S1.detail.nextFireAt).toLocaleString()}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fire Morning summary now" }).textContent).toBe("Fire now");
    fireEvent.click(screen.getByRole("switch", { name: "Turn off Morning summary" }));
    await waitFor(() => expect(updateWorkflowSchedule).toHaveBeenCalledWith("S1", { enabled: false }));
  });

  it("reads Off and offers Turn on for a routine that is off", async () => {
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { enabled: false })] });
    wrap(<RoutinesPane />);
    expect(await screen.findByText("Off")).toBeTruthy();
    expect(screen.queryByText(/^Next:/)).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Turn on Morning summary" }));
    await waitFor(() => expect(updateWorkflowSchedule).toHaveBeenCalledWith("S1", { enabled: true }));
  });

  it("shows its own empty state with no routine", async () => {
    listWorkflowTriggers.mockResolvedValue({ triggers: [EVENT_TRIGGER] });
    wrap(<RoutinesPane />);
    expect(await screen.findByText("No routine yet. Select New routine to have Valet act at a set time.")).toBeTruthy();
  });

  it("opens the dialog for a new routine", async () => {
    wrap(<RoutinesPane />);
    fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
    expect(screen.getByText("New routine dialog")).toBeTruthy();
  });
});
