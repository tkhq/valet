// @vitest-environment jsdom
/**
 * The Presence hub acceptance scenario, P1 to P12, revision 3
 * (docs/specs/2026-10-16-presence-hub-design.md, "Acceptance scenario").
 *
 * The test renders the app's real route tree (`routeTree.gen.ts`, with the
 * root layout, the nav, and the workspace switcher) under a memory history.
 * The network is a `fetch` stub that answers each api path with a fixture
 * typed by the wire types, so every query hook, search schema, and redirect
 * runs as it does in the browser. The stub keeps the writes the scenario
 * makes (a create, a pick) and lists them on the next read. The repo has no
 * browser driver for the web app; the api integration suite
 * `integration/presence-hub.test.ts` runs the data half of the scenario
 * over a real database.
 *
 * `/presence` lands on the overview roster (Part B). Each place and each
 * drill-in is reached from the overview, as a reader reaches it.
 *
 * P11 renders the thread context card's background section on its own
 * router, because the thread page needs a live session socket. The thread
 * header's place label is a pure function, so P11 asserts it directly.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CreateEventSubscriptionRequest,
  CreateWorkflowScheduleRequest,
  EnsureWorkspaceRuntimeResponse,
  EventDeliveryWire,
  EventLogItem,
  EventLogResponse,
  EventSubscriptionWire,
  EventSummaryWire,
  GetEventCatalogResponse,
  GetWorkflowTriggerCatalogResponse,
  ListAllWorkflowRunsResponse,
  ListEventSubscriptionsResponse,
  ListIdentityLinksResponse,
  ListPresencePlacesResponse,
  ListSessionWakeupsResponse,
  ListThreadFeedersResponse,
  ListThreadsResponse,
  ListWorkflowTriggersResponse,
  ListWorkflowsResponse,
  PatchEventSubscriptionRequest,
  PresencePlaceDetailResponse,
  PresencePlaceWire,
  TeamSummary,
  WorkflowScheduleResponse,
  WorkflowTriggerItem,
} from "@valet/api/wire";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Universe: org acme, user u-001, team sre ─────────────────────────────

const ME = { id: "u-001", email: "u@acme.test", name: "U One", orgId: "acme", orgRole: "admin", role: "admin" };
const SRE: TeamSummary = {
  id: "sre", orgId: "acme", name: "SRE", origin: "local", externalId: null, createdAt: 1,
  memberCount: 3, callerRole: "member", defaultModel: null,
};

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useMe: () => ({ data: ME, isLoading: false, isFetching: false, error: null, isError: false, isSuccess: true }),
    useOrg: () => ({ data: { callerRole: "admin", features: { organizations: true }, plugins: [] }, isLoading: false, error: null }),
    useTeams: () => ({ data: { teams: [SRE] }, isLoading: false, error: null }),
  };
});

// Chrome outside the scenario: each owns its own reads and its own suite.
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

import { routeTree } from "../routeTree.gen";
import { BackgroundWorkSection } from "~/components/session/background-work";
import { subjectPlaceLabel } from "~/components/session/session-header";
import { TooltipProvider } from "~/components/primitives";
import { clearCreated } from "~/components/presence/created-highlight";
import { place } from "~/components/presence/test-fixtures";

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOW = Date.now();
/** The dead-letter text the api stores for an archived pin. */
const PIN_UNAVAILABLE = "Pick another thread in Presence.";

function line(id: string, over: Partial<EventSubscriptionWire>): EventSubscriptionWire {
  return {
    id, name: id, ownerType: "user", ownerId: "u-001", eventKeys: [], filters: [],
    target: { kind: "assistant" }, enabled: true, createdBy: "u-001", createdAt: 1, updatedAt: 1, ...over,
  };
}

const ACME_REPO = [{ field: "repo", op: "eq" as const, value: "acme/api" }];
const INCIDENTS_CHANNEL = [{ field: "channel", op: "eq" as const, value: "C900", label: "#incidents" }];

const R1 = line("R1", {
  name: "Reviews and checks",
  eventKeys: ["github.pull_request_review.submitted", "github.check_run.completed"],
  filters: ACME_REPO,
  target: { kind: "assistant", thread: { mode: "subject" } },
});
const R4_BROKEN = line("R4", {
  name: "CI failures",
  eventKeys: ["github.check_run.completed"],
  filters: ACME_REPO,
  target: { kind: "assistant", thread: { mode: "existing", sessionId: "s-u", threadId: "t-ci" } },
  problem: PIN_UNAVAILABLE,
});
const M = line("M", {
  name: "Incident mentions", ownerType: "team", ownerId: "sre", eventKeys: ["slack.app_mention"], filters: INCIDENTS_CHANNEL,
  target: { kind: "assistant", assistant: "team", teamId: "sre", appearance: { displayName: "Ops Bot" }, thread: { mode: "new" } },
});
const P = line("P", {
  name: "Channel watch", ownerType: "team", ownerId: "sre", eventKeys: ["slack.message"], filters: INCIDENTS_CHANNEL,
  target: { kind: "assistant", assistant: "team", teamId: "sre", thread: { mode: "existing", sessionId: "s-sre", threadId: "t-inc" } },
});

