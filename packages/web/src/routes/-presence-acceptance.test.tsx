// @vitest-environment jsdom
/**
 * The Presence hub acceptance scenario, H1 to H12
 * (docs/specs/2026-10-16-presence-hub-design.md, "Acceptance scenario").
 *
 * The test renders the app's real route tree (`routeTree.gen.ts`, with the
 * root layout, the nav, and the workspace switcher) under a memory history.
 * The network is a `fetch` stub that answers each api path with a fixture
 * typed by the wire types, so every query hook, search schema, and redirect
 * runs as it does in the browser. The repo has no browser driver for the
 * web app; the api integration suite `integration/presence-hub.test.ts`
 * runs the data half of the scenario over a real database.
 *
 * H11 renders the thread context card's background section on its own
 * router, because the thread page needs a live session socket.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CreateEventSubscriptionRequest,
  EnsureWorkspaceRuntimeResponse,
  EventDeliveryWire,
  EventLogItem,
  EventLogResponse,
  EventSubscriptionWire,
  GetEventCatalogResponse,
  GetWorkflowTriggerCatalogResponse,
  ListAllWorkflowRunsResponse,
  ListEventReceiptsResponse,
  ListEventSubscriptionsResponse,
  ListIdentityLinksResponse,
  ListPresencePlacesResponse,
  ListSessionWakeupsResponse,
  ListThreadFeedersResponse,
  ListThreadsResponse,
  ListWorkflowTriggersResponse,
  ListWorkflowsResponse,
  PresencePlaceDetailResponse,
  PresencePlaceWire,
  TeamSummary,
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
import { TooltipProvider } from "~/components/primitives";

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOW = Date.now();
const PIN_UNAVAILABLE = "Pick another thread for this rule in Presence.";

function listener(id: string, over: Partial<EventSubscriptionWire>): EventSubscriptionWire {
  return {
    id, name: id, ownerType: "user", ownerId: "u-001", eventKeys: [], filters: [],
    target: { kind: "assistant" }, enabled: true, createdBy: "u-001", createdAt: 1, updatedAt: 1, ...over,
  };
}

const ACME_REPO = [{ field: "repo", op: "eq" as const, value: "acme/api" }];
const INCIDENTS_CHANNEL = [{ field: "channel", op: "eq" as const, value: "C900", label: "#incidents" }];

const R1 = listener("R1", {
  name: "Reviews and checks",
  eventKeys: ["github.pull_request_review.submitted", "github.check_run.completed"],
  filters: ACME_REPO,
  target: { kind: "assistant", thread: { mode: "subject" } },
});
const R4 = listener("R4", {
  name: "Failed checks",
  eventKeys: ["github.check_run.completed"],
  filters: ACME_REPO,
  target: { kind: "assistant", thread: { mode: "existing", sessionId: "s-u", threadId: "t-ci" } },
  problem: PIN_UNAVAILABLE,
});
const M = listener("M", {
  name: "M", ownerType: "team", ownerId: "sre", eventKeys: ["slack.app_mention"], filters: INCIDENTS_CHANNEL,
  target: { kind: "assistant", assistant: "team", teamId: "sre", appearance: { displayName: "SRE Bot" }, thread: { mode: "new" } },
});
const P = listener("P", {
  name: "P", ownerType: "team", ownerId: "sre", eventKeys: ["slack.message"], filters: INCIDENTS_CHANNEL,
  target: { kind: "assistant", assistant: "team", teamId: "sre", thread: { mode: "existing", sessionId: "s-sre", threadId: "t-inc" } },
});

function place(subject: string, label: string, service: PresencePlaceWire["service"], parent: string | null, listenerCount: number, activeThreadCount: number, scopeLabel?: string): PresencePlaceWire {
  return { subject, label, service, parent, listenerCount, activeThreadCount, lastActivityAt: NOW - 60_000, ...(scopeLabel ? { scopeLabel } : {}) };
}

const ACME_API = place("github:acme/api", "acme/api", "github", null, 2, 0, "Across acme/api");
const INCIDENTS_USER = place("slack:T1/C900", "#incidents", "slack", "slack:T1", 0, 0);
const INCIDENTS_SRE = place("slack:T1/C900", "#incidents", "slack", "slack:T1", 2, 1);
const SLACK_ROOT = place("slack:T1", "Slack", "slack", null, 0, 0);

const PLACES: Record<string, ListPresencePlacesResponse> = {
  user: { places: [SLACK_ROOT, INCIDENTS_USER, ACME_API] },
  sre: { places: [SLACK_ROOT, INCIDENTS_SRE] },
};

function conversation(sessionId: string, threadId: string, title: string, url?: string) {
  return { sessionId, threadId, title, lastActivityAt: NOW - 120_000, ...(url ? { url } : {}) };
}

const PLACE_DETAIL: Record<string, PresencePlaceDetailResponse> = {
  "user github:acme/api": {
    place: ACME_API,
    listeners: [R1, R4],
    threads: {
      subject: [conversation("s-u", "t-12", "acme/api#12"), conversation("s-u", "t-13", "acme/api#13")],
      following: [],
      active: [],
    },
    activity: [],
  },
  "sre slack:T1/C900": {
    place: INCIDENTS_SRE,
    listeners: [M, P],
    threads: {
      subject: [],
      following: [conversation("s-sre", "t-inc", "t-inc", "https://acme.slack.com/archives/C900/p1")],
      active: [conversation("s-sre", "t-inc", "t-inc")],
    },
    activity: [],
  },
};

const LISTENERS: Record<string, EventSubscriptionWire[]> = { user: [R1, R4], sre: [M, P] };

const S1: WorkflowTriggerItem = {
  kind: "schedule", id: "S1", name: "Morning summary", enabled: true,
  detail: {
    cron: "0 9 * * *", timezone: "UTC", targetKind: "assistant", prompt: "Summarize the night.",
    thread: { mode: "own" }, nextFireAt: NOW + 3_600_000, lastFiredAt: null, ownerType: "user", ownerId: "u-001",
  },
};
const WF_EVENT: WorkflowTriggerItem = {
  kind: "event", id: "R-wf", workflowId: "wf-1", name: "Run triage", enabled: true,
  detail: { eventKeys: ["github.check_run.completed"], filters: [] },
};
const WF_LISTENER = listener("R-wf", {
  name: "Run triage", eventKeys: ["github.check_run.completed"], filters: ACME_REPO,
  target: { kind: "workflow", workflowId: "wf-1" },
});
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
  return { id: "d-1", subscriptionId: "M", subscriptionName: "M", status: "delivered", attempts: 1, lastError: null, deliveredAt: NOW, ...over };
}
function logEvent(id: string, eventKey: string, deliveries: EventDeliveryWire[], status: EventLogItem["status"]): EventLogItem {
  return {
    kind: "event", id, at: NOW - 30_000, status, service: "slack", eventKey, summary: `summary of ${id}`, actor: "alice",
    reason: null, detail: null, deliveryCount: deliveries.length, place: "#incidents", deliveries,
  };
}
const T_INC = { sessionId: "s-sre", threadId: "t-inc", title: "t-inc" };
const LOG: Record<string, EventLogResponse> = {
  sre: {
    items: [
      logEvent("ev-c2", "slack.app_mention", [delivery({ thread: T_INC })], "delivered"),
      logEvent("ev-c1", "slack.message", [delivery({ id: "d-2", subscriptionId: "P", subscriptionName: "P", status: "skipped", lastError: "Skipped, claimed by thread t-inc.", claimedBy: T_INC })], "skipped"),
    ],
    nextCursor: null, lastEventAt: NOW - 30_000, windowDays: 30,
  },
};

const RECEIPTS: ListEventReceiptsResponse = {
  receipts: [{
    id: "rc-c2", service: "slack", externalId: "Ev-C2", metadata: {}, eventKey: "slack.app_mention", eventId: "ev-c2",
    stages: [
      { stage: "classification", outcome: "accepted", detail: "Mention classified", at: NOW - 30_000 },
      { stage: "dispatch", outcome: "enqueued", detail: "Queued for t-inc", at: NOW - 29_000 },
    ],
    subscriptions: [], createdAt: NOW - 30_000, updatedAt: NOW - 29_000,
  }],
  nextCursor: null, lastReceiptAt: NOW - 30_000, retentionDays: 7,
};

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
const FEEDERS: ListThreadFeedersResponse = { listeners: [{ id: "M", name: "M" }, { id: "P", name: "P" }], routines: [] };

// ── The fetch stub ───────────────────────────────────────────────────────

const created: CreateEventSubscriptionRequest[] = [];
/** Listeners the scenario creates, by workspace key, as the api lists them after the write. */
const createdListeners: Record<string, EventSubscriptionWire[]> = {};
const unhandled: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function scopeOf(query: URLSearchParams): string {
  return query.get("scope") ?? (query.get("ownerType") === "team" ? query.get("ownerId") ?? "user" : "user");
}

