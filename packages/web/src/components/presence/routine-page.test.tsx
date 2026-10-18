// @vitest-environment jsdom
/**
 * A routine's page (docs/specs/2026-10-16-presence-hub-design.md Part E
 * step 2): the sentence as the title, the fact strip, fire now, edit, enable
 * or disable, the history, and the problem with the picker inline.
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

const navigate = vi.fn<(to: { to: string }) => Promise<void>>();
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  useNavigate: () => navigate,
  Link: ({ to, params, search, hash, children, className, "aria-label": label }: {
    to: string; params?: Record<string, string>; search?: Record<string, string>; hash?: string; children: ReactNode; className?: string; "aria-label"?: string;
  }) => {
    const path = Object.entries(params ?? {}).reduce((p, [key, value]) => p.replace(`$${key}`, value), to);
    const query = new URLSearchParams(search ?? {}).toString();
    const href = `${query ? `${path}?${query}` : path}${hash ? `#${hash}` : ""}`;
    return <a href={href} className={className} aria-label={label}>{children}</a>;
  },
}));

const listWorkflowTriggers = vi.fn<(owner?: { ownerType: string; ownerId: string }) => Promise<ListWorkflowTriggersResponse>>();
const listWorkflows = vi.fn<() => Promise<ListWorkflowsResponse>>();
const listWorkflowRuns = vi.fn<(id: string) => Promise<ListWorkflowRunsResponse>>();
const runWorkflowScheduleNow = vi.fn<(id: string) => Promise<{ ok: true }>>();
const updateWorkflowSchedule = vi.fn<(id: string, body: UpdateWorkflowScheduleRequest) => Promise<WorkflowScheduleResponse>>();
const listThreads = vi.fn<(sessionId: string, opts?: { threadId?: string; archived?: boolean }) => Promise<ListThreadsResponse>>();
const deleteWorkflowSchedule = vi.fn<(id: string) => Promise<{ ok: true }>>();
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
      deleteWorkflowSchedule: (id: string) => deleteWorkflowSchedule(id),
    },
  };
});

let teamsData: { teams: { id: string; name?: string; callerRole: "admin" | "member" | null }[] } | undefined = {
  teams: [{ id: "team-sre", name: "SRE", callerRole: "member" }],
};
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u-001", orgId: "acme", orgRole: "member" } }),
  useTeams: () => ({ data: teamsData }),
}));

vi.mock("~/lib/workspace-scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/workspace-scope")>(),
  useWorkspaceScope: () => ({ key: "user", teamId: undefined, available: ["user"], setKey: () => {} }),
}));

/** The dialog is its own suite's; here it records what it opened on and
 * whose threads its Runs in lists. */
