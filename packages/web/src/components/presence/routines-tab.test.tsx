// @vitest-environment jsdom
/**
 * The Routines tab and a routine's page (docs/specs/2026-10-16-presence-hub-design.md
 * Part D; acceptance H8): each routine as one sentence with its timezone when
 * not UTC, fire now, edit, enable or disable, the history, and the problem
 * badge with the picker inline.
 *
 * The api client is mocked at the transport, so the real query hooks run.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  ListThreadsResponse,
  ListWorkflowRunsResponse,
  ListWorkflowTriggersResponse,
  ListWorkflowsResponse,
  UpdateWorkflowScheduleRequest,
  WorkflowScheduleResponse,
  WorkflowTriggerItem,
} from "@valet/api/wire";
import type { AssistantThreadPolicy } from "@valet/shared";
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
vi.mock("~/components/workflows/trigger-dialog", () => ({
  TriggerDialog: ({ editing }: { editing?: WorkflowTriggerItem }) => <p>{editing ? `Editing ${editing.name}` : "New routine dialog"}</p>,
}));

vi.mock("./thread-picker", () => ({
  ThreadPicker: ({ workspace, onPick }: {
    workspace: string;
    onPick: (policy: Extract<AssistantThreadPolicy, { mode: "existing" }>, title: string) => void;
  }) => (
    <button type="button" onClick={() => onPick({ mode: "existing", sessionId: "s-ws", threadId: "t-ops" }, "Platform Ops")}>
      Pick Platform Ops from {workspace}
    </button>
  ),
}));

import { RoutinesTab } from "./routines-tab";
import { RoutinePage, routineReadOnly } from "./routine-page";

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

describe("RoutinesTab", () => {
  it("lists routines as sentences, with the timezone when not UTC, and no listeners (H8)", async () => {
    wrap(<RoutinesTab />);
    expect(await screen.findByRole("link", { name: "Every day at 9:00 · Morning summary · works in this routine's thread" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Every weekday at 8:30 (America/Denver) · Standup · works in a new thread each time" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Every day at 2:00 · Nightly build · runs Build" })).toBeTruthy();
    expect(screen.queryByText(/On push/)).toBeNull();
    expect(screen.getByRole("link", { name: "Every day at 9:00 · Morning summary · works in this routine's thread" }).getAttribute("href"))
      .toBe("/presence/routines?routine=S1");
    expect(listWorkflowTriggers).toHaveBeenCalledWith({ ownerType: "user", ownerId: "u-001" });
  });

  it("fires a routine now from its row", async () => {
    wrap(<RoutinesTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Fire Morning summary now" }));
    await waitFor(() => expect(runWorkflowScheduleNow).toHaveBeenCalledWith("S1"));
  });

  it("badges a routine the scheduler turned off for an archived thread", async () => {
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { enabled: false, detail: { disabledReason: PIN_TEXT } })] });
    wrap(<RoutinesTab />);
    expect(await screen.findByText("Thread archived")).toBeTruthy();
    // The row says Off once, on its second line.
    expect(screen.getAllByText("Off")).toHaveLength(1);
  });

  it("opens the dialog for a new routine", async () => {
    wrap(<RoutinesTab />);
    fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
    expect(screen.getByText("New routine dialog")).toBeTruthy();
  });
});

describe("RoutinePage", () => {
  it("shows the sentence and offers fire now, edit, and disable", async () => {
    wrap(<RoutinePage id="S1" />);
    expect(await screen.findByText("Every day at 9:00 · Morning summary · works in this routine's thread")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fire now" }));
    await waitFor(() => expect(runWorkflowScheduleNow).toHaveBeenCalledWith("S1"));
    expect(await screen.findByText("Fired. The routine runs now.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Editing Morning summary")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Turn off Morning summary" }));
    await waitFor(() => expect(updateWorkflowSchedule).toHaveBeenCalledWith("S1", { enabled: false }));
  });

  it("names a pinned thread from the archived list", async () => {
    listWorkflowTriggers.mockResolvedValue({
      triggers: [routine("S1", { detail: { thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ci" } } })],
    });
    listThreads.mockImplementation(async (_sessionId, opts) => ({
      threads: opts?.archived ? [{ id: "t-ci", sessionId: "s-ws", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1, archivedAt: 2 }] : [],
    }));
    wrap(<RoutinePage id="S1" />);
    expect(await screen.findByText("Every day at 9:00 · Morning summary · works in the thread Platform CI")).toBeTruthy();
  });

  it("shows the problem with the picker inline; a pick repins and turns the routine on", async () => {
    listWorkflowTriggers.mockResolvedValue({
      triggers: [routine("S1", { enabled: false, detail: { disabledReason: PIN_TEXT, thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ci" } } })],
    });
    wrap(<RoutinePage id="S1" />);
    const problem = await screen.findByRole("region", { name: "Problem" });
    expect(within(problem).getByText("This routine's thread is archived. Pick another thread.")).toBeTruthy();
    expect(screen.getByText("Thread archived")).toBeTruthy();
    fireEvent.click(within(problem).getByRole("button", { name: "Pick Platform Ops from user" }));
    await waitFor(() => expect(updateWorkflowSchedule).toHaveBeenCalledWith("S1", {
      thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ops" },
      enabled: true,
    }));
  });

  it("lists the routine owner's threads in the picker, whatever the switcher shows", async () => {
    listWorkflowTriggers.mockResolvedValue({
      triggers: [routine("S1", { enabled: false, detail: { disabledReason: PIN_TEXT, ownerType: "team", ownerId: "team-sre" } })],
    });
    wrap(<RoutinePage id="S1" />);
    const problem = await screen.findByRole("region", { name: "Problem" });
    expect(within(problem).getByRole("button", { name: "Pick Platform Ops from team-sre" })).toBeTruthy();
  });

  it("keeps another member's personal routine read-only", async () => {
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { detail: { ownerId: "u-other" } })] });
    wrap(<RoutinePage id="S1" />);
    expect(await screen.findByText("Only its owner can change this routine.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Fire now" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("switch", { name: "Turn off Morning summary" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps a team routine read-only for a viewer outside the team", async () => {
    teamsData = { teams: [{ id: "team-sre", callerRole: null }] };
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { detail: { ownerType: "team", ownerId: "team-sre" } })] });
    wrap(<RoutinePage id="S1" />);
    expect(await screen.findByText("Only its owner can change this routine.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" }).hasAttribute("disabled")).toBe(true);
  });

  it("reads a routine as read-only until the viewer and the teams load", () => {
    const team = routine("S1", { detail: { ownerType: "team", ownerId: "team-sre" } });
    const mine = routine("S2");
    const member = [{ id: "team-sre", callerRole: "member" as const }];
    expect(routineReadOnly(mine, undefined, member)).toBe(true);
    expect(routineReadOnly(mine, { id: "u-001" }, undefined)).toBe(true);
    expect(routineReadOnly(mine, { id: "u-001" }, member)).toBe(false);
    expect(routineReadOnly(team, { id: "u-001" }, member)).toBe(false);
    expect(routineReadOnly(team, { id: "u-001" }, [{ id: "team-sre", callerRole: null }])).toBe(true);
    // An org routine opens only through its workflow, which the server checks.
    const org = routine("S3", { detail: { ownerType: "org", ownerId: "acme" } });
    expect(routineReadOnly(org, { id: "u-001" }, member)).toBe(true);
    expect(routineReadOnly({ ...org, workflowId: "wf-1" }, { id: "u-001" }, member)).toBe(false);
  });

  it("lists a workflow routine's runs", async () => {
    listWorkflowRuns.mockResolvedValue({
      runs: [
        { runId: "wfrun_sch_S3_100", workflowId: "wf-1", status: "settled", outcome: "completed", createdAt: 100, updatedAt: 100 },
        { runId: "wfrun_manual_1", workflowId: "wf-1", status: "settled", outcome: "completed", createdAt: 90, updatedAt: 90 },
      ],
    });
    wrap(<RoutinePage id="S3" />);
    const history = await screen.findByRole("region", { name: "History" });
    expect((await within(history).findByRole("link", { name: /wfrun_sch_S3_100/ })).getAttribute("href")).toBe("/workflows/runs/wfrun_sch_S3_100");
    expect(within(history).queryByText(/wfrun_manual_1/)).toBeNull();
    expect(listWorkflowRuns).toHaveBeenCalledWith("wf-1");
  });

  it("says when an assistant routine last fired", async () => {
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { detail: { lastFiredAt: Date.now() - 2 * 3_600_000 } })] });
    wrap(<RoutinePage id="S1" />);
    const history = await screen.findByRole("region", { name: "History" });
    expect(within(history).getByText(/^Last fired/)).toBeTruthy();
  });

  it("names the fix for a routine that is not in the list", async () => {
    wrap(<RoutinePage id="gone" />);
    expect(await screen.findByText("This routine does not exist, or you cannot see it. Open Routines and pick a routine.")).toBeTruthy();
  });
});
