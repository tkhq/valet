// @vitest-environment jsdom
/**
 * The subscriptions panel and the activity feed both ask for the workspace
 * the nav's switcher names (small-fixes design, decisions 1 and 2). These
 * cases pin the OWNER each list requests, which is the whole of the change:
 * the panel scopes hard, and the feed scopes only while its filter reads
 * "This workspace".
 *
 * `~/api/events` is mocked to record the arguments its hooks receive,
 * following the same isolate-from-the-network pattern as the page suite in
 * `routes/-events.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { EventSubscriptionWire } from "@valet/api/wire";
import type { OwnerFilter } from "~/api/client";
import { TooltipProvider } from "~/components/primitives";

const subscriptionsData: { subscriptions: EventSubscriptionWire[] } = {
  subscriptions: [
    {
      id: "sub_1",
      name: "PR alerts",
      ownerType: "user",
      ownerId: "u1",
      eventKeys: ["github.pr.opened"],
      filters: [],
      target: { kind: "orchestrator" as const },
      enabled: true,
      createdBy: "u1",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

const catalogData = {
  services: [
    {
      service: "github",
      entries: [{ key: "github.pr.opened", description: "A pull request was opened", filters: [] }],
    },
  ],
};

const eventsData = { events: [] };

/** The owner each hook was last called with. `undefined` is a real answer
 * here — it is what an unscoped list sends — so a separate "was it called"
 * flag keeps the two apart. */
let subscriptionsOwner: OwnerFilter | undefined;
let feedOwner: OwnerFilter | undefined;
let feedCalls = 0;

vi.mock("~/api/events", () => ({
  useEventCatalog: () => ({ data: catalogData, isLoading: false, error: null }),
  useEvents: (_params: unknown, owner?: OwnerFilter) => {
    feedOwner = owner;
    feedCalls += 1;
    return { data: eventsData, isLoading: false, isFetching: false, error: null, refetch: vi.fn() };
  },
  useEventSubscriptions: (owner?: OwnerFilter) => {
    subscriptionsOwner = owner;
    return { data: subscriptionsData, isLoading: false, error: null };
  },
  usePatchEventSubscription: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateEventSubscription: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEventSubscription: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: { workflows: [] }, isLoading: false, error: null }),
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u1", orgRole: "member" }, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams: [] }, isLoading: false, error: null }),
  useOrg: () => ({ data: { features: { organizations: true } }, isLoading: false, error: null }),
}));

// The switcher's key, mutable per case; reset in afterEach.
let scopeTeamId: string | undefined;
vi.mock("~/lib/workspace-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/workspace-scope")>();
  return {
    ...actual,
    useWorkspaceScope: () => ({
      key: scopeTeamId ?? "user",
      teamId: scopeTeamId,
      available: ["user"],
      setKey: () => {},
    }),
  };
});

import { EventFeed } from "./feed";
import { SubscriptionsPanel } from "./subscriptions-panel";

beforeEach(() => {
  subscriptionsOwner = undefined;
  feedOwner = undefined;
  feedCalls = 0;
});

afterEach(() => {
  scopeTeamId = undefined;
});

describe("SubscriptionsPanel", () => {
  it("asks for the caller's own subscriptions in the personal workspace", () => {
    render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );
    expect(subscriptionsOwner).toEqual({ ownerType: "user", ownerId: "u1" });
  });

  it("asks for the team's subscriptions in a team workspace", () => {
    scopeTeamId = "t_eng";
    render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );
    expect(subscriptionsOwner).toEqual({ ownerType: "team", ownerId: "t_eng" });
  });
});

describe("EventFeed scope control", () => {
  it("starts on the workspace and asks for the switcher's owner", () => {
    render(<EventFeed />);
    expect(feedCalls).toBeGreaterThan(0);
    expect(feedOwner).toEqual({ ownerType: "user", ownerId: "u1" });
    expect(screen.getByRole("button", { name: "Scope: This workspace" })).toBeTruthy();
  });

  it("drops the owner when the reader selects All", async () => {
    render(<EventFeed />);
    // Radix dropdown triggers do not open from jsdom's plain click; the
    // keyboard path (Enter) is the reliable way to open one in tests.
    fireEvent.keyDown(screen.getByRole("button", { name: "Scope: This workspace" }), { key: "Enter" });
    fireEvent.click(await screen.findByText("All"));

    expect(feedOwner).toBeUndefined();
    // The org-wide state must be reachable AND legible: the trigger now
    // reads All, so a reader can tell which feed they are looking at.
    expect(screen.getByRole("button", { name: "Scope: All" })).toBeTruthy();
  });

  it("scopes to the team in a team workspace", () => {
    scopeTeamId = "t_eng";
    render(<EventFeed />);
    expect(feedOwner).toEqual({ ownerType: "team", ownerId: "t_eng" });
  });
});