async function answer(method: string, url: URL, body: string | undefined): Promise<Response> {
  const path = url.pathname;
  const q = url.searchParams;
  if (method === "POST" && path === "/api/event-subscriptions") {
    const request = JSON.parse(body ?? "{}") as CreateEventSubscriptionRequest;
    created.push(request);
    const team = request.target.kind === "assistant" && request.target.assistant === "team" ? request.target.teamId : undefined;
    const row = listener("R-new", {
      name: request.name, eventKeys: request.eventKeys, filters: request.filters ?? [], target: request.target,
      ...(team !== undefined ? { ownerType: "team" as const, ownerId: team } : {}),
    });
    (createdListeners[team ?? "user"] ??= []).push(row);
    return json(row, 201);
  }
  const runtime = /^\/api\/workspaces\/([^/]+)\/runtime$/.exec(path);
  if (method === "POST" && runtime) {
    const ensured: EnsureWorkspaceRuntimeResponse = runtime[1] === "user" ? { sessionId: "s-u" } : { sessionId: "s-sre", workspaceSessionId: "s-sre" };
    return json(ensured);
  }
  if (method !== "GET") {
    unhandled.push(`${method} ${path}`);
    return json({ error: "not in the scenario" }, 404);
  }
  if (path === "/api/presence/places") return json(PLACES[scopeOf(q)] ?? { places: [] });
  const placeMatch = /^\/api\/presence\/places\/(.+)$/.exec(path);
  if (placeMatch) {
    const scope = scopeOf(q);
    const detail = PLACE_DETAIL[`${scope} ${decodeURIComponent(placeMatch[1]!)}`];
    if (!detail) return json({ error: "Valet is not present in that place in this workspace." }, 404);
    const extra = (createdListeners[scope] ?? []).filter((sub) => sub.filters.some((f) => f.value === "C900") && detail.place.subject.endsWith("/C900"));
    return json({ ...detail, listeners: [...detail.listeners, ...extra] });
  }
  if (path === "/api/presence/feeders") return json(FEEDERS);
  if (path === "/api/workflows/trigger-catalog") return json(TRIGGER_CATALOG);
  if (path === "/api/workflows/triggers") {
    const response: ListWorkflowTriggersResponse = q.get("workflowId") === "wf-1"
      ? { triggers: [WF_EVENT, WF_ROUTINE] }
      : { triggers: scopeOf(q) === "user" ? [S1] : [] };
    return json(response);
  }
  if (path === "/api/workflows/runs") return json(RUNS);
  if (path === "/api/workflows") return json(WORKFLOWS);
  if (path === "/api/event-subscriptions") {
    const owner = q.get("ownerType") ? scopeOf(q) : undefined;
    const subscriptions = owner === undefined ? [...LISTENERS.user!, ...LISTENERS.sre!, WF_LISTENER] : LISTENERS[owner] ?? [];
    const response: ListEventSubscriptionsResponse = { subscriptions };
    return json(response);
  }
  if (/^\/api\/event-subscriptions\/[^/]+\/deliveries$/.test(path)) return json({ deliveries: [] });
  if (path === "/api/events/log") return json(LOG[scopeOf(q)] ?? { items: [], nextCursor: null, lastEventAt: null, windowDays: 30 });
  if (path === "/api/events/receipts") return json(q.get("q") === "ev-c2" ? RECEIPTS : { ...RECEIPTS, receipts: [] });
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
  created.length = 0;
  for (const key of Object.keys(createdListeners)) delete createdListeners[key];
  unhandled.length = 0;
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : undefined;
    return answer(init?.method ?? "GET", new URL(raw, "http://valet.test"), body);
  });
});