/** The place's line and active thread counts, last active a minute ago. */
function counts(listenerCount: number, activeThreadCount: number): Partial<PresencePlaceWire> {
  return { listenerCount, activeThreadCount, lastActivityAt: NOW - 60_000 };
}

const SLACK_ROOT = place("slack:T1", "Slack", "slack", null, counts(0, 0));
const INCIDENTS_USER = place("slack:T1/C900", "#incidents", "slack", "slack:T1", counts(0, 0));
const INCIDENTS_SRE = place("slack:T1/C900", "#incidents", "slack", "slack:T1", counts(2, 1));
const ACME_API = place("github:acme/api", "acme/api", "github", null, counts(2, 1));
const ACME_API_12 = place("github:acme/api#12", "acme/api#12", "github", "github:acme/api", counts(0, 0));

const PLACES: Record<string, ListPresencePlacesResponse> = {
  user: { places: [SLACK_ROOT, INCIDENTS_USER, ACME_API, ACME_API_12] },
  sre: { places: [SLACK_ROOT, INCIDENTS_SRE] },
};

function conversation(sessionId: string, threadId: string, title: string, url?: string) {
  return { sessionId, threadId, title, lastActivityAt: NOW - 120_000, ...(url ? { url } : {}) };
}

const C2_MENTION: EventSummaryWire = {
  id: "ev-c2", service: "slack", eventKey: "slack.app_mention", summary: "@Valet the deploy is failing",
  refs: { channel: "C900", channel_name: "incidents" }, actor: { externalId: "U-alice", login: "alice" },
  occurredAt: NOW - 30_000, receivedAt: NOW - 30_000,
};

/** The place pages, by `<workspace> <place key>`. The lines come from `rules` at read time. */
const PLACE_DETAIL: Record<string, Omit<PresencePlaceDetailResponse, "listeners">> = {
  "user github:acme/api": {
    place: ACME_API,
    threads: {
      subject: [conversation("s-u", "t-12", "acme/api#12"), conversation("s-u", "t-13", "acme/api#13")],
      following: [],
      active: [conversation("s-u", "t-12", "acme/api#12")],
    },
    activity: [],
  },
  "sre slack:T1/C900": {
    place: INCIDENTS_SRE,
    threads: {
      subject: [],
      following: [conversation("s-sre", "t-inc", "t-inc", "https://acme.slack.com/archives/C900/p1")],
      active: [conversation("s-sre", "t-inc", "t-inc")],
    },
    activity: [C2_MENTION],
  },
};

const S1: WorkflowTriggerItem = {
  kind: "schedule", id: "S1", name: "Morning summary", enabled: true,
  detail: {
    cron: "0 9 * * *", timezone: "UTC", targetKind: "assistant", prompt: "Summarize the night.",
    thread: { mode: "own" }, nextFireAt: NOW + 3_600_000, lastFiredAt: null, ownerType: "user", ownerId: "u-001",
  },
};
const WF_LINE = line("R-wf", {
  name: "Run triage", eventKeys: ["github.check_run.completed"], filters: ACME_REPO,
  target: { kind: "workflow", workflowId: "wf-1" },
});
const WF_EVENT: WorkflowTriggerItem = {
  kind: "event", id: "R-wf", workflowId: "wf-1", name: "Run triage", enabled: true,
  detail: { eventKeys: ["github.check_run.completed"], filters: ACME_REPO },
};
const WF_ROUTINE: WorkflowTriggerItem = {
  kind: "schedule", id: "S-wf", workflowId: "wf-1", name: "Nightly triage", enabled: true,
  detail: {
    cron: "0 2 * * *", timezone: "UTC", targetKind: "workflow", nextFireAt: NOW + 7_200_000, lastFiredAt: null,
    ownerType: "user", ownerId: "u-001",
  },
};

const WORKFLOWS: ListWorkflowsResponse = {
  workflows: [{
    id: "wf-1", name: "Triage failures", ownerType: "user", ownerId: "u-001", createdAt: 1, updatedAt: 1,
    definition: { version: "dag/v1", nodes: [{ id: "trigger", type: "trigger" }], edges: [] },
  }],
};
const RUNS: ListAllWorkflowRunsResponse = {
  runs: [{ runId: "run-1", workflowId: "wf-1", workflowName: "Triage failures", status: "settled", outcome: "completed", createdAt: NOW - 600_000, updatedAt: NOW - 500_000 }],
};

