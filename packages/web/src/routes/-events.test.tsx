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
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

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

const eventDetailData = {
  event: { ...eventsData.events[0], payload: { action: "opened", number: 7 } },
  deliveries: [
    {
      id: "d1",
      subscriptionId: "sub_1",
      status: "delivered" as const,
      attempts: 1,
      lastError: null,
      deliveredAt: 1_723_200_001_000,
    },
  ],
};

const subscriptionsData = {
  subscriptions: [
    {
      id: "sub_1",
      name: "PR alerts",
      ownerType: "user" as const,
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

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u1", orgRole: "member" }, isLoading: false, error: null }),
}));

import { EventsPage } from "./events";

beforeEach(() => {
  patchMutate.mockClear();
  createMutate.mockClear();
  deleteMutate.mockClear();
});

describe("EventsPage — Activity", () => {
  it("renders the feed with service, key, summary, and actor", () => {
    render(<EventsPage />);
    expect(screen.getByText("PR #7 opened: fix login")).toBeTruthy();
    expect(screen.getByText("github.pr.opened")).toBeTruthy();
    expect(screen.getByText("octocat")).toBeTruthy();
  });

  it("expands an event into its deliveries and payload", () => {
    render(<EventsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Expand PR #7/ }));
    expect(screen.getByText("delivered")).toBeTruthy();
    expect(screen.getByText(/"action": "opened"/)).toBeTruthy();
  });
});

describe("EventsPage — Subscriptions", () => {
  function openSubscriptionsTab() {
    render(<EventsPage />);
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