afterEach(() => {
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

async function openTab(name: string) {
  await userEvent.click(screen.getByRole("tab", { name }));
}

describe("Presence hub acceptance (H1 to H12)", () => {
  it("walks the scenario in one run", { timeout: 60_000 }, async () => {
    const router = mountApp("/");

    // H1: one nav entry, Presence; no Events or Automation entry.
    const nav = await screen.findByRole("navigation", { name: /primary|main/i });
    expect(within(nav).getByRole("link", { name: "Presence" })).toBeTruthy();
    expect(within(nav).queryByRole("link", { name: "Events" })).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Automation" })).toBeNull();

    // H2: /presence opens on Places, grouped Slack, GitHub, Linear.
    await userEvent.click(within(nav).getByRole("link", { name: "Presence" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/presence"));
    expect(screen.getByRole("tab", { name: "Places" }).getAttribute("aria-selected")).toBe("true");
    const groups = ["Slack", "GitHub", "Linear"].map((name) => screen.getByRole("region", { name }));
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i - 1]!.compareDocumentPosition(groups[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const github = within(groups[1]!);
    expect(rowText(await github.findByRole("link", { name: "acme/api" }))).toContain("Across acme/api · 2 listeners · No active thread");
    expect(rowText(within(groups[0]!).getByRole("link", { name: "#incidents" }))).toContain("No listeners · No active thread");

    // H3: acme/api lists R1 and R4 as sentences, and its subject threads.
    await userEvent.click(github.getByRole("link", { name: "acme/api" }));
    await screen.findByRole("heading", { level: 1, name: "acme/api" });
    const listeners = screen.getByRole("region", { name: "Listeners" });
    expect(within(listeners).getByText(
      "Listens on acme/api for pull request reviews and completed checks · works in one thread per pull request",
    )).toBeTruthy();
    expect(await within(listeners).findByText("Listens on acme/api for completed checks · works in the thread Platform CI")).toBeTruthy();
    const subjectThreads = within(screen.getByRole("list", { name: "Threads for acme/api" }));
    expect(subjectThreads.getByRole("link", { name: "acme/api#12" })).toBeTruthy();
    expect(subjectThreads.getByRole("link", { name: "acme/api#13" })).toBeTruthy();

    // H4: in the sre workspace, #incidents lists M and P, Appears as, the
    // active thread, and the followed Slack thread.
    await switchWorkspace("Personal", "SRE");
    await waitFor(() => expect(router.state.location.pathname).toBe("/presence"));
    await userEvent.click(await within(screen.getByRole("region", { name: "Slack" })).findByRole("link", { name: "#incidents" }));
    await screen.findByRole("heading", { level: 1, name: "#incidents" });
    const incidents = within(screen.getByRole("region", { name: "Listeners" }));
    expect(incidents.getByText("Listens in #incidents for mentions · replies in a new thread · as SRE Bot")).toBeTruthy();
    expect(incidents.getByText("Listens in #incidents for messages · works in the thread t-inc")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Appears as" })).getByText("SRE Bot")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Active now" })).getByRole("link", { name: "t-inc" })).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Following" })).getByRole("link", { name: /Slack thread/ })).toBeTruthy();

    // H5: Add on #incidents opens the wizard on the place; a mention rule
    // with the default Runs in replies in a new thread.
    await userEvent.click(screen.getByRole("button", { name: "Add a listener in #incidents" }));
    const wizard = within(await screen.findByRole("dialog", { name: "New listener" }));
    await userEvent.click(wizard.getByLabelText(/Reply to Slack mentions/));
    await userEvent.click(wizard.getByRole("button", { name: /^Next$/ }));
    expect(wizard.getByRole("button", { name: "Remove #incidents" })).toBeTruthy();
    expect(checkedRunsIn(wizard)).toBe("A new thread each time");
    await userEvent.click(wizard.getByRole("button", { name: /^Next$/ }));
    await userEvent.type(wizard.getByLabelText("Listener name"), "Incident replies");
    await userEvent.click(wizard.getByRole("button", { name: /Create listener/ }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.eventKeys).toEqual(["slack.app_mention"]);
    expect(created[0]!.target).toMatchObject({ kind: "assistant", thread: { mode: "new" } });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New listener" })).toBeNull());
    const sentences = await waitFor(() => {
      const rows = within(screen.getByRole("region", { name: "Listeners" })).getAllByRole("link").map((link) => link.textContent ?? "");
      expect(rows).toHaveLength(3);
      return rows;
    });
    expect(sentences[2]).toMatch(/replies in a new thread$/);

    // H6: on acme/api, a notification for failed checks defaults to one
    // thread per pull request and offers the other three modes.
    await switchWorkspace("SRE", "Personal");
    await userEvent.click(await within(screen.getByRole("region", { name: "GitHub" })).findByRole("link", { name: "acme/api" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add a listener in acme/api" }));
    const notify = within(await screen.findByRole("dialog", { name: "New listener" }));
    expect(notify.getByLabelText(/Send a notification/)).toHaveProperty("checked", true);
    await userEvent.click(notify.getByRole("button", { name: /^Next$/ }));
    await userEvent.click(notify.getByRole("checkbox", { name: /github\.check_run\.completed/ }));
    await userEvent.click(notify.getByRole("button", { name: /^Next$/ }));
    expect(checkedRunsIn(notify)).toBe("One thread per pull request");
    const modes = within(notify.getByRole("group", { name: "Runs in" })).getAllByRole("radio").map((r) => r.parentElement?.textContent);
    expect(modes).toEqual(["A new thread each time", "One thread per pull request", "This listener's thread", "An existing thread…"]);
    await userEvent.click(notify.getByRole("radio", { name: "An existing thread…" }));
    // INV-H4: the picker lists the workspace's open threads, not the archived one.
    expect(notify.getByLabelText("Search threads")).toBeTruthy();
    const picker = within(notify.getByRole("listbox", { name: "Threads" }));
    expect(await picker.findByRole("option", { name: /Platform Ops/ })).toBeTruthy();
    expect(picker.queryByRole("option", { name: /Platform CI/ })).toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New listener" })).toBeNull());

    // H7: R4 carries a problem badge; its page names the problem with the picker inline.
    expect(within(screen.getByRole("region", { name: "Listeners" })).getByText("Thread archived")).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: "Listens on acme/api for completed checks · works in the thread Platform CI" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/presence/listeners/R4"));
    const problem = within(await screen.findByRole("region", { name: "Problem" }));
    expect(problem.getByRole("alert").textContent).toBe("This listener's thread is archived. Pick another thread.");
    expect(await within(problem.getByRole("listbox", { name: "Threads" })).findByRole("option", { name: /Platform Ops/ })).toBeTruthy();

    // H8: the Routines tab reads S1 as a sentence, with Fire now, edit, and enable.
    await userEvent.click(screen.getByRole("link", { name: /Places/ }));
    await openTab("Routines");
    const routines = within(await screen.findByRole("region", { name: "Routines" }));
    const s1 = await routines.findByRole("link", { name: "Every day at 9:00 · Morning summary · works in this routine's thread" });
    expect(routines.getByRole("button", { name: "Fire Morning summary now" })).toBeTruthy();
    await userEvent.click(s1);
    const edit = await screen.findByRole("button", { name: "Edit" });
    await waitFor(() => expect(edit.hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("button", { name: "Fire now" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("switch", { name: "Turn off Morning summary" }).hasAttribute("disabled")).toBe(false);

    // H9: the Activity tab reads the C2 mention and the C1 message as sentences.
    await switchWorkspace("Personal", "SRE");
    await act(async () => { await router.navigate({ to: "/presence/activity" }); });
    const mention = await screen.findByRole("link", { name: "Mention in #incidents" });
    expect(mention.parentElement?.textContent).toBe("Mention in #incidents → replied in t-inc");
    const message = screen.getByRole("link", { name: "Message in #incidents" });
    expect(message.parentElement?.textContent).toBe("Message in #incidents → claimed by t-inc");
    await userEvent.click(screen.getAllByText("Deliveries and receipt stages")[0]!);
    expect(await screen.findByText(/Mention classified/)).toBeTruthy();

    // H10: Workflows and Runs show what /workflows showed; the editor's panel
    // lists the workflow's listeners and routines as sentences.
    await switchWorkspace("SRE", "Personal");
    await openTab("Workflows");
    expect(await screen.findByRole("link", { name: "Triage failures" })).toBeTruthy();
    await openTab("Runs");
    expect(await screen.findByText("Triage failures")).toBeTruthy();
    await act(async () => { await router.navigate({ to: "/presence/workflows/$workflowId", params: { workflowId: "wf-1" } }); });
    await userEvent.click(await screen.findByRole("button", { name: "Listeners and routines" }));
    const panel = within(await screen.findByRole("region", { name: "Listeners and routines" }));
    expect(await panel.findByRole("link", { name: "Listens on acme/api for completed checks · runs Triage failures" })).toBeTruthy();
    expect(panel.getByRole("link", { name: /^Every day at 2:00 · / })).toBeTruthy();

    // H12: every old URL redirects to its Presence URL.
    for (const [from, to] of [
      ["/events?tab=subscriptions", "/presence"],
      ["/events/ev-c2", "/presence/events/ev-c2"],
      ["/workflows/wf-1", "/presence/workflows/wf-1"],
      ["/workflows/runs/run-1", "/presence/runs/run-1"],
      ["/channel?key=slack%3AT1%2FC900", "/presence/places/slack%3AT1%2FC900"],
    ] as const) {
      await act(async () => { await router.navigate({ href: from }); });
      await waitFor(() => expect(decodeURIComponent(router.state.location.pathname)).toBe(decodeURIComponent(to)));
      expect(screen.queryByText("This page doesn’t exist.")).toBeNull();
    }

    // Every Presence read had a fixture. The reads left over belong to the
    // chrome, the workflow editor's other panels, and the pages that H12's
    // redirects land on; each has its own suite.
    expect(unhandled.filter((call) => /\/api\/(presence|event-subscriptions|events\/log|workflows\/triggers)/.test(call))).toEqual([]);
  });

  it("H11: the thread card's background section names the listeners that feed t-inc", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRootRoute({
      component: () => <TooltipProvider><BackgroundWorkSection sessionId="s-sre" threadId="t-inc" canCancel={false} /></TooltipProvider>,
    });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    const section = within(await screen.findByRole("region", { name: "Background work" }));
    expect(section.getByText(/wait for the incident to close/)).toBeTruthy();
    const fedBy = await section.findByText(/Fed by:/);
    expect(fedBy.textContent).toBe("Fed by: M, P");
    expect(section.getByRole("link", { name: "M" }).getAttribute("href")).toBe("/presence/listeners/M");
    expect(section.getByRole("link", { name: "P" }).getAttribute("href")).toBe("/presence/listeners/P");
  });
});

/** The text of the list row that holds a link. */
function rowText(link: HTMLElement): string {
  return link.closest("li")?.textContent ?? "";
}

function checkedRunsIn(scope: ReturnType<typeof within>): string {
  const radios = within(scope.getByRole("group", { name: "Runs in" })).getAllByRole("radio");
  return radios.find((r) => r instanceof HTMLInputElement && r.checked)?.parentElement?.textContent ?? "";
}