function delivery(over: Partial<EventDeliveryWire>): EventDeliveryWire {
  return { id: "d-1", subscriptionId: "M", subscriptionName: "Incident mentions", status: "delivered", attempts: 1, lastError: null, deliveredAt: NOW, ...over };
}
function logEvent(id: string, service: string, eventKey: string, placeName: string, deliveries: EventDeliveryWire[], status: EventLogItem["status"]): EventLogItem {
  return {
    kind: "event", id, at: NOW - 30_000, status, service, eventKey, summary: `summary of ${id}`, actor: "alice",
    reason: null, detail: null, deliveryCount: deliveries.length, place: placeName, deliveries,
  };
}
const T_INC = { sessionId: "s-sre", threadId: "t-inc", title: "t-inc" };
const C2_ROW = logEvent("ev-c2", "slack", "slack.app_mention", "#incidents", [delivery({ thread: T_INC })], "delivered");
/** The sre delivery that dead-lettered on R4's archived pin. */
const DEAD_ROW = logEvent("ev-14", "github", "github.check_run.completed", "acme/api#14", [
  delivery({ id: "d-14", subscriptionId: "R4", subscriptionName: "CI failures", status: "dead", attempts: 3, lastError: PIN_UNAVAILABLE, deliveredAt: null }),
], "failed");

function logPage(items: EventLogItem[]): EventLogResponse {
  return { items, nextCursor: null, lastEventAt: NOW - 30_000, windowDays: 30 };
}

const TRIGGER_CATALOG: GetWorkflowTriggerCatalogResponse = { catalog: [] };
const EVENT_CATALOG: GetEventCatalogResponse = {
  services: [
    {
      service: "slack",
      entries: [
        { key: "slack.app_mention", description: "Mention", filters: [{ field: "channel", path: "channel", description: "Channel" }] },
        { key: "slack.message", description: "Message", filters: [{ field: "channel", path: "channel", description: "Channel" }] },
      ],
    },
    {
      service: "github",
      entries: [
        { key: "github.check_run.completed", description: "A check completed", filters: [{ field: "repo", path: "repository.full_name", description: "Repository" }] },
      ],
    },
  ],
};
const IDENTITY_LINKS: ListIdentityLinksResponse = {
  links: [{ provider: "slack", linked: true, channelReady: true, codeDelivery: true, memberSearch: true }],
};
const THREADS: ListThreadsResponse = {
  threads: [
    { id: "t-ci", sessionId: "s-u", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1, archivedAt: NOW - 86_400_000 },
    { id: "t-ops", sessionId: "s-u", title: "Platform Ops", createdAt: 1, lastUserActivityAt: NOW - 1_000 },
  ],
};
const WAKEUPS: ListSessionWakeupsResponse = {
  wakeups: [{
    id: "wk-inc", threadId: "t-inc", kind: "event", status: "running", reason: "wait for the incident to close",
    deadlineAt: NOW + 3_600_000, subject: "slack:T1/C900", subjectLabel: "#incidents", clauseCount: 1, createdAt: NOW,
  }],
  leases: [],
};
const FEEDERS: ListThreadFeedersResponse = {
  listeners: [{ id: "M", name: "Incident mentions" }, { id: "P", name: "Channel watch" }],
  routines: [],
};

// ── The fetch stub ───────────────────────────────────────────────────────

/** The lines each workspace owns, as the api lists them now. Writes change these. */
const rules: Record<string, EventSubscriptionWire[]> = {};
/** Routines each workspace owns, as the api lists them now. */
const routines: Record<string, WorkflowTriggerItem[]> = {};
const created: CreateEventSubscriptionRequest[] = [];
const createdRoutines: CreateWorkflowScheduleRequest[] = [];
const patches: Array<{ id: string; body: PatchEventSubscriptionRequest }> = [];
const unhandled: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function scopeOf(query: URLSearchParams): string {
  return query.get("scope") ?? (query.get("ownerType") === "team" ? query.get("ownerId") ?? "user" : "user");
}

function placeHasLine(subject: string, sub: EventSubscriptionWire): boolean {
  if (subject === "slack:T1/C900") return sub.filters.some((f) => f.field === "channel" && f.value === "C900");
  if (subject === "github:acme/api") return sub.target.kind === "assistant" && sub.filters.some((f) => f.field === "repo" && f.value === "acme/api");
  return false;
}

function readBody<T>(body: string | undefined): T {
  // The stub reads the body the client serialized from the same wire type.
  return JSON.parse(body ?? "{}") as T;
}

