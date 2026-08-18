// @vitest-environment jsdom
/**
 * `/events` — the events page: the Activity feed renders ingested events
 * and expands one into deliveries + payload; the Subscriptions tab lists
 * rules with a resolved workflow-target name, toggles `enabled` through
 * the patch mutation, and creates a subscription from catalog-picked keys.
 * Mocks `~/api/events`, `~/api/workflows`, and `~/api/settings` the same
 * way `-workflows.index.test.tsx` mocks its api module — this suite cares
 * that the page renders from query data and calls the right mutation.
 * `useMe` resolves to user "u1", the owner of the one fixture subscription,
 * so mutate controls render by default; one test flips ownership to prove
 * they gate on it.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { EventSubscriptionWire, TeamSummary } from "@valet/api/wire";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "~/components/primitives";

const catalogData = {
  services: [
    {
      service: "github",
      entries: [
        {
          key: "github.pr.opened",
          description: "A pull request was opened",
          filters: [{ field: "repo", path: "$.repository.full_name", description: "repo" }],
        },
        { key: "github.pr.merged", description: "A pull request was merged", filters: [] },
      ],
    },
  ],
};

const eventsData = {
  events: [
    {
      id: "evt_1",
      service: "github",
      eventKey: "github.pr.opened",
      summary: "PR #7 opened: fix login",
      refs: { repo: "acme/app" },
      actor: { externalId: "u-ext", login: "octocat" },
      occurredAt: 1_723_200_000_000,
      receivedAt: 1_723_200_000_000,
    },
  ],
};

/** A long error, so a truncation regression shows up as a failed substring
 * match rather than a passing prefix match. */
const LONG_ERROR =
  "Error: workflow wf_1 not found in org acme — the definition was deleted while the delivery was in flight";

const eventDetailData = {
  event: { ...eventsData.events[0], payload: { action: "opened", number: 7 } },
  deliveries: [
    {
      id: "d1",
      subscriptionId: "sub_1",
      subscriptionName: "PR alerts",
      status: "delivered" as const,
      attempts: 1,
      lastError: null,
      deliveredAt: 1_723_200_001_000,
      nextAttemptAt: null,
    },
    {
      id: "d2",
      subscriptionId: "sub_2",
      subscriptionName: "Deploy watcher",
      status: "failed" as const,
      attempts: 2,
      lastError: LONG_ERROR,
      deliveredAt: null,
      // Eight minutes out, with 30s of slack: the countdown rounds DOWN, so
      // the assertion stays "in 8 minutes" however long the suite takes to
      // reach this file.
      nextAttemptAt: Date.now() + 8 * 60_000 + 30_000,
    },
    {
      id: "d3",
      subscriptionId: "sub_3",
      subscriptionName: "Nightly triage",
      status: "dead" as const,
      attempts: 4,
      lastError: "Error: connect ECONNREFUSED 127.0.0.1:8788",
      deliveredAt: null,
      nextAttemptAt: null,
    },
  ],
};

const subscriptionsData: { subscriptions: EventSubscriptionWire[] } = {
  subscriptions: [
    {
      id: "sub_1",
      name: "PR alerts",
      ownerType: "user",
      ownerId: "u1",
      eventKeys: ["github.pr.opened"],
      filters: [],
      target: { kind: "workflow" as const, workflowId: "wf_1" },
      enabled: true,
      createdBy: "u1",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

const workflowsData = {
  workflows: [
    {
      id: "wf_1",
      name: "Deploy pipeline",
      definition: {},
      createdAt: 1,
      updatedAt: 1,
      ownerType: "user" as const,
      ownerId: "u1",
    },
  ],
};

const patchMutate = vi.fn();
const createMutate = vi.fn();
const deleteMutate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Link: ({
    children,
    to,
    params: _params,
    ...rest
  }: {
    children: ReactNode;
    to?: string;
    params?: Record<string, string>;
    [key: string]: unknown;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("~/api/events", () => ({
  useEventCatalog: () => ({ data: catalogData, isLoading: false, error: null }),
  useEvents: () => ({
    data: eventsData,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
  useEvent: () => ({ data: eventDetailData, isLoading: false, error: null }),
  useEventSubscriptions: () => ({ data: subscriptionsData, isLoading: false, error: null }),
  usePatchEventSubscription: () => ({ mutate: patchMutate, isPending: false }),
  useCreateEventSubscription: () => ({ mutate: createMutate, isPending: false }),
  useDeleteEventSubscription: () => ({ mutate: deleteMutate, isPending: false, error: null }),
}));

vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: workflowsData, isLoading: false, error: null }),
}));

// Teams back the subscription owner badges and the workspace-scoped create
// target. Mutable so team cases can add fixtures; reset in afterEach.
let teamsData: { teams: TeamSummary[] } = { teams: [] };
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u1", orgRole: "member" }, isLoading: false, error: null }),
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useOrg: () => ({
    data: { features: { organizations: true } },
    isLoading: false,
    error: null,
  }),
}));

