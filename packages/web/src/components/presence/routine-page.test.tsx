// @vitest-environment jsdom
/**
 * A routine's page (docs/specs/2026-10-16-presence-hub-design.md Part E
 * step 2): the line page's anatomy. The sentence as the title with the
 * clock mark, the status line with fire now, edit, and enable or disable,
 * the health strip, the problem with the picker inline, How it works, and
 * Activity as the routine's firings.
 *
 * The api client is mocked at the transport, so the real query hooks run.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  useOrgDirectory: () => ({ data: { users: [{ userId: "u-001", email: "c@acme.test", name: "Conner", avatarUrl: null }] } }),
}));

vi.mock("~/lib/workspace-scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/workspace-scope")>(),
  useWorkspaceScope: () => ({ key: "user", teamId: undefined, available: ["user"], setKey: () => {} }),
}));

/** The editor is its own suite's; here it records the mode it opened on. */
vi.mock("~/components/presence/editor/line-editor", async () => (await import("~/components/presence/editor/test-editor-stub")).stubModule);

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
import { RoutinePage, routineReadOnly, scheduleRunPrefix } from "./routine-page";
import { routine } from "./test-fixtures";
import { zoneLongName } from "~/lib/time-zones";

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

/** How it works as the text of each column, When, Do, Where. */
async function columns(): Promise<string[]> {
  const how = await screen.findByRole("region", { name: "How it works" });
  return Array.from(how.querySelectorAll<HTMLElement>("[data-section]")).map((column) => column.textContent ?? "");
}

/** The timeline's rows as their text, newest first. */
function activityRows(): string[] {
  return Array.from(screen.getByRole("region", { name: "Activity" }).querySelectorAll("li")).map((row) => row.textContent ?? "");
}

