// @vitest-environment jsdom
/**
 * The Presence overview as a roster (docs/specs/2026-10-16-presence-hub-design.md
 * Part B; plan Review Focus 1 to 4). The test renders the app's real route tree
 * at `/presence` under a memory history. The network is a `fetch` stub that
 * answers each api path with a fixture typed by the wire types and keeps
 * the one write the overview makes here (a pick), so every query hook and
 * invalidation runs as it does in the browser.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  EnsureWorkspaceRuntimeResponse,
  EventLogItem,
  EventLogResponse,
  EventSubscriptionWire,
  GetWorkflowTriggerCatalogResponse,
  ListEventSubscriptionsResponse,
  ListPresencePlacesResponse,
  ListThreadsResponse,
  ListWorkflowTriggersResponse,
  ListWorkflowsResponse,
  CreateWorkflowScheduleRequest,
  PatchEventSubscriptionRequest,
  PresencePlaceWire,
  WorkflowScheduleResponse,
  WorkflowTriggerItem,
} from "@valet/api/wire";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = { id: "u-001", email: "u@acme.test", name: "U One", orgId: "acme", orgRole: "admin", role: "admin" };

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useMe: () => ({ data: ME, isLoading: false, isFetching: false, error: null, isError: false, isSuccess: true }),
    useOrg: () => ({ data: { callerRole: "admin", features: { organizations: true }, plugins: [] }, isLoading: false, error: null }),
    useTeams: () => ({ data: { teams: [] }, isLoading: false, error: null }),
  };
});
vi.mock("~/components/layout/notifications-bell", () => ({ NotificationsBell: () => null }));
vi.mock("~/components/product-announcement", () => ({ ProductAnnouncement: () => null }));
vi.mock("~/lib/use-attention-ping", () => ({ useAttentionPing: () => {} }));
vi.mock("~/components/layout/workspace-assistant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/components/layout/workspace-assistant")>();
  return {
    ...actual,
    WorkspaceAssistantProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    WorkspaceAssistantDock: () => null,
    WorkspaceAssistantButton: () => null,
    useWorkspaceAssistant: () => ({ open: () => {}, panel: null }),
  };
});

import { routeTree } from "../../routeTree.gen";
import { announceCreated, clearCreated } from "./created-highlight";
import { PIN_UNAVAILABLE } from "./problem-badge";
import { PLATFORM_CI, PLATFORM_OPS, line } from "./test-fixtures";

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOW = Date.now();

function place(subject: string, label: string, service: PresencePlaceWire["service"], parent: string | null, activeThreadCount = 0, lastActivityAt: number | null = NOW - 60_000): PresencePlaceWire {
  return { subject, label, service, parent, listenerCount: 1, activeThreadCount, lastActivityAt };
}

const ACME_REPO = [{ field: "repo", op: "eq" as const, value: "acme/api" }];
const R1 = line("R1", {
  name: "Reviews and checks",
  eventKeys: ["github.pull_request_review.submitted", "github.check_run.completed"],
  filters: ACME_REPO,
  target: { kind: "assistant", thread: { mode: "subject" } },
});
const R4 = line("R4", {
  name: "CI failures",
  eventKeys: ["github.check_run.completed"],
  filters: ACME_REPO,
  target: { kind: "assistant", thread: { mode: "existing", sessionId: "s-u", threadId: "t-ci" } },
  problem: PIN_UNAVAILABLE,
});
const ANYWHERE = line("A", {
  name: "Mentions anywhere", eventKeys: ["slack.app_mention"], target: { kind: "assistant", thread: { mode: "new" } },
});
const ENG_LINE = line("L", {
  name: "New ENG issues", eventKeys: ["linear.issue.create"], filters: [{ field: "team", op: "eq", value: "ENG" }],
  target: { kind: "assistant", thread: { mode: "own" } },
});

const SLACK_ROOT = place("slack:T1", "Slack", "slack", null, 0, null);
const INCIDENTS = place("slack:T1/C900", "#incidents", "slack", "slack:T1");
const ACME_API = place("github:acme/api", "acme/api", "github", null, 1);
const ACME_API_12 = place("github:acme/api#12", "acme/api#12", "github", "github:acme/api", 1);
const ENG = place("linear:team/ENG", "ENG", "linear", null);

const S1: WorkflowTriggerItem = {
  kind: "schedule", id: "S1", name: "Morning summary", enabled: true,
  detail: {
    cron: "0 9 * * *", timezone: "UTC", targetKind: "assistant", prompt: "Summarize the night.",
    thread: { mode: "own" }, nextFireAt: NOW + 3_600_000, lastFiredAt: null, ownerType: "user", ownerId: "u-001",
  },
};

const THREADS: ListThreadsResponse = {
  threads: [
    { ...PLATFORM_CI, archivedAt: NOW - 86_400_000 },
    { ...PLATFORM_OPS, lastUserActivityAt: NOW - 1_000 },
  ],
};
const WORKFLOWS: ListWorkflowsResponse = { workflows: [] };
const TRIGGER_CATALOG: GetWorkflowTriggerCatalogResponse = { catalog: [] };

// ── The fetch stub ───────────────────────────────────────────────────────

let places: PresencePlaceWire[] = [];
let rules: EventSubscriptionWire[] = [];
let routines: WorkflowTriggerItem[] = [];
let placesFail = false;
let logItems: EventLogItem[] = [];
const patches: Array<{ id: string; body: PatchEventSubscriptionRequest }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function readBody<T>(body: string | undefined): T {
  // The stub reads the body the client serialized from the same wire type.
  return JSON.parse(body ?? "{}") as T;
}

function answer(method: string, url: URL, body: string | undefined): Response {
  const path = url.pathname;
  const patch = /^\/api\/event-subscriptions\/([^/]+)$/.exec(path);
  if (method === "PATCH" && patch) {
    const id = decodeURIComponent(patch[1]!);
    const request = readBody<PatchEventSubscriptionRequest>(body);
    patches.push({ id, body: request });
    const index = rules.findIndex((sub) => sub.id === id);
    const current = rules[index];
    if (current === undefined) return json({ error: "not in this test" }, 404);
    // A pin change clears the problem (spec Deviations, Problem state source).
    const { problem: _cleared, ...rest } = current;
    const next: EventSubscriptionWire = request.thread !== undefined && request.thread !== null && current.target.kind === "assistant"
      ? { ...rest, updatedAt: NOW, target: { ...current.target, thread: request.thread } }
      : current;
    rules = rules.map((sub) => (sub.id === id ? next : sub));
    return json(next);
  }
  if (method === "POST" && path === "/api/workflows/schedules") {
    // The created routine joins the list the next read returns, as the server stores it.
    const request = readBody<CreateWorkflowScheduleRequest>(body);
    const prompt = request.target.kind === "assistant" ? request.target.prompt : "";
    const schedule: WorkflowScheduleResponse["schedule"] = {
      scheduleId: "S-new", targetKind: "assistant", prompt,
      name: request.name, cron: request.cron, timezone: request.timezone ?? "UTC", enabled: true, lastFiredAt: null, nextFireAt: NOW + 3_600_000,
    };
    routines = [...routines, {
      kind: "schedule", id: schedule.scheduleId, name: schedule.name, enabled: true,
      detail: {
        cron: schedule.cron, timezone: schedule.timezone, targetKind: "assistant", prompt,
        thread: { mode: "own" }, nextFireAt: schedule.nextFireAt, lastFiredAt: null, ownerType: "user", ownerId: "u-001",
      },
    }];
    return json({ schedule } satisfies WorkflowScheduleResponse);
  }
  if (method === "POST" && /^\/api\/workspaces\/[^/]+\/runtime$/.test(path)) {
    const ensured: EnsureWorkspaceRuntimeResponse = { sessionId: "s-u" };
    return json(ensured);
  }
  if (method !== "GET") return json({ error: "not in this test" }, 404);
  if (path === "/api/presence/places") {
    if (placesFail) return json({ error: "boom" }, 500);
    return json({ places } satisfies ListPresencePlacesResponse);
  }
  if (path === "/api/event-subscriptions") return json({ subscriptions: rules } satisfies ListEventSubscriptionsResponse);
  if (path === "/api/workflows/triggers") return json({ triggers: routines } satisfies ListWorkflowTriggersResponse);
  if (path === "/api/workflows/trigger-catalog") return json(TRIGGER_CATALOG);
  if (path === "/api/workflows") return json(WORKFLOWS);
  if (path === "/api/events/log") {
    return json({ items: logItems, nextCursor: null, lastEventAt: null, windowDays: 30 } satisfies EventLogResponse);
  }
  if (/^\/api\/sessions\/[^/]+\/threads$/.test(path)) return json(THREADS);
  return json({ error: "not in this test" }, 404);
}

beforeEach(() => {
  places = [SLACK_ROOT, INCIDENTS, ACME_API, ACME_API_12, ENG];
  rules = [R1, R4, ANYWHERE, ENG_LINE];
  routines = [S1];
  placesFail = false;
  logItems = [];
  patches.length = 0;
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const text = typeof init?.body === "string" ? init.body : undefined;
    return answer(init?.method ?? "GET", new URL(raw, "http://valet.test"), text);
  });
});

afterEach(() => {
  cleanup();
  clearCreated();
  Element.prototype.scrollIntoView = ORIGINAL_SCROLL;
  vi.unstubAllGlobals();
});

function mountOverview() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: ["/presence"] }) });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { router, queryClient };
}

const ORIGINAL_SCROLL = Element.prototype.scrollIntoView;

/** Records each element the overview scrolls into view. jsdom has no layout, so the method is a stub. */
function spyScroll(): HTMLElement[] {
  const scrolled: HTMLElement[] = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    scrolled.push(this);
  };
  return scrolled;
}