// `OwnerBadge` reads the assistants list to link a team badge to the team's
// assistant; no assistant fixtures needed — an unlinked badge still names
// the owner.
vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({ data: { assistants: [] }, isLoading: false, error: null }),
  };
});

// The create dialog inherits the switcher's workspace. Mutable for the
// team-scope case; reset in afterEach (isolate: false shares the registry).
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

import { EventsPage } from "./events.index";

function team(id: string, name: string, callerRole: "admin" | "member" | null): TeamSummary {
  return {
    id,
    orgId: "org_1",
    name,
    origin: "local",
    externalId: null,
    createdAt: 0,
    memberCount: 3,
    callerRole,
  };
}

beforeEach(() => {
  patchMutate.mockClear();
  createMutate.mockClear();
  deleteMutate.mockClear();
});

afterEach(() => {
  teamsData = { teams: [] };
  scopeTeamId = undefined;
});

describe("EventsPage — Activity", () => {
  it("renders the feed with service, key, summary, and actor", () => {
    render(<EventsPage />);
    expect(screen.getByText("PR #7 opened: fix login")).toBeTruthy();
    expect(screen.getByText("github.pr.opened")).toBeTruthy();
    expect(screen.getByText("octocat")).toBeTruthy();
  });

  it("links each row to the event's own URL", () => {
    render(<EventsPage />);
    const link = screen.getByRole("link", { name: /Open PR #7/ }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/events/$eventId");
  });

  it("expands an event into its deliveries and payload", () => {
    render(<EventsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Expand PR #7/ }));
    expect(screen.getByText("delivered")).toBeTruthy();
    expect(screen.getByText(/"action": "opened"/)).toBeTruthy();
  });

  it("names the subscription each delivery was trying to reach", () => {
    render(<EventsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Expand PR #7/ }));
    expect(screen.getByText("PR alerts")).toBeTruthy();
    expect(screen.getByText("Deploy watcher")).toBeTruthy();
  });

  it("separates a delivery that retries from one that gave up", () => {
    render(<EventsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Expand PR #7/ }));
    expect(screen.getByText(/Retries in 8 minutes/)).toBeTruthy();
    expect(screen.getByText(/Gave up after 4 attempts\. To send it again, press Redeliver\./)).toBeTruthy();
  });

  it("shows the whole error string, never a truncated one", () => {
    render(<EventsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Expand PR #7/ }));
    expect(screen.getByText(LONG_ERROR)).toBeTruthy();
  });
});

describe("EventsPage — Subscriptions", () => {
  function openSubscriptionsTab() {
    // `TooltipProvider` because `OwnerBadge` (team badges) renders a Radix
    // tooltip — same wrapper `-workflows.index.test.tsx` uses.
    render(
      <TooltipProvider>
        <EventsPage />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Subscriptions" }));
  }

  it("lists subscriptions with the workflow target resolved to its name", () => {
    openSubscriptionsTab();
    expect(screen.getByText("PR alerts")).toBeTruthy();
    expect(screen.getByText(/Run workflow: Deploy pipeline/)).toBeTruthy();
  });

  it("toggles enabled through the patch mutation", () => {
    openSubscriptionsTab();
    fireEvent.click(screen.getByRole("switch", { name: "Disable PR alerts" }));
    expect(patchMutate).toHaveBeenCalledWith(
      { id: "sub_1", body: { enabled: false } },
      expect.anything(),
    );
  });

  it("hides the actions menu and disables the switch for another user's personal subscription", () => {
    subscriptionsData.subscriptions[0].ownerId = "someone-else";
    try {
      openSubscriptionsTab();
      expect(screen.queryByRole("button", { name: "PR alerts actions" })).toBeNull();
      const toggle = screen.getByRole("switch", { name: "Disable PR alerts" }) as HTMLButtonElement;
      expect(toggle.disabled).toBe(true);
    } finally {
      subscriptionsData.subscriptions[0].ownerId = "u1";
    }
  });

  it("creates a subscription from a name, catalog-picked keys, and the default target", async () => {
    openSubscriptionsTab();
    fireEvent.click(screen.getByRole("button", { name: /New subscription/ }));

    fireEvent.change(screen.getByLabelText("Subscription name"), {
      target: { value: "Merged PRs" },
    });
    fireEvent.click(screen.getByText("github.pr.merged"));
    fireEvent.click(screen.getByRole("button", { name: "Create subscription" }));

    await waitFor(() =>
      expect(createMutate).toHaveBeenCalledWith(
        {
          name: "Merged PRs",
          eventKeys: ["github.pr.merged"],
          target: { kind: "orchestrator", orchestrator: "user" },
        },
        expect.anything(),
      ),
    );
  });

  it("badges a team-owned subscription with the team's name and lets a member manage it", () => {
    teamsData = { teams: [team("t_eng", "Engineering", "member")] };
    subscriptionsData.subscriptions[0].ownerType = "team";
    subscriptionsData.subscriptions[0].ownerId = "t_eng";
    try {
      openSubscriptionsTab();
      expect(screen.getByText("Engineering")).toBeTruthy();
      const toggle = screen.getByRole("switch", { name: "Disable PR alerts" }) as HTMLButtonElement;
      expect(toggle.disabled).toBe(false);
    } finally {
      subscriptionsData.subscriptions[0].ownerType = "user";
      subscriptionsData.subscriptions[0].ownerId = "u1";
    }
  });

  it("keeps a non-member's hands off a team subscription (org admin included)", () => {
    teamsData = { teams: [team("t_eng", "Engineering", null)] };
    subscriptionsData.subscriptions[0].ownerType = "team";
    subscriptionsData.subscriptions[0].ownerId = "t_eng";
    try {
      openSubscriptionsTab();
      const toggle = screen.getByRole("switch", { name: "Disable PR alerts" }) as HTMLButtonElement;
      expect(toggle.disabled).toBe(true);
      expect(screen.queryByRole("button", { name: "PR alerts actions" })).toBeNull();
    } finally {
      subscriptionsData.subscriptions[0].ownerType = "user";
      subscriptionsData.subscriptions[0].ownerId = "u1";
    }
  });

  it("in a team workspace, the create dialog targets the team's assistant by default", async () => {
    teamsData = { teams: [team("t_eng", "Engineering", "member")] };
    scopeTeamId = "t_eng";
    openSubscriptionsTab();
    fireEvent.click(screen.getByRole("button", { name: /New subscription/ }));

    // The team option exists and is preselected.
    const teamRadio = screen.getByRole("radio", {
      name: /Notify Engineering's assistant/,
    }) as HTMLInputElement;
    expect(teamRadio.checked).toBe(true);

    fireEvent.change(screen.getByLabelText("Subscription name"), {
      target: { value: "Team PRs" },
    });
    fireEvent.click(screen.getByText("github.pr.merged"));
    fireEvent.click(screen.getByRole("button", { name: "Create subscription" }));

    await waitFor(() =>
      expect(createMutate).toHaveBeenCalledWith(
        {
          name: "Team PRs",
          eventKeys: ["github.pr.merged"],
          target: { kind: "orchestrator", orchestrator: "team", teamId: "t_eng" },
        },
        expect.anything(),
      ),
    );
  });

  it("personal workspace: no team target is offered", () => {
    teamsData = { teams: [team("t_eng", "Engineering", "member")] };
    openSubscriptionsTab();
    fireEvent.click(screen.getByRole("button", { name: /New subscription/ }));
    expect(screen.queryByRole("radio", { name: /Engineering's assistant/ })).toBeNull();
  });

  it("deletes a subscription after the confirm dialog", async () => {
    openSubscriptionsTab();
    // Radix dropdown triggers do not open from jsdom's plain click; the
    // keyboard path (Enter) is the reliable way to open one in tests.
    fireEvent.keyDown(screen.getByRole("button", { name: "PR alerts actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByText("Delete subscription"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete subscription" }));
    expect(deleteMutate).toHaveBeenCalledWith("sub_1", expect.anything());
  });
});