vi.mock("~/components/workflows/trigger-dialog", () => ({
  TriggerDialog: ({ editing, workspace }: { editing?: WorkflowTriggerItem; workspace?: string }) => (
    <p>{editing ? `Editing ${editing.name}${workspace ? ` in ${workspace}` : ""}` : "New routine dialog"}</p>
  ),
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

import { routineWhen } from "./routine-helpers";
import { RoutinePage, routineReadOnly } from "./routine-page";
import { routine } from "./test-fixtures";

const PIN_TEXT = "Pick another thread in Presence.";


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
  teamsData = { teams: [{ id: "team-sre", name: "SRE", callerRole: "member" }] };
  navigate.mockReset();
  for (const mock of [listWorkflowTriggers, listWorkflows, listWorkflowRuns, runWorkflowScheduleNow, updateWorkflowSchedule, listThreads, deleteWorkflowSchedule]) {
    mock.mockReset();
  }
  deleteWorkflowSchedule.mockResolvedValue({ ok: true });
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

/** The fact strip as [term, value] pairs. */
function factsOf(strip: HTMLElement): string[][] {
  return Array.from(strip.querySelectorAll("dt")).map((dt) => [dt.textContent ?? "", dt.nextElementSibling?.textContent ?? ""]);
}

describe("RoutinePage", () => {
  it("shows the sentence and offers fire now, edit, and disable", async () => {
    wrap(<RoutinePage id="S1" />);
    expect(await screen.findByText("Every day at 9:00, Morning summary: work in its own thread.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fire now" }));
    await waitFor(() => expect(runWorkflowScheduleNow).toHaveBeenCalledWith("S1"));
    expect(await screen.findByText("Fired. The routine runs now.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Editing Morning summary in user")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Turn off Morning summary" }));
    await waitFor(() => expect(updateWorkflowSchedule).toHaveBeenCalledWith("S1", { enabled: false }));
  });

  it("titles the page with the sentence under Presence › On a schedule › <name>", async () => {
    wrap(<RoutinePage id="S1" />);
    const title = await screen.findByRole("heading", { level: 1, name: "Every day at 9:00, Morning summary: work in its own thread." });
    expect(title).toBeTruthy();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("Presence›On a schedule›Morning summary");
    expect(within(crumbs).getByRole("link", { name: "Presence" }).getAttribute("href")).toBe("/presence");
    expect(within(crumbs).getByRole("link", { name: "On a schedule" }).getAttribute("href")).toBe("/presence#schedule");
    expect(within(crumbs).getByText("Morning summary").getAttribute("aria-current")).toBe("page");
  });

  it("shows When, Do, and Runs in for an assistant routine, with the timezone when not UTC", async () => {
    wrap(<RoutinePage id="S2" />);
    const strip = await screen.findByLabelText("Facts");
    expect(factsOf(strip)).toEqual([
      ["When", "Every weekday at 8:30 (America/Denver)"],
      ["Do", "work on it"],
      ["Runs in", "A new thread each time"],
    ]);
  });

  it("shows When and Do, and no Runs in, for a workflow routine", async () => {
    wrap(<RoutinePage id="S3" />);
    const strip = await screen.findByLabelText("Facts");
    await waitFor(() => expect(factsOf(strip)).toEqual([
      ["When", "Every day at 2:00"],
      ["Do", "run Build"],
    ]));
  });

  it("names a pinned thread from the archived list", async () => {
    listWorkflowTriggers.mockResolvedValue({
      triggers: [routine("S1", { detail: { thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ci" } } })],
    });
    listThreads.mockImplementation(async (_sessionId, opts) => ({
      threads: opts?.archived ? [{ id: "t-ci", sessionId: "s-ws", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1, archivedAt: 2 }] : [],
    }));
    wrap(<RoutinePage id="S1" />);
    expect(await screen.findByText("Every day at 9:00, Morning summary: work in the Platform CI thread.")).toBeTruthy();
  });

  it("shows the problem with the picker inline; a pick repins and turns the routine on", async () => {
    listWorkflowTriggers.mockResolvedValue({
      triggers: [routine("S1", { enabled: false, detail: { disabledReason: PIN_TEXT, thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ci" } } })],
    });
    wrap(<RoutinePage id="S1" />);
    const problem = await screen.findByRole("region", { name: "Problem" });
    expect(await within(problem).findByText("The pinned thread is archived. Pick another thread:")).toBeTruthy();
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
    teamsData = { teams: [{ id: "team-sre", name: "SRE", callerRole: null }] };
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { detail: { ownerType: "team", ownerId: "team-sre" } })] });
    wrap(<RoutinePage id="S1" />);
    expect(await screen.findByText("Only members of SRE can change this.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled")).toBe(true);
  });

  it("scopes Edit's Runs in to a team routine's team and marks the routine Team", async () => {
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { detail: { ownerType: "team", ownerId: "team-sre" } })] });
    wrap(<RoutinePage id="S1" />);
    expect(await screen.findByText("Team")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Editing Morning summary in team-sre")).toBeTruthy();
  });

  it("deletes the routine after the confirm, then opens Presence", async () => {
    wrap(<RoutinePage id="S1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Valet stops acting on this schedule. Its past runs stay.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteWorkflowSchedule).toHaveBeenCalledWith("S1"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/presence" }));
  });

  it("names a team routine's team in the Delete confirm", async () => {
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { detail: { ownerType: "team", ownerId: "team-sre" } })] });
    wrap(<RoutinePage id="S1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByText("This is SRE's routine. Valet stops acting on this schedule. Its past runs stay.")).toBeTruthy();
  });

  it("shows a scheduler reason as written, with Edit to fix it", async () => {
    const reason = "Its workflow was deleted. Edit the routine and pick another workflow.";
    listWorkflowTriggers.mockResolvedValue({
      triggers: [routine("S1", { enabled: false, workflowId: "wf-gone", detail: { targetKind: "workflow", disabledReason: reason } })],
    });
    wrap(<RoutinePage id="S1" />);
    const problem = await screen.findByRole("region", { name: "Problem" });
    expect(within(problem).getByText(reason)).toBeTruthy();
    fireEvent.click(within(problem).getByRole("button", { name: "Edit the routine" }));
    expect(screen.getByText("Editing Morning summary in user")).toBeTruthy();
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

  it("reads Next as a date and a time without seconds, in the schedule's timezone", async () => {
    const now = Date.UTC(2026, 9, 19, 15, 0, 0);
    const at = Date.UTC(2026, 9, 19, 16, 0, 0);
    const next = routine("S1", { detail: { nextFireAt: at } });
    // ICU may put U+202F before PM; `\s` covers it.
    expect(routineWhen(next, ": ", now, "en-US")).toMatch(/^Next: Oct 19, 2026, 4:00\sPM$/);
    const denver = routine("S2", { detail: { nextFireAt: at, timezone: "America/Denver" } });
    expect(routineWhen(denver, ": ", now, "en-US")).toMatch(/^Next: Oct 19, 2026, 10:00\sAM$/);
    expect(routineWhen(routine("S1", { detail: { nextFireAt: now } }), ": ", now)).toBe("Due now");
    expect(routineWhen(routine("S1", { enabled: false }), ": ", now)).toBe("Off");
    // The page renders the same form: no seconds.
    listWorkflowTriggers.mockResolvedValue({ triggers: [S1] });
    wrap(<RoutinePage id="S1" />);
    const line = await screen.findByText(/^Next: /);
    expect(line.textContent).not.toMatch(/\d:\d\d:\d\d/);
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
    expect(await screen.findByText("This routine does not exist, or you cannot see it. Open Presence and pick a routine.")).toBeTruthy();
  });
});
