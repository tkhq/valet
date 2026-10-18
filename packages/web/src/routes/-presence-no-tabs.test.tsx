// @vitest-environment jsdom
/**
 * INV-H5 (docs/specs/2026-10-16-presence-hub-design.md): no level of
 * navigation sits under the top nav. The test renders the app's real route
 * tree at each Presence route and expects no tab list, and no navigation
 * landmark except the top nav (`Primary`) and the breadcrumb. It also checks
 * that `/presence` lands on the overview (Part A step 5), that only the
 * overview shows the section's `Presence` title while each detail page shows
 * a breadcrumb that starts at `Presence` and its own title (Part A step 2),
 * and that the revision 1 rule URL redirects.
 *
 * The network is a `fetch` stub. It answers the reads the shell and its
 * pages make with small fixtures, and every other read with an empty 404.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import type {
  EventLogResponse,
  EventSubscriptionWire,
  GetEventResponse,
  ListEventSubscriptionsResponse,
  ListPresencePlacesResponse,
  ListWorkflowTriggersResponse,
  PresencePlaceDetailResponse,
  PresencePlaceWire,
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

import { routeTree } from "../routeTree.gen";

const INCIDENTS: PresencePlaceWire = {
  subject: "slack:T1/C900", label: "#incidents", service: "slack", parent: "slack:T1", listenerCount: 1, activeThreadCount: 0, lastActivityAt: null,
};
const SLACK_ROOT: PresencePlaceWire = {
  subject: "slack:T1", label: "Slack", service: "slack", parent: null, listenerCount: 0, activeThreadCount: 0, lastActivityAt: null,
};
const SUB_1: EventSubscriptionWire = {
  id: "sub-1", name: "Incident intake", ownerType: "user", ownerId: "u-001", eventKeys: ["slack.app_mention"],
  filters: [{ field: "channel", op: "eq", value: "C900", label: "#incidents" }],
  target: { kind: "assistant" }, enabled: true, createdBy: "u-001", createdAt: 1, updatedAt: 1,
};

const S1: WorkflowTriggerItem = {
  kind: "schedule", id: "S1", name: "Morning summary", enabled: true,
  detail: {
    cron: "0 9 * * *", timezone: "UTC", targetKind: "assistant", prompt: "Summarize the night.",
    thread: { mode: "own" }, nextFireAt: Date.now() + 3_600_000, lastFiredAt: null, ownerType: "user", ownerId: "u-001",
  },
};
const EVENT: GetEventResponse = {
  event: {
    id: "ev-1", service: "slack", eventKey: "slack.app_mention", summary: "@Valet the deploy is failing", refs: { channel: "C900" }, actor: null,
    occurredAt: 1, receivedAt: 1, payload: {}, place: "#incidents",
  },
  deliveries: [],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function answer(url: URL): Response {
  const path = url.pathname;
  if (path === "/api/presence/places") return json({ places: [SLACK_ROOT, INCIDENTS] } satisfies ListPresencePlacesResponse);
  if (path.startsWith("/api/presence/places/")) {
    const detail: PresencePlaceDetailResponse = {
      place: INCIDENTS, listeners: [SUB_1], threads: { subject: [], following: [], active: [] }, activity: [],
    };
    return json(detail);
  }
  if (path === "/api/event-subscriptions") return json({ subscriptions: [SUB_1] } satisfies ListEventSubscriptionsResponse);
  if (path === "/api/workflows/triggers") return json({ triggers: [S1] } satisfies ListWorkflowTriggersResponse);
  if (path === "/api/events/ev-1") return json(EVENT);
  if (path === "/api/workflows") return json({ workflows: [] });
  if (path === "/api/events/log") {
    return json({ items: [], nextCursor: null, lastEventAt: null, windowDays: 30 } satisfies EventLogResponse);
  }
  return json({ error: "not in this test" }, 404);
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return answer(new URL(raw, "http://valet.test"));
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

describe("INV-H5: no navigation under the top nav except the breadcrumb", () => {
  it.each([
    ["/presence", "Presence"],
    ["/presence/activity", "Activity"],
    ["/presence/places/slack:T1%2FC900", "#incidents"],
    ["/presence/rules/sub-1", "When you mention Valet in #incidents, reply in a new thread."],
    ["/presence/routines/S1", "Every day at 9:00, Morning summary: work in its own thread."],
    ["/presence/events/ev-1", "Mention in #incidents"],
  ])("%s has no tab list, and every navigation landmark is the breadcrumb", async (path, title) => {
    mountApp(path);
    await screen.findByRole("heading", { level: 1, name: title });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    // The top nav is `Primary`. Every other navigation landmark is a breadcrumb.
    const names = screen.queryAllByRole("navigation").map((nav) => nav.getAttribute("aria-label"));
    expect(names.filter((name) => name !== "Primary").every((name) => name === "Breadcrumb")).toBe(true);
    expect(names.filter((name) => name === "Primary")).toHaveLength(1);
    // One page title. A detail page's breadcrumb starts at Presence, and the
    // section's title block, subtitle, and actions stay on the overview.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    if (path === "/presence") {
      expect(screen.getByText("Where Valet is, and what it does there.")).toBeTruthy();
      expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    } else {
      expect(screen.queryByText("Where Valet is, and what it does there.")).toBeNull();
      const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
      expect(crumbs.getAllByRole("listitem")[0]!.textContent).toBe("Presence");
      expect(crumbs.getByRole("link", { name: "Presence" }).getAttribute("href")).toBe("/presence");
    }
  });

  it("lands /presence on the overview", async () => {
    mountApp("/presence");
    expect(await screen.findByRole("region", { name: "#incidents" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Activity" }).getAttribute("href")).toBe("/presence/activity");
    expect(screen.queryByRole("searchbox", { name: "Place" })).toBeNull();
  });

  it("opens a place page with a breadcrumb", async () => {
    mountApp("/presence/places/slack:T1%2FC900");
    expect(await screen.findByRole("heading", { level: 1, name: "#incidents" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Presence›#incidents");
  });

  it("redirects a revision 1 rule URL to its rule page", async () => {
    const router = mountApp("/presence/listeners/sub-1?workspace=user");
    await waitFor(() => expect(router.state.location.pathname).toBe("/presence/rules/sub-1"));
    expect(await screen.findByRole("heading", { level: 1, name: "When you mention Valet in #incidents, reply in a new thread." })).toBeTruthy();
  });
});