/** The text of every `h2` group heading, in order. */
function groupNames(): string[] {
  return screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent ?? "").filter((name) => name !== "Needs attention");
}

/** The count at the right of each group heading, in order. */
function groupCounts(): string[] {
  return screen.getAllByRole("heading", { level: 2 })
    .filter((heading) => heading.textContent !== "Needs attention")
    .map((heading) => heading.nextElementSibling?.textContent ?? "");
}

/** A sentence link's text, for the rows of a region. */
function sentences(region: HTMLElement): string[] {
  return within(region).getAllByRole("link").map((link) => link.textContent ?? "").filter((text) => text.startsWith("When ") || text.startsWith("Every "));
}

function detailsOf(summary: HTMLElement): HTMLDetailsElement {
  const details = summary.closest("details");
  if (!(details instanceof HTMLDetailsElement)) throw new Error("The summary has no details element.");
  return details;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Presence overview", () => {
  it("pairs Activity and Add at the header's right, with no other link to Activity", async () => {
    mountOverview();
    await screen.findByRole("heading", { level: 2, name: "On a schedule" });
    const add = screen.getByRole("button", { name: "Add" });
    const activity = screen.getByRole("link", { name: "Activity" });
    expect(activity.getAttribute("href")).toBe("/presence/activity");
    expect(activity.parentElement).toBe(add.parentElement);
    expect(screen.getAllByRole("link", { name: "Activity" })).toHaveLength(1);
    // The pair sits in the header row with the title, not under the groups.
    const header = screen.getByRole("heading", { level: 1, name: "Presence" }).closest(".justify-between");
    expect(header?.contains(add)).toBe(true);
  });

  it("lands on the groups in order, with place rows, sentences, and routines", async () => {
    mountOverview();
    await screen.findByRole("heading", { level: 2, name: "On a schedule" });
    expect(groupNames()).toEqual(["Slack", "GitHub", "Linear", "On a schedule"]);
    expect(groupCounts()).toEqual(["1 place", "1 place", "1 place", "1 routine"]);

    const acme = screen.getByRole("region", { name: "acme/api" });
    expect(within(acme).getByRole("link", { name: "acme/api" }).getAttribute("href")).toBe("/presence/places/github%3Aacme%2Fapi");
    expect(within(acme).getByText("1 active thread")).toBeTruthy();
    await waitFor(() => expect(sentences(acme)).toEqual([
      "When a pull request review or a check completes, work in one thread per pull request.",
      "When a check completes, work in the Platform CI thread.",
    ]));
    // No pull request row and no row for a place without a line.
    expect(screen.queryByRole("region", { name: "acme/api#12" })).toBeNull();
    expect(screen.queryByRole("region", { name: "#incidents" })).toBeNull();
    expect(screen.getByRole("region", { name: "ENG" })).toBeTruthy();

    const schedule = screen.getByRole("region", { name: "On a schedule" });
    const routine = within(schedule).getByRole("region", { name: "Morning summary" });
    expect(within(routine).getByRole("link", { name: "Morning summary: work in its own thread." }).getAttribute("href")).toBe("/presence/routines/S1");
    expect(within(routine).getByText("Summarize the night.")).toBeTruthy();
    expect(within(routine).getByText(/^Next /)).toBeTruthy();
    expect(within(routine).getByRole("button", { name: "Fire Morning summary now" })).toBeTruthy();
    expect(within(routine).getByRole("button", { name: "+ New routine" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Presence" })).toBeNull();
  });

  it("draws no card in the roster: no element has a border on all sides with rounded corners", async () => {
    mountOverview();
    const schedule = await screen.findByRole("region", { name: "On a schedule" });
    const roster = schedule.parentElement;
    if (roster === null) throw new Error("The groups have no container.");
    // The thread picker in a fix is a form control, not a place's frame.
    const cards = [roster, ...roster.querySelectorAll("*")].filter((element) => {
      if (element.closest('[role="group"][aria-label="Problem"]') !== null) return false;
      const classes = [...element.classList];
      return classes.includes("border") && classes.some((name) => name.startsWith("rounded"));
    });
    expect(cards).toEqual([]);
    const heading = within(schedule).getByRole("heading", { level: 2, name: "On a schedule" });
    expect(heading.className).toContain("text-xs");
    expect(heading.parentElement?.className).toContain("border-b");
  });

  it("shows only the schedule group for a workspace with a routine and no place (Review Focus 1)", async () => {
    places = [];
    rules = [];
    mountOverview();
    await screen.findByRole("heading", { level: 2, name: "On a schedule" });
    expect(groupNames()).toEqual(["On a schedule"]);
    expect(screen.queryByText("Valet is not present anywhere yet.")).toBeNull();
  });

  it("shows the empty state for a workspace with no place and no routine, with Add and no Activity (Review Focus 1)", async () => {
    places = [];
    rules = [];
    routines = [];
    mountOverview();
    expect(await screen.findByText("Valet is not present anywhere yet.")).toBeTruthy();
    expect(screen.getByText(/^Choose Add to have Valet act on a schedule\./)).toBeTruthy();
    for (const name of ["Slack", "GitHub", "Linear"]) {
      expect(screen.getByRole("link", { name }).getAttribute("href")).toBe("/integrations");
    }
    expect(screen.getAllByRole("button", { name: "Add" })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Activity" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "On a schedule" })).toBeNull();
  });

  it("reads Loading… while a read is pending, and names the fix when a read fails", async () => {
    placesFail = true;
    mountOverview();
    expect(await screen.findByText("Loading…")).toBeTruthy();
    const alert = await screen.findByText("Could not load Presence. Reload the page to try again.");
    expect(alert.getAttribute("role")).toBe("alert");
  });

  it("puts a line that names no place in the service row, once (Review Focus 2)", async () => {
    mountOverview();
    const slack = await screen.findByRole("region", { name: "Everywhere in Slack" });
    expect(within(slack).getByRole("link", { name: "Everywhere in Slack" }).getAttribute("href")).toBe("/presence/places/slack%3AT1");
    expect(sentences(slack)).toEqual(["When someone mentions Valet, reply in a new thread."]);
    const everywhere = screen.getAllByRole("link").filter((link) => link.textContent === "When someone mentions Valet, reply in a new thread.");
    expect(everywhere).toHaveLength(1);
  });

  it("fixes a line from the banner: the item and the row's problem line go (Review Focus 3, INV-H6)", async () => {
    mountOverview();
    const banner = await screen.findByRole("region", { name: "Needs attention" });
    const lead = await within(banner).findByText("Platform CI is archived. Pick another thread:");
    expect(lead.textContent).toBe("In acme/api, Platform CI is archived. Pick another thread:");
    const acme = screen.getByRole("region", { name: "acme/api" });
    expect(await within(acme).findByText("Platform CI is archived. Pick another thread:")).toBeTruthy();

    await userEvent.click(await within(banner).findByRole("option", { name: /Platform Ops/ }));
    await waitFor(() => expect(patches).toEqual([{ id: "R4", body: { thread: { mode: "existing", sessionId: "s-u", threadId: "t-ops" } } }]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull());
    await waitFor(() => expect(within(acme).queryByText("Platform CI is archived. Pick another thread:")).toBeNull());
    expect(sentences(acme)).toContain("When a check completes, work in the Platform Ops thread.");
  });

  it("collapses past ten places, keeps a faulted group open, and opens a group on a match (Review Focus 4)", async () => {
    const channels = Array.from({ length: 10 }, (_unused, index) => place(`slack:T1/C${index}`, `#chan-${index}`, "slack", "slack:T1"));
    places = [SLACK_ROOT, ...channels, ACME_API];
    rules = [
      ...channels.map((channel, index) => line(`M${index}`, {
        name: `Mentions ${index}`, eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: `C${index}` }],
      })),
      R4,
    ];
    mountOverview();
    const filter = await screen.findByRole("searchbox", { name: "Filter places" });
    const slack = screen.getByRole("heading", { level: 2, name: "Slack" });
    const github = screen.getByRole("heading", { level: 2, name: "GitHub" });
    expect(slack.closest("summary")).not.toBeNull();
    expect(groupCounts()).toEqual(["10 places", "1 place", "1 routine"]);
    await waitFor(() => expect(detailsOf(github).open).toBe(true));
    expect(detailsOf(slack).open).toBe(false);
    expect(detailsOf(screen.getByRole("heading", { level: 2, name: "On a schedule" })).open).toBe(false);

    await userEvent.type(filter, "chan-3");
    await waitFor(() => expect(detailsOf(screen.getByRole("heading", { level: 2, name: "Slack" })).open).toBe(true));
    // The filter reads place names; the schedule group stays, still collapsed.
    expect(groupCounts()).toEqual(["1 place", "1 routine"]);
    expect(screen.getByRole("region", { name: "#chan-3" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "#chan-4" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "GitHub" })).toBeNull();
  });

  it("keeps a collapsed group open when its only fault is a dead delivery (Part B step 8)", async () => {
    const channels = Array.from({ length: 10 }, (_unused, index) => place(`slack:T1/C${index}`, `#chan-${index}`, "slack", "slack:T1"));
    places = [SLACK_ROOT, ...channels, ACME_API];
    rules = [
      ...channels.map((channel, index) => line(`M${index}`, {
        name: `Mentions ${index}`, eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: `C${index}` }],
      })),
      R1,
    ];
    logItems = [{
      kind: "event", id: "ev-14", at: NOW - 60_000, status: "failed", service: "github", eventKey: "github.check_run.completed",
      summary: "ev-14", actor: null, reason: null, detail: null, deliveryCount: 1, place: "acme/api#14",
      deliveries: [{ id: "d-1", subscriptionId: "R1", status: "dead", attempts: 3, lastError: null, deliveredAt: null }],
    }];
    mountOverview();
    await screen.findByRole("searchbox", { name: "Filter places" });
    const banner = await screen.findByRole("region", { name: "Needs attention" });
    expect(within(banner).getByText("In acme/api,")).toBeTruthy();
    await waitFor(() => expect(detailsOf(screen.getByRole("heading", { level: 2, name: "GitHub" })).open).toBe(true));
    expect(detailsOf(screen.getByRole("heading", { level: 2, name: "Slack" })).open).toBe(false);
  });

  it("leaves a collapsed group open after a pick fixes its last fault", async () => {
    const channels = Array.from({ length: 10 }, (_unused, index) => place(`slack:T1/C${index}`, `#chan-${index}`, "slack", "slack:T1"));
    places = [SLACK_ROOT, ...channels, ACME_API];
    rules = [
      ...channels.map((channel, index) => line(`M${index}`, {
        name: `Mentions ${index}`, eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: `C${index}` }],
      })),
      R4,
    ];
    mountOverview();
    const banner = await screen.findByRole("region", { name: "Needs attention" });
    const github = screen.getByRole("heading", { level: 2, name: "GitHub" });
    await waitFor(() => expect(detailsOf(github).open).toBe(true));
    const details = detailsOf(github);
    await userEvent.click(await within(banner).findByRole("option", { name: /Platform Ops/ }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull());
    // The same element, still open: no remount, no snap shut.
    expect(detailsOf(screen.getByRole("heading", { level: 2, name: "GitHub" }))).toBe(details);
    expect(details.open).toBe(true);
    expect(sentences(screen.getByRole("region", { name: "acme/api" }))).toContain("When a check completes, work in the Platform Ops thread.");
  });

  it("opens the wizard on When with all four choices from Add", async () => {
    mountOverview();
    await screen.findByRole("heading", { level: 2, name: "On a schedule" });
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const when = within(await screen.findByRole("group", { name: "When" }));
    expect(when.getAllByRole("radio").map((radio) => radio.parentElement?.textContent)).toEqual([
      "Someone mentions Valet in Slack", "Something happens on GitHub", "Something happens in Linear", "On a schedule",
    ]);
  });

  it("anchors the On a schedule group at #schedule for the routine page's crumb", async () => {
    mountOverview();
    const heading = await screen.findByRole("heading", { level: 2, name: "On a schedule" });
    expect(heading.id).toBe("schedule");
  });

  it("after Create from Add, scrolls to the schedule group and marks it for two seconds (Part H step 9)", async () => {
    const scrolled = spyScroll();
    mountOverview();
    await screen.findByRole("heading", { level: 2, name: "On a schedule" });
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.click(within(await screen.findByRole("group", { name: "When" })).getByLabelText("On a schedule"));
    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    await userEvent.type(screen.getByLabelText("Cron"), "0 9 * * 1-5");
    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    await userEvent.type(screen.getByLabelText("Prompt"), "Daily digest");
    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    await userEvent.type(screen.getByLabelText("Routine name"), "Evening digest");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    const schedule = screen.getByRole("region", { name: "On a schedule" });
    await waitFor(() => expect(within(schedule).getByRole("region", { name: "Evening digest" })).toBeTruthy());
    await waitFor(() => expect(schedule.getAttribute("data-highlight")).toBe("true"));
    expect(schedule.className).toContain("bg-moss-wash");
    await waitFor(() => expect(scrolled).toContain(schedule));
    await waitFor(() => expect(schedule.getAttribute("data-highlight")).toBeNull(), { timeout: 3_000 });
    expect(schedule.className).not.toContain("bg-moss-wash");
  });

  it("marks a new line's place only once the refetched list holds it", async () => {
    const scrolled = spyScroll();
    const { queryClient } = mountOverview();
    const eng = await screen.findByRole("region", { name: "ENG" });
    act(() => announceCreated({ kind: "line", id: "L2" }));
    // The list does not hold L2 yet, so nothing is marked.
    expect(document.querySelector('[data-highlight="true"]')).toBeNull();

    rules = [...rules, line("L2", {
      name: "Closed ENG issues", eventKeys: ["linear.issue.update"], filters: [{ field: "team", op: "eq", value: "ENG" }],
      target: { kind: "assistant", thread: { mode: "own" } },
    })];
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(eng.getAttribute("data-highlight")).toBe("true"));
    expect(eng.className).toContain("bg-moss-wash");
    await waitFor(() => expect(scrolled).toEqual([eng]));
    expect(screen.getByRole("region", { name: "acme/api" }).getAttribute("data-highlight")).toBeNull();
  });
});