/** Opens the status line's overflow menu and picks Delete. */
async function pickDelete() {
  await userEvent.click(await screen.findByRole("button", { name: "More for Morning summary" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
}

// Review S5: the page finds a routine's runs by a prefix that hashes the
// whole id, so two proposal routines never read each other's runs.
describe("scheduleRunPrefix", () => {
  it("gives two proposal routines distinct prefixes, and agrees with the api's example", () => {
    expect(scheduleRunPrefix("proposal-aaa")).not.toBe(scheduleRunPrefix("proposal-bbb"));
    // The same example schedule-service.test.ts asserts for scheduledRunId.
    expect(scheduleRunPrefix("proposal-aaa")).toBe("wfrun_sch_1a2834f7313832_");
  });
});

describe("RoutinePage", () => {
  it("shows the sentence and offers fire now, edit, and disable", async () => {
    wrap(<RoutinePage id="S1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Every day at 9:00, Morning summary: work in its own thread." })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fire now" }));
    await waitFor(() => expect(runWorkflowScheduleNow).toHaveBeenCalledWith("S1"));
    expect(await screen.findByText("Fired. The routine runs now.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: edit-routine Morning summary");
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

  it("follows the line page's anatomy: clock mark, status line, health strip, How it works, Activity", async () => {
    wrap(<RoutinePage id="S1" />);
    const setUp = await screen.findByText("set up by", { exact: false });
    expect(setUp.textContent).toBe("set up by Conner");
    const title = screen.getByRole("heading", { level: 1 });
    expect(title.parentElement?.querySelector('[data-service="schedule"][data-size="lg"]')).not.toBeNull();
    const strip = screen.getByRole("region", { name: "Health" });
    const how = screen.getByRole("region", { name: "How it works" });
    const timeline = screen.getByRole("region", { name: "Activity" });
    const order = [title, setUp, strip, how, timeline];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(strip).getByText("never")).toBeTruthy();
    expect(within(strip).getByText("last fired")).toBeTruthy();
    expect(within(strip).getAllByRole("img", { name: "Activity over the last 30 days" })[0]!.querySelectorAll("span")).toHaveLength(30);
    // A routine has no skipped entries, so its Activity has no chips.
    expect(within(timeline).queryByRole("group", { name: "Show" })).toBeNull();
    expect(within(timeline).getByText("Nothing yet. Activity appears here when the routine fires.")).toBeTruthy();
    expect(screen.queryByLabelText("Facts")).toBeNull();
    expect(screen.queryByText("Runs in")).toBeNull();
  });

  it("shows When with the timezone, Do, and Where for an assistant routine", async () => {
    wrap(<RoutinePage id="S2" />);
    const zone = zoneLongName("America/Denver");
    expect(await columns()).toEqual([
      `WhenEvery weekday at 8:30 (${zone})The times are in ${zone}.Change`,
      "Dowork on its promptValet reads the prompt and acts in the thread.Change",
      "Wherein a new thread each timeEvery firing starts a fresh thread.Change",
    ]);
  });

  it("shows When, Do, and a run for Where on a workflow routine", async () => {
    wrap(<RoutinePage id="S3" />);
    await waitFor(async () => expect(await columns()).toEqual([
      "WhenEvery day at 2:00The times are in UTC.Change",
      "Dorun BuildValet starts the Build workflow.Change",
      "Wherein a workflow runA workflow run has no thread. Open the run from Activity to follow it.Change",
    ]));
  });

  it("opens the editor on the section a Change names", async () => {
    wrap(<RoutinePage id="S1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Change When" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: edit-routine Morning summary at when");
  });

  it("names a pinned thread from the archived list", async () => {
    listWorkflowTriggers.mockResolvedValue({
      triggers: [routine("S1", { detail: { thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ci" } } })],
    });
    listThreads.mockImplementation(async (_sessionId, opts) => ({
      threads: opts?.archived ? [{ id: "t-ci", sessionId: "s-ws", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1, archivedAt: 2 }] : [],
    }));
    wrap(<RoutinePage id="S1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Every day at 9:00, Morning summary: work in the Platform CI thread." })).toBeTruthy();
  });

  it("shows the problem with the picker inline; a pick repins and turns the routine on", async () => {
    listWorkflowTriggers.mockResolvedValue({
      triggers: [routine("S1", { enabled: false, detail: { disabledReason: PIN_TEXT, thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ci" } } })],
    });
    wrap(<RoutinePage id="S1" />);
    const problem = await screen.findByRole("region", { name: "Problem" });
    expect(await within(problem).findByText("The pinned thread is archived. Pick another thread:")).toBeTruthy();
    const strip = screen.getByRole("region", { name: "Health" });
    expect(within(strip).getByText("Needs attention")).toBeTruthy();
    expect(within(strip).getByText("The pinned thread is archived")).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "Change When" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps a team routine read-only for a viewer outside the team", async () => {
    teamsData = { teams: [{ id: "team-sre", name: "SRE", callerRole: null }] };
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { detail: { ownerType: "team", ownerId: "team-sre" } })] });
    wrap(<RoutinePage id="S1" />);
    expect(await screen.findByText("Only members of SRE can change this.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "More for Morning summary" }));
    expect(screen.getByRole("menuitem", { name: "Delete" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("opens Edit on a team routine and marks the routine Team", async () => {
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { detail: { ownerType: "team", ownerId: "team-sre" } })] });
    wrap(<RoutinePage id="S1" />);
    expect(await screen.findByText("Team")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: edit-routine Morning summary");
  });

  it("deletes the routine after the confirm, then opens Presence", async () => {
    wrap(<RoutinePage id="S1" />);
    await pickDelete();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Valet stops acting on this schedule. Its past runs stay.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteWorkflowSchedule).toHaveBeenCalledWith("S1"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/presence" }));
  });

  it("names a team routine's team in the Delete confirm", async () => {
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { detail: { ownerType: "team", ownerId: "team-sre" } })] });
    wrap(<RoutinePage id="S1" />);
    await pickDelete();
    expect(await screen.findByText("This is SRE's routine. Valet stops acting on this schedule. Its past runs stay.")).toBeTruthy();
  });

  it("shows a scheduler reason as written, with Edit to fix it", async () => {
    const reason = "Its workflow was deleted. Delete this routine and make a new one with another workflow.";
    listWorkflowTriggers.mockResolvedValue({
      triggers: [routine("S1", { enabled: false, workflowId: "wf-gone", detail: { targetKind: "workflow", disabledReason: reason } })],
    });
    wrap(<RoutinePage id="S1" />);
    const problem = await screen.findByRole("region", { name: "Problem" });
    expect(within(problem).getByText(reason)).toBeTruthy();
    fireEvent.click(within(problem).getByRole("button", { name: "Edit the routine" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: edit-routine Morning summary");
  });

  it("names who may change a routine with a scheduler reason for a read-only viewer (S10)", async () => {
    const reason = "The prompt is empty. Edit the routine and write a prompt.";
    listWorkflowTriggers.mockResolvedValue({
      triggers: [routine("S1", { enabled: false, detail: { ownerId: "u-other", disabledReason: reason } })],
    });
    wrap(<RoutinePage id="S1" />);
    const problem = await screen.findByRole("region", { name: "Problem" });
    expect(within(problem).getByText(reason)).toBeTruthy();
    expect(within(problem).getByText("Only its owner can change this routine.")).toBeTruthy();
    expect(within(problem).queryByRole("button", { name: "Edit the routine" })).toBeNull();
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

  it("lists a workflow routine's runs as firings, with the strip's count and the time each took", async () => {
    const now = Date.now();
    listWorkflowRuns.mockResolvedValue({
      runs: [
        { runId: `${scheduleRunPrefix("S3")}100`, workflowId: "wf-1", status: "settled", outcome: "completed", createdAt: now - 3_600_000, updatedAt: now - 3_600_000 + 40_000 },
        { runId: "wfrun_manual_1", workflowId: "wf-1", status: "settled", outcome: "completed", createdAt: now - 7_200_000, updatedAt: now - 7_100_000 },
        { runId: `${scheduleRunPrefix("S3")}090`, workflowId: "wf-1", status: "running", createdAt: now - 40 * 86_400_000, updatedAt: now - 40 * 86_400_000 },
      ],
    });
    wrap(<RoutinePage id="S3" />);
    await waitFor(() => expect(activityRows()).toHaveLength(2));
    expect(activityRows()[0]).toContain("Fired → started Build run40 s");
    expect(activityRows()[1]).toContain("Fired → started Build run");
    expect(within(screen.getByRole("region", { name: "Activity" })).getAllByRole("link", { name: "Build" })[0]!.getAttribute("href")).toBe("/workflows/wf-1");
    const strip = screen.getByRole("region", { name: "Health" });
    // One firing in 30 days; the manual run is not this routine's.
    expect(within(strip).getByText("1")).toBeTruthy();
    expect(within(strip).getByText("1h ago")).toBeTruthy();
    expect(listWorkflowRuns).toHaveBeenCalledWith("wf-1");
  });

  it("counts the firings its 30 bars show, so the count is the sum of the bars (S11)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = Date.UTC(2026, 9, 19, 12);
      vi.setSystemTime(now);
      const firstBarDay = Date.UTC(2026, 9, 19) - 29 * 86_400_000;
      listWorkflowRuns.mockResolvedValue({
        runs: [
          { runId: `${scheduleRunPrefix("S3")}2`, workflowId: "wf-1", status: "running", createdAt: now - 3_600_000, updatedAt: now - 3_600_000 },
          // Inside 30 × 24 hours, but on the UTC day before the first bar.
          { runId: `${scheduleRunPrefix("S3")}1`, workflowId: "wf-1", status: "running", createdAt: firstBarDay - 3_600_000, updatedAt: firstBarDay - 3_600_000 },
        ],
      });
      wrap(<RoutinePage id="S3" />);
      await waitFor(() => expect(activityRows()).toHaveLength(2));
      const strip = screen.getByRole("region", { name: "Health" });
      const bars = Array.from(strip.querySelectorAll<HTMLElement>("[data-day]")).map((bar) => Number.parseInt(bar.title, 10));
      const count = strip.querySelector('[data-fact="count"] [data-fact-value]')?.textContent;
      expect(count).toBe(String(bars.reduce((sum, n) => sum + n, 0)));
      expect(count).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an assistant routine's last firing, and no count it does not record", async () => {
    listWorkflowTriggers.mockResolvedValue({ triggers: [routine("S1", { detail: { lastFiredAt: Date.now() - 2 * 3_600_000 } })] });
    wrap(<RoutinePage id="S1" />);
    const strip = await screen.findByRole("region", { name: "Health" });
    expect(within(strip).getByText("2h ago")).toBeTruthy();
    expect(within(strip).queryByText("times in 30 days")).toBeNull();
    expect(activityRows()).toEqual([expect.stringContaining("Fired → worked in its own thread")]);
    expect(listWorkflowRuns).not.toHaveBeenCalled();
  });

  it("names the fix for a routine that is not in the list", async () => {
    wrap(<RoutinePage id="gone" />);
    expect(await screen.findByText("This page does not exist, or you cannot see it.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Presence" }).getAttribute("href")).toBe("/presence");
  });
});