function answerWrite(method: string, path: string, body: string | undefined): Response | undefined {
  if (method === "POST" && path === "/api/event-subscriptions") {
    const request = readBody<CreateEventSubscriptionRequest>(body);
    created.push(request);
    const team = request.target.kind === "assistant" && request.target.assistant === "team" ? request.target.teamId : undefined;
    const row = line("R-new", {
      name: request.name, eventKeys: request.eventKeys, filters: request.filters ?? [], target: request.target,
      ...(team !== undefined ? { ownerType: "team" as const, ownerId: team } : {}),
    });
    (rules[team ?? "user"] ??= []).push(row);
    return json(row, 201);
  }
  const patch = /^\/api\/event-subscriptions\/([^/]+)$/.exec(path);
  if (method === "PATCH" && patch) {
    const id = decodeURIComponent(patch[1]!);
    const request = readBody<PatchEventSubscriptionRequest>(body);
    patches.push({ id, body: request });
    for (const list of Object.values(rules)) {
      const index = list.findIndex((sub) => sub.id === id);
      const current = list[index];
      if (current === undefined) continue;
      // A pin change clears the problem (spec Deviations, Problem state source).
      const { problem: _cleared, ...rest } = current;
      // The scenario's one write pins a thread; null (clear the pin) is not in it.
      const next: EventSubscriptionWire = request.thread !== undefined && request.thread !== null && current.target.kind === "assistant"
        ? { ...rest, target: { ...current.target, thread: request.thread } }
        : current;
      list[index] = next;
      return json(next);
    }
    return json({ error: "not in the scenario" }, 404);
  }
  if (method === "POST" && path === "/api/workflows/schedules") {
    const request = readBody<CreateWorkflowScheduleRequest>(body);
    createdRoutines.push(request);
    const response: WorkflowScheduleResponse = {
      schedule: {
        scheduleId: "S-new", targetKind: "assistant", name: request.name, cron: request.cron, timezone: request.timezone ?? "UTC",
        enabled: true, lastFiredAt: null, nextFireAt: NOW + 86_400_000,
      },
    };
    (routines.user ??= []).push({
      kind: "schedule", id: "S-new", name: request.name, enabled: true,
      detail: {
        cron: request.cron, timezone: request.timezone ?? "UTC", targetKind: "assistant", thread: { mode: "own" },
        nextFireAt: NOW + 86_400_000, lastFiredAt: null, ownerType: "user", ownerId: "u-001",
      },
    });
    return json(response, 201);
  }
  const runtime = /^\/api\/workspaces\/([^/]+)\/runtime$/.exec(path);
  if (method === "POST" && runtime) {
    const ensured: EnsureWorkspaceRuntimeResponse = runtime[1] === "user" ? { sessionId: "s-u" } : { sessionId: "s-sre", workspaceSessionId: "s-sre" };
    return json(ensured);
  }
  return undefined;
}

async function answer(method: string, url: URL, body: string | undefined): Promise<Response> {
  const path = url.pathname;
  const q = url.searchParams;
  const write = answerWrite(method, path, body);
  if (write !== undefined) return write;
  if (method !== "GET") {
    unhandled.push(`${method} ${path}`);
    return json({ error: "not in the scenario" }, 404);
  }
  if (path === "/api/presence/places") return json(PLACES[scopeOf(q)] ?? { places: [] });
  const placeMatch = /^\/api\/presence\/places\/(.+)$/.exec(path);
  if (placeMatch) {
    const scope = scopeOf(q);
    const subject = decodeURIComponent(placeMatch[1]!);
    const detail = PLACE_DETAIL[`${scope} ${subject}`];
    if (!detail) return json({ error: "Valet is not present in that place in this workspace." }, 404);
    const response: PresencePlaceDetailResponse = { ...detail, listeners: (rules[scope] ?? []).filter((sub) => placeHasLine(subject, sub)) };
    return json(response);
  }
  if (path === "/api/presence/feeders") return json(FEEDERS);
  if (path === "/api/workflows/trigger-catalog") return json(TRIGGER_CATALOG);
  if (path === "/api/workflows/triggers") {
    const response: ListWorkflowTriggersResponse = q.get("workflowId") === "wf-1"
      ? { triggers: [WF_EVENT, WF_ROUTINE] }
      : { triggers: routines[scopeOf(q)] ?? [] };
    return json(response);
  }
  if (path === "/api/workflows/runs") return json(RUNS);
  if (path === "/api/workflows") return json(WORKFLOWS);
  if (path === "/api/event-subscriptions") {
    const owner = q.get("ownerType") ? scopeOf(q) : undefined;
    const subscriptions = owner === undefined ? [...(rules.user ?? []), ...(rules.sre ?? []), WF_LINE] : rules[owner] ?? [];
    const response: ListEventSubscriptionsResponse = { subscriptions };
    return json(response);
  }
  if (/^\/api\/event-subscriptions\/[^/]+\/deliveries$/.test(path)) return json({ deliveries: [] });
  if (path === "/api/events/log") {
    if (scopeOf(q) !== "sre") return json(logPage([]));
    return json(logPage(q.get("problems") === "1" ? [DEAD_ROW] : [C2_ROW, DEAD_ROW]));
  }
  if (path === "/api/events/receipts") return json({ receipts: [], nextCursor: null, lastReceiptAt: null, retentionDays: 7 });
  if (path === "/api/workflows/wf-1") return json(WORKFLOWS.workflows[0]);
  if (path === "/api/workflows/wf-1/runs") return json({ runs: [] });
  if (path === "/api/events/catalog") return json(EVENT_CATALOG);
  if (path === "/api/events/filter-options") return json({ options: [], reason: "Connect Slack first." });
  if (path === "/api/me/identity-links") return json(IDENTITY_LINKS);
  if (/^\/api\/sessions\/[^/]+\/threads$/.test(path)) return json(THREADS);
  if (/^\/api\/sessions\/[^/]+\/wakeups$/.test(path)) return json(WAKEUPS);
  unhandled.push(`${method} ${path}${url.search}`);
  return json({ error: "not in the scenario" }, 404);
}

beforeEach(() => {
  rules.user = [R1, R4_BROKEN];
  rules.sre = [M, P];
  routines.user = [S1];
  routines.sre = [];
  created.length = 0;
  createdRoutines.length = 0;
  patches.length = 0;
  unhandled.length = 0;
  window.sessionStorage.clear();
  window.localStorage.clear();
  // jsdom has no scrolling. The overview scrolls a new row into view after a Create (Part H step 9).
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : undefined;
    return answer(init?.method ?? "GET", new URL(raw, "http://valet.test"), body);
  });
});

afterEach(() => {
  // The Create highlight keeps its target in a module store; a later walk must not inherit it.
  clearCreated();
  vi.unstubAllGlobals();
});

function mountApp(initial: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [initial] }) });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

async function switchWorkspace(from: string, to: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Workspace: ${from}. Change workspace` }));
  await userEvent.click(screen.getByRole("menuitem", { name: to }));
  await screen.findByRole("button", { name: `Workspace: ${to}. Change workspace` });
}

/** The overview's header row: the `Presence` title, the subtitle, and the action pair. */
function overviewHeader(): HTMLElement {
  const header = screen.getByRole("heading", { level: 1, name: "Presence" }).closest<HTMLElement>(".justify-between");
  if (header === null) throw new Error("The overview has no header row.");
  return header;
}

/** The text of every group heading of the roster, in order. */
function groupNames(): string[] {
  return screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent ?? "").filter((name) => name !== "Needs attention");
}

/** The sentence links of a section of lines, in order. */
function sentences(section: HTMLElement): string[] {
  return within(section).getAllByRole("link").map((link) => link.textContent ?? "").filter((text) => text.startsWith("When "));
}

/** Back to the overview through the first crumb of a detail page. */
async function crumbToOverview(router: ReturnType<typeof mountApp>) {
  await userEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Presence" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/presence"));
  await screen.findByRole("heading", { level: 1, name: "Presence" });
}

describe("Presence hub acceptance (P1 to P12)", () => {
  it("walks the scenario in one run", { timeout: 90_000 }, async () => {
    const router = mountApp("/");

    // P1: the nav shows Presence and Workflows, and no Events or Automation entry.
    const nav = await screen.findByRole("navigation", { name: /primary|main/i });
    expect(within(nav).getByRole("link", { name: "Presence" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Workflows" })).toBeTruthy();
    expect(within(nav).queryByRole("link", { name: "Events" })).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Automation" })).toBeNull();

    // P2: /presence lands on the overview. The header pairs Activity and Add.
    // Needs attention holds one item, R4's archived pin with its picker. The
    // group GitHub holds the acme/api row: an active mark, R1 and R4 as
    // sentences without their place clause and with switches, R4's mark and
    // its fix under its row. The group On a schedule holds S1 with Next and
    // Fire now. No rail, no tabs, no pull request row, no card.
    await userEvent.click(within(nav).getByRole("link", { name: "Presence" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/presence"));
    await screen.findByRole("heading", { level: 2, name: "On a schedule" });
    const header = within(overviewHeader());
    expect(header.getByRole("link", { name: "Activity" }).getAttribute("href")).toBe("/presence/activity");
    expect(header.getByRole("button", { name: "Add" })).toBeTruthy();
    expect(screen.getByText("Where Valet is, and what it does there.")).toBeTruthy();

    const attention = within(await screen.findByRole("region", { name: "Needs attention" }));
    expect(attention.getAllByRole("listitem")).toHaveLength(1);
    await waitFor(() => expect(attention.getByRole("alert").textContent).toBe("In acme/api, Platform CI is archived. Pick another thread:"));
    expect(await within(attention.getByRole("listbox", { name: "Threads" })).findByRole("option", { name: /Platform Ops/ })).toBeTruthy();

    expect(groupNames()).toEqual(["GitHub", "On a schedule"]);
    const github = screen.getByRole("region", { name: "GitHub" });
    const acme = within(github).getByRole("region", { name: "acme/api" });
    expect(within(acme).getByText("1 active thread").querySelector(".bg-moss")).not.toBeNull();
    await waitFor(() => expect(sentences(acme)).toEqual([
      "When a pull request review or a check completes, work in one thread per pull request.",
      "When a check completes, work in the Platform CI thread.",
    ]));
    expect(within(acme).getByRole("switch", { name: "Turn off Reviews and checks" })).toBeTruthy();
    expect(within(acme).getByRole("switch", { name: "Turn off CI failures" })).toBeTruthy();
    const r4Row = within(acme).getByRole("link", { name: "When a check completes, work in the Platform CI thread." });
    expect(r4Row.previousElementSibling?.className).toContain("bg-danger-500");
    const r1Row = within(acme).getByRole("link", { name: /^When a pull request review/ });
    expect(r1Row.previousElementSibling).toBeNull();
    const r4Fix = within(within(acme).getByRole("group", { name: "Problem" }));
    expect(r4Fix.getByRole("alert").textContent).toBe("Platform CI is archived. Pick another thread:");
    expect(r4Fix.getByRole("listbox", { name: "Threads" })).toBeTruthy();

    const schedule = screen.getByRole("region", { name: "On a schedule" });
    const s1 = within(within(schedule).getByRole("region", { name: "Morning summary" }));
    expect(s1.getByRole("link", { name: "Morning summary: work in its own thread." }).getAttribute("href")).toBe("/presence/routines/S1");
    expect(s1.getByText("Every day at 9:00")).toBeTruthy();
    // `Next <date and time>`, without seconds, in the reader's locale.
    expect(s1.getByText(/^Next /).textContent).not.toMatch(/\d:\d\d:\d\d/);
    expect(s1.getByRole("button", { name: "Fire Morning summary now" })).toBeTruthy();

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Presence" })).toBeNull();
    expect(screen.queryByRole("region", { name: "acme/api#12" })).toBeNull();
    // No card in the roster: no element has a border on all sides with
    // rounded corners, and none has a shadow. The thread picker in a fix is
    // a form control.
    const roster = schedule.parentElement;
    if (roster === null) throw new Error("The groups have no container.");
    const cards = [roster, ...roster.querySelectorAll("*")].filter((element) => {
      if (element.closest('[role="group"][aria-label="Problem"]') !== null) return false;
      const classes = [...element.classList];
      const framed = classes.includes("border") && classes.some((name) => name.startsWith("rounded"));
      // A switch's thumb carries a shadow; it is a control, not a frame.
      const shadowed = element.closest('[role="switch"]') === null && classes.some((name) => /^(?:[\w-]+:)*shadow(?:-|$)/.test(name));
      return framed || shadowed;
    });
    expect(cards).toEqual([]);

    // P3: acme/api reads R1 and R4 as sentences; R4 carries the inline
    // problem line and a picker; Threads lists the pull request threads.
    await userEvent.click(within(acme).getByRole("link", { name: "acme/api" }));
    expect(await screen.findByRole("heading", { level: 1, name: "acme/api" })).toBeTruthy();
    expect(screen.getByText("GitHub", { selector: "p" })).toBeTruthy();
    const here = screen.getByRole("region", { name: "Valet here" });
    await waitFor(() => expect(sentences(here)).toEqual([
      "When a pull request review or a check completes on acme/api, work in one thread per pull request.",
      "When a check completes on acme/api, work in the Platform CI thread.",
    ]));
    const inline = within(within(here).getByRole("group", { name: "Problem" }));
    expect(inline.getByRole("alert").textContent).toBe("Platform CI is archived. Pick another thread:");
    expect(await within(inline.getByRole("listbox", { name: "Threads" })).findByRole("option", { name: /Platform Ops/ })).toBeTruthy();
    const prThreads = within(screen.getByRole("list", { name: "One thread per pull request" }));
    expect(prThreads.getAllByRole("link").map((link) => link.textContent)).toEqual(["acme/api#12", "acme/api#13"]);

    // P4: in the sre workspace, #incidents lists M and P as sentences,
    // Appears as Ops Bot, the active and the followed thread, and the C2 mention.
    await crumbToOverview(router);
    await switchWorkspace("Personal", "SRE");
    const slack = await screen.findByRole("region", { name: "Slack" });
    await userEvent.click(await within(slack).findByRole("link", { name: "#incidents" }));
    expect(await screen.findByRole("heading", { level: 1, name: "#incidents" })).toBeTruthy();
    const incidents = await screen.findByRole("region", { name: "Valet here" });
    await waitFor(() => expect(sentences(incidents)).toEqual([
      "When someone mentions Valet in #incidents, reply in a new thread, as Ops Bot.",
      "When someone posts a message in #incidents, work in the t-inc thread.",
    ]));
    expect(within(screen.getByRole("region", { name: "Appears as" })).getByText("Ops Bot")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Active now" })).getByRole("link", { name: "t-inc" })).toBeTruthy();
    const following = within(screen.getByRole("list", { name: "Following" }));
    expect(following.getAllByRole("listitem")).toHaveLength(1);
    expect(following.getByRole("link", { name: /Slack thread/ })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Recent activity" })).getByRole("link", { name: "Mention in #incidents" })).toBeTruthy();

    // P5: + Listen for… on the overview's #incidents row opens the wizard
    // fixed on the place. The When step offers only Slack, and the preview
    // reads the default line. Create stores the policy `{ mode: "new" }`, and
    // the row shows the new line.
    await crumbToOverview(router);
    const incidentsRow = await screen.findByRole("region", { name: "#incidents" });
    await userEvent.click(within(incidentsRow).getByRole("button", { name: "+ Listen for…" }));
    const wizard = within(await screen.findByRole("dialog", { name: "Listen for…" }));
    expect(within(wizard.getByRole("group", { name: "When" })).getAllByRole("radio").map((r) => r.parentElement?.textContent))
      .toEqual(["Someone mentions Valet in Slack"]);
    const preview = wizard.getByTestId("wizard-preview");
    expect(preview.textContent).toBe("When someone mentions Valet in #incidents, reply in a new thread.");
    await userEvent.click(wizard.getByRole("button", { name: "Next" }));
    expect(wizard.getByRole("button", { name: "Remove #incidents" })).toBeTruthy();
    await userEvent.click(wizard.getByRole("button", { name: "Next" }));
    await userEvent.type(wizard.getByLabelText("Name"), "Incident replies");
    await userEvent.click(wizard.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.eventKeys).toEqual(["slack.app_mention"]);
    expect(created[0]!.filters).toEqual([{ field: "channel", op: "eq", value: "C900", label: "#incidents" }]);
    expect(created[0]!.target).toMatchObject({ kind: "assistant", thread: { mode: "new" } });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Listen for…" })).toBeNull());
    expect(await within(incidentsRow).findByText("Incident replies")).toBeTruthy();
    expect(sentences(incidentsRow)).toContain("When someone mentions Valet, reply in a new thread.");

    // P6: Add, then On a schedule. The When step offers all four choices,
    // the preview reads the Part E sentence, and the new row shows Next and
    // Fire now under On a schedule.
    await switchWorkspace("SRE", "Personal");
    await screen.findByRole("region", { name: "acme/api" });
    await userEvent.click(within(overviewHeader()).getByRole("button", { name: "Add" }));
    const routineWizard = within(await screen.findByRole("dialog"));
    const when = within(routineWizard.getByRole("group", { name: "When" }));
    expect(when.getAllByRole("radio").map((radio) => radio.parentElement?.textContent)).toEqual([
      "Someone mentions Valet in Slack", "Something happens on GitHub", "Something happens in Linear", "On a schedule",
    ]);
    await userEvent.click(when.getByLabelText("On a schedule"));
    await userEvent.click(routineWizard.getByRole("button", { name: "Next" }));
    await userEvent.type(routineWizard.getByLabelText("Cron"), "0 9 * * 1-5");
    await userEvent.clear(routineWizard.getByLabelText("Timezone"));
    await userEvent.type(routineWizard.getByLabelText("Timezone"), "UTC");
    await userEvent.click(routineWizard.getByRole("button", { name: "Next" }));
    await userEvent.type(routineWizard.getByLabelText("Prompt"), "Summarize open incidents.");
    await userEvent.click(routineWizard.getByRole("button", { name: "Next" }));
    await userEvent.type(routineWizard.getByLabelText("Routine name"), "Incident digest");
    expect(routineWizard.getByTestId("wizard-preview").textContent).toBe("Every weekday at 9:00, Incident digest: work in its own thread.");
    await userEvent.click(routineWizard.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createdRoutines).toHaveLength(1));
    expect(createdRoutines[0]).toMatchObject({ name: "Incident digest", cron: "0 9 * * 1-5", timezone: "UTC" });
    const digest = within(await within(screen.getByRole("region", { name: "On a schedule" })).findByRole("region", { name: "Incident digest" }));
    expect(digest.getByRole("link", { name: "Incident digest: work in its own thread." })).toBeTruthy();
    expect(digest.getByText("Every weekday at 9:00")).toBeTruthy();
    expect(digest.getByText(/^Next /)).toBeTruthy();
    expect(digest.getByRole("button", { name: "Fire Incident digest now" })).toBeTruthy();

    // P7: R4's page shows the breadcrumb, the sentence as the title, the
    // fact strip with Edit, and the problem line with the picker.
    await userEvent.click(within(screen.getByRole("region", { name: "acme/api" })).getByRole("link", { name: "When a check completes, work in the Platform CI thread." }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/presence/rules/R4"));
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("Presence›acme/api›CI failures");
    expect(within(crumbs).getByRole("link", { name: "acme/api" }).getAttribute("href")).toBe("/presence/places/github%3Aacme%2Fapi");
    expect(within(crumbs).getByText("CI failures").getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("heading", { level: 1, name: "When a check completes on acme/api, work in the Platform CI thread." })).toBeTruthy();
    const facts = screen.getByLabelText("Facts");
    expect([...facts.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["When", "Do", "Runs in", "Appears as"]);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    const problem = within(screen.getByRole("region", { name: "Problem" }));
    expect(problem.getByRole("alert").textContent).toBe("Platform CI is archived. Pick another thread:");
    expect(screen.getByRole("region", { name: "Deliveries" })).toBeTruthy();

    // P8: a pick patches the pin; the problem line goes and the title names
    // the new thread. Back on /presence, the row's sentence ends with the new
    // thread, its fix is gone, and Needs attention is gone.
    await userEvent.click(await within(problem.getByRole("listbox", { name: "Threads" })).findByRole("option", { name: /Platform Ops/ }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ id: "R4", body: { thread: { mode: "existing", sessionId: "s-u", threadId: "t-ops" } } });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Problem" })).toBeNull());
    expect(await screen.findByRole("heading", { level: 1, name: "When a check completes on acme/api, work in the Platform Ops thread." })).toBeTruthy();
    await crumbToOverview(router);
    const acmeAfter = await screen.findByRole("region", { name: "acme/api" });
    await waitFor(() => expect(sentences(acmeAfter)).toContain("When a check completes, work in the Platform Ops thread."));
    expect(within(acmeAfter).queryByRole("group", { name: "Problem" })).toBeNull();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull());

    // P9: in sre, Activity in the header opens /presence/activity under the
    // breadcrumb Presence › Activity. The Problems chip shows the
    // dead-lettered delivery; with the chip off, the C2 mention reads as
    // replied in t-inc.
    await switchWorkspace("Personal", "SRE");
    await userEvent.click(within(overviewHeader()).getByRole("link", { name: "Activity" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/presence/activity"));
    expect((await screen.findByRole("navigation", { name: "Breadcrumb" })).textContent).toBe("Presence›Activity");
    await userEvent.click(await screen.findByRole("button", { name: "Problems" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ status: "problems" }));
    const dead = await screen.findByRole("link", { name: "Completed check in acme/api#14" });
    expect(dead.parentElement?.textContent).toBe("Completed check in acme/api#14 → gave up after 3 attempts. To send it again, press Redeliver");
    expect(screen.queryByRole("link", { name: "Mention in #incidents" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    const mention = await screen.findByRole("link", { name: "Mention in #incidents" });
    expect(mention.parentElement?.textContent).toBe("Mention in #incidents → replied in t-inc");

    // P10: Workflows has the list and a Runs view at its own URL. The
    // editor's panel lists the workflow's lines and routines as sentences,
    // and its Add opens the wizard fixed on the workflow.
    await switchWorkspace("SRE", "Personal");
    await userEvent.click(within(nav).getByRole("link", { name: "Workflows" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows"));
    expect(await screen.findByRole("link", { name: "Triage failures" })).toBeTruthy();
    await userEvent.click(within(screen.getByRole("navigation", { name: "Workflows sections" })).getByRole("link", { name: "Runs" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows/runs"));
    expect(await screen.findByText("Triage failures")).toBeTruthy();
    await act(async () => { await router.navigate({ to: "/workflows/$workflowId", params: { workflowId: "wf-1" } }); });
    await userEvent.click(await screen.findByRole("button", { name: "What starts it" }));
    const panel = within(await screen.findByRole("region", { name: "What starts it" }));
    expect(await panel.findByRole("link", { name: "When a check completes on acme/api, run Triage failures." })).toBeTruthy();
    expect(panel.getByRole("link", { name: "Every day at 2:00, Nightly triage: run Triage failures." })).toBeTruthy();
    await userEvent.click(panel.getByRole("button", { name: "Add" }));
    const addWizard = within(await screen.findByRole("dialog", { name: "Listen for…" }));
    const doChoices = within(addWizard.getByRole("group", { name: "Do" })).getAllByRole("radio");
    const enabled = doChoices.filter((radio) => !(radio instanceof HTMLInputElement && radio.disabled));
    expect(enabled.map((radio) => radio.parentElement?.textContent)).toEqual(["Run a workflow"]);
    expect(enabled[0]).toHaveProperty("checked", true);
    await userEvent.keyboard("{Escape}");

    // P12: each old URL redirects, and none returns a 404.
    for (const [from, to] of [
      ["/events?tab=subscriptions", "/presence"],
      ["/events/ev-c2", "/presence/events/ev-c2"],
      ["/channel?key=slack%3AT1%2FC900", "/presence/places/slack%3AT1%2FC900"],
      ["/presence/listeners/R4", "/presence/rules/R4"],
      ["/presence/routines", "/presence"],
      ["/presence/routines?routine=S1", "/presence/routines/S1"],
      ["/presence/workflows", "/workflows"],
      ["/presence/runs/run-1", "/workflows/runs/run-1"],
    ] as const) {
      await act(async () => { await router.navigate({ href: from }); });
      await waitFor(() => expect(decodeURIComponent(router.state.location.pathname)).toBe(decodeURIComponent(to)));
      expect(screen.queryByText("This page doesn’t exist.")).toBeNull();
    }
    expect(router.state.location.search).toEqual({});

    // Every Presence read had a fixture. The reads left over belong to the
    // chrome, the workflow editor's other panels, and the pages that P12's
    // redirects land on; each has its own suite.
    expect(unhandled.filter((call) => /\/api\/(presence|event-subscriptions|events\/log|workflows\/triggers)/.test(call))).toEqual([]);
  });

  it("P11: the thread card names the lines that feed t-inc, and a pull request thread names its repository", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRootRoute({
      component: () => <TooltipProvider><BackgroundWorkSection sessionId="s-sre" threadId="t-inc" canCancel={false} /></TooltipProvider>,
    });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    const section = within(await screen.findByRole("region", { name: "Background work" }));
    const fedBy = await section.findByText(/Fed by:/);
    expect(fedBy.textContent).toBe("Fed by: Incident mentions, Channel watch");
    expect(section.getByRole("link", { name: "Incident mentions" }).getAttribute("href")).toBe("/presence/rules/M");
    expect(section.getByRole("link", { name: "Channel watch" }).getAttribute("href")).toBe("/presence/rules/P");

    // The thread header renders inside the thread page, which needs a live
    // socket; its place label is the pure `subjectPlaceLabel`.
    expect(subjectPlaceLabel("subject:github:acme/api#12")).toEqual({ subject: "github:acme/api#12", label: "acme/api#12" });
  });
});
